#!/usr/bin/env bash
# Tear down the GKE staging env so idle cost -> ~$0. Deletes the Autopilot cluster (stops all node
# compute + any Ingress load balancer). Keeps the Artifact Registry images and the GCP service
# account (pennies) so gke-up.sh comes back fast. Prod on Cloud Run is untouched.
set -euo pipefail
export CLOUDSDK_ACTIVE_CONFIG_NAME="${CLOUDSDK_ACTIVE_CONFIG_NAME:-com-tower}"
PROJECT="${PROJECT_ID:-com-tower}"
REGION="${REGION:-us-central1}"
CLUSTER="${CLUSTER:-com-tower-staging}"

echo "Deleting Autopilot cluster ${CLUSTER} (${REGION})..."
gcloud container clusters delete "$CLUSTER" --region "$REGION" --project "$PROJECT" --quiet
echo "Cluster deleted — node compute + load balancer billing stopped."
echo
echo "Kept (near-zero cost, so re-up is fast): Artifact Registry '${AR_REPO:-com-tower}' + GCP SA com-tower-worker."
echo "To remove those too:"
echo "  gcloud artifacts repositories delete ${AR_REPO:-com-tower} --location ${REGION} --project ${PROJECT} --quiet"
echo "  gcloud iam service-accounts delete com-tower-worker@${PROJECT}.iam.gserviceaccount.com --project ${PROJECT} --quiet"
