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

**Secrets from your own Secrets.** `postgres.externalUrlSecret`, `postgres.passwordSecret`, `nats.externalUrlSecret` and `nats.auth.tokenSecret` take the `name` and `key` of a Secret you created, in place of `postgres.externalUrl`, `postgres.password`, `nats.externalUrl` and `nats.auth.token`, so nothing secret sits in a values file or in the Helm release. Give each secret once; the render refuses both forms. A password or token from a Secret goes into a URL as it is, so use letters, digits and `- . _ ~`. The pods read Secrets at start: after changing one, `kubectl rollout restart statefulset/<release>-flightdeck`. `flightdeck.extraEnv` is plain text in a ConfigMap, so it refuses a name that reads like a secret, in any case (one containing `PASSWORD`, `SECRET`, `TOKEN`, `CREDENTIAL` or `APIKEY`, or with `KEY`, `URL`, `URI`, `DSN`, `PASS` or `PWD` as a word); that guards against a slip and cannot find a secret under another name. `flightdeck.extraEnvFrom` takes a Secret of yours, or a ConfigMap for a refused name that is no secret; its keys override the chart's, and the chart does not see them. A name whose last word is `FILE` holds a path and goes through.

**The dashboard token.** `flightdeck.dashboardTokenSecret` names a Secret of yours that holds the dashboard token (`name`, and `key`, default `token`). The chart mounts that key read-only as a file in every pod and sets `FLIGHTDECK_DASHBOARD_TOKEN_FILE` to it, never `FLIGHTDECK_DASHBOARD_TOKEN`, which would put the token in the pod's environment. Every pod then serves that one token, however many replicas run, and it is known before the first start. It must be `ftd_` and 32 random lower-case hex digits, and a pod refuses to start on anything else: `kubectl create secret generic flightdeck-dashboard-token --from-literal=token="ftd_$(openssl rand -hex 16)"`. Without it each pod mints a token of its own on its first start; each is valid on every pod, since tokens are rows of the database the pods share, and Settings lists one `Bootstrap token` per pod. To rotate the supplied token, put the new one in the Secret, restart every pod (`kubectl rollout restart statefulset/<release>-flightdeck`: the pods read the file at start), then revoke the old one in Settings (`Supplied dashboard token (ftd_xxxx)`). The old one stays valid until you revoke it, so the pods not yet restarted keep working; revoked earlier, it is stored again by the next pod that starts with it.

**Changing the database.** The chart never moves data. An upgrade that changes the database (SQLite to Postgres, the chart's Postgres to an external one, one external Postgres to another) starts the pods on the new database as it is, and the old data stays where it was (a volume claim, or the other server). The chart records the database on the StatefulSet and refuses such an upgrade unless `allowDatabaseChange=true`; it cannot check a release installed by an earlier chart, or a render that cannot read the cluster (`helm template`, Argo CD). A URL from a Secret is recorded by the Secret's name and key, not what it holds: a Secret changed to point at another database is not seen, and moving the same database from `postgres.externalUrl` to `postgres.externalUrlSecret` is refused like a move (set `allowDatabaseChange=true` for that upgrade). So is a first install that failed and is retried with `helm upgrade --install` on another database: the failed attempt left its StatefulSet. The notes of every upgrade name the database the release runs on.

**Rotating the bundled Postgres's password.** Postgres takes `postgres.password` only when it creates its database, so a new value alone leaves the pods unable to connect, and the claim outlives `helm uninstall`, so a reinstall keeps the old password too. Change it in the database first, `kubectl exec -it <release>-postgres-0 -- psql -U flightdeck -d flightdeck -c '\password flightdeck'` (psql asks for it, so it stays off the command line), then upgrade with the new value (or update your Secret and restart the pods). A password given as `postgres.password` is hashed into the pods' `checksum/secret` annotation with the rest of the chart's Secret, so whoever can read pods can test guesses against it: use a random one (`openssl rand -hex 24`), or `postgres.passwordSecret`.

**Storage.** The sizes and storage classes of the claims (`flightdeck.data`, `postgres.storage`, `nats.jetstream.fileStore`) are fixed once installed: a StatefulSet's claim template cannot change, so `helm upgrade` fails on a change. To grow claims on a storage class that allows expansion, raise each claim (`kubectl patch pvc data-<release>-flightdeck-0 -p '{"spec":{"resources":{"requests":{"storage":"20Gi"}}}}'`), delete the StatefulSet but not its pods (`kubectl delete statefulset <release>-flightdeck --cascade=orphan`), then upgrade with the new size. Another storage class means moving the data yourself. Claims are kept on uninstall and when replicas are scaled in (the StatefulSets state `Retain` for both on Kubernetes 1.27 and later, and that is the behaviour before it too): delete them to delete the data.

**Host names.** The pods answer for the names they are reached by (`FLIGHTDECK_ALLOWED_HOSTS`): the Service and the headless Service in short and qualified forms, the Ingress host and TLS hosts, and `localhost` for a port-forward. Add other names (another Ingress, a LoadBalancer's DNS name) to `flightdeck.extraAllowedHosts`. A binary that checks the `Host` header refuses other names with 421; IP addresses, and so the probes, are always answered. `flightdeck.metrics.networkPolicy` (off by default) lets only the peers you name reach the metrics ports, which carry no auth.

**A pod that stops on `secrets.json` after a restore.** The binary refuses a `secrets.json` that anyone but its owner can read. A volume restored or cloned with wider modes stops the pod with that error in its log. Scale the StatefulSet to 0, make the file private from a one-off pod that mounts the claim as uid 65532 (the image has no shell, so a busybox pod: `chmod 0600 /data/flightdeck/secrets.json`), and scale back.

**Upgrading a release of an earlier chart**: set `postgres.enabled=true` (with the same `postgres.password`) to stay on the chart's Postgres, which earlier charts ran by default; without it the pods start on an empty SQLite database. The `api.*`, `ingestion.*`, `workers.*` and `dashboard.*` values no longer exist; `flightdeck.*` replaces them. A release whose base name (the release name, with `-flightdeck` when it lacks it, or `fullnameOverride`) is longer than 43 characters gets shorter names, its Postgres StatefulSet and claim included, so the upgraded release starts on a new, empty Postgres. Its NATS StatefulSet and claims (`<base>-nats`) are renamed too, which loses only the events still queued on the old bus. On the earlier chart that StatefulSet's name was over 52 characters, and Kubernetes creates its pods only while the revision's hash is short enough to keep the `controller-revision-hash` label within 63 (about one revision in four at a 44-character base, one in 43 at 45), so most such releases never ran it. If yours did, its data stays in the old claim, which the new release does not read: dump it before the upgrade, `kubectl exec <old base>-postgres-0 -- pg_dump -U flightdeck -d flightdeck --clean --if-exists > flightdeck.sql`, and after it scale the flightdeck StatefulSet to 0, load the dump in one transaction, so that a load that fails leaves nothing half-loaded, `kubectl exec -i <new base>-postgres-0 -- psql -v ON_ERROR_STOP=1 -1 -U flightdeck -d flightdeck < flightdeck.sql`, and scale back; the pods then migrate it forward. A release that set `postgres.user` or `postgres.database` uses those in place of `flightdeck` in both commands. `fullnameOverride` cannot keep the old name: it is cut to 43 too.

**Upgrading a v0.5.3 install with `nats.replicas` above 1** (the default is 3): the NATS StatefulSet's pod start policy changes, which Kubernetes does not allow in place. Scale ingestion to zero, give the workers a minute to drain, then run `kubectl delete statefulset <release>-flightdeck-nats` (the data volumes stay) before `helm upgrade`. On first start the clustered servers discard the old per-server streams and ingestion recreates the stream, so any event still on the bus at that point is dropped. A one-replica install upgrades in place and keeps its stream.

The chart is at `version` 0.8.0 with `appVersion` 0.8.0; the default `image.tag` is `v0.8.0`. See [`helm/values.yaml`](../helm/values.yaml) for the full schema, including replicas, HPA bounds, ingress, resources, and security contexts.

| Key | Default | Description |
|---|---|---|
| `image.tag` | `v0.8.0` | Tag of the `flightdeckhq/flightdeck` image. |
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

## Backing up

Everything Flightdeck keeps is in its data dir (`--data-dir`, default `~/.flightdeck`; `/data` in the image): the SQLite database `flightdeck.db`, the message-bus store and `secrets.json`. With `--database-url postgres://…` the sessions and events are in that Postgres, backed up with its own tools, and the data dir holds only the bus store and the secrets.

While the binary runs, copy the SQLite database with SQLite itself:

```bash
sqlite3 ~/.flightdeck/flightdeck.db "VACUUM INTO '/backup/flightdeck.db'"
```

That (or the shell's `.backup` command) writes a consistent snapshot without stopping the binary. A plain file copy is only safe when the binary is stopped (a clean stop folds the write-ahead log into `flightdeck.db` and removes it); a copy taken while it runs must include `flightdeck.db-wal` and may still be torn.
