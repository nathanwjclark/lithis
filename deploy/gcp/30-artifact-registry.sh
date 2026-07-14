#!/usr/bin/env bash
# Artifact Registry docker repo for the two lithis images. Idempotent.
set -euo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/config.sh"

if gcloud artifacts repositories describe "${AR_REPO}" --location "${REGION}" >/dev/null 2>&1; then
  echo "Artifact Registry repo ${AR_REPO} exists — skipping."
else
  gcloud artifacts repositories create "${AR_REPO}" \
    --repository-format=docker \
    --location "${REGION}" \
    --description "lithis container images"
fi

echo "Artifact Registry ready: ${REGION}-docker.pkg.dev/${PROJECT_ID}/${AR_REPO}"
