{{- define "cw.name" -}}
{{- default .Chart.Name .Values.nameOverride | trunc 63 | trimSuffix "-" -}}
{{- end -}}

{{- define "cw.fullname" -}}
{{- default .Chart.Name .Values.fullnameOverride | trunc 63 | trimSuffix "-" -}}
{{- end -}}

{{- define "cw.labels" -}}
app.kubernetes.io/name: {{ include "cw.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
helm.sh/chart: {{ .Chart.Name }}-{{ .Chart.Version }}
{{- end -}}

{{- define "cw.selectorLabels" -}}
app.kubernetes.io/name: {{ include "cw.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
{{- end -}}
