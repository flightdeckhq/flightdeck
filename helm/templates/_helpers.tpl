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

{{- define "flightdeck.migrationsConfigMapName" -}}
{{- printf "%s-migrations" (include "flightdeck.fullname" .) -}}
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
Bundled Postgres password. Fails the render when postgres.externalUrl is
empty AND postgres.password is unset — prior releases silently defaulted
to the literal "flightdeck", which left every bundled-Postgres install
sharing one well-known credential. Operators MUST set
postgres.password (or set postgres.externalUrl to point at a managed DB).
Single source of truth so the DSN helper and the Secret stay byte-aligned.
*/}}
{{- define "flightdeck.postgresPassword" -}}
{{- required "postgres.password must be set when postgres.externalUrl is empty. Set --set postgres.password=<strong-password> or supply --set postgres.externalUrl=<dsn>. Defaulting to the literal 'flightdeck' (the pre-v0.5.1 behaviour) is unsafe and has been removed." .Values.postgres.password -}}
{{- end -}}

{{/*
Bundled Postgres DSN. Only used when .Values.postgres.externalUrl is empty.
*/}}
{{- define "flightdeck.bundledPostgresURL" -}}
{{- $pw := include "flightdeck.postgresPassword" . -}}
{{- printf "postgres://%s:%s@%s:%d/%s?sslmode=%s" .Values.postgres.user $pw (include "flightdeck.postgresServiceName" .) (int .Values.postgres.port) .Values.postgres.database .Values.postgres.sslmode -}}
{{- end -}}

{{/*
Postgres DSN used by every server component. Resolves to externalUrl when
set; otherwise to the bundled in-cluster service.
*/}}
{{- define "flightdeck.postgresURL" -}}
{{- if .Values.postgres.externalUrl -}}
{{- .Values.postgres.externalUrl -}}
{{- else -}}
{{- include "flightdeck.bundledPostgresURL" . -}}
{{- end -}}
{{- end -}}

{{/*
NATS URL -- always the bundled in-cluster client Service. A token goes
in the user slot (nats://<token>@host): nats.go sends a lone user as the
auth token, while nats://:<token>@host sends an empty user and a
password, which a token-protected server rejects.
*/}}
{{- define "flightdeck.natsURL" -}}
{{- if .Values.nats.auth.token -}}
{{- printf "nats://%s@%s:%d" .Values.nats.auth.token (include "flightdeck.natsClientServiceName" .) (int .Values.nats.clientPort) -}}
{{- else -}}
{{- printf "nats://%s:%d" (include "flightdeck.natsClientServiceName" .) (int .Values.nats.clientPort) -}}
{{- end -}}
{{- end -}}

{{/*
Validated NATS token. The token is written into URLs unencoded (the
client URL and the cluster route URLs, the latter expanded from an env
var by the kubelet), so it is limited to URL-unreserved characters.
*/}}
{{- define "flightdeck.natsToken" -}}
{{- $token := .Values.nats.auth.token -}}
{{- if and $token (not (regexMatch "^[A-Za-z0-9._~-]+$" $token)) -}}
{{- fail "nats.auth.token may contain only letters, digits and . _ ~ - (it is placed in NATS URLs); generate one with: openssl rand -hex 32" -}}
{{- end -}}
{{- $token -}}
{{- end -}}

{{/*
Userinfo the cluster routes authenticate with when a token is set. The
password is the NATS_TOKEN env var, expanded by the kubelet in args.
*/}}
{{- define "flightdeck.natsRouteAuth" -}}
{{- if .Values.nats.auth.token -}}route:$(NATS_TOKEN)@{{- end -}}
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
Fully-qualified image reference per component. Usage:
  image: {{ include "flightdeck.image" (dict "root" . "component" .Values.ingestion) }}
*/}}
{{- define "flightdeck.image" -}}
{{- $registry := .root.Values.image.registry -}}
{{- $repoBase := .root.Values.image.repository -}}
{{- $repo := .component.image.repository -}}
{{- $tag := .component.image.tag | default .root.Values.image.tag -}}
{{- if $registry -}}
{{- printf "%s/%s/%s:%s" $registry $repoBase $repo $tag -}}
{{- else -}}
{{- printf "%s/%s:%s" $repoBase $repo $tag -}}
{{- end -}}
{{- end -}}

{{/*
ServiceAccount name for a given component.
*/}}
{{- define "flightdeck.serviceAccountName" -}}
{{- printf "%s-%s" (include "flightdeck.fullname" .root) .component | trunc 63 | trimSuffix "-" -}}
{{- end -}}
