#!/usr/bin/env python3
"""Concurrency smoke for the flightdeck binary.

Starts the binary on a fresh data dir, then has many sessions post
events through /ingest/v1/events at once while readers hit the query
API, and checks what a single-writer database must still guarantee:

  * every request is answered, none with a 5xx;
  * every event posted is stored, exactly once;
  * the log has no "database is locked" / SQLITE_BUSY;
  * reads keep answering while the writes run (the slowest read stays
    under READ_STALL_SECS);
  * on SQLite the write-ahead log stays bounded, a snapshot taken with
    VACUUM INTO while the load runs is a valid database, and a clean
    stop leaves one database file.

With no --database-url the binary runs on its default, the SQLite file
in the data dir; with a postgres:// URL it runs on that database, which
must be empty of this script's flavor (use a throwaway database).

Standard library only. Memory is bounded: response bodies are read and
dropped, and only one latency number per read is kept.

Usage:
  scripts/flightdeck_stress.py <binary> [--database-url URL]
      [--listen 127.0.0.1:4100] [--sessions 50] [--events 200] [--readers 8]

Exit status 0 when every check holds; 1 otherwise, with the reasons.
"""

from __future__ import annotations

import argparse
import http.client
import json
import os
import signal
import sqlite3
import subprocess
import sys
import tempfile
import threading
import time
import uuid
from pathlib import Path

# The binary migrates an empty database and starts JetStream before it
# serves; a cold CI runner does that in a few seconds.
READY_TIMEOUT_SECS = 60
# After the last POST is answered the workers still drain the stream.
# Under the default load (10,000 events, eight readers in a tight loop)
# the binary stored about 100 events a second on SQLite and 325 on
# Postgres (measured on a 32-core laptop: everything stored 98 to 110 s
# and 31 s after the first POST). Five minutes covers a CI runner with
# a few cores; the bound turns a stall into a failure.
STORE_TIMEOUT_SECS = 300
# The binary's own shutdown budget is 30 s per step.
STOP_TIMEOUT_SECS = 90
# A read that takes longer than this while writes run counts as stalled
# behind them. Readers use their own connections on SQLite (WAL) and
# never wait for the writer, so reads stay in the tens of milliseconds;
# two seconds leaves room for a loaded CI runner and the client's own
# thread scheduling, and is far below what waiting for the 10,000-event
# write queue would cost.
READ_STALL_SECS = 2.0
# The storage module resets the write-ahead log once it passes 16 MiB
# and the reads in flight have ended. Under the default load the log
# peaked at 40 to 77 MiB (measured); without the reset it reached
# 446 MiB and kept growing with the load. 256 MiB therefore means the
# log is no longer being reset.
WAL_LIMIT_BYTES = 256 * 1024 * 1024
# How often the write-ahead log's size is sampled.
WAL_SAMPLE_SECS = 0.25
# Per-request socket timeout: above READ_STALL_SECS, so a stalled read
# is measured rather than cut, and far below the run's length.
HTTP_TIMEOUT_SECS = 30
# The ingestion API's default limit is 1000 events a minute per token;
# the load posts all its events with one token.
RATE_LIMIT_PER_MINUTE = "100000000"

TOKEN = "tok_dev"
EPOCH = "1970-01-01T00:00:00Z"


def log(msg: str) -> None:
    print(msg, flush=True)


class Client:
    """One keep-alive connection; bodies are read and dropped."""

    def __init__(self, host: str, port: int) -> None:
        self.host, self.port = host, port
        self.conn: http.client.HTTPConnection | None = None

    def request(self, method: str, path: str, body: bytes | None = None) -> tuple[int, bytes]:
        headers = {"Authorization": f"Bearer {TOKEN}"}
        if body is not None:
            headers["Content-Type"] = "application/json"
        for attempt in (1, 2):
            if self.conn is None:
                self.conn = http.client.HTTPConnection(self.host, self.port, timeout=HTTP_TIMEOUT_SECS)
            try:
                self.conn.request(method, path, body=body, headers=headers)
                resp = self.conn.getresponse()
                return resp.status, resp.read()
            except (http.client.HTTPException, ConnectionError, TimeoutError):
                # A keep-alive connection the server closed: reconnect
                # once. A second failure is the caller's to count.
                self.conn.close()
                self.conn = None
                if attempt == 2:
                    raise
        raise AssertionError("unreachable")

    def close(self) -> None:
        if self.conn is not None:
            self.conn.close()


class Stats:
    """Thread-safe counters and read latencies."""

    def __init__(self) -> None:
        self.lock = threading.Lock()
        self.posted = 0
        self.statuses: dict[int, int] = {}
        self.errors: list[str] = []
        self.read_latency: dict[str, list[float]] = {}

    def status(self, code: int) -> None:
        with self.lock:
            self.statuses[code] = self.statuses.get(code, 0) + 1

    def error(self, msg: str) -> None:
        with self.lock:
            if len(self.errors) < 20:
                self.errors.append(msg)
            self.statuses[-1] = self.statuses.get(-1, 0) + 1

    def read(self, name: str, seconds: float) -> None:
        with self.lock:
            self.read_latency.setdefault(name, []).append(seconds)


def event(session_id: str, agent_id: str, flavor: str, event_type: str) -> bytes:
    payload: dict[str, object] = {
        "session_id": session_id,
        "agent_id": agent_id,
        "agent_name": "stress",
        "agent_type": "coding",
        "client_type": "flightdeck_sensor",
        "user": "stress",
        "hostname": "stress-host",
        "host": "stress-host",
        "flavor": flavor,
        "event_type": event_type,
        "sensor_version": "0.0.0",
        "capture_prompts": False,
        "timestamp": time.strftime("%Y-%m-%dT%H:%M:%S", time.gmtime()) + f".{int(time.time() * 1000) % 1000:03d}Z",
    }
    if event_type == "session_start":
        payload["context"] = {}
    else:
        payload.update(model="claude-sonnet-4-5", tokens_input=10, tokens_output=5, tokens_total=15, latency_ms=12)
    return json.dumps(payload).encode()


def writer(host: str, port: int, flavor: str, events: int, stats: Stats) -> None:
    client = Client(host, port)
    session_id, agent_id = str(uuid.uuid4()), str(uuid.uuid4())
    try:
        for i in range(events):
            body = event(session_id, agent_id, flavor, "session_start" if i == 0 else "post_call")
            try:
                code, _ = client.request("POST", "/ingest/v1/events", body)
            except Exception as exc:  # noqa: BLE001 - every failure is counted
                stats.error(f"POST /ingest/v1/events: {exc!r}")
                continue
            stats.status(code)
            if code == 200:
                with stats.lock:
                    stats.posted += 1
    finally:
        client.close()


def read_paths(flavor: str) -> dict[str, str]:
    return {
        "sessions": f"/api/v1/sessions?from={EPOCH}&limit=50",
        "events": f"/api/v1/events?from={EPOCH}&limit=50&flavor={flavor}",
        "analytics": "/api/v1/analytics?metric=tokens&group_by=flavor&range=7d",
        "fleet": "/api/v1/fleet",
    }


def reader(host: str, port: int, flavor: str, stats: Stats, stop: threading.Event) -> None:
    client = Client(host, port)
    paths = read_paths(flavor)
    try:
        while not stop.is_set():
            for name, path in paths.items():
                start = time.monotonic()
                try:
                    code, _ = client.request("GET", path)
                except Exception as exc:  # noqa: BLE001
                    stats.error(f"GET {path}: {exc!r}")
                    continue
                stats.read(name, time.monotonic() - start)
                stats.status(code)
                if code != 200:
                    stats.error(f"GET {path}: {code}")
    finally:
        client.close()


def wal_watch(wal: Path, peak: list[int], stop: threading.Event) -> None:
    while not stop.wait(WAL_SAMPLE_SECS):
        try:
            peak[0] = max(peak[0], wal.stat().st_size)
        except FileNotFoundError:
            pass


def percentile(values: list[float], pct: float) -> float:
    ordered = sorted(values)
    return ordered[min(len(ordered) - 1, int(len(ordered) * pct))]


def stored_events(client: Client, flavor: str) -> int:
    code, body = client.request("GET", f"/api/v1/events?from={EPOCH}&limit=1&flavor={flavor}")
    if code != 200:
        raise RuntimeError(f"GET /api/v1/events: {code}")
    return int(json.loads(body)["total"])


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("binary")
    ap.add_argument("--database-url", default="")
    ap.add_argument("--listen", default="127.0.0.1:4100")
    ap.add_argument("--sessions", type=int, default=50)
    ap.add_argument("--events", type=int, default=200, help="events per session")
    ap.add_argument("--readers", type=int, default=8)
    args = ap.parse_args()

    host, port_s = args.listen.rsplit(":", 1)
    port = int(port_s)
    sqlite_default = args.database_url == ""
    expected = args.sessions * args.events
    flavor = f"flightdeck-stress-{uuid.uuid4().hex[:8]}"
    failures: list[str] = []

    with tempfile.TemporaryDirectory(prefix="flightdeck-stress-") as tmp:
        data = Path(tmp) / "data"
        log_path = Path(tmp) / "flightdeck.log"
        env = {k: v for k, v in os.environ.items() if not k.startswith("FLIGHTDECK_") and k != "ENVIRONMENT"}
        env["FLIGHTDECK_RATE_LIMIT_PER_MINUTE"] = RATE_LIMIT_PER_MINUTE
        cmd = [args.binary, "--listen", args.listen, "--data-dir", str(data)]
        if args.database_url:
            cmd += ["--database-url", args.database_url]
        with open(log_path, "wb") as log_file:
            proc = subprocess.Popen(cmd, stdout=log_file, stderr=subprocess.STDOUT, env=env)
        try:
            probe = Client(host, port)
            deadline = time.monotonic() + READY_TIMEOUT_SECS
            while True:
                if proc.poll() is not None:
                    log(log_path.read_text(errors="replace"))
                    log("FAIL: flightdeck exited before it served")
                    return 1
                try:
                    if probe.request("GET", "/api/health")[0] == 200:
                        break
                except Exception:  # noqa: BLE001 - not listening yet
                    pass
                if time.monotonic() > deadline:
                    log(log_path.read_text(errors="replace"))
                    log(f"FAIL: no /api/health within {READY_TIMEOUT_SECS}s")
                    return 1
                time.sleep(0.2)
            backend = "SQLite" if sqlite_default or args.database_url.startswith("sqlite://") else "Postgres"
            log(f"== {args.sessions} sessions x {args.events} events, {args.readers} readers, on {backend}")

            # Read latency with nothing else running, for comparison.
            idle = Stats()
            for name, path in read_paths(flavor).items():
                for _ in range(20):
                    start = time.monotonic()
                    code, _ = probe.request("GET", path)
                    idle.read(name, time.monotonic() - start)
                    if code != 200:
                        failures.append(f"idle GET {path}: {code}")

            stats = Stats()
            stop_readers = threading.Event()
            stop_wal = threading.Event()
            wal_peak = [0]
            threads = [
                threading.Thread(target=reader, args=(host, port, flavor, stats, stop_readers), daemon=True)
                for _ in range(args.readers)
            ]
            if sqlite_default:
                threads.append(
                    threading.Thread(
                        target=wal_watch, args=(data / "flightdeck.db-wal", wal_peak, stop_wal), daemon=True
                    )
                )
            writers = [
                threading.Thread(target=writer, args=(host, port, flavor, args.events, stats), daemon=True)
                for _ in range(args.sessions)
            ]
            began = time.monotonic()
            for t in threads + writers:
                t.start()

            snapshot_rows = None
            if sqlite_default:
                # A backup taken while the load runs, the way the docs
                # say to take one.
                snapshot = Path(tmp) / "snapshot.db"
                while stats.posted < expected // 4 and any(w.is_alive() for w in writers):
                    time.sleep(0.05)
                src = sqlite3.connect(str(data / "flightdeck.db"), timeout=30)
                try:
                    src.execute("VACUUM INTO ?", (str(snapshot),))
                finally:
                    src.close()
                snap = sqlite3.connect(str(snapshot))
                try:
                    check = snap.execute("PRAGMA integrity_check").fetchall()
                    snapshot_rows = snap.execute(
                        "SELECT COUNT(*) FROM events WHERE flavor = ?", (flavor,)
                    ).fetchone()[0]
                finally:
                    snap.close()
                if check != [("ok",)]:
                    failures.append(f"the VACUUM INTO snapshot fails integrity_check: {check[:3]}")
                if not 0 < snapshot_rows <= expected:
                    failures.append(f"the snapshot holds {snapshot_rows} of this run's events")

            for w in writers:
                w.join()
            posted_in = time.monotonic() - began
            stored = 0
            deadline = time.monotonic() + STORE_TIMEOUT_SECS
            while True:
                stored = stored_events(probe, flavor)
                if stored >= expected or time.monotonic() > deadline:
                    break
                time.sleep(0.2)
            stored_in = time.monotonic() - began
            stop_readers.set()
            stop_wal.set()
            for t in threads:
                t.join(HTTP_TIMEOUT_SECS + 5)

            # The sessions' own counters agree with the events.
            code, body = probe.request(
                "GET", f"/api/v1/analytics?metric=tokens&group_by=flavor&range=7d&filter_flavor={flavor}"
            )
            tokens = None
            if code == 200:
                totals = json.loads(body).get("totals") or {}
                tokens = totals.get("grand_total")
            probe.close()
        finally:
            if proc.poll() is None:
                proc.send_signal(signal.SIGINT)
            try:
                rc = proc.wait(STOP_TIMEOUT_SECS)
            except subprocess.TimeoutExpired:
                proc.kill()
                rc = proc.wait()
                failures.append(f"flightdeck did not exit within {STOP_TIMEOUT_SECS}s of SIGINT")

        text = log_path.read_text(errors="replace")
        busy = sum(text.count(s) for s in ("database is locked", "SQLITE_BUSY"))
        error_lines = [ln for ln in text.splitlines() if " ERROR " in ln]
        left = sorted(p.name for p in data.glob("flightdeck.db-*")) if sqlite_default else []

        five_xx = sum(n for code, n in stats.statuses.items() if code >= 500)
        other = {code: n for code, n in stats.statuses.items() if code != 200}
        log(f"   posted {stats.posted}/{expected} in {posted_in:.1f}s ({stats.posted / posted_in:.0f} events/s)")
        log(f"   stored {stored}/{expected} after {stored_in:.1f}s")
        log(f"   responses: {dict(sorted(stats.statuses.items()))}")
        for name in sorted(stats.read_latency):
            under, calm = stats.read_latency[name], idle.read_latency[name]
            log(
                f"   read {name:<9} n={len(under):<5} p50={percentile(under, 0.5) * 1000:6.1f} ms "
                f"p95={percentile(under, 0.95) * 1000:6.1f} ms max={max(under) * 1000:7.1f} ms "
                f"(idle p50={percentile(calm, 0.5) * 1000:.1f} ms max={max(calm) * 1000:.1f} ms)"
            )
        if sqlite_default:
            log(f"   write-ahead log peak {wal_peak[0] / 1048576:.1f} MiB; snapshot held {snapshot_rows} events")
        log(f"   exit status {rc}; ERROR lines {len(error_lines)}; locked-database lines {busy}")

        if stats.posted != expected:
            failures.append(f"{stats.posted} of {expected} events were accepted")
        if five_xx:
            failures.append(f"{five_xx} responses were 5xx")
        if other:
            failures.append(f"responses other than 200: {other}; first errors: {stats.errors[:5]}")
        if stored != expected:
            failures.append(f"{stored} events stored, want exactly {expected}")
        if tokens is not None and tokens != 15 * (expected - args.sessions):
            failures.append(f"analytics counts {tokens} tokens, want {15 * (expected - args.sessions)}")
        if busy:
            failures.append(f"the log reports a locked database {busy} times")
        if error_lines:
            failures.append(f"{len(error_lines)} ERROR lines in the log, first: {error_lines[0][:300]}")
        slowest = max((max(v) for v in stats.read_latency.values()), default=0.0)
        if slowest > READ_STALL_SECS:
            failures.append(f"a read took {slowest:.2f}s while writes ran (limit {READ_STALL_SECS}s)")
        if not stats.read_latency:
            failures.append("no read completed")
        if wal_peak[0] > WAL_LIMIT_BYTES:
            failures.append(f"the write-ahead log grew to {wal_peak[0]} bytes (limit {WAL_LIMIT_BYTES})")
        if rc != 0:
            failures.append(f"flightdeck exited {rc} on SIGINT")
        if left:
            failures.append(f"files left beside the database after a clean stop: {left}")
        if failures:
            sys.stdout.write(text[-4000:])

    if failures:
        for f in failures:
            log(f"FAIL: {f}")
        return 1
    log(f"STRESS OK ({backend})")
    return 0


if __name__ == "__main__":
    sys.exit(main())
