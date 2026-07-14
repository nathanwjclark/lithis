#!/usr/bin/env bash
# Enable the GCP APIs the lithis reference deploy uses. Idempotent by nature.
set -euo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/config.sh"

gcloud services enable \
  run.googleapis.com \
  sqladmin.googleapis.com \
  secretmanager.googleapis.com \
  artifactregistry.googleapis.com \
  cloudbuild.googleapis.com \
  cloudscheduler.googleapis.com \
  servicenetworking.googleapis.com \
  compute.googleapis.com \
  storage.googleapis.com \
  pubsub.googleapis.com

echo "APIs enabled for ${PROJECT_ID}."
