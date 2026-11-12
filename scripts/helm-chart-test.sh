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
# the pods would refuse at start.
#
# Usage: scripts/helm-chart-test.sh [chart dir]   (default: helm/)
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

# render <name> [helm args...]: the chart rendered to $OUT/<name>.yaml.
render() {
  local name="$1"
  shift
  helm template flightdeck "$CHART" "$@" >"$OUT/$name.yaml" 2>"$OUT/$name.err" ||
    { cat "$OUT/$name.err" >&2; fail "$name: the render failed for: $*"; }
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

helm lint "$CHART"

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

echo "helm chart: $checks checks passed"
