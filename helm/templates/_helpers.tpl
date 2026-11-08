{{/*
Common helpers for the flightdeck chart.
*/}}

{{- define "flightdeck.name" -}}
{{- default .Chart.Name .Values.nameOverride | trunc 63 | trimSuffix "-" -}}
{{- end -}}

{{- define "flightdeck.fullname" -}}
{{- if .Values.fullnameOverride -}}
{{- .Values.fullnameOverride | trunc 63 | trimSuffix "-" -}}
{{- else -}}
{{- $name := default .Chart.Name .Values.nameOverride -}}
{{- if contains $name .Release.Name -}}
{{- .Release.Name | trunc 63 | trimSuffix "-" -}}
{{- else -}}
{{- printf "%s-%s" .Release.Name $name | trunc 63 | trimSuffix "-" -}}
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
Whether the chart runs more than one flightdeck pod: replicas above 1,
or the HPA, which may scale above 1.
*/}}
{{- define "flightdeck.multiReplica" -}}
{{- if or (gt (int .Values.flightdeck.replicas) 1) .Values.flightdeck.hpa.enabled -}}true{{- end -}}
{{- end -}}

{{/*
Whether the NATS cluster is rendered, "true" or "". nats.enabled null
follows the replica count: several pods need one shared bus, one pod
uses the binary's embedded server. An explicit false with several pods
fails the render: each embedded server is a bus of its own, so the
workers of one pod would never see the events another pod ingested.
*/}}
{{- define "flightdeck.natsEnabled" -}}
{{- $multi := include "flightdeck.multiReplica" . -}}
{{- $set := .Values.nats.enabled -}}
{{- if kindIs "invalid" $set -}}
{{- $multi -}}
{{- else if $set -}}
true
{{- else if $multi -}}
{{- fail "nats.enabled=false with more than one flightdeck replica (flightdeck.replicas above 1, or flightdeck.hpa.enabled): several pods need one shared bus, since the embedded NATS of each pod is a bus of its own; leave nats.enabled unset, or run one replica" -}}
{{- end -}}
{{- end -}}

{{/*
Replica count of the FLIGHTDECK JetStream stream. Without the NATS
cluster the embedded server holds the one copy. With it, unset, it is 3
when the cluster has at least 3 servers and 1 otherwise: 3 replicas keep
a quorum through the loss of one server, while 2 need both servers for a
quorum, so they would stop the stream on either server's loss. Set, it
must be between 1 and 5 (JetStream's maximum), not 2 for that reason,
and at most nats.replicas, since JetStream places each replica on its
own server.
*/}}
{{- define "flightdeck.natsStreamReplicas" -}}
{{- if not (include "flightdeck.natsEnabled" .) -}}
1
{{- else -}}
{{- $servers := int .Values.nats.replicas -}}
{{- $set := .Values.nats.jetstream.stream.replicas -}}
{{- $replicas := 1 -}}
{{- if not (kindIs "invalid" $set) -}}
{{- $replicas = int $set -}}
{{- else if ge $servers 3 -}}
{{- $replicas = 3 -}}
{{- end -}}
{{- if or (lt $replicas 1) (gt $replicas 5) -}}
{{- fail (printf "nats.jetstream.stream.replicas must be between 1 and 5, got %d" $replicas) -}}
{{- end -}}
{{- if eq $replicas 2 -}}
{{- fail "nats.jetstream.stream.replicas must not be 2: two replicas need both servers for a quorum, so losing either one stops the stream; use 1 or 3" -}}
{{- end -}}
{{- if gt $replicas $servers -}}
{{- fail (printf "nats.jetstream.stream.replicas (%d) must not exceed nats.replicas (%d): JetStream places each stream replica on its own server" $replicas $servers) -}}
{{- end -}}
{{- $replicas -}}
{{- end -}}
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
{{- else -}}
{{- $volume := include "flightdeck.sizeMiB" .Values.flightdeck.data.size -}}
{{- if and $volume (gt (mul $mib 4) (mul (int $volume) 3)) -}}
{{- fail (printf "nats.jetstream.stream.maxSizeMiB (%d) must be at most 75%% of flightdeck.data.size (%s, %s MiB): the embedded bus keeps its store on the pod's data volume, beside the secrets and the TLS cache" $mib .Values.flightdeck.data.size $volume) -}}
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
Bundled Postgres password. Fails the render when postgres.externalUrl is
empty AND postgres.password is unset: a default every bundled install
would share is a well-known credential. Single source of truth so the
DSN helper and the Secret stay byte-aligned.
*/}}
{{- define "flightdeck.postgresPassword" -}}
{{- required "postgres.password must be set when postgres.externalUrl is empty. Set --set postgres.password=<strong-password> or supply --set postgres.externalUrl=<dsn>." .Values.postgres.password -}}
{{- end -}}

{{/*
Bundled Postgres DSN. Only used when .Values.postgres.externalUrl is empty.
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
Postgres DSN the pods read (FLIGHTDECK_DATABASE_URL). Resolves to
externalUrl when set; otherwise to the bundled in-cluster service.
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
the bundled cluster's client Service. The token goes in the user slot
(nats://<token>@host): nats.go sends a lone user as the auth token,
while nats://:<token>@host sends an empty user and a password, which a
token-protected server rejects.
*/}}
{{- define "flightdeck.natsURL" -}}
{{- printf "nats://%s@%s:%d" (include "flightdeck.natsToken" .) (include "flightdeck.natsClientServiceName" .) (int .Values.nats.clientPort) -}}
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
{{- $sts := include "flightdeck.componentName" (dict "root" . "component" "nats") -}}
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
{{- if .Values.image.registry -}}
{{- printf "%s/%s:%s" .Values.image.registry .Values.image.repository .Values.image.tag -}}
{{- else -}}
{{- printf "%s:%s" .Values.image.repository .Values.image.tag -}}
{{- end -}}
{{- end -}}

{{/*
ServiceAccount name for a given component.
*/}}
{{- define "flightdeck.serviceAccountName" -}}
{{- printf "%s-%s" (include "flightdeck.fullname" .root) .component | trunc 63 | trimSuffix "-" -}}
{{- end -}}
