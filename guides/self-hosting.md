# Self-hosting: Compose, Helm and backups

The [README](../README.md#self-hosting) has the one-line form of every way to run Flightdeck for a team: the binary with `--public`, `--domain` or `--database-url`, the Docker image, Compose and Helm. This page is the detail for Compose and Helm (what each starts, where the token is, the event stream's retention, the chart's values, the upgrade notes) and for backing up and restoring. [ARCHITECTURE.md](../ARCHITECTURE.md) ("Deployment") lists every flag and variable of the binary.

Flightdeck is self-hosted. Two deployment targets are supported, both running the one `flightdeckhq/flightdeck` image: Docker Compose (single host) and a Helm chart for Kubernetes.

## Prerequisites

- Docker Engine 28+ with Compose v2 (`docker compose version` reports `v2.x`), or a Kubernetes 1.25+ cluster with Helm 3.
- For TLS from the binary: a DNS A/AAAA record for the host (e.g. `flightdeck.example.com`) and ports 80 and 443 reachable from the public internet.

## Running in the background

On one machine without Docker, `flightdeck service install` keeps the binary running for your user on Linux and macOS: it starts it now, at every login, and again within seconds if it stops. It needs no sudo, and it runs the `flightdeck` you run it with, with the flags you give it:

```bash
flightdeck service install --port 4100
```

- **Linux**: a systemd user unit, `~/.config/systemd/user/flightdeck.service`, with its log in the journal (`journalctl --user -u flightdeck`). The user manager runs while you are logged in; on a server nobody stays logged in to, `sudo loginctl enable-linger <user>` starts it at boot, and `install` prints that command when lingering is off. On WSL, systemd must be on (`[boot] systemd=true` in `/etc/wsl.conf`), and the service runs while WSL does.
- **macOS**: a launchd agent, `~/Library/LaunchAgents/com.flightdeck-hq.flightdeck.plist`, with its log in `flightdeck.log` in the data dir. It runs while you are logged in to the Mac.

`install` takes `--port`, `--public`, `--listen`, `--data-dir`, `--allowed-hosts` and `--metrics`, or their `FLIGHTDECK_` variables in the shell you run it from, and waits until the service answers. For a Postgres, put its URL in a file only you can read (`chmod 600`) and give the file, `--database-url-file <file>`: the URL never goes into the service's file or onto a command line. Run `install` again to change the flags; after you install a new release, `flightdeck service restart` runs it. `flightdeck service status` says whether the service runs and answers, and `flightdeck service remove` stops and removes it and leaves the data dir as it is. A `flightdeck` started by hand while the service runs on its port or data dir says that the service runs. On a Homebrew install, `brew services start flightdeck` runs the formula's own service, which takes no flags; `flightdeck service install --no-brew` writes this one instead, once Homebrew's is stopped. ARCHITECTURE.md ("Running in the background") has every line of the files it writes.

## Docker Compose

```bash
git clone https://github.com/flightdeckhq/flightdeck
cd flightdeck
docker compose -f docker/docker-compose.yml up -d
```

That is one container: the database is a SQLite file on the `flightdeck_data` volume, and the dashboard is at `http://localhost:4000`. The first start mints the access token, since the seed `tok_dev` token is refused off loopback; `/runtime-config.json` on that address returns it, and the start-up block in the container's log carries it on that start. The port is published on `127.0.0.1` because whoever can reach it can read that token: `FLIGHTDECK_PUBLISH_HOST` publishes it wider, behind a firewall or a proxy that authenticates. The header of [`docker/docker-compose.yml`](../docker/docker-compose.yml) lists every variable, including `FLIGHTDECK_DOMAIN` for TLS from the binary (a Let's Encrypt certificate, 80 redirecting to 443); [`docker/docker-compose.postgres.yml`](../docker/docker-compose.postgres.yml), layered on it, runs a Postgres instead of SQLite and requires `POSTGRES_PASSWORD`. Both set `restart: unless-stopped` and keep their data on named volumes. The file names the image of its own release, so to upgrade, `git pull` in the clone and run the same `docker compose ... up -d`, which replaces the container and keeps the volumes.

The `FLIGHTDECK` NATS stream that carries events from ingestion to the workers keeps them for 72 hours, up to 5 GiB, then removes the oldest (`FLIGHTDECK_NATS_STREAM_MAX_AGE_HOURS`, `FLIGHTDECK_NATS_STREAM_MAX_SIZE_MIB` in `docker/.env`). The limits remove events whether or not the workers have processed them, so if the workers are down for longer than 72 hours, or fall more than 5 GiB behind, the oldest unprocessed events are lost; the workers log how many at their next start. To roll back to a release before the stream was bounded, first run `nats stream edit FLIGHTDECK --max-age=0 --max-bytes=-1 --discard=old --replicas=1 --force` (with `-s <your NATS URL>`), which restores unbounded retention; the earlier ingestion and workers do not start on the bounded stream.

Reach the dashboard at `http://localhost:4000/` (or `https://flightdeck.example.com/`). Go to **Settings → Access tokens → Create** to mint a token for your agents. The token's plaintext is shown once at creation; copy it into your secret store before closing the modal.

Point an agent (the Python sensor and the Claude Code plugin read the same two variables; the server's ingestion URL, ending in `/ingest`, works as the address too):

```bash
export FLIGHTDECK_SERVER="https://flightdeck.example.com"
export FLIGHTDECK_TOKEN="ftd_..."
```

For Claude Code, a developer with the `flightdeck` binary can save both in the plugin's options instead, with the token in a file: `flightdeck connect claude-code --server https://flightdeck.example.com --token-file ~/flightdeck-token` installs the plugin if it is missing and keeps the token in Claude Code's credential store.

The dashboard fetches its bearer token at runtime from `/runtime-config.json`, which the binary answers from the token it keeps in `/data/secrets.json`; nothing is baked into the bundle.

## Kubernetes (Helm)

```bash
helm install flightdeck helm/ --namespace flightdeck --create-namespace
```

With the default values the chart runs one pod and nothing else: the database is a SQLite file and the bus is embedded, both on the pod's own volume. The notes `helm install` prints say how to open the dashboard and read the token. `postgres.enabled=true` with `postgres.password` runs the chart's own single-instance Postgres StatefulSet instead (fine for small deployments, not HA, not backed up), and `postgres.externalUrl` uses a Postgres you run.

Several pods need a database and a bus they share, so the render refuses more than one replica (or the HPA) without a Postgres, and without a NATS: the chart then runs its own NATS cluster, which needs `nats.auth.token`, unless `nats.externalUrl` names one. [`helm/values.prod.yaml`](../helm/values.prod.yaml) is that shape (three replicas behind an HPA, an Ingress), to be given `postgres.externalUrl` and `nats.auth.token`. Each pod opens at most 80 Postgres connections; the chart sizes its own Postgres for that, and an external one needs `max_connections` for 80 per pod or a pooler. With more than one NATS server the servers form a cluster, so events published on any of them reach the workers. On a cluster of 3 or more servers the `FLIGHTDECK` JetStream stream keeps a copy on 3 of them, so it survives the loss of one. The token may contain only letters, digits and `. _ ~ -` because it is placed in NATS URLs (`openssl rand -hex 32` works); with more than one NATS replica the cluster routes authenticate with it too.

**Secrets from your own Secrets.** `postgres.externalUrlSecret`, `postgres.passwordSecret`, `nats.externalUrlSecret` and `nats.auth.tokenSecret` take the `name` and `key` of a Secret you created, in place of `postgres.externalUrl`, `postgres.password`, `nats.externalUrl` and `nats.auth.token`, so nothing secret sits in a values file or in the Helm release. Give each secret once; the render refuses both forms. A password or token from a Secret goes into a URL as it is, so use letters, digits and `- . _ ~`. The pods read Secrets at start: after changing one, `kubectl rollout restart statefulset/<release>-flightdeck`. `flightdeck.extraEnv` is plain text in a ConfigMap, so it refuses a name that reads like a secret, in any case (one containing `PASSWORD`, `SECRET`, `TOKEN`, `CREDENTIAL` or `APIKEY`, or with `KEY`, `URL`, `URI`, `DSN`, `PASS` or `PWD` as a word); that guards against a slip and cannot find a secret under another name. `flightdeck.extraEnvFrom` takes a Secret of yours, or a ConfigMap for a refused name that is no secret; its keys override the chart's, and the chart does not see them. A name whose last word is `FILE` holds a path and goes through.

**The dashboard token.** `flightdeck.dashboardTokenSecret` names a Secret of yours that holds the dashboard token (`name`, and `key`, default `token`). The chart mounts that key read-only as a file in every pod and sets `FLIGHTDECK_DASHBOARD_TOKEN_FILE` to it, never `FLIGHTDECK_DASHBOARD_TOKEN`, which would put the token in the pod's environment. Every pod then serves that one token, however many replicas run, and it is known before the first start. It must be `ftd_` and 32 random lower-case hex digits, and a pod refuses to start on anything else: `kubectl create secret generic flightdeck-dashboard-token --from-literal=token="ftd_$(openssl rand -hex 16)"`. Without it each pod mints a token of its own on its first start; each is valid on every pod, since tokens are rows of the database the pods share, and Settings lists one `Bootstrap token` per pod. To rotate the supplied token, put the new one in the Secret, restart every pod (`kubectl rollout restart statefulset/<release>-flightdeck`: the pods read the file at start), then revoke the old one in Settings (`Supplied dashboard token (ftd_xxxx)`). The old one stays valid until you revoke it, so the pods not yet restarted keep working; revoked earlier, it is stored again by the next pod that starts with it.

**Changing the database.** The chart never moves data. An upgrade that changes the database (SQLite to Postgres, the chart's Postgres to an external one, one external Postgres to another) starts the pods on the new database as it is, and the old data stays where it was (a volume claim, or the other server). The chart records the database on the StatefulSet and refuses such an upgrade unless `allowDatabaseChange=true`; it cannot check a release installed by an earlier chart, or a render that cannot read the cluster (`helm template`, Argo CD). A URL from a Secret is recorded by the Secret's name and key, not what it holds: a Secret changed to point at another database is not seen, and moving the same database from `postgres.externalUrl` to `postgres.externalUrlSecret` is refused like a move (set `allowDatabaseChange=true` for that upgrade). So is a first install that failed and is retried with `helm upgrade --install` on another database: the failed attempt left its StatefulSet. The notes of every upgrade name the database the release runs on.

**Rotating the bundled Postgres's password.** Postgres takes `postgres.password` only when it creates its database, so a new value alone leaves the pods unable to connect, and the claim outlives `helm uninstall`, so a reinstall keeps the old password too. Change it in the database first, `kubectl exec -it <release>-postgres-0 -- psql -U flightdeck -d flightdeck -c '\password flightdeck'` (psql asks for it, so it stays off the command line), then upgrade with the new value (or update your Secret and restart the pods). A password given as `postgres.password` is hashed into the pods' `checksum/secret` annotation with the rest of the chart's Secret, so whoever can read pods can test guesses against it: use a random one (`openssl rand -hex 24`), or `postgres.passwordSecret`.

**Storage.** The sizes and storage classes of the claims (`flightdeck.data`, `postgres.storage`, `nats.jetstream.fileStore`) are fixed once installed: a StatefulSet's claim template cannot change, so `helm upgrade` fails on a change. To grow claims on a storage class that allows expansion, raise each claim (`kubectl patch pvc data-<release>-flightdeck-0 -p '{"spec":{"resources":{"requests":{"storage":"20Gi"}}}}'`), delete the StatefulSet but not its pods (`kubectl delete statefulset <release>-flightdeck --cascade=orphan`), then upgrade with the new size. Another storage class means moving the data yourself. Claims are kept on uninstall and when replicas are scaled in (the StatefulSets state `Retain` for both on Kubernetes 1.27 and later, and that is the behaviour before it too): delete them to delete the data.

**Host names.** The pods answer for the names they are reached by (`FLIGHTDECK_ALLOWED_HOSTS`): the Service and the headless Service in short and qualified forms, the Ingress host and TLS hosts, and `localhost` for a port-forward. Add other names (another Ingress, a LoadBalancer's DNS name) to `flightdeck.extraAllowedHosts`. A binary that checks the `Host` header refuses other names with 421; IP addresses, and so the probes, are always answered. `flightdeck.metrics.networkPolicy` (off by default) lets only the peers you name reach the metrics ports, which carry no auth.

**A pod that stops on `secrets.json` after a restore.** The binary refuses a `secrets.json` that anyone but its owner can read. A volume restored or cloned with wider modes stops the pod with that error in its log. Scale the StatefulSet to 0, make the file private from a one-off pod that mounts the claim as uid 65532 (the image has no shell, so a busybox pod: `chmod 0600 /data/flightdeck/secrets.json`), and scale back.

**Upgrading a release of an earlier chart**: set `postgres.enabled=true` (with the same `postgres.password`) to stay on the chart's Postgres, which earlier charts ran by default; without it the pods start on an empty SQLite database. The `api.*`, `ingestion.*`, `workers.*` and `dashboard.*` values no longer exist; `flightdeck.*` replaces them. A release whose base name (the release name, with `-flightdeck` when it lacks it, or `fullnameOverride`) is longer than 43 characters gets shorter names, its Postgres StatefulSet and claim included, so the upgraded release starts on a new, empty Postgres. Its NATS StatefulSet and claims (`<base>-nats`) are renamed too, which loses only the events still queued on the old bus. On the earlier chart that StatefulSet's name was over 52 characters, and Kubernetes creates its pods only while the revision's hash is short enough to keep the `controller-revision-hash` label within 63 (about one revision in four at a 44-character base, one in 43 at 45), so most such releases never ran it. If yours did, its data stays in the old claim, which the new release does not read: dump it before the upgrade, `kubectl exec <old base>-postgres-0 -- pg_dump -U flightdeck -d flightdeck --clean --if-exists > flightdeck.sql`, and after it scale the flightdeck StatefulSet to 0, load the dump in one transaction, so that a load that fails leaves nothing half-loaded, `kubectl exec -i <new base>-postgres-0 -- psql -v ON_ERROR_STOP=1 -1 -U flightdeck -d flightdeck < flightdeck.sql`, and scale back; the pods then migrate it forward. A release that set `postgres.user` or `postgres.database` uses those in place of `flightdeck` in both commands. `fullnameOverride` cannot keep the old name: it is cut to 43 too.

**Upgrading a v0.5.3 install with `nats.replicas` above 1** (the default is 3): the NATS StatefulSet's pod start policy changes, which Kubernetes does not allow in place. Scale ingestion to zero, give the workers a minute to drain, then run `kubectl delete statefulset <release>-flightdeck-nats` (the data volumes stay) before `helm upgrade`. On first start the clustered servers discard the old per-server streams and ingestion recreates the stream, so any event still on the bus at that point is dropped. A one-replica install upgrades in place and keeps its stream.

The chart is at `version` 0.11.0 with `appVersion` 0.11.0; the default `image.tag` is `v0.11.0`. See [`helm/values.yaml`](../helm/values.yaml) for the full schema, including replicas, HPA bounds, ingress, resources, and security contexts.

| Key | Default | Description |
|---|---|---|
| `image.tag` | `v0.11.0` | Tag of the `flightdeckhq/flightdeck` image. |
| `image.digest` | *(empty)* | `sha256:...` pins the image by digest; `nats.image.digest` and `postgres.image.digest` likewise. |
| `allowDatabaseChange` | `false` | Let an upgrade move the release to another database (the data is not moved). |
| `flightdeck.replicas` | `1` | Pod count. Above 1 needs Postgres and a shared NATS. HPA overrides at runtime when enabled. |
| `flightdeck.hpa.enabled` | `false` | Enable the HorizontalPodAutoscaler for the pods. |
| `flightdeck.data.size` | `10Gi` | PVC size of each pod's data dir (the SQLite database, the embedded bus store, the minted token). |
| `flightdeck.corsOrigin` | *(empty)* | `Access-Control-Allow-Origin` for the query API; empty keeps `*`. Lock down in prod. |
| `flightdeck.extraAllowedHosts` | `[]` | Host names the pods answer for besides the chart's own list; `*` turns the check off. |
| `flightdeck.extraEnvFrom` | `[]` | More `envFrom` entries (a Secret of yours) for the flightdeck container. |
| `flightdeck.dashboardTokenSecret.name` | *(empty)* | The dashboard token every pod serves, from a Secret of yours (`.key`, default `token`), mounted as a file. |
| `flightdeck.metrics.networkPolicy.enabled` | `false` | Restrict the metrics ports 9102-9104 to `flightdeck.metrics.networkPolicy.from`. |
| `postgres.enabled` | `false` | Run the chart's single-instance Postgres StatefulSet; needs `postgres.password`. |
| `postgres.externalUrl` | *(empty)* | A Postgres you run. When set, the bundled StatefulSet is not rendered. |
| `postgres.externalUrlSecret.name` | *(empty)* | The same URL from a Secret of yours (`.key`, default `url`). |
| `postgres.passwordSecret.name` | *(empty)* | The bundled Postgres's password from a Secret of yours (`.key`, default `password`). |
| `postgres.maxConnections` | *(empty)* | `max_connections` of the bundled Postgres. Empty: 80 per pod the chart may run, plus 20. |
| `postgres.storage.size` | `20Gi` | PVC size for the bundled StatefulSet. |
| `nats.enabled` | *(empty)* | Run the chart's NATS cluster. Empty: exactly when the chart runs more than one pod. |
| `nats.externalUrl` | *(empty)* | A NATS server you run, for the pods to share instead. |
| `nats.externalUrlSecret.name` | *(empty)* | The same URL from a Secret of yours (`.key`, default `url`). |
| `nats.replicas` | `3` | NATS StatefulSet replica count; more than one forms a NATS cluster. |
| `nats.auth.token` | *(empty)* | Client token for the event bus. Required when the chart runs its NATS cluster. |
| `nats.auth.tokenSecret.name` | *(empty)* | The token from a Secret of yours (`.key`, default `token`). |
| `nats.jetstream.fileStore.size` | `10Gi` | PVC size per NATS replica. |
| `nats.jetstream.stream.maxAgeHours` | `72` | How long the `FLIGHTDECK` stream keeps an event, processed or not. Unprocessed events older than this are lost. |
| `nats.jetstream.stream.maxSizeMiB` | `5120` | Most the stream stores on each NATS server; at the limit the oldest events go. The render fails above 75% of `fileStore.size`; keep it well under (`values.prod.yaml`: 30720 for 50Gi). |
| `nats.jetstream.stream.replicas` | *(empty)* | Servers holding a copy of the stream. Empty: 3 when `nats.replicas` is 3 or more, else 1. At most `nats.replicas` and 5, and not 2. |
| `ingress.enabled` | `false` | Render an Ingress routing every path to the pods, which serve the dashboard, `/api` and `/ingest` themselves. |
| `ingress.tls` | `[]` | Pass through to the Ingress `tls:` stanza. |

## Backing up and restoring

Everything Flightdeck keeps is in its data dir (`--data-dir`, default `~/.flightdeck`, `%LOCALAPPDATA%\flightdeck` on Windows; `/data` in the image): the SQLite database `flightdeck.db`, the message-bus store and `secrets.json`. The database is the part to back up: it holds the sessions, the events and the settings, access tokens included, and the bus store and `secrets.json` are made again when they are missing. With `--database-url postgres://…` the sessions and events are in that Postgres (below), and the data dir holds only the bus store and the secrets.

Keep backups on another disk or another machine: a copy on the same disk is lost with that disk. A backup holds everything the database does, captured prompts included, so keep it where only you can read it.

### SQLite

```bash
flightdeck backup
```

That copies the database, while Flightdeck runs or not, to `backups/flightdeck-<time>.db` in the data dir; `flightdeck backup <file>` writes it to the file you name, or into a directory (`flightdeck backup /mnt/usb/`). It needs nothing else installed (no `sqlite3`, on Windows too), checks the copy before it says it is done, and never writes over a file. Give it the `--data-dir` (or `--database-url`) Flightdeck runs with, as for every command.

To restore, stop Flightdeck, then:

```bash
flightdeck restore <file>
```

It refuses while Flightdeck runs, naming its process, and refuses a file that is not a Flightdeck backup, is damaged or cut short, or comes from a newer release, with nothing changed. It keeps the database it replaces, with its write-ahead log, as `flightdeck.db.replaced-<time>` beside it, and puts that back if any step fails; remove it once Flightdeck shows what you expect. A service of [`flightdeck service`](#running-in-the-background) is stopped with `flightdeck service remove` (a process of it that is killed is started again by the service manager) and started again with `flightdeck service install` and the flags it had, which `flightdeck service status` shows first; `restore` says so when the service is what holds the database.

A start that upgrades the database's schema first keeps a copy of it in `backups/before-<release>-<time>.db`, the two latest, and the start-up block names it: with the release before, `flightdeck restore` of that copy is the way back. An older release does not start on a database a newer one has migrated; it says so, with the copies it finds. A backup from an older release is restored as it is, and the next start migrates it forward.

**In the image** the data dir is `/data`, on the container's volume. The commands below write `<container>` and `<volume>` for their names: `flightdeck` and `flightdeck` with the README's `docker run`, `flightdeck-flightdeck-1` and `flightdeck_data` under Compose, and otherwise what `docker ps -a` and `docker inspect -f '{{range .Mounts}}{{.Name}}{{end}}' <container>` print. A backup runs in the running container, onto its volume, and `docker cp` copies it out:

```bash
docker exec <container> flightdeck backup
docker cp <container>:/data/backups/flightdeck-<time>.db .
```

A restore needs the container stopped, and runs the image's binary in a container of its own on the volume, as the image's user (uid 65532), so the database keeps the owner the server needs; use the image tag the container runs. A backup already on the volume, in `/data/backups/`, is restored from there:

```bash
docker stop <container>
docker run --rm -v <volume>:/data flightdeckhq/flightdeck restore /data/backups/flightdeck-<time>.db
docker start <container>
```

A backup from outside (one `docker cp` took out is yours, mode 0600, which uid 65532 cannot read) goes onto the volume first, owned by that user, with the backup in the current directory:

```bash
docker run --rm -v <volume>:/data -v "$PWD":/backup:ro alpine:3 install -D -o 65532 -g 65532 -m 600 /backup/flightdeck-<time>.db /data/backups/flightdeck-<time>.db
```

and is then restored from `/data/backups/` as above.

**On Kubernetes** `kubectl exec <pod> -- flightdeck backup` writes a checked copy onto the pod's own claim, which covers a bad upgrade but not the loss of the claim. The image has no `tar`, which `kubectl cp` needs, so a copy cannot be taken out of a flightdeck pod: scale the StatefulSet to 0 and copy `flightdeck/flightdeck.db` (or a file in `flightdeck/backups/`) on the claim (`kubectl get pvc` lists it: `data-<release>-flightdeck-0` for a release whose name contains `flightdeck`; the files are owned by uid 65532) through a one-off pod that mounts it, as for `secrets.json` above, take a snapshot of the claim where its storage class supports one, or run the chart on Postgres and use `pg_dump`.

### Postgres

Back up with `pg_dump`, of the server's major version or newer, while Flightdeck runs:

```bash
pg_dump --no-owner -d '<database url>' > flightdeck.sql
```

To restore, load the dump into a new, empty database beside the current one, in one transaction, so that a load that fails leaves nothing half-loaded. `<restore url>` is `<database url>` with its database name changed to `flightdeck_restore`; `CREATE DATABASE` needs the `CREATEDB` privilege, which a managed Postgres's role often lacks (create the database in the provider's console then):

```bash
psql -d '<database url>' -c 'CREATE DATABASE flightdeck_restore'
psql -v ON_ERROR_STOP=1 -1 -d '<restore url>' < flightdeck.sql
```

Only when the load exits 0 (psql exits non-zero on the first error and loads nothing), stop Flightdeck and start it with `--database-url '<restore url>'`. It migrates a dump from an older release forward, and the old database stays as it was until you drop it.

Under Compose with `docker-compose.postgres.yml`, Postgres is not published on the host and the URL in the file names the `postgres` service and the database `flightdeck`, so the commands run in that container and the restore swaps the database names. Back up while Flightdeck runs:

```bash
docker compose -f docker/docker-compose.yml -f docker/docker-compose.postgres.yml exec -T postgres pg_dump --no-owner -U flightdeck flightdeck > flightdeck.sql
```

To restore, load the dump into a new database:

```bash
docker compose -f docker/docker-compose.yml -f docker/docker-compose.postgres.yml exec -T postgres psql -U flightdeck -d postgres -c 'CREATE DATABASE flightdeck_restore'
docker compose -f docker/docker-compose.yml -f docker/docker-compose.postgres.yml exec -T postgres psql -v ON_ERROR_STOP=1 -1 -U flightdeck -d flightdeck_restore < flightdeck.sql
```

Only when the load exits 0 (after a failed one, `flightdeck_restore` is there but empty: drop it and run both commands again), stop Flightdeck and swap the two names in one transaction, which renames both or neither, then start it:

```bash
docker compose -f docker/docker-compose.yml -f docker/docker-compose.postgres.yml stop flightdeck
docker compose -f docker/docker-compose.yml -f docker/docker-compose.postgres.yml exec -T postgres psql -v ON_ERROR_STOP=1 -1 -U flightdeck -d postgres -c 'ALTER DATABASE flightdeck RENAME TO flightdeck_before_restore' -c 'ALTER DATABASE flightdeck_restore RENAME TO flightdeck'
docker compose -f docker/docker-compose.yml -f docker/docker-compose.postgres.yml start flightdeck
```

The swap refuses while Flightdeck is still connected to the database, and `flightdeck_before_restore` keeps the database as it was until you drop it.
