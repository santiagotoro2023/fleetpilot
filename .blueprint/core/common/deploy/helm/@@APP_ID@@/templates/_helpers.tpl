{{- define "@@APP_ID@@.name" -}}
{{- default .Chart.Name .Values.nameOverride | trunc 63 | trimSuffix "-" }}
{{- end }}

{{- define "@@APP_ID@@.fullname" -}}
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

{{- define "@@APP_ID@@.labels" -}}
helm.sh/chart: {{ printf "%s-%s" .Chart.Name .Chart.Version | replace "+" "_" }}
{{ include "@@APP_ID@@.selectorLabels" . }}
app.kubernetes.io/version: {{ .Chart.AppVersion | quote }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
{{- end }}

{{- define "@@APP_ID@@.selectorLabels" -}}
app.kubernetes.io/name: {{ include "@@APP_ID@@.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
{{- end }}

@@IF server@@
{{/* The bundled database: its own name label, so the app's selectors never match it */}}
{{- define "@@APP_ID@@.dbSelectorLabels" -}}
app.kubernetes.io/name: {{ include "@@APP_ID@@.name" . }}-db
app.kubernetes.io/instance: {{ .Release.Name }}
app.kubernetes.io/component: database
{{- end }}

{{/* The Secret with the database URL */}}
{{- define "@@APP_ID@@.dbSecret" -}}
{{- .Values.database.existingSecret | default (printf "%s-db" (include "@@APP_ID@@.fullname" .)) }}
{{- end }}

{{/* Password of the bundled database: given, or kept from the existing Secret, or new */}}
{{- define "@@APP_ID@@.dbPassword" -}}
{{- if .Values.database.password }}
{{- .Values.database.password }}
{{- else }}
{{- $s := lookup "v1" "Secret" .Release.Namespace (printf "%s-db" (include "@@APP_ID@@.fullname" .)) }}
{{- if and $s $s.data (hasKey $s.data "password") }}
{{- index $s.data "password" | b64dec }}
{{- else }}
{{- randAlphaNum 32 }}
{{- end }}
{{- end }}
{{- end }}

@@END@@
@@IF lib:secrets@@
{{/* The Secret with the key for the stored secrets */}}
{{- define "@@APP_ID@@.keySecret" -}}
{{- .Values.secretKey.existingSecret | default (printf "%s-key" (include "@@APP_ID@@.fullname" .)) }}
{{- end }}

{{/* The key: kept from the existing Secret, or new (32 random bytes, base64) */}}
{{- define "@@APP_ID@@.keyValue" -}}
{{- $s := lookup "v1" "Secret" .Release.Namespace (printf "%s-key" (include "@@APP_ID@@.fullname" .)) }}
{{- if and $s $s.data (hasKey $s.data "key") }}
{{- index $s.data "key" | b64dec }}
{{- else }}
{{- randAlphaNum 32 | b64enc }}
{{- end }}
{{- end }}

@@END@@

{{/* The public address: set explicitly, or from the first Ingress host */}}
{{- define "@@APP_ID@@.canonical" -}}
{{- if .Values.canonicalUrl }}
{{- .Values.canonicalUrl | trimSuffix "/" }}
{{- else if and .Values.ingress.enabled .Values.ingress.hosts }}
{{- $host := (index .Values.ingress.hosts 0).host }}
{{- if .Values.ingress.tls }}https://{{ $host }}{{ else }}http://{{ $host }}{{ end }}
{{- end }}
{{- end }}
