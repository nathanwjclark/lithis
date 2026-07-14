#!/usr/bin/env bash
# Deploy the lithis portal to Cloud Run, pointed at the server service.
# Idempotent: `gcloud run deploy` creates or updates in place.
set -euo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/config.sh"

SERVER_URL="$(gcloud run services describe "${SVC_SERVER}" --region "${REGION}" --format='value(status.url)')"
if [ -z "${SERVER_URL}" ]; then
  echo "ERROR: server service ${SVC_SERVER} not found — run 60-deploy-server.sh first." >&2
  exit 1
fi

gcloud run deploy "${SVC_PORTAL}" \
  --image "${IMAGE_PORTAL}:${IMAGE_TAG}" \
  --region "${REGION}" \
  --port 4401 \
  --set-env-vars "LITHIS_SERVER_URL=${SERVER_URL}" \
  --allow-unauthenticated \
  --quiet

PORTAL_URL="$(gcloud run services describe "${SVC_PORTAL}" --region "${REGION}" --format='value(status.url)')"
echo "Portal deployed: ${PORTAL_URL} → server ${SERVER_URL}"
