{{- define "fleetpilot.name" -}}
{{- default .Chart.Name .Values.nameOverride | trunc 63 | trimSuffix "-" }}
{{- end }}

{{- define "fleetpilot.fullname" -}}
{{- if .Values.fullnameOverride }}
{{- .Values.fullnameOverride | trunc 63 | trimSuffix "-" }}
{{- else }}
{{- $name := default .Chart.Name .Values.nameOverride }}
{{- if contains $name .Release.Name }}
{{- .Release.Name | trunc 63 | trimSuffix "-" }}
{{- else }}
{{- printf "%s-%s" .Release.Name $name | trunc 63 | trimSuffix "-" }}
{{- end }}
{{- end }}
{{- end }}

{{- define "fleetpilot.labels" -}}
helm.sh/chart: {{ printf "%s-%s" .Chart.Name .Chart.Version | replace "+" "_" }}
{{ include "fleetpilot.selectorLabels" . }}
app.kubernetes.io/version: {{ .Chart.AppVersion | quote }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
{{- end }}

{{- define "fleetpilot.selectorLabels" -}}
app.kubernetes.io/name: {{ include "fleetpilot.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
{{- end }}

{{/* The bundled database: its own name label, so the app's selectors never match it */}}
{{- define "fleetpilot.dbSelectorLabels" -}}
app.kubernetes.io/name: {{ include "fleetpilot.name" . }}-db
app.kubernetes.io/instance: {{ .Release.Name }}
app.kubernetes.io/component: database
{{- end }}

{{/* The Secret with the database URL */}}
{{- define "fleetpilot.dbSecret" -}}
{{- .Values.database.existingSecret | default (printf "%s-db" (include "fleetpilot.fullname" .)) }}
{{- end }}

{{/* Password of the bundled database: given, or kept from the existing Secret, or new */}}
{{- define "fleetpilot.dbPassword" -}}
{{- if .Values.database.password }}
{{- .Values.database.password }}
{{- else }}
{{- $s := lookup "v1" "Secret" .Release.Namespace (printf "%s-db" (include "fleetpilot.fullname" .)) }}
{{- if and $s $s.data (hasKey $s.data "password") }}
{{- index $s.data "password" | b64dec }}
{{- else }}
{{- randAlphaNum 32 }}
{{- end }}
{{- end }}
{{- end }}

{{/* The Secret with the key for the stored secrets */}}
{{- define "fleetpilot.keySecret" -}}
{{- .Values.secretKey.existingSecret | default (printf "%s-key" (include "fleetpilot.fullname" .)) }}
{{- end }}

{{/* The key: kept from the existing Secret, or new (32 random bytes, base64) */}}
{{- define "fleetpilot.keyValue" -}}
{{- $s := lookup "v1" "Secret" .Release.Namespace (printf "%s-key" (include "fleetpilot.fullname" .)) }}
{{- if and $s $s.data (hasKey $s.data "key") }}
{{- index $s.data "key" | b64dec }}
{{- else }}
{{- randAlphaNum 32 | b64enc }}
{{- end }}
{{- end }}


{{/* The public address: set explicitly, or from the first Ingress host */}}
{{- define "fleetpilot.canonical" -}}
{{- if .Values.canonicalUrl }}
{{- .Values.canonicalUrl | trimSuffix "/" }}
{{- else if and .Values.ingress.enabled .Values.ingress.hosts }}
{{- $host := (index .Values.ingress.hosts 0).host }}
{{- if .Values.ingress.tls }}https://{{ $host }}{{ else }}http://{{ $host }}{{ end }}
{{- end }}
{{- end }}
