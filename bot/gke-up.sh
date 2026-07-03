#!/usr/bin/env bash
# Provision + deploy the com-tower bot to a GKE Autopilot STAGING cluster (personal com-tower
# project). Idempotent — safe to re-run. Pairs with gke-down.sh (tear it all down to ~$0).
#
# Prod stays on Cloud Run (bot/deploy.sh); this is a separate, disposable staging env for k8s
# learning + load testing. All gcloud is scoped to the personal `com-tower` profile, never Nexus.
set -euo pipefail
export CLOUDSDK_ACTIVE_CONFIG_NAME="${CLOUDSDK_ACTIVE_CONFIG_NAME:-com-tower}"

PROJECT="${PROJECT_ID:-com-tower}"
REGION="${REGION:-us-central1}"
CLUSTER="${CLUSTER:-com-tower-staging}"
AR_REPO="${AR_REPO:-com-tower}"
NAMESPACE="${NAMESPACE:-default}"
KSA="com-tower-worker"
GSA="com-tower-worker@${PROJECT}.iam.gserviceaccount.com"
IMAGE="${REGION}-docker.pkg.dev/${PROJECT}/${AR_REPO}/com-tower-worker"
TAG="${TAG:-$(git rev-parse --short HEAD 2>/dev/null || echo latest)}"
cd "$(dirname "$0")"   # -> bot/

echo "== 1/6 enable APIs =="
gcloud services enable container.googleapis.com artifactregistry.googleapis.com \
  cloudbuild.googleapis.com firestore.googleapis.com --project "$PROJECT"

echo "== 2/6 Artifact Registry =="
gcloud artifacts repositories describe "$AR_REPO" --location "$REGION" --project "$PROJECT" >/dev/null 2>&1 || \
  gcloud artifacts repositories create "$AR_REPO" --repository-format=docker --location "$REGION" --project "$PROJECT"

echo "== 3/6 build + push image via Cloud Build (no local docker needed): ${IMAGE}:${TAG} =="
gcloud builds submit --tag "${IMAGE}:${TAG}" --project "$PROJECT" .

echo "== 4/6 Autopilot cluster (create if missing; ~5-9 min first time) =="
gcloud container clusters describe "$CLUSTER" --region "$REGION" --project "$PROJECT" >/dev/null 2>&1 || \
  gcloud container clusters create-auto "$CLUSTER" --region "$REGION" --project "$PROJECT"
gcloud container clusters get-credentials "$CLUSTER" --region "$REGION" --project "$PROJECT"

echo "== 5/6 Workload Identity: GCP SA + Firestore role + KSA binding =="
gcloud iam service-accounts describe "$GSA" --project "$PROJECT" >/dev/null 2>&1 || \
  gcloud iam service-accounts create "$KSA" --project "$PROJECT" --display-name "Com Tower worker"
gcloud projects add-iam-policy-binding "$PROJECT" \
  --member "serviceAccount:${GSA}" --role roles/datastore.user --condition=None >/dev/null
gcloud iam service-accounts add-iam-policy-binding "$GSA" --project "$PROJECT" \
  --role roles/iam.workloadIdentityUser \
  --member "serviceAccount:${PROJECT}.svc.id.goog[${NAMESPACE}/${KSA}]" >/dev/null

echo "== 6/6 helm deploy =="
helm upgrade --install com-tower-worker chart/com-tower-worker \
  -f chart/com-tower-worker/values-staging.yaml \
  --namespace "$NAMESPACE" \
  --set image.repo="$IMAGE" --set image.tag="$TAG" \
  --set serviceAccount.gcpServiceAccount="$GSA" \
  ${SIGNAL_CLI_URL:+--set config.SIGNAL_CLI_URL="$SIGNAL_CLI_URL"} \
  ${SIGNAL_BOT_NUMBER:+--set secrets.SIGNAL_BOT_NUMBER="$SIGNAL_BOT_NUMBER"}

echo
echo "Done. Watch rollout:  kubectl get pods -l app.kubernetes.io/instance=com-tower-worker -w"
echo "Probe check:          kubectl port-forward svc/com-tower-worker 8080:80 & sleep 2; curl -s localhost:8080/readyz"
echo "Tear down to ~\$0:     ./gke-down.sh"
