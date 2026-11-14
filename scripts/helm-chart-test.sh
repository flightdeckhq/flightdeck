#!/usr/bin/env bash
# Renders the Helm chart in every shape it supports and checks what
# comes out, and renders every combination it must refuse and checks
# the message. No cluster is needed: `helm lint` and `helm template`
# only. CI's Helm job runs it; `make -C helm test` runs it locally.
#
# The shapes (ARCHITECTURE.md, Deployment, Helm chart):
#   one pod on SQLite with the embedded bus (the default);
#   one pod on Postgres, the chart's own or an external one;
#   several pods on Postgres and a shared NATS, the chart's cluster or
#   an external one, with or without the HPA.
# The refusals: several pods on SQLite, several pods without a shared
# bus, a bundled Postgres without a password or with too few
# connections, a NATS cluster without a usable token, stream settings
# the pods would refuse at start, a secret given twice or where nothing
# reads it, a Secret reference that is not one, a secret in the
# plain-text ConfigMap, a host name the pods could not answer for, a
# bad image digest, a negative replica count, and an upgrade that would
# move the release to another database. Long release names render
# names Kubernetes accepts.
#
# Every successful render is also checked against the Kubernetes
# schemas with kubeconform when it is installed (CI installs it and
# sets REQUIRE_KUBECONFORM=1, which makes its absence a failure).
#
# Usage: scripts/helm-chart-test.sh [chart dir]   (default: helm/)
# Environment:
#   REQUIRE_KUBECONFORM   1: fail when kubeconform is not on PATH
#   KUBECONFORM_CACHE     a directory for the downloaded schemas
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CHART="${1:-$ROOT/helm}"
OUT="$(mktemp -d)"
trap 'rm -rf "$OUT"' EXIT

checks=0
fail() {
  echo "FAIL: $*" >&2
  exit 1
}

# The Kubernetes versions the renders are validated against: the one
# helm template assumes without --kube-version, and the oldest the
# chart's kubeVersion admits for the renders made with --kube-version.
SCHEMA_VERSION_DEFAULT=1.31.0

# render <name> [helm args...]: the chart rendered to $OUT/<name>.yaml,
# as the release $RELEASE (default flightdeck). A render made with
# --kube-version is validated against that version.
render() {
  local name="$1" kube="$SCHEMA_VERSION_DEFAULT" arg prev=""
  shift
  helm template "${RELEASE:-flightdeck}" "$CHART" "$@" >"$OUT/$name.yaml" 2>"$OUT/$name.err" ||
    { cat "$OUT/$name.err" >&2; fail "$name: the render failed for: $*"; }
  for arg in "$@"; do
    [ "$prev" != --kube-version ] || kube="${arg#v}"
    prev="$arg"
  done
  echo "$name $kube" >>"$OUT/renders.list"
}

# has <name> <extended regex>: the rendered output has a matching line.
has() {
  checks=$((checks + 1))
  grep -Eq -- "$2" "$OUT/$1.yaml" || fail "$1: no line matches: $2"
}

# lacks <name> <extended regex>: no line of the rendered output matches.
lacks() {
  checks=$((checks + 1))
  if grep -Eq -- "$2" "$OUT/$1.yaml"; then
    grep -En -- "$2" "$OUT/$1.yaml" >&2
    fail "$1: a line matches: $2"
  fi
}

# count <name> <extended regex> <n>: exactly n lines match.
count() {
  local got
  checks=$((checks + 1))
  got="$(grep -Ec -- "$2" "$OUT/$1.yaml" || true)"
  [ "$got" = "$3" ] || fail "$1: $got lines match '$2', want $3"
}

# refuse <message> [helm args...]: the render fails and says why.
refuse() {
  local msg="$1"
  shift
  checks=$((checks + 1))
  if helm template flightdeck "$CHART" "$@" >"$OUT/refused.yaml" 2>"$OUT/refused.err"; then
    fail "the render succeeded, want a refusal with '$msg', for: $*"
  fi
  grep -q -- "$msg" "$OUT/refused.err" ||
    { cat "$OUT/refused.err" >&2; fail "want the refusal to say '$msg' for: $*"; }
}

PG=(--set postgres.enabled=true --set postgres.password=ci-test-password)
NATS_TOKEN=(--set nats.auth.token=ci-test-nats-token)
EXTERNAL_PG=(--set 'postgres.externalUrl=postgres://u:p@db.example.com:5432/d?sslmode=require')

helm lint --strict "$CHART"

# --- One pod on SQLite: the default -----------------------------------------
render default
count default '^kind: StatefulSet$' 1
has default '^  name: flightdeck-flightdeck$'
has default '^  replicas: 1$'
has default '^          image: docker.io/flightdeckhq/flightdeck:v'
has default '^          command: \["/usr/local/bin/flightdeck"\]$'
has default '^            - ":4000"$'
# The data dir is a directory inside the volume, which the binary
# creates 0700 whatever mode the storage class gives the volume's root.
has default '^            - "/data/flightdeck"$'
has default '^            - "--metrics"$'
# Every pod has a volume of its own for the SQLite file, the bus store
# and secrets.json.
has default '^  volumeClaimTemplates:$'
has default '^              mountPath: /data$'
has default '^              mountPath: /tmp$'
has default '^        runAsUser: 65532$'
# Without it the kubelet widens secrets.json at every mount and the
# binary refuses to start a second time.
has default '^        fsGroupChangePolicy: OnRootMismatch$'
has default '^            readOnlyRootFilesystem: true$'
has default '^      terminationGracePeriodSeconds: 75$'
has default '^              path: /ingest/health$'
has default '^              path: /api/health$'
# No database URL and no bus URL: the binary's own defaults apply.
lacks default 'FLIGHTDECK_DATABASE_URL'
lacks default 'FLIGHTDECK_NATS_URL'
lacks default 'POSTGRES_PASSWORD'
lacks default '^kind: NetworkPolicy$'
lacks default '^kind: HorizontalPodAutoscaler$'
lacks default '^kind: Ingress$'
# The embedded bus holds one copy of the stream.
has default '^  FLIGHTDECK_NATS_STREAM_MAX_AGE_HOURS: "72"$'
has default '^  FLIGHTDECK_NATS_STREAM_MAX_SIZE_MIB: "5120"$'
has default '^  FLIGHTDECK_NATS_STREAM_REPLICAS: "1"$'
# The metrics ports are on the headless metrics Service only.
has default '^  name: flightdeck-flightdeck-metrics$'
count default '^      port: 9102$' 1
# What the retired per-service chart set, and nothing reads.
lacks default 'FLIGHTDECK_MIGRATIONS_DIR|FLIGHTDECK_JWT_SECRET|FLIGHTDECK_ADMIN_|FLIGHTDECK_POSTGRES_URL|FLIGHTDECK_ENV'

render no-metrics --set flightdeck.metrics.enabled=false
lacks no-metrics '"--metrics"'
lacks no-metrics '9102'

# --- One pod on Postgres ----------------------------------------------------
render one-bundled "${PG[@]}"
count one-bundled '^kind: StatefulSet$' 2
has one-bundled '^  name: flightdeck-postgres$'
has one-bundled '^  FLIGHTDECK_DATABASE_URL: "postgres://flightdeck:ci-test-password@flightdeck-postgres:5432/flightdeck\?sslmode=disable"$'
# 80 connections for the one pod and 20 for everything else.
has one-bundled '^            - "max_connections=100"$'
count one-bundled '^kind: NetworkPolicy$' 1
lacks one-bundled 'FLIGHTDECK_NATS_URL'
lacks one-bundled '^  name: flightdeck-nats$'

render encoded --set postgres.enabled=true --set 'postgres.password=p@ss w+rd/x'
has encoded 'postgres://flightdeck:p%40ss%20w%2Brd%2Fx@'

render one-external "${EXTERNAL_PG[@]}"
count one-external '^kind: StatefulSet$' 1
has one-external '^  FLIGHTDECK_DATABASE_URL: "postgres://u:p@db.example.com:5432/d\?sslmode=require"$'
lacks one-external 'POSTGRES_PASSWORD'
lacks one-external '^kind: NetworkPolicy$'
# externalUrl wins over enabled: no bundled server either way.
render external-wins "${EXTERNAL_PG[@]}" --set postgres.enabled=true
count external-wins '^kind: StatefulSet$' 1

# --- Several pods: Postgres and a shared NATS ----------------------------------
render three "${PG[@]}" "${NATS_TOKEN[@]}" --set flightdeck.replicas=3
count three '^kind: StatefulSet$' 3
has three '^  replicas: 3$'
has three '^  name: flightdeck-nats$'
has three '^  FLIGHTDECK_NATS_URL: "nats://ci-test-nats-token@flightdeck-nats-client:4222"$'
has three '^  FLIGHTDECK_NATS_STREAM_REPLICAS: "3"$'
# 80 for each of the three pods and 20 for everything else.
has three '^            - "max_connections=260"$'
count three '^kind: NetworkPolicy$' 2
has three '^  podManagementPolicy: Parallel$'

render three-external "${EXTERNAL_PG[@]}" --set flightdeck.replicas=3 \
  --set 'nats.externalUrl=nats://tok@nats.example.com:4222'
count three-external '^kind: StatefulSet$' 1
has three-external '^  FLIGHTDECK_NATS_URL: "nats://tok@nats.example.com:4222"$'
lacks three-external 'FLIGHTDECK_NATS_TOKEN'
has three-external '^  FLIGHTDECK_NATS_STREAM_REPLICAS: "1"$'
lacks three-external '^kind: NetworkPolicy$'

render hpa "${PG[@]}" "${NATS_TOKEN[@]}" --set flightdeck.hpa.enabled=true --set flightdeck.hpa.maxReplicas=10
count hpa '^kind: HorizontalPodAutoscaler$' 1
has hpa '^    kind: StatefulSet$'
has hpa '^  maxReplicas: 10$'
# The HPA may run ten pods, and owns the replica count: the flightdeck
# StatefulSet states none.
has hpa '^            - "max_connections=820"$'
render hpa-statefulset "${PG[@]}" "${NATS_TOKEN[@]}" --set flightdeck.hpa.enabled=true \
  --show-only templates/flightdeck/statefulset.yaml
lacks hpa-statefulset '^  replicas:'

render connections "${PG[@]}" "${NATS_TOKEN[@]}" --set flightdeck.replicas=3 --set postgres.maxConnections=500
has connections '^            - "max_connections=500"$'

# The three images follow image.registry, an empty one included.
has three '^          image: "docker.io/nats:'
has three '^          image: "docker.io/postgres:'
render no-registry "${PG[@]}" "${NATS_TOKEN[@]}" --set flightdeck.replicas=3 --set image.registry=
has no-registry '^          image: flightdeckhq/flightdeck:v'
has no-registry '^          image: "nats:'
has no-registry '^          image: "postgres:'
lacks no-registry 'image: "?/'

# One pod may use the cluster too.
render one-cluster "${NATS_TOKEN[@]}" --set nats.enabled=true
has one-cluster '^  name: flightdeck-nats$'
has one-cluster '^  FLIGHTDECK_NATS_URL: "nats://ci-test-nats-token@flightdeck-nats-client:4222"$'
lacks one-cluster 'FLIGHTDECK_DATABASE_URL'

render prod -f "$CHART/values.prod.yaml" "${EXTERNAL_PG[@]}" "${NATS_TOKEN[@]}"
count prod '^kind: Ingress$' 1
count prod '^kind: HorizontalPodAutoscaler$' 1
has prod '^  FLIGHTDECK_NATS_STREAM_MAX_SIZE_MIB: "30720"$'
has prod '^  FLIGHTDECK_CORS_ORIGIN: "https://flightdeck.example.com"$'
has prod '^                name: flightdeck-flightdeck$'

# --- What several pods need ----------------------------------------------------
refuse "needs a Postgres database" --set flightdeck.replicas=2
refuse "needs a Postgres database" --set flightdeck.replicas=2 "${NATS_TOKEN[@]}" --set nats.enabled=true
refuse "needs a Postgres database" --set flightdeck.hpa.enabled=true
refuse "needs a Postgres database" -f "$CHART/values.prod.yaml" "${NATS_TOKEN[@]}"
refuse "several pods need one shared bus" "${PG[@]}" --set flightdeck.replicas=2 --set nats.enabled=false
refuse "several pods need one shared bus" "${EXTERNAL_PG[@]}" --set flightdeck.hpa.enabled=true --set nats.enabled=false
refuse "nats.auth.token must be set" "${PG[@]}" --set flightdeck.replicas=2
refuse "nats.auth.token may contain only" "${PG[@]}" --set flightdeck.replicas=2 --set 'nats.auth.token=a/b@c'
refuse "are both set" "${PG[@]}" --set nats.enabled=true --set 'nats.externalUrl=nats://tok@nats.example.com:4222'
refuse "postgres.password must be set" --set postgres.enabled=true
refuse "is below the 260" "${PG[@]}" "${NATS_TOKEN[@]}" --set flightdeck.replicas=3 --set postgres.maxConnections=100
refuse "is below the 100" "${PG[@]}" --set postgres.maxConnections=50

# --- The FLIGHTDECK stream's settings ---------------------------------------
stream() {
  local name="$1"
  shift
  render "$name" "${PG[@]}" "${NATS_TOKEN[@]}" --set flightdeck.replicas=2 "$@"
}
stream stream-one --set nats.replicas=1
has stream-one '^  FLIGHTDECK_NATS_STREAM_REPLICAS: "1"$'
stream stream-two --set nats.replicas=2
has stream-two '^  FLIGHTDECK_NATS_STREAM_REPLICAS: "1"$'
stream stream-five --set nats.replicas=5
has stream-five '^  FLIGHTDECK_NATS_STREAM_REPLICAS: "3"$'
stream stream-five-set --set nats.replicas=5 --set nats.jetstream.stream.replicas=5
has stream-five-set '^  FLIGHTDECK_NATS_STREAM_REPLICAS: "5"$'
stream stream-size --set nats.jetstream.stream.maxSizeMiB=7680
has stream-size '^  FLIGHTDECK_NATS_STREAM_MAX_SIZE_MIB: "7680"$'
CLUSTER=("${PG[@]}" "${NATS_TOKEN[@]}" --set flightdeck.replicas=2)
refuse "must not exceed nats.replicas" "${CLUSTER[@]}" --set nats.replicas=1 --set nats.jetstream.stream.replicas=3
refuse "must be between 1 and 5" "${CLUSTER[@]}" --set nats.replicas=7 --set nats.jetstream.stream.replicas=6
refuse "must not be 2" "${CLUSTER[@]}" --set nats.jetstream.stream.replicas=2
refuse "at most 75% of nats.jetstream.fileStore.size" "${CLUSTER[@]}" --set nats.jetstream.stream.maxSizeMiB=7681
refuse "at most 75% of nats.jetstream.fileStore.size" "${CLUSTER[@]}" \
  --set nats.jetstream.fileStore.size=50Gi --set nats.jetstream.stream.maxSizeMiB=38401
refuse "maxAgeHours must be at least 1" --set nats.jetstream.stream.maxAgeHours=0
refuse "maxSizeMiB must be at least 64" --set nats.jetstream.stream.maxSizeMiB=10
# On the embedded bus the store shares the pod's volume, and the bus is
# one server.
refuse "at most 75% of flightdeck.data.size" --set nats.jetstream.stream.maxSizeMiB=7681
refuse "its embedded bus, which is one server" --set nats.jetstream.stream.replicas=3
render stream-embedded --set flightdeck.data.size=20Gi --set nats.jetstream.stream.maxSizeMiB=15360
has stream-embedded '^  FLIGHTDECK_NATS_STREAM_MAX_SIZE_MIB: "15360"$'
# An external NATS has a volume the chart cannot see: no size check.
render stream-external "${EXTERNAL_PG[@]}" --set 'nats.externalUrl=nats://tok@nats.example.com:4222' \
  --set nats.jetstream.stream.maxSizeMiB=20000 --set nats.jetstream.stream.replicas=3
has stream-external '^  FLIGHTDECK_NATS_STREAM_REPLICAS: "3"$'

# The pods read the ConfigMap and the Secret at start only, so a change
# to either must roll them: the stream settings, and above all the
# database and the bus. A release that moves from SQLite to Postgres
# must not leave the running pod on its SQLite file beside new pods on
# Postgres.
checksum() { grep "checksum/$2" "$OUT/$1.yaml"; }
differs() {
  checks=$((checks + 1))
  [ "$(checksum "$1" "$3")" != "$(checksum "$2" "$3")" ] ||
    fail "the pod annotation checksum/$3 must differ between $1 and $2"
}
same() {
  checks=$((checks + 1))
  [ "$(checksum "$1" "$3")" = "$(checksum "$2" "$3")" ] ||
    fail "the pod annotation checksum/$3 must not differ between $1 and $2"
}
render sum-a
render sum-b --set nats.jetstream.stream.maxAgeHours=24
differs sum-a sum-b config
same sum-a sum-b secret
differs default one-bundled secret
differs default one-external secret
differs one-bundled three secret
render sum-password --set postgres.enabled=true --set postgres.password=another-password
differs one-bundled sum-password secret

# --- Security contexts -------------------------------------------------------
# Every pod runs under the runtime's default seccomp profile; the
# bundled Postgres and NATS run read-only, Postgres with emptyDirs for
# its socket directory and /tmp, and keep fsGroup off every file.
count three '^          type: RuntimeDefault$' 3
count three '^        fsGroupChangePolicy: OnRootMismatch$' 3
count three '^            readOnlyRootFilesystem: true$' 3
has three '^              mountPath: /var/run/postgresql$'
count three '^              mountPath: /tmp$' 2

# --- Claims ---------------------------------------------------------------------
# Retain on delete and on scale-in, stated on every StatefulSet where
# the field exists (Kubernetes 1.27 and later).
count three '^  persistentVolumeClaimRetentionPolicy:$' 3
count three '^    whenDeleted: Retain$' 3
count three '^    whenScaled: Retain$' 3
render kube-126 "${PG[@]}" "${NATS_TOKEN[@]}" --set flightdeck.replicas=3 --kube-version 1.26.0
lacks kube-126 'persistentVolumeClaimRetentionPolicy'

# --- Secrets from the operator's own Secrets --------------------------------
# The bundled Postgres's password and the NATS token from Secrets: the
# chart's Secret carries neither, nor a URL built from them; the pods
# build the URLs from env entries read from those Secrets.
render secret-refs --set postgres.enabled=true --set postgres.passwordSecret.name=pg-creds \
  --set flightdeck.replicas=2 --set nats.auth.tokenSecret.name=nats-creds --set nats.auth.tokenSecret.key=tok
lacks secret-refs '^  (POSTGRES_PASSWORD|FLIGHTDECK_DATABASE_URL|FLIGHTDECK_NATS_TOKEN|FLIGHTDECK_NATS_URL):'
has secret-refs '^  POSTGRES_USER: "flightdeck"$'
has secret-refs '^            - name: FD_POSTGRES_PASSWORD$'
has secret-refs '^              value: "postgres://flightdeck:\$\(FD_POSTGRES_PASSWORD\)@flightdeck-postgres:5432/flightdeck\?sslmode=disable"$'
has secret-refs '^            - name: FD_NATS_TOKEN$'
has secret-refs '^              value: "nats://\$\(FD_NATS_TOKEN\)@flightdeck-nats-client:4222"$'
# The Postgres and NATS pods read the same Secrets.
count secret-refs '^                  name: "pg-creds"$' 2
count secret-refs '^                  name: "nats-creds"$' 2
has secret-refs '^                  key: "tok"$'
lacks secret-refs 'key: "?(POSTGRES_PASSWORD|FLIGHTDECK_NATS_TOKEN)"?$'
# The external URLs from Secrets, read as they are.
render secret-urls --set postgres.externalUrlSecret.name=db --set flightdeck.replicas=2 \
  --set nats.externalUrlSecret.name=bus --set nats.externalUrlSecret.key=nats-url
lacks secret-urls '^  (FLIGHTDECK_DATABASE_URL|FLIGHTDECK_NATS_URL|POSTGRES_USER):'
has secret-urls '^            - name: FLIGHTDECK_DATABASE_URL$'
has secret-urls '^                  name: "db"$'
has secret-urls '^                  key: "url"$'
has secret-urls '^                  key: "nats-url"$'
count secret-urls '^kind: StatefulSet$' 1
has secret-urls '^    flightdeck/database: "postgres from Secret db, key url \(external\)"$'
# With values only, the flightdeck container has no env entry: the
# chart's Secret has all.
render three-flightdeck "${PG[@]}" "${NATS_TOKEN[@]}" --set flightdeck.replicas=3 \
  --show-only templates/flightdeck/statefulset.yaml
lacks three-flightdeck '^          env:$'
refuse "are both set: give the database URL once" "${EXTERNAL_PG[@]}" --set postgres.externalUrlSecret.name=db
refuse "are both set: give the password once" "${PG[@]}" --set postgres.passwordSecret.name=pg-creds
refuse "postgres.passwordSecret is set, but the chart runs no Postgres" --set postgres.passwordSecret.name=pg-creds
refuse "postgres.passwordSecret is set, but the chart runs no Postgres" "${EXTERNAL_PG[@]}" \
  --set postgres.enabled=true --set postgres.passwordSecret.name=pg-creds
refuse "postgres.passwordSecret.key must name" --set postgres.enabled=true \
  --set postgres.passwordSecret.name=pg-creds --set postgres.passwordSecret.key=
refuse "or postgres.passwordSecret.name" --set postgres.enabled=true
refuse "are both set: give the NATS URL once" "${EXTERNAL_PG[@]}" \
  --set 'nats.externalUrl=nats://tok@nats.example.com:4222' --set nats.externalUrlSecret.name=bus
refuse "are both set: give the token once" "${PG[@]}" "${NATS_TOKEN[@]}" --set flightdeck.replicas=2 \
  --set nats.auth.tokenSecret.name=nats-creds
refuse "nats.auth.tokenSecret is set, but the chart runs no NATS cluster" --set nats.auth.tokenSecret.name=nats-creds
refuse "nats.enabled=true and nats.externalUrl (or nats.externalUrlSecret)" "${PG[@]}" \
  --set nats.enabled=true --set nats.externalUrlSecret.name=bus
# A reference set to null is unset, as if never given; one that is not
# a map is refused by its path, without the value, which may be the
# secret itself given in the wrong place.
render ref-null --set postgres.externalUrlSecret=null --set nats.externalUrlSecret=null \
  --set nats.auth.tokenSecret=null --set flightdeck.metrics.networkPolicy=null
same default ref-null config
same default ref-null secret
lacks ref-null '^          env:$'
render ref-null-bundled "${PG[@]}" "${NATS_TOKEN[@]}" --set flightdeck.replicas=2 \
  --set postgres.passwordSecret=null --set nats.auth.tokenSecret=null
has ref-null-bundled '^  POSTGRES_PASSWORD: "ci-test-password"$'
has ref-null-bundled '^  FLIGHTDECK_NATS_TOKEN: "ci-test-nats-token"$'
render ref-null-external --set postgres.externalUrlSecret=null "${EXTERNAL_PG[@]}"
has ref-null-external '^    flightdeck/database: "postgres db.example.com:5432/d \(external\)"$'
for path in postgres.externalUrlSecret postgres.passwordSecret nats.externalUrlSecret nats.auth.tokenSecret \
  flightdeck.dashboardTokenSecret; do
  refuse "$path must be a Secret reference" --set "$path=postgres://u:hunter2@db.example.com/d"
  checks=$((checks + 1))
  if grep -q hunter2 "$OUT/refused.err"; then fail "the refusal for $path repeats the value"; fi
done
refuse "nats.auth must be a map, not a string" --set nats.auth=x

# --- The dashboard token from the operator's Secret -------------------------
# A file every pod reads, mounted read-only from the Secret, named by
# FLIGHTDECK_DASHBOARD_TOKEN_FILE; never the variable that carries the
# token, which would put it in the pod's environment.
render dashboard-token "${PG[@]}" "${NATS_TOKEN[@]}" --set flightdeck.replicas=3 \
  --set flightdeck.dashboardTokenSecret.name=fd-token
has dashboard-token '^            - name: FLIGHTDECK_DASHBOARD_TOKEN_FILE$'
has dashboard-token '^              value: "/etc/flightdeck/dashboard-token/token"$'
has dashboard-token '^            - name: dashboard-token$'
has dashboard-token '^              mountPath: /etc/flightdeck/dashboard-token$'
has dashboard-token '^              readOnly: true$'
has dashboard-token '^            secretName: "fd-token"$'
has dashboard-token '^            defaultMode: 0440$'
has dashboard-token '^              - key: "token"$'
has dashboard-token '^                path: token$'
lacks dashboard-token 'FLIGHTDECK_DASHBOARD_TOKEN(:|"?$)'
count dashboard-token '^        - name: dashboard-token$' 1
render dashboard-token-key --set flightdeck.dashboardTokenSecret.name=fd-token \
  --set flightdeck.dashboardTokenSecret.key=dashboard
has dashboard-token-key '^              - key: "dashboard"$'
# Unset or null: no file, no variable, no volume.
for r in default ref-null; do
  lacks "$r" 'DASHBOARD_TOKEN'
  lacks "$r" 'dashboard-token'
done
render dashboard-token-null --set flightdeck.dashboardTokenSecret=null
lacks dashboard-token-null 'DASHBOARD_TOKEN|dashboard-token'
refuse "flightdeck.dashboardTokenSecret.key must name" --set flightdeck.dashboardTokenSecret.name=fd-token \
  --set flightdeck.dashboardTokenSecret.key=
refuse "flightdeck.metrics.networkPolicy must be a map" --set flightdeck.metrics.networkPolicy=on

# --- Secrets in the plain-text ConfigMap, and its own keys ---------------------
# A name that reads like a secret, in any case: one of the words
# anywhere, the short ones as a word of the name.
for name in FLIGHTDECK_DATABASE_URL FLIGHTDECK_NATS_URL FLIGHTDECK_DASHBOARD_TOKEN FLIGHTDECK_POSTGRES_URL \
  FLIGHTDECK_JWT_SECRET FLIGHTDECK_ADMIN_PASSWORD SOME_PASSWORD flightdeck_nats_token db_url 'Db\.Passwd' \
  GITHUB_APITOKEN AWS_SECRET_ACCESS_KEY My-Api-Key SERVICE_DSN LDAP_URI MAIL_PASS SMTP_PWD GCP_CREDENTIALS \
  STRIPE_APIKEY KEY URL; do
  refuse "reads like a secret" --set "flightdeck.extraEnv.$name=x"
done
refuse "is not a name a ConfigMap can carry" --set 'flightdeck.extraEnv.A\ B=x'
# A name whose last word is FILE holds a path: it goes through, unless
# the chart sets it itself.
render extra-env-file --set flightdeck.extraEnv.FLIGHTDECK_DASHBOARD_TOKEN_FILE=/run/t \
  --set flightdeck.extraEnv.DB_PASSWORD_FILE=/run/p --set 'flightdeck.extraEnv.TLS_KEY\.FILE=/run/k'
has extra-env-file '^  "FLIGHTDECK_DASHBOARD_TOKEN_FILE": "/run/t"$'
has extra-env-file '^  "DB_PASSWORD_FILE": "/run/p"$'
has extra-env-file '^  "TLS_KEY.FILE": "/run/k"$'
refuse "is set by the chart from its own value" --set flightdeck.dashboardTokenSecret.name=fd-token \
  --set flightdeck.extraEnv.FLIGHTDECK_DASHBOARD_TOKEN_FILE=/run/t
refuse "reads like a secret" --set flightdeck.extraEnv.FLIGHTDECK_DASHBOARD_TOKEN_FILES=x
refuse "must be a string, a number or a boolean, not a map" --set flightdeck.extraEnv.LOG.LEVEL=x
refuse "is set by the chart from its own value" --set flightdeck.extraEnv.FLIGHTDECK_ALLOWED_HOSTS=x
refuse "is set by the chart from its own value" --set flightdeck.extraEnv.FLIGHTDECK_WORKER_POOL_SIZE=4
# The short words only as words: MONKEY has KEY, CURLY has URL.
render extra-env --set flightdeck.extraEnv.FLIGHTDECK_LOG_LEVEL=debug \
  --set flightdeck.extraEnv.FLIGHTDECK_PRICING_PATH=/etc/pricing.yaml --set flightdeck.extraEnv.MONKEY_CURLY=1 \
  --set 'flightdeck.extraEnvFrom[0].secretRef.name=flightdeck-extra'
has extra-env '^  "FLIGHTDECK_LOG_LEVEL": "debug"$'
has extra-env '^  "FLIGHTDECK_PRICING_PATH": "/etc/pricing.yaml"$'
has extra-env '^  "MONKEY_CURLY": "1"$'
has extra-env '^                name: flightdeck-extra$'

# --- FLIGHTDECK_ALLOWED_HOSTS ---------------------------------------------------
# The Service (short and qualified), every pod through the headless
# Service, localhost; in the release's namespace and cluster domain.
hosts() { sed -n 's/^  FLIGHTDECK_ALLOWED_HOSTS: "\(.*\)"$/\1/p' "$OUT/$1.yaml" | tr ',' '\n'; }
host() {
  checks=$((checks + 1))
  hosts "$1" | grep -qx -- "$2" || fail "$1: FLIGHTDECK_ALLOWED_HOSTS lacks $2 (has: $(hosts "$1" | tr '\n' ' '))"
}
no_host() {
  checks=$((checks + 1))
  if hosts "$1" | grep -qx -- "$2"; then fail "$1: FLIGHTDECK_ALLOWED_HOSTS has $2"; fi
}
for name in localhost flightdeck-flightdeck flightdeck-flightdeck.default flightdeck-flightdeck.default.svc \
  flightdeck-flightdeck.default.svc.cluster.local .flightdeck-flightdeck-headless \
  .flightdeck-flightdeck-headless.default .flightdeck-flightdeck-headless.default.svc \
  .flightdeck-flightdeck-headless.default.svc.cluster.local; do
  host default "$name"
done
# The Ingress names count only when the Ingress is rendered.
no_host default flightdeck.local
render hosts-ingress --namespace obs --set clusterDomain=k8s.example. --set ingress.enabled=true \
  --set ingress.host=Fd.Example.com --set 'ingress.tls[0].hosts[0]=*.tls.example.com' \
  --set 'ingress.tls[0].hosts[1]=fd.example.com' --set 'flightdeck.extraAllowedHosts[0]=fd.lb.example.net' \
  --set 'flightdeck.extraAllowedHosts[1]=.corp.example'
for name in fd.example.com .tls.example.com fd.lb.example.net .corp.example flightdeck-flightdeck.obs.svc.k8s.example \
  .flightdeck-flightdeck-headless.obs.svc.k8s.example; do
  host hosts-ingress "$name"
done
# One entry per name: fd.example.com is both the host and a TLS host.
count hosts-ingress 'fd\.example\.com,.*fd\.example\.com(,|")' 0
render hosts-any --set 'flightdeck.extraAllowedHosts[0]=*'
host hosts-any '*'
refuse "is not a host name the pods could answer for" --set 'flightdeck.extraAllowedHosts[0]=https://fd.example.com'
refuse "is not a host name the pods could answer for" --set 'flightdeck.extraAllowedHosts[0]=fd.example.com:443'
refuse "is not a host name the pods could answer for" --set ingress.enabled=true --set 'ingress.host=fd_example'

# --- Image digests --------------------------------------------------------------
DIGEST=sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef
render digests "${PG[@]}" "${NATS_TOKEN[@]}" --set flightdeck.replicas=2 --set "image.digest=$DIGEST" \
  --set "nats.image.digest=$DIGEST" --set "postgres.image.digest=$DIGEST"
has digests "^          image: docker.io/flightdeckhq/flightdeck@$DIGEST\$"
has digests "^          image: \"docker.io/nats@$DIGEST\"\$"
has digests "^          image: \"docker.io/postgres@$DIGEST\"\$"
lacks digests 'image: .*:v?[0-9][^@]*@'
refuse "image.digest must be sha256:" --set image.digest=latest
refuse "nats.image.digest must be sha256:" "${PG[@]}" "${NATS_TOKEN[@]}" --set flightdeck.replicas=2 \
  --set nats.image.digest=sha256:abc
refuse "postgres.image.digest must be sha256:" "${PG[@]}" --set "postgres.image.digest=${DIGEST^^}"

# --- Replicas ---------------------------------------------------------------------
refuse "flightdeck.replicas must be 0 or more" --set flightdeck.replicas=-1
render zero --set flightdeck.replicas=0
has zero '^  replicas: 0$'

# --- The metrics NetworkPolicy -----------------------------------------------------
render metrics-policy --set flightdeck.metrics.networkPolicy.enabled=true \
  --set 'flightdeck.metrics.networkPolicy.from[0].namespaceSelector.matchLabels.kubernetes\.io/metadata\.name=monitoring'
count metrics-policy '^kind: NetworkPolicy$' 1
has metrics-policy '^              kubernetes.io/metadata.name: monitoring$'
count metrics-policy '^          port: (9102|9103|9104)$' 3
# The port of the dashboard and the APIs stays open to everyone.
has metrics-policy '^    - ports:$'
has metrics-policy '^          port: 4000$'
refuse "needs flightdeck.metrics.networkPolicy.from" --set flightdeck.metrics.networkPolicy.enabled=true
render metrics-policy-off --set flightdeck.metrics.enabled=false --set flightdeck.metrics.networkPolicy.enabled=true
lacks metrics-policy-off '^kind: NetworkPolicy$'

# --- The database a release runs on ------------------------------------------------
has default '^    flightdeck/database: "sqlite \(each pod.s volume\)"$'
has one-bundled '^    flightdeck/database: "postgres flightdeck-postgres \(the chart.s\)"$'
# Host, port and database of an external Postgres; never its credentials.
has one-external '^    flightdeck/database: "postgres db.example.com:5432/d \(external\)"$'
lacks one-external 'flightdeck/database: .*u:p'
# The upgrade check itself reads the running StatefulSet with lookup,
# which has no cluster here. Its decision is a helper of its own; a
# copy of the chart with one more template calls it with the identity
# a running release would carry.
WRAP="$OUT/wrap"
cp -R "$CHART" "$WRAP"
cat >"$WRAP/templates/zz-database-change.yaml" <<'TPL'
{{- include "flightdeck.databaseChange" (dict "previous" .Values.testPrevious "current" (include "flightdeck.databaseIdentity" .) "allow" .Values.allowDatabaseChange) -}}
TPL
# helm template does not render NOTES.txt, and parses every file it
# renders as YAML, so the copy carries the notes as a define, emitted
# as one quoted value.
{ echo '{{- define "zz.notes" -}}'; cat "$CHART/templates/NOTES.txt"; echo '{{- end -}}'; } >"$WRAP/templates/_zz_notes.tpl"
cat >"$WRAP/templates/zz-notes.yaml" <<'TPL'
apiVersion: v1
kind: ConfigMap
metadata:
  name: zz-notes
data:
  notes: {{ include "zz.notes" . | quote }}
TPL
wrapped() { helm template flightdeck "$WRAP" "$@"; }
change_refused() {
  checks=$((checks + 1))
  if wrapped "$@" >"$OUT/wrap.yaml" 2>"$OUT/wrap.err"; then
    fail "an upgrade that changes the database rendered, want a refusal, for: $*"
  fi
  grep -q "the chart does not move data" "$OUT/wrap.err" || { cat "$OUT/wrap.err" >&2; fail "the refusal does not say why"; }
}
change_allowed() {
  checks=$((checks + 1))
  wrapped "$@" >"$OUT/wrap.yaml" 2>"$OUT/wrap.err" || { cat "$OUT/wrap.err" >&2; fail "the render failed for: $*"; }
}
change_refused --set 'testPrevious=sqlite (each pod'"'"'s volume)' "${PG[@]}"
change_refused --set 'testPrevious=postgres flightdeck-postgres (the chart'"'"'s)' "${EXTERNAL_PG[@]}"
change_refused --set 'testPrevious=postgres db.example.com:5432/d (external)' \
  --set 'postgres.externalUrl=postgres://u:p@other.example.com:5432/d'
# The same database (another password included), the flag, and a
# release that recorded nothing all go ahead.
change_allowed --set 'testPrevious=postgres db.example.com:5432/d (external)' \
  --set 'postgres.externalUrl=postgres://u:other@db.example.com:5432/d?sslmode=require'
change_allowed --set 'testPrevious=sqlite (each pod'"'"'s volume)' "${PG[@]}" --set allowDatabaseChange=true
change_allowed "${PG[@]}"
# The notes of an upgrade name the database and say the data stays.
wrapped --is-upgrade "${PG[@]}" --show-only templates/zz-notes.yaml >"$OUT/notes-upgrade.yaml"
has notes-upgrade 'now runs on postgres flightdeck-postgres \(the chart.s\)\.'
has notes-upgrade 'never moves data between databases'
wrapped "${PG[@]}" --show-only templates/zz-notes.yaml >"$OUT/notes-install.yaml"
lacks notes-install 'never moves data'
has notes-install 'Flightdeck is starting as the StatefulSet flightdeck-flightdeck'
has notes-install 'Database  Postgres \(the chart.s own StatefulSet\)'
has notes-install 'Each pod mints a token on its first start'
wrapped --set flightdeck.dashboardTokenSecret.name=fd-token --show-only templates/zz-notes.yaml >"$OUT/notes-token.yaml"
has notes-token 'Every pod serves the token in the Secret fd-token, key token'
lacks notes-token 'Each pod mints'
# A database and a bus from the operator's Secrets are outside the chart.
wrapped --set postgres.externalUrlSecret.name=db --set nats.externalUrlSecret.name=bus \
  --show-only templates/zz-notes.yaml >"$OUT/notes-secret-urls.yaml"
has notes-secret-urls 'Database  Postgres outside the chart'
has notes-secret-urls 'Bus       NATS outside the chart'

# --- Names -------------------------------------------------------------------------
# Helm takes a release name of up to 53 characters. Every name the
# chart builds must fit: 63 for any object (a DNS label for a Service),
# 52 for a StatefulSet, whose pods' controller-revision-hash label adds
# up to 11; no two objects of a kind may share one; and the pods answer
# for the names they are reached by.
FULL=("${PG[@]}" "${NATS_TOKEN[@]}" --set flightdeck.hpa.enabled=true --set ingress.enabled=true \
  --set flightdeck.metrics.networkPolicy.enabled=true \
  --set 'flightdeck.metrics.networkPolicy.from[0].podSelector.matchLabels.app=prometheus')
# names <render>: "<kind> <metadata.name>" of every object.
names() {
  awk '/^---/ { kind = "" } /^kind: / { kind = $2 } /^[^ #]/ { meta = ($0 ~ /^metadata:/) }
    meta && kind != "" && /^  name: / { gsub(/"/, "", $2); print kind, $2 }' "$OUT/$1.yaml"
}
names_fit() {
  local r="$1" bad
  checks=$((checks + 1))
  bad="$(names "$r" | awk 'length($2) > 63 || ($1 == "StatefulSet" && length($2) > 52)')"
  [ -z "$bad" ] || fail "$r: names too long: $bad"
  checks=$((checks + 1))
  bad="$(names "$r" | sort | uniq -d)"
  [ -z "$bad" ] || fail "$r: names used twice: $bad"
  # The flightdeck StatefulSet's headless Service is rendered, and its
  # pods' names are allowed; the HPA scales that StatefulSet.
  local headless sts
  headless="$(sed -n 's/^  serviceName: //p' "$OUT/$r.yaml" | grep -- '-headless$')"
  sts="$(names "$r" | awk '$1 == "StatefulSet" && $2 ~ /-flightd/ { print $2 }')"
  checks=$((checks + 1))
  names "$r" | grep -qx -- "Service $headless" || fail "$r: no Service $headless"
  host "$r" ".$headless"
  host "$r" ".$headless.default.svc.cluster.local"
  checks=$((checks + 1))
  [ "$(sed -n '/^  scaleTargetRef:/,/^  [a-z]/s/^    name: //p' "$OUT/$r.yaml")" = "$sts" ] ||
    fail "$r: the HPA does not scale the StatefulSet $sts"
}
RELEASE=observability-platform-production-eu-west-1-cluster-a render long "${FULL[@]}"
names_fit long
RELEASE=flightdeck-observability-production-eu-west-1-clstr-a render long-flightdeck "${FULL[@]}"
names_fit long-flightdeck
render long-override "${FULL[@]}" --set fullnameOverride=a-full-name-override-of-sixty-three-characters-for-the-test-x
names_fit long-override
# A base of 43 characters keeps every name an earlier chart gave it
# (its Postgres ran, at 52); only the flightdeck StatefulSet is cut.
BASE43=flightdeck-observability-prod-eu-west-1-clu
RELEASE=$BASE43 render base43 "${FULL[@]}"
names_fit base43
has base43 "^  name: $BASE43-postgres\$"
has base43 "^  name: $BASE43-nats\$"
has base43 "^  name: $BASE43-flightdeck\$"
has base43 "^  name: $BASE43-flightde\$"
has base43 "^  serviceName: $BASE43-flightdeck-headless\$"
# The default release keeps its names.
names_fit hpa
has hpa '^  name: flightdeck-flightdeck$'

# --- Schemas -----------------------------------------------------------------------
# Every successful render against the Kubernetes schemas: strict (an
# unknown field fails), at the version it was rendered for.
if command -v kubeconform >/dev/null 2>&1; then
  cache="${KUBECONFORM_CACHE:-$OUT/schemas}"
  mkdir -p "$cache"
  while read -r name version; do
    checks=$((checks + 1))
    kubeconform -strict -summary -cache "$cache" -kubernetes-version "$version" "$OUT/$name.yaml" \
      >"$OUT/kubeconform.out" 2>&1 || { cat "$OUT/kubeconform.out" >&2; fail "$name: kubeconform (Kubernetes $version)"; }
  done <"$OUT/renders.list"
  echo "kubeconform: $(wc -l <"$OUT/renders.list") renders valid ($(kubeconform -v))"
elif [ "${REQUIRE_KUBECONFORM:-0}" = 1 ]; then
  fail "kubeconform is not on PATH, and REQUIRE_KUBECONFORM=1"
else
  echo "kubeconform not installed: the renders were not checked against the schemas"
fi

echo "helm chart: $checks checks passed"
