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
Bundled Postgres DSN. Only used when .Values.postgres.externalUrl is empty.
*/}}
{{- define "flightdeck.bundledPostgresURL" -}}
{{- $pw := .Values.postgres.password | default "flightdeck" -}}
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
NATS URL -- always the bundled in-cluster service (no escape hatch in v0.3.0).
*/}}
{{- define "flightdeck.natsURL" -}}
{{- printf "nats://%s:%d" (include "flightdeck.natsServiceName" .) (int .Values.nats.clientPort) -}}
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
