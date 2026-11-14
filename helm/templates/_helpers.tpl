{{/*
Common helpers for the flightdeck chart.
*/}}

{{- define "flightdeck.name" -}}
{{- default .Chart.Name .Values.nameOverride | trunc 63 | trimSuffix "-" -}}
{{- end -}}

{{/*
The base of every resource name, at most 43 characters: the longest
name built on it, the headless Service <base>-flightdeck-headless, is
then 63, the most a Service name (a DNS label) may have. 43 also keeps
the names an earlier chart gave a release whose Postgres StatefulSet
ran, so an upgrade finds its volume claims.
*/}}
{{- define "flightdeck.fullname" -}}
{{- if .Values.fullnameOverride -}}
{{- .Values.fullnameOverride | trunc 43 | trimSuffix "-" -}}
{{- else -}}
{{- $name := default .Chart.Name .Values.nameOverride -}}
{{- if contains $name .Release.Name -}}
{{- .Release.Name | trunc 43 | trimSuffix "-" -}}
{{- else -}}
{{- printf "%s-%s" .Release.Name $name | trunc 43 | trimSuffix "-" -}}
{{- end -}}
{{- end -}}
{{- end -}}

{{- define "flightdeck.chart" -}}
{{- printf "%s-%s" .Chart.Name .Chart.Version | replace "+" "_" | trunc 63 | trimSuffix "-" -}}
{{- end -}}

{{/*
Component-scoped name: <release>-<component>
*/}}
{{- define "flightdeck.componentName" -}}
{{- printf "%s-%s" (include "flightdeck.fullname" .root) .component | trunc 63 | trimSuffix "-" -}}
{{- end -}}

{{/*
A StatefulSet's name, <release>-<component> cut to 52 characters: the
controller labels each pod with controller-revision-hash, the name
and up to 11 characters more, and a label value has at most 63. Only
the flightdeck StatefulSet of a 42- or 43-character base is cut.
*/}}
{{- define "flightdeck.statefulSetName" -}}
{{- include "flightdeck.componentName" . | trunc 52 | trimSuffix "-" -}}
{{- end -}}

{{/*
Common labels applied to every resource.
*/}}
{{- define "flightdeck.labels" -}}
helm.sh/chart: {{ include "flightdeck.chart" .root }}
app.kubernetes.io/name: {{ include "flightdeck.name" .root }}
app.kubernetes.io/instance: {{ .root.Release.Name }}
app.kubernetes.io/version: {{ .root.Chart.AppVersion | quote }}
app.kubernetes.io/managed-by: {{ .root.Release.Service }}
app.kubernetes.io/part-of: flightdeck
app.kubernetes.io/component: {{ .component }}
{{- end -}}

{{/*
Selector labels -- stable subset of common labels.
*/}}
{{- define "flightdeck.selectorLabels" -}}
app.kubernetes.io/name: {{ include "flightdeck.name" .root }}
app.kubernetes.io/instance: {{ .root.Release.Name }}
app.kubernetes.io/component: {{ .component }}
{{- end -}}

{{/*
Shared ConfigMap and Secret names.
*/}}
{{- define "flightdeck.configMapName" -}}
{{- printf "%s-config" (include "flightdeck.fullname" .) -}}
{{- end -}}

{{- define "flightdeck.secretName" -}}
{{- printf "%s-secret" (include "flightdeck.fullname" .) -}}
{{- end -}}

{{/*
In-cluster hostnames.
*/}}
{{- define "flightdeck.postgresServiceName" -}}
{{- printf "%s-postgres" (include "flightdeck.fullname" .) -}}
{{- end -}}

{{- define "flightdeck.natsServiceName" -}}
{{- printf "%s-nats" (include "flightdeck.fullname" .) -}}
{{- end -}}

{{/*
Client Service for the event bus. It lists ready pods only, unlike the
headless natsServiceName (which also lists starting pods so the cluster
routes can form).
*/}}
{{- define "flightdeck.natsClientServiceName" -}}
{{- printf "%s-nats-client" (include "flightdeck.fullname" .) -}}
{{- end -}}

{{/*
The flightdeck StatefulSet's headless Service, for stable pod DNS.
*/}}
{{- define "flightdeck.headlessServiceName" -}}
{{- printf "%s-flightdeck-headless" (include "flightdeck.fullname" .) -}}
{{- end -}}

{{/*
The database the pods use, "postgres" or "sqlite": Postgres when the
chart runs its own (postgres.enabled) or is given one
(postgres.externalUrl), otherwise the SQLite file in each pod's data
volume.
*/}}
{{- define "flightdeck.database" -}}
{{- if or (include "flightdeck.postgresExternal" .) .Values.postgres.enabled -}}postgres{{- else -}}sqlite{{- end -}}
{{- end -}}

{{/*
Whether the pods use a Postgres outside the chart, "true" or "": its
URL given as postgres.externalUrl or in postgres.externalUrlSecret.
*/}}
{{- define "flightdeck.postgresExternal" -}}
{{- $ref := include "flightdeck.secretRef" (dict "root" . "path" "postgres.externalUrlSecret") | fromJson -}}
{{- if or .Values.postgres.externalUrl $ref.name -}}true{{- end -}}
{{- end -}}

{{/*
Whether the chart renders its own Postgres, "true" or "": asked for
with postgres.enabled, and not replaced by an external one.
*/}}
{{- define "flightdeck.postgresBundled" -}}
{{- if and .Values.postgres.enabled (not (include "flightdeck.postgresExternal" .)) -}}true{{- end -}}
{{- end -}}

{{/*
Whether the pods use a NATS outside the chart, "true" or "": its URL
given as nats.externalUrl or in nats.externalUrlSecret.
*/}}
{{- define "flightdeck.natsExternal" -}}
{{- $ref := include "flightdeck.secretRef" (dict "root" . "path" "nats.externalUrlSecret") | fromJson -}}
{{- if or .Values.nats.externalUrl $ref.name -}}true{{- end -}}
{{- end -}}

{{/*
The database the release runs on, as a stable one-line identity: the
StatefulSet carries it as an annotation, the upgrade check compares it,
and the notes print it. An external Postgres is named by host, port and
database (never its credentials), or by the Secret its URL comes from.
*/}}
{{- define "flightdeck.databaseIdentity" -}}
{{- $urlRef := include "flightdeck.secretRef" (dict "root" . "path" "postgres.externalUrlSecret") | fromJson -}}
{{- if .Values.postgres.externalUrl -}}
{{- $u := urlParse .Values.postgres.externalUrl -}}
postgres {{ $u.host }}{{ $u.path }} (external)
{{- else if $urlRef.name -}}
postgres from Secret {{ $urlRef.name }}, key {{ $urlRef.key }} (external)
{{- else if .Values.postgres.enabled -}}
postgres {{ include "flightdeck.postgresServiceName" . }} (the chart's)
{{- else -}}
sqlite (each pod's volume)
{{- end -}}
{{- end -}}

{{/*
The upgrade check: refuse to move a release to another database unless
allowDatabaseChange says so. The chart does not move data, so such an
upgrade starts the pods on an empty database (or another one's data)
while what the release stored stays behind. previous is the identity
the running StatefulSet carries; it is empty on a first install, for a
StatefulSet of a chart that did not record it, and wherever the chart
cannot read the cluster (helm template, --dry-run=client, a GitOps
tool), and an empty previous never fails.
*/}}
{{- define "flightdeck.databaseChange" -}}
{{- if and .previous (ne .previous .current) (not .allow) -}}
{{- fail (printf "this upgrade moves the release from the database %q to %q, and the chart does not move data: the pods would start on the new database as it is, and what the release stored stays where it was (its volume claim, or the other server, is kept). Set the values back to keep the release on its database, or set allowDatabaseChange=true if moving is what you want" .previous .current) -}}
{{- end -}}
{{- end -}}

{{- define "flightdeck.checkDatabaseChange" -}}
{{- if .Release.IsUpgrade -}}
{{- $sts := lookup "apps/v1" "StatefulSet" .Release.Namespace (include "flightdeck.statefulSetName" (dict "root" . "component" "flightdeck")) -}}
{{- $previous := "" -}}
{{- if $sts -}}
{{- $previous = dig "metadata" "annotations" "flightdeck/database" "" $sts -}}
{{- end -}}
{{- include "flightdeck.databaseChange" (dict "previous" $previous "current" (include "flightdeck.databaseIdentity" .) "allow" .Values.allowDatabaseChange) -}}
{{- end -}}
{{- end -}}

{{/*
Whether the chart runs more than one flightdeck pod: replicas above 1,
or the HPA, which may scale above 1.
*/}}
{{- define "flightdeck.multiReplica" -}}
{{- if or (gt (int .Values.flightdeck.replicas) 1) .Values.flightdeck.hpa.enabled -}}true{{- end -}}
{{- end -}}

{{/*
The most flightdeck pods the chart may run: the HPA's maximum when it
is on, the replica count otherwise.
*/}}
{{- define "flightdeck.maxReplicas" -}}
{{- $replicas := int .Values.flightdeck.replicas -}}
{{- if .Values.flightdeck.hpa.enabled -}}
{{- max $replicas (int .Values.flightdeck.hpa.maxReplicas) -}}
{{- else -}}
{{- $replicas -}}
{{- end -}}
{{- end -}}

{{/*
What several pods need, checked once (the StatefulSet includes it): a
database they share. On SQLite every pod has a database file of its
own, since one process serves a SQLite file, so the Service would
spread one fleet over several unrelated databases without any error.
The bus they must share is checked by flightdeck.natsEnabled.
*/}}
{{- define "flightdeck.validate" -}}
{{- if lt (int .Values.flightdeck.replicas) 0 -}}
{{- fail (printf "flightdeck.replicas must be 0 or more, got %d" (int .Values.flightdeck.replicas)) -}}
{{- end -}}
{{- include "flightdeck.validateSecrets" . -}}
{{- include "flightdeck.validateExtraEnv" . -}}
{{- include "flightdeck.checkDatabaseChange" . -}}
{{- if and (include "flightdeck.metricsNetworkPolicy" .) (not .Values.flightdeck.metrics.networkPolicy.from) -}}
{{- fail "flightdeck.metrics.networkPolicy.enabled needs flightdeck.metrics.networkPolicy.from: the NetworkPolicy peers (a namespaceSelector, a podSelector) that may reach the metrics ports; without any, nothing could scrape them" -}}
{{- end -}}
{{- if and (include "flightdeck.multiReplica" .) (eq (include "flightdeck.database" .) "sqlite") -}}
{{- fail "more than one flightdeck pod (flightdeck.replicas above 1, or flightdeck.hpa.enabled) needs a Postgres database: on SQLite every pod would have a database of its own, since one process serves a SQLite file. Set postgres.enabled=true with postgres.password (the chart's Postgres) or postgres.externalUrl=<dsn>, or run one replica" -}}
{{- end -}}
{{- end -}}

{{/*
Whether the metrics NetworkPolicy is rendered, "true" or "": metrics on
and flightdeck.metrics.networkPolicy.enabled. A null networkPolicy is
off; anything else but a map fails the render.
*/}}
{{- define "flightdeck.metricsNetworkPolicy" -}}
{{- $policy := .Values.flightdeck.metrics.networkPolicy | default dict -}}
{{- if not (kindIs "map" $policy) -}}
{{- fail (printf "flightdeck.metrics.networkPolicy must be a map, {enabled, from}, not a %s" (kindOf $policy)) -}}
{{- end -}}
{{- if and .Values.flightdeck.metrics.enabled $policy.enabled -}}true{{- end -}}
{{- end -}}

{{/*
Whether the chart's NATS cluster is rendered, "true" or "". With
nats.externalUrl the pods use that server and the chart renders none.
Otherwise nats.enabled null follows the replica count: several pods
need one shared bus, one pod uses the binary's embedded server. An
explicit false with several pods fails the render: each embedded server
is a bus of its own, so the workers of one pod would never see the
events another pod ingested.
*/}}
{{- define "flightdeck.natsEnabled" -}}
{{- $multi := include "flightdeck.multiReplica" . -}}
{{- $set := .Values.nats.enabled -}}
{{- if include "flightdeck.natsExternal" . -}}
{{- if and (not (kindIs "invalid" $set)) $set -}}
{{- fail "nats.enabled=true and nats.externalUrl (or nats.externalUrlSecret) are both set: the pods use one bus. Leave nats.enabled unset to use the external server, or drop the external URL to run the chart's NATS cluster" -}}
{{- end -}}
{{- else if kindIs "invalid" $set -}}
{{- $multi -}}
{{- else if $set -}}
true
{{- else if $multi -}}
{{- fail "nats.enabled=false with more than one flightdeck pod (flightdeck.replicas above 1, or flightdeck.hpa.enabled): several pods need one shared bus, since the embedded NATS of each pod is a bus of its own. Leave nats.enabled unset (the chart then runs its NATS cluster), set nats.externalUrl to a NATS server you run, or run one replica" -}}
{{- end -}}
{{- end -}}

{{/*
Whether the pods share a NATS outside their own process, "true" or "":
the chart's cluster or nats.externalUrl. Empty means each pod's
embedded bus.
*/}}
{{- define "flightdeck.natsShared" -}}
{{- if or (include "flightdeck.natsEnabled" .) (include "flightdeck.natsExternal" .) -}}true{{- end -}}
{{- end -}}

{{/*
Replica count of the FLIGHTDECK JetStream stream. Unset, it is 3 on the
chart's NATS cluster of at least 3 servers and 1 everywhere else: 3
replicas keep a quorum through the loss of one server, while 2 need
both servers for a quorum, so they would stop the stream on either
server's loss. Set, it must be between 1 and 5 (JetStream's maximum)
and not 2 for that reason; at most nats.replicas on the chart's
cluster, since JetStream places each replica on its own server; and 1
on the embedded bus, which is one server.
*/}}
{{- define "flightdeck.natsStreamReplicas" -}}
{{- $cluster := include "flightdeck.natsEnabled" . -}}
{{- $servers := int .Values.nats.replicas -}}
{{- $set := .Values.nats.jetstream.stream.replicas -}}
{{- $replicas := 1 -}}
{{- if not (kindIs "invalid" $set) -}}
{{- $replicas = int $set -}}
{{- else if and $cluster (ge $servers 3) -}}
{{- $replicas = 3 -}}
{{- end -}}
{{- if or (lt $replicas 1) (gt $replicas 5) -}}
{{- fail (printf "nats.jetstream.stream.replicas must be between 1 and 5, got %d" $replicas) -}}
{{- end -}}
{{- if eq $replicas 2 -}}
{{- fail "nats.jetstream.stream.replicas must not be 2: two replicas need both servers for a quorum, so losing either one stops the stream; use 1 or 3" -}}
{{- end -}}
{{- if and $cluster (gt $replicas $servers) -}}
{{- fail (printf "nats.jetstream.stream.replicas (%d) must not exceed nats.replicas (%d): JetStream places each stream replica on its own server" $replicas $servers) -}}
{{- end -}}
{{- if and (not (include "flightdeck.natsShared" .)) (gt $replicas 1) -}}
{{- fail (printf "nats.jetstream.stream.replicas is %d, but the pod uses its embedded bus, which is one server: leave it unset, or run the chart's NATS cluster (nats.enabled=true)" $replicas) -}}
{{- end -}}
{{- $replicas -}}
{{- end -}}

{{/*
The FLIGHTDECK stream's age and size limits, validated so a bad value
fails the render instead of the pods' startup (which refuses the same
values).
*/}}
{{- define "flightdeck.natsStreamMaxAgeHours" -}}
{{- $hours := int .Values.nats.jetstream.stream.maxAgeHours -}}
{{- if lt $hours 1 -}}
{{- fail (printf "nats.jetstream.stream.maxAgeHours must be at least 1, got %d" $hours) -}}
{{- end -}}
{{- $hours -}}
{{- end -}}

{{- define "flightdeck.natsStreamMaxSizeMiB" -}}
{{- $mib := int .Values.nats.jetstream.stream.maxSizeMiB -}}
{{- if lt $mib 64 -}}
{{- fail (printf "nats.jetstream.stream.maxSizeMiB must be at least 64, got %d" $mib) -}}
{{- end -}}
{{- if include "flightdeck.natsEnabled" . -}}
{{- $volume := include "flightdeck.sizeMiB" .Values.nats.jetstream.fileStore.size -}}
{{- if and $volume (gt (mul $mib 4) (mul (int $volume) 3)) -}}
{{- fail (printf "nats.jetstream.stream.maxSizeMiB (%d) must be at most 75%% of nats.jetstream.fileStore.size (%s, %s MiB): a NATS server reserves at most 75%% of its volume's free space, so it would refuse the stream" $mib .Values.nats.jetstream.fileStore.size $volume) -}}
{{- end -}}
{{- else if not (include "flightdeck.natsExternal" .) -}}
{{- $volume := include "flightdeck.sizeMiB" .Values.flightdeck.data.size -}}
{{- if and $volume (gt (mul $mib 4) (mul (int $volume) 3)) -}}
{{- fail (printf "nats.jetstream.stream.maxSizeMiB (%d) must be at most 75%% of flightdeck.data.size (%s, %s MiB): the embedded bus keeps its store on the pod's data volume, beside the SQLite database and the secrets" $mib .Values.flightdeck.data.size $volume) -}}
{{- end -}}
{{- end -}}
{{- $mib -}}
{{- end -}}

{{/*
A Kubernetes quantity in MiB, for the size checks above. Only the plain
forms are read (Ki, Mi, Gi, Ti and K, M, G, T, with an integer);
anything else renders empty and skips the check.
*/}}
{{- define "flightdeck.sizeMiB" -}}
{{- $size := toString . -}}
{{- if regexMatch "^[0-9]+(Ki|Mi|Gi|Ti|K|M|G|T)$" $size -}}
{{- $n := int64 (regexFind "^[0-9]+" $size) -}}
{{- $unit := trimPrefix (toString $n) $size -}}
{{- if eq $unit "Ki" -}}{{ div $n 1024 }}
{{- else if eq $unit "Mi" -}}{{ $n }}
{{- else if eq $unit "Gi" -}}{{ mul $n 1024 }}
{{- else if eq $unit "Ti" -}}{{ mul $n 1048576 }}
{{- else if eq $unit "K" -}}{{ div (mul $n 1000) 1048576 }}
{{- else if eq $unit "M" -}}{{ div (mul $n 1000000) 1048576 }}
{{- else if eq $unit "G" -}}{{ div (mul $n 1000000000) 1048576 }}
{{- else if eq $unit "T" -}}{{ div (mul $n 1000000000000) 1048576 }}
{{- end -}}
{{- end -}}
{{- end -}}

{{/*
Bundled Postgres password. Fails the render when the chart runs its own
Postgres and postgres.password is unset: a default every bundled
install would share is a well-known credential. Single source of truth
so the DSN helper and the Secret stay byte-aligned.
*/}}
{{- define "flightdeck.postgresPassword" -}}
{{- required "postgres.password must be set when postgres.enabled is true. Set --set postgres.password=<strong-password>, or postgres.passwordSecret.name to a Secret holding it, or supply postgres.externalUrl=<dsn> for a Postgres outside the chart." .Values.postgres.password -}}
{{- end -}}

{{/*
A Secret reference among the values, {name, key} (postgres.externalUrlSecret,
postgres.passwordSecret, nats.externalUrlSecret, nats.auth.tokenSecret),
as JSON for fromJson, so every template reads the four one way. Null
reads as unset, name and key empty: --set <path>=null removes the
entry, defaults included. Anything but a map fails the render, naming
the path but not the value, which may be a secret given in the wrong
place.
*/}}
{{- define "flightdeck.secretRef" -}}
{{- $v := .root.Values -}}
{{- $set := true -}}
{{- $at := list -}}
{{- range $k := splitList "." .path -}}
{{- if $set -}}
{{- if not (kindIs "map" $v) -}}
{{- fail (printf "%s must be a map, not a %s" (join "." $at) (kindOf $v)) -}}
{{- end -}}
{{- $v = index $v $k -}}
{{- $at = append $at $k -}}
{{- $set = not (kindIs "invalid" $v) -}}
{{- end -}}
{{- end -}}
{{- if not $set -}}
{{- dict "name" "" "key" "" | toJson -}}
{{- else if kindIs "map" $v -}}
{{- dict "name" (toString ($v.name | default "")) "key" (toString ($v.key | default "")) | toJson -}}
{{- else -}}
{{- fail (printf "%s must be a Secret reference, {name: <Secret>, key: <key in it>}, not a %s: set %s.name (and .key when it is not the default)" .path (kindOf $v) .path) -}}
{{- end -}}
{{- end -}}

{{/*
Each secret has one source, a value or a Secret of the operator's
(name and key), and a Secret given for something the chart does not
run is a mistake worth naming. Checked once, from flightdeck.validate.
*/}}
{{- define "flightdeck.validateSecrets" -}}
{{- $pg := .Values.postgres -}}
{{- $nats := .Values.nats -}}
{{- $pgUrl := include "flightdeck.secretRef" (dict "root" . "path" "postgres.externalUrlSecret") | fromJson -}}
{{- $pgPassword := include "flightdeck.secretRef" (dict "root" . "path" "postgres.passwordSecret") | fromJson -}}
{{- $natsUrl := include "flightdeck.secretRef" (dict "root" . "path" "nats.externalUrlSecret") | fromJson -}}
{{- $natsToken := include "flightdeck.secretRef" (dict "root" . "path" "nats.auth.tokenSecret") | fromJson -}}
{{- if and $pg.externalUrl $pgUrl.name -}}
{{- fail "postgres.externalUrl and postgres.externalUrlSecret.name are both set: give the database URL once, as the value or from the Secret" -}}
{{- end -}}
{{- if and $pg.password $pgPassword.name -}}
{{- fail "postgres.password and postgres.passwordSecret.name are both set: give the password once, as the value or from the Secret" -}}
{{- end -}}
{{- if $pgPassword.name -}}
{{- if not (include "flightdeck.postgresBundled" .) -}}
{{- fail "postgres.passwordSecret is set, but the chart runs no Postgres of its own (postgres.enabled is false, or the database is external), so nothing would read it" -}}
{{- end -}}
{{- if not $pgPassword.key -}}
{{- fail "postgres.passwordSecret.key must name the key of the password in that Secret" -}}
{{- end -}}
{{- else if include "flightdeck.postgresBundled" . -}}
{{- $_ := include "flightdeck.postgresPassword" . -}}
{{- end -}}
{{- if and $pgUrl.name (not $pgUrl.key) -}}
{{- fail "postgres.externalUrlSecret.key must name the key of the URL in that Secret" -}}
{{- end -}}
{{- if and $nats.externalUrl $natsUrl.name -}}
{{- fail "nats.externalUrl and nats.externalUrlSecret.name are both set: give the NATS URL once, as the value or from the Secret" -}}
{{- end -}}
{{- if and $natsUrl.name (not $natsUrl.key) -}}
{{- fail "nats.externalUrlSecret.key must name the key of the URL in that Secret" -}}
{{- end -}}
{{- if and $nats.auth.token $natsToken.name -}}
{{- fail "nats.auth.token and nats.auth.tokenSecret.name are both set: give the token once, as the value or from the Secret" -}}
{{- end -}}
{{- if $natsToken.name -}}
{{- if not (include "flightdeck.natsEnabled" .) -}}
{{- fail "nats.auth.tokenSecret is set, but the chart runs no NATS cluster (one pod uses its embedded bus, and an external NATS takes its token in its URL), so nothing would read it" -}}
{{- end -}}
{{- if not $natsToken.key -}}
{{- fail "nats.auth.tokenSecret.key must name the key of the token in that Secret" -}}
{{- end -}}
{{- end -}}
{{- end -}}

{{/*
flightdeck.extraEnv lands in the ConfigMap, in plain text, so a name
that reads like a secret is refused, in any case: one containing
PASSWORD, PASSWD, SECRET, TOKEN, CREDENTIAL or APIKEY, or with KEY,
URL, URI, DSN, PASS or PWD as a word of it (words split at _ - .). A
URL may carry a password, and the binary reads no setting that is a
URL without one. It is a guard against a slip, not a scanner: a secret
under another name goes through. Secrets belong in a Secret (the
chart's values that have a Secret form, or extraEnvFrom), and a
setting the guard refuses that is no secret in a ConfigMap of yours,
through extraEnvFrom. A name the chart's ConfigMap sets itself is
refused too, since the key would be there twice with one value lost,
and so are a name a ConfigMap cannot have and a value that is a map
or a list.
*/}}
{{- define "flightdeck.validateExtraEnv" -}}
{{- $own := list "FLIGHTDECK_WORKER_POOL_SIZE" "FLIGHTDECK_RATE_LIMIT_PER_MINUTE" "SHUTDOWN_TIMEOUT_SECS" "FLIGHTDECK_CORS_ORIGIN" "FLIGHTDECK_NATS_STREAM_MAX_AGE_HOURS" "FLIGHTDECK_NATS_STREAM_MAX_SIZE_MIB" "FLIGHTDECK_NATS_STREAM_REPLICAS" "FLIGHTDECK_ALLOWED_HOSTS" "AGENT_FLAVOR" "AGENT_TYPE" "FLIGHTDECK_UNAVAILABLE_POLICY" "FLIGHTDECK_CAPTURE_PROMPTS" -}}
{{- range $name, $value := .Values.flightdeck.extraEnv -}}
{{- $upper := upper $name -}}
{{- if not (regexMatch "^[-._a-zA-Z0-9]+$" $name) -}}
{{- fail (printf "flightdeck.extraEnv: %q is not a name a ConfigMap can carry (letters, digits and - . _ only)" $name) -}}
{{- end -}}
{{- if or (kindIs "map" $value) (kindIs "slice" $value) -}}
{{- fail (printf "flightdeck.extraEnv.%s must be a string, a number or a boolean, not a %s (with --set, a dot in a name splits it: write it as \\.)" $name (kindOf $value)) -}}
{{- end -}}
{{- if or (regexMatch "PASSWORD|PASSWD|SECRET|TOKEN|CREDENTIAL|APIKEY" $upper) (regexMatch "(^|[-._])(KEY|URL|URI|DSN|PASS|PWD)([-._]|$)" $upper) -}}
{{- fail (printf "flightdeck.extraEnv.%s reads like a secret, and extraEnv goes into the ConfigMap in plain text. The database and NATS URLs, the Postgres password and the NATS token have values of their own with a Secret form (postgres.externalUrlSecret, postgres.passwordSecret, nats.externalUrlSecret, nats.auth.tokenSecret); anything else goes in a Secret of yours, or, if it is no secret, a ConfigMap of yours, through flightdeck.extraEnvFrom" $name) -}}
{{- end -}}
{{- if has $upper $own -}}
{{- fail (printf "flightdeck.extraEnv.%s is set by the chart from its own value (values.yaml; for FLIGHTDECK_ALLOWED_HOSTS, flightdeck.extraAllowedHosts): set that value instead, since the ConfigMap would carry the key twice" $name) -}}
{{- end -}}
{{- end -}}
{{- end -}}

{{/*
FLIGHTDECK_ALLOWED_HOSTS: every name the pods are reached by inside and
outside the cluster. A binary that checks the Host header answers IP
addresses (the kubelet's probes connect to the pod IP) and localhost (a
port-forward) whatever the list, and refuses other names with 421; the
image sets the variable to localhost, which turns the check on. The
list: the Service in its short and qualified forms, every pod through
the headless Service (a leading dot admits the names under it), the
Ingress host and TLS hosts (a wildcard *.x becomes .x), and
flightdeck.extraAllowedHosts. An entry the binary would refuse at start
fails the render instead.
*/}}
{{- define "flightdeck.allowedHosts" -}}
{{- $ns := .Release.Namespace -}}
{{- $domain := .Values.clusterDomain | trimSuffix "." -}}
{{- $svc := include "flightdeck.componentName" (dict "root" . "component" "flightdeck") -}}
{{- $headless := include "flightdeck.headlessServiceName" . -}}
{{- $hosts := list "localhost" $svc (printf "%s.%s" $svc $ns) (printf "%s.%s.svc" $svc $ns) (printf "%s.%s.svc.%s" $svc $ns $domain) -}}
{{- $hosts = concat $hosts (list (printf ".%s" $headless) (printf ".%s.%s" $headless $ns) (printf ".%s.%s.svc" $headless $ns) (printf ".%s.%s.svc.%s" $headless $ns $domain)) -}}
{{- if .Values.ingress.enabled -}}
{{- $hosts = append $hosts .Values.ingress.host -}}
{{- range .Values.ingress.tls -}}
{{- $hosts = concat $hosts (.hosts | default list) -}}
{{- end -}}
{{- end -}}
{{- $hosts = concat $hosts .Values.flightdeck.extraAllowedHosts -}}
{{- $out := list -}}
{{- range $hosts -}}
{{- $entry := . | toString | lower | trimSuffix "." -}}
{{- if hasPrefix "*." $entry -}}
{{- $entry = trimPrefix "*" $entry -}}
{{- end -}}
{{- if and $entry (ne $entry "*") (not (regexMatch "^\\.?[a-z0-9-]+(\\.[a-z0-9-]+)*$" $entry)) -}}
{{- fail (printf "%q is not a host name the pods could answer for (FLIGHTDECK_ALLOWED_HOSTS takes names without a scheme, a port or a path; a leading dot admits every name under one, and \"*\" turns the check off): fix it in flightdeck.extraAllowedHosts, ingress.host or ingress.tls" .) -}}
{{- end -}}
{{- if $entry -}}
{{- $out = append $out $entry -}}
{{- end -}}
{{- end -}}
{{- join "," (uniq $out) -}}
{{- end -}}

{{/*
persistentVolumeClaimRetentionPolicy for the three StatefulSets: Retain
when the StatefulSet is deleted (helm uninstall) and when it is scaled
in, which is what Kubernetes does with no policy too, stated so nobody
reads it as an oversight. The field is beta and on by default from
Kubernetes 1.27 (GA in 1.32); below that it is not rendered, and the
claims are retained all the same.
*/}}
{{- define "flightdeck.pvcRetention" -}}
{{- if semverCompare ">=1.27-0" .Capabilities.KubeVersion.Version -}}
persistentVolumeClaimRetentionPolicy:
  whenDeleted: Retain
  whenScaled: Retain
{{- end -}}
{{- end -}}

{{/*
max_connections of the bundled Postgres. One flightdeck process opens
at most 80 connections (a pool per service inside it, its LISTEN
connections and the start-up check), so the server needs 80 for every
pod the chart may run, and 20 more for what else connects: the 3
Postgres keeps for superusers, a psql session, a backup. That is 100
for one pod, Postgres's own default. A postgres.maxConnections set
below it fails the render, since the pods would be refused connections
under load rather than at install.
*/}}
{{- define "flightdeck.postgresMaxConnections" -}}
{{- $pods := max 1 (int (include "flightdeck.maxReplicas" .)) -}}
{{- $needed := add (mul 80 $pods) 20 -}}
{{- $set := .Values.postgres.maxConnections -}}
{{- if kindIs "invalid" $set -}}
{{- $needed -}}
{{- else if lt (int $set) (int $needed) -}}
{{- fail (printf "postgres.maxConnections (%d) is below the %d the chart's flightdeck pods need: each pod opens at most 80 connections, the chart may run %d, and 20 are left for everything else. Raise it, leave it unset, or put a connection pooler in front and use postgres.externalUrl" (int $set) (int $needed) $pods) -}}
{{- else -}}
{{- int $set -}}
{{- end -}}
{{- end -}}

{{/*
Bundled Postgres DSN. Only used when the chart runs its own Postgres.
*/}}
{{- define "flightdeck.bundledPostgresURL" -}}
{{- $pw := include "flightdeck.postgresPassword" . -}}
{{- printf "postgres://%s:%s@%s:%d/%s?sslmode=%s" (include "flightdeck.urlUserinfoEscape" .Values.postgres.user) (include "flightdeck.urlUserinfoEscape" $pw) (include "flightdeck.postgresServiceName" .) (int .Values.postgres.port) .Values.postgres.database .Values.postgres.sslmode -}}
{{- end -}}

{{/*
Percent-encode a URL user or password. The Postgres driver splits the
user:password part at the first "@", so an unencoded "@" (or "/", "?",
"#", ":") in a password would be read as part of the host. urlquery
encodes everything but writes a space as "+", which a URL's user part
keeps literally, so spaces are rewritten to "%20" (urlquery has already
turned any literal "+" into "%2B").
*/}}
{{- define "flightdeck.urlUserinfoEscape" -}}
{{- . | urlquery | replace "+" "%20" -}}
{{- end -}}

{{/*
Postgres DSN the pods read (FLIGHTDECK_DATABASE_URL) when the database
is Postgres. Resolves to externalUrl when set; otherwise to the bundled
in-cluster service.
*/}}
{{- define "flightdeck.postgresURL" -}}
{{- if .Values.postgres.externalUrl -}}
{{- .Values.postgres.externalUrl -}}
{{- else -}}
{{- include "flightdeck.bundledPostgresURL" . -}}
{{- end -}}
{{- end -}}

{{/*
NATS URL the pods read (FLIGHTDECK_NATS_URL, the binary's --nats-url):
nats.externalUrl as given, or the bundled cluster's client Service.
There the token goes in the user slot (nats://<token>@host): nats.go
sends a lone user as the auth token, while nats://:<token>@host sends
an empty user and a password, which a token-protected server rejects.
*/}}
{{- define "flightdeck.natsURL" -}}
{{- if .Values.nats.externalUrl -}}
{{- .Values.nats.externalUrl -}}
{{- else -}}
{{- printf "nats://%s@%s:%d" (include "flightdeck.natsToken" .) (include "flightdeck.natsClientServiceName" .) (int .Values.nats.clientPort) -}}
{{- end -}}
{{- end -}}

{{/*
The env entries of the flightdeck container for the secrets that come
from the operator's own Secrets: the chart cannot write those into its
Secret, so the URLs are built in the pod spec instead. A URL from a
Secret is read as it is; a password or a token from a Secret is read
into FD_POSTGRES_PASSWORD or FD_NATS_TOKEN and the kubelet expands it
into the URL ($(NAME) refers to an entry earlier in the list). Empty
when every secret is a value, which the chart's Secret carries.
*/}}
{{- define "flightdeck.secretEnv" -}}
{{- $pg := .Values.postgres -}}
{{- $nats := .Values.nats -}}
{{- $pgUrl := include "flightdeck.secretRef" (dict "root" . "path" "postgres.externalUrlSecret") | fromJson -}}
{{- $pgPassword := include "flightdeck.secretRef" (dict "root" . "path" "postgres.passwordSecret") | fromJson -}}
{{- $natsUrl := include "flightdeck.secretRef" (dict "root" . "path" "nats.externalUrlSecret") | fromJson -}}
{{- $natsToken := include "flightdeck.secretRef" (dict "root" . "path" "nats.auth.tokenSecret") | fromJson -}}
{{- if $pgUrl.name }}
- name: FLIGHTDECK_DATABASE_URL
  valueFrom:
    secretKeyRef:
      name: {{ $pgUrl.name | quote }}
      key: {{ $pgUrl.key | quote }}
{{- else if and (include "flightdeck.postgresBundled" .) $pgPassword.name }}
- name: FD_POSTGRES_PASSWORD
  valueFrom:
    secretKeyRef:
      name: {{ $pgPassword.name | quote }}
      key: {{ $pgPassword.key | quote }}
- name: FLIGHTDECK_DATABASE_URL
  value: {{ printf "postgres://%s:$(FD_POSTGRES_PASSWORD)@%s:%d/%s?sslmode=%s" (include "flightdeck.urlUserinfoEscape" $pg.user) (include "flightdeck.postgresServiceName" .) (int $pg.port) $pg.database $pg.sslmode | quote }}
{{- end }}
{{- if $natsUrl.name }}
- name: FLIGHTDECK_NATS_URL
  valueFrom:
    secretKeyRef:
      name: {{ $natsUrl.name | quote }}
      key: {{ $natsUrl.key | quote }}
{{- else if and (include "flightdeck.natsEnabled" .) $natsToken.name }}
- name: FD_NATS_TOKEN
  valueFrom:
    secretKeyRef:
      name: {{ $natsToken.name | quote }}
      key: {{ $natsToken.key | quote }}
- name: FLIGHTDECK_NATS_URL
  value: {{ printf "nats://$(FD_NATS_TOKEN)@%s:%d" (include "flightdeck.natsClientServiceName" .) (int $nats.clientPort) | quote }}
{{- end }}
{{- end -}}

{{/*
Validated NATS token, required whenever the cluster is rendered. The
token is written into URLs unencoded (the client URL and the cluster
route URLs, the latter expanded from an env var by the kubelet), so it
is limited to URL-unreserved characters.
*/}}
{{- define "flightdeck.natsToken" -}}
{{- $token := required "nats.auth.token must be set when the NATS cluster is rendered (more than one flightdeck replica, the HPA, or nats.enabled=true): an unauthenticated event bus lets any pod that can reach it forge events or drain the queue. Set --set nats.auth.token=<strong-random-token> (openssl rand -hex 32)." .Values.nats.auth.token -}}
{{- if not (regexMatch "^[A-Za-z0-9._~-]+$" $token) -}}
{{- fail "nats.auth.token may contain only letters, digits and . _ ~ - (it is placed in NATS URLs); generate one with: openssl rand -hex 32" -}}
{{- end -}}
{{- $token -}}
{{- end -}}

{{/*
Userinfo the cluster routes authenticate with. The password is the
NATS_TOKEN env var, expanded by the kubelet in args.
*/}}
{{- define "flightdeck.natsRouteAuth" -}}
route:$(NATS_TOKEN)@
{{- end -}}

{{/*
Comma-separated cluster routes to every NATS pod (a route to the pod
itself is ignored by the server). Pod DNS comes from the headless
Service: <statefulset>-<ordinal>.<service>.
*/}}
{{- define "flightdeck.natsRoutes" -}}
{{- $sts := include "flightdeck.statefulSetName" (dict "root" . "component" "nats") -}}
{{- $svc := include "flightdeck.natsServiceName" . -}}
{{- $auth := include "flightdeck.natsRouteAuth" . -}}
{{- $routes := list -}}
{{- range $i := until (int .Values.nats.replicas) -}}
{{- $routes = append $routes (printf "nats://%s%s-%d.%s:%d" $auth $sts $i $svc (int $.Values.nats.clusterPort)) -}}
{{- end -}}
{{- join "," $routes -}}
{{- end -}}

{{/*
The flightdeck image reference.
*/}}
{{- define "flightdeck.image" -}}
{{- include "flightdeck.imageRef" (dict "root" . "image" .Values.image "key" "image") -}}
{{- end -}}

{{/*
An image reference under image.registry: <registry>/<repository>:<tag>,
or <repository>:<tag> when the registry is empty (an image loaded onto
the nodes, a mirror named in the repository itself). With a digest it
is <repository>@<digest>, and the tag is not used. The flightdeck, NATS
and Postgres images all go through it; key names the values entry in a
refusal.
*/}}
{{- define "flightdeck.imageRef" -}}
{{- $repo := .image.repository -}}
{{- if .root.Values.image.registry -}}
{{- $repo = printf "%s/%s" .root.Values.image.registry .image.repository -}}
{{- end -}}
{{- if .image.digest -}}
{{- if not (regexMatch "^sha256:[a-f0-9]{64}$" .image.digest) -}}
{{- fail (printf "%s.digest must be sha256: and 64 lower-case hex digits, got %q" .key .image.digest) -}}
{{- end -}}
{{- printf "%s@%s" $repo .image.digest -}}
{{- else -}}
{{- printf "%s:%s" $repo .image.tag -}}
{{- end -}}
{{- end -}}

{{/*
ServiceAccount name for a given component.
*/}}
{{- define "flightdeck.serviceAccountName" -}}
{{- printf "%s-%s" (include "flightdeck.fullname" .root) .component | trunc 63 | trimSuffix "-" -}}
{{- end -}}
