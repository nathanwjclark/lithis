#!/usr/bin/env bash
# Build and push both images with Cloud Build from the REPO ROOT context, using
# the same Dockerfiles docker-compose builds from. Re-running rebuilds; safe.
set -euo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/config.sh"

echo "Building ${IMAGE_SERVER}:${IMAGE_TAG} ..."
gcloud builds submit "${REPO_ROOT}" \
  --config "${REPO_ROOT}/deploy/gcp/cloudbuild.server.yaml" \
  --substitutions="_IMAGE=${IMAGE_SERVER}:${IMAGE_TAG}"

echo "Building ${IMAGE_PORTAL}:${IMAGE_TAG} ..."
gcloud builds submit "${REPO_ROOT}" \
  --config "${REPO_ROOT}/deploy/gcp/cloudbuild.portal.yaml" \
  --substitutions="_IMAGE=${IMAGE_PORTAL}:${IMAGE_TAG}"

echo "Images pushed: ${IMAGE_SERVER}:${IMAGE_TAG}, ${IMAGE_PORTAL}:${IMAGE_TAG}"
