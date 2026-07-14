#!/usr/bin/env bash
# Deploy the lithis server to Cloud Run. `gcloud run deploy` is idempotent
# (creates or updates in place). Secrets are MOUNTED BY NAME from Secret
# Manager — this script never sees their values.
#
# Reference topology: one service, LITHIS_ROLE=all (api + orchestrator +
# worker in-process). To split roles, deploy this script multiple times with
# SVC_SERVER + SERVER_ROLE overridden (exactly one orchestrator!).
set -euo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/config.sh"

# The server is private by default; set SERVER_ALLOW_UNAUTH=true for demos.
AUTH_FLAG="--no-allow-unauthenticated"
if [ "${SERVER_ALLOW_UNAUTH:-false}" = "true" ]; then
  AUTH_FLAG="--allow-unauthenticated"
fi

gcloud run deploy "${SVC_SERVER}" \
  --image "${IMAGE_SERVER}:${IMAGE_TAG}" \
  --region "${REGION}" \
  --network "${NETWORK}" \
  --subnet "${SUBNET}" \
  --vpc-egress private-ranges-only \
  --port 4400 \
  --set-env-vars "LITHIS_ROLE=${SERVER_ROLE}" \
  --set-secrets "DATABASE_URL=${SECRET_DATABASE_URL}:latest,ANTHROPIC_API_KEY=${SECRET_ANTHROPIC}:latest" \
  ${AUTH_FLAG} \
  --quiet

SERVER_URL="$(gcloud run services describe "${SVC_SERVER}" --region "${REGION}" --format='value(status.url)')"
echo "Server deployed: ${SERVER_URL} (role=${SERVER_ROLE})"
