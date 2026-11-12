# Self-hosting: Compose, Helm and backups

The [README](../README.md#self-hosting) has the one-line form of every way to run Flightdeck for a team: the binary with `--domain` or `--database-url`, the Docker image, Compose and Helm. This page is the detail for Compose and Helm (what each starts, where the token is, the event stream's retention, the chart's values, the upgrade notes) and for backups. [ARCHITECTURE.md](../ARCHITECTURE.md) ("Deployment") lists every flag and variable of the binary.

Flightdeck is self-hosted. Two deployment targets are supported, both running the one `flightdeckhq/flightdeck` image: Docker Compose (single host) and a Helm chart for Kubernetes.

## Prerequisites

- Docker Engine 28+ with Compose v2 (`docker compose version` reports `v2.x`), or a Kubernetes 1.25+ cluster with Helm 3.
- For TLS from the binary: a DNS A/AAAA record for the host (e.g. `flightdeck.example.com`) and ports 80 and 443 reachable from the public internet.

## Docker Compose

```bash
git clone https://github.com/flightdeckhq/flightdeck
cd flightdeck
docker compose -f docker/docker-compose.yml up -d
```

That is one container: the database is a SQLite file on the `flightdeck_data` volume, and the dashboard is at `http://localhost:4000`. The first start mints the access token, since the seed `tok_dev` token is refused off loopback; `/runtime-config.json` on that address returns it, and the start-up block in the container's log carries it on that start. The port is published on `127.0.0.1` because whoever can reach it can read that token: `FLIGHTDECK_PUBLISH_HOST` publishes it wider, behind a firewall or a proxy that authenticates. The header of [`docker/docker-compose.yml`](../docker/docker-compose.yml) lists every variable, including `FLIGHTDECK_DOMAIN` for TLS from the binary (a Let's Encrypt certificate, 80 redirecting to 443); [`docker/docker-compose.postgres.yml`](../docker/docker-compose.postgres.yml), layered on it, runs a Postgres instead of SQLite and requires `POSTGRES_PASSWORD`. Both set `restart: unless-stopped` and keep their data on named volumes.

The `FLIGHTDECK` NATS stream that carries events from ingestion to the workers keeps them for 72 hours, up to 5 GiB, then removes the oldest (`FLIGHTDECK_NATS_STREAM_MAX_AGE_HOURS`, `FLIGHTDECK_NATS_STREAM_MAX_SIZE_MIB` in `docker/.env`). The limits remove events whether or not the workers have processed them, so if the workers are down for longer than 72 hours, or fall more than 5 GiB behind, the oldest unprocessed events are lost; the workers log how many at their next start. To roll back to a release before the stream was bounded, first run `nats stream edit FLIGHTDECK --max-age=0 --max-bytes=-1 --discard=old --replicas=1 --force` (with `-s <your NATS URL>`), which restores unbounded retention; the earlier ingestion and workers do not start on the bounded stream.

Reach the dashboard at `http://localhost:4000/` (or `https://flightdeck.example.com/`). Go to **Settings → Access tokens → Create** to mint a token for your agents. The token's plaintext is shown once at creation; copy it into your secret store before closing the modal.

Point an agent:

```bash
export FLIGHTDECK_SERVER="https://flightdeck.example.com/ingest"
export FLIGHTDECK_TOKEN="ftd_..."
```

The dashboard fetches its bearer token at runtime from `/runtime-config.json`, which the binary answers from the token it keeps in `/data/secrets.json`; nothing is baked into the bundle.

## Kubernetes (Helm)

```bash
helm install flightdeck helm/ --namespace flightdeck --create-namespace
```

With the default values the chart runs one pod and nothing else: the database is a SQLite file and the bus is embedded, both on the pod's own volume. The notes `helm install` prints say how to open the dashboard and read the token. `postgres.enabled=true` with `postgres.password` runs the chart's own single-instance Postgres StatefulSet instead (fine for small deployments, not HA, not backed up), and `postgres.externalUrl` uses a Postgres you run.

Several pods need a database and a bus they share, so the render refuses more than one replica (or the HPA) without a Postgres, and without a NATS: the chart then runs its own NATS cluster, which needs `nats.auth.token`, unless `nats.externalUrl` names one. [`helm/values.prod.yaml`](../helm/values.prod.yaml) is that shape (three replicas behind an HPA, an Ingress), to be given `postgres.externalUrl` and `nats.auth.token`. Each pod opens at most 80 Postgres connections; the chart sizes its own Postgres for that, and an external one needs `max_connections` for 80 per pod or a pooler. With more than one NATS server the servers form a cluster, so events published on any of them reach the workers. On a cluster of 3 or more servers the `FLIGHTDECK` JetStream stream keeps a copy on 3 of them, so it survives the loss of one. The token may contain only letters, digits and `. _ ~ -` because it is placed in NATS URLs (`openssl rand -hex 32` works); with more than one NATS replica the cluster routes authenticate with it too.

**Upgrading a release of an earlier chart**: set `postgres.enabled=true` (with the same `postgres.password`) to stay on the chart's Postgres, which earlier charts ran by default; without it the pods start on an empty SQLite database. The `api.*`, `ingestion.*`, `workers.*` and `dashboard.*` values no longer exist; `flightdeck.*` replaces them.

**Upgrading a v0.5.3 install with `nats.replicas` above 1** (the default is 3): the NATS StatefulSet's pod start policy changes, which Kubernetes does not allow in place. Scale ingestion to zero, give the workers a minute to drain, then run `kubectl delete statefulset <release>-flightdeck-nats` (the data volumes stay) before `helm upgrade`. On first start the clustered servers discard the old per-server streams and ingestion recreates the stream, so any event still on the bus at that point is dropped. A one-replica install upgrades in place and keeps its stream.

The chart is at `version` 0.8.0 with `appVersion` 0.8.0; the default `image.tag` is `v0.8.0`. See [`helm/values.yaml`](../helm/values.yaml) for the full schema, including replicas, HPA bounds, ingress, resources, and security contexts.

| Key | Default | Description |
|---|---|---|
| `image.tag` | `v0.8.0` | Tag of the `flightdeckhq/flightdeck` image. |
| `flightdeck.replicas` | `1` | Pod count. Above 1 needs Postgres and a shared NATS. HPA overrides at runtime when enabled. |
| `flightdeck.hpa.enabled` | `false` | Enable the HorizontalPodAutoscaler for the pods. |
| `flightdeck.data.size` | `10Gi` | PVC size of each pod's data dir (the SQLite database, the embedded bus store, the minted token). |
| `flightdeck.corsOrigin` | *(empty)* | `Access-Control-Allow-Origin` for the query API; empty keeps `*`. Lock down in prod. |
| `postgres.enabled` | `false` | Run the chart's single-instance Postgres StatefulSet; needs `postgres.password`. |
| `postgres.externalUrl` | *(empty)* | A Postgres you run. When set, the bundled StatefulSet is not rendered. |
| `postgres.maxConnections` | *(empty)* | `max_connections` of the bundled Postgres. Empty: 80 per pod the chart may run, plus 20. |
| `postgres.storage.size` | `20Gi` | PVC size for the bundled StatefulSet. |
| `nats.enabled` | *(empty)* | Run the chart's NATS cluster. Empty: exactly when the chart runs more than one pod. |
| `nats.externalUrl` | *(empty)* | A NATS server you run, for the pods to share instead. |
| `nats.replicas` | `3` | NATS StatefulSet replica count; more than one forms a NATS cluster. |
| `nats.auth.token` | *(empty)* | Client token for the event bus. Required when the chart runs its NATS cluster. |
| `nats.jetstream.fileStore.size` | `10Gi` | PVC size per NATS replica. |
| `nats.jetstream.stream.maxAgeHours` | `72` | How long the `FLIGHTDECK` stream keeps an event, processed or not. Unprocessed events older than this are lost. |
| `nats.jetstream.stream.maxSizeMiB` | `5120` | Most the stream stores on each NATS server; at the limit the oldest events go. The render fails above 75% of `fileStore.size`; keep it well under (`values.prod.yaml`: 30720 for 50Gi). |
| `nats.jetstream.stream.replicas` | *(empty)* | Servers holding a copy of the stream. Empty: 3 when `nats.replicas` is 3 or more, else 1. At most `nats.replicas` and 5, and not 2. |
| `ingress.enabled` | `false` | Render an Ingress routing every path to the pods, which serve the dashboard, `/api` and `/ingest` themselves. |
| `ingress.tls` | `[]` | Pass through to the Ingress `tls:` stanza. |

## Backing up

Everything Flightdeck keeps is in its data dir (`--data-dir`, default `~/.flightdeck`; `/data` in the image): the SQLite database `flightdeck.db`, the message-bus store and `secrets.json`. With `--database-url postgres://…` the sessions and events are in that Postgres, backed up with its own tools, and the data dir holds only the bus store and the secrets.

While the binary runs, copy the SQLite database with SQLite itself:

```bash
sqlite3 ~/.flightdeck/flightdeck.db "VACUUM INTO '/backup/flightdeck.db'"
```

That (or the shell's `.backup` command) writes a consistent snapshot without stopping the binary. A plain file copy is only safe when the binary is stopped (a clean stop folds the write-ahead log into `flightdeck.db` and removes it); a copy taken while it runs must include `flightdeck.db-wal` and may still be torn.
