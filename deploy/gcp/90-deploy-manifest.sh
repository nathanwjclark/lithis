#!/usr/bin/env bash
# Write deploy-manifest.json — a description of WHAT is deployed (service and
# secret NAMES, urls, regions — NEVER secret values) — and upload it to a GCS
# bucket. The portal's infrastructure map ingests this document alongside
# Connections, Workspaces, and SorDescriptors.
set -euo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/config.sh"

describe_url() {
  gcloud run services describe "$1" --region "${REGION}" --format='value(status.url)' 2>/dev/null || echo ""
}

SERVER_URL="$(describe_url "${SVC_SERVER}")"
PORTAL_URL="$(describe_url "${SVC_PORTAL}")"
SQL_STATE="$(gcloud sql instances describe "${SQL_INSTANCE}" --format='value(state)' 2>/dev/null || echo "ABSENT")"
CLOCK_STATE="$(gcloud scheduler jobs describe "${SCHEDULER_JOB_CLOCK}" --location "${REGION}" --format='value(state)' 2>/dev/null || echo "ABSENT")"

MANIFEST="$(mktemp)"
trap 'rm -f "${MANIFEST}"' EXIT

cat > "${MANIFEST}" <<EOF
{
  "kind": "lithis.deploy-manifest",
  "version": 1,
  "generatedAt": "$(date -u +%Y-%m-%dT%H:%M:%SZ)",
  "projectId": "${PROJECT_ID}",
  "region": "${REGION}",
  "services": [
    { "name": "${SVC_SERVER}", "kind": "cloud-run", "role": "${SERVER_ROLE}", "url": "${SERVER_URL}" },
    { "name": "${SVC_PORTAL}", "kind": "cloud-run", "role": "portal", "url": "${PORTAL_URL}" }
  ],
  "database": { "name": "${SQL_INSTANCE}", "kind": "cloud-sql-postgres-16", "state": "${SQL_STATE}", "database": "${DB_NAME}" },
  "jobs": [
    { "name": "${SCHEDULER_JOB_CLOCK}", "kind": "cloud-scheduler", "cron": "${CLOCK_TICK_CRON}", "state": "${CLOCK_STATE}" }
  ],
  "secrets": [
    { "name": "${SECRET_ANTHROPIC}", "purpose": "anthropic api key" },
    { "name": "${SECRET_DATABASE_URL}", "purpose": "database url" }
  ],
  "images": { "server": "${IMAGE_SERVER}:${IMAGE_TAG}", "portal": "${IMAGE_PORTAL}:${IMAGE_TAG}" },
  "network": { "vpc": "${NETWORK}", "subnet": "${SUBNET}" },
  "note": "Names and locations only. Secret VALUES never appear in this document."
}
EOF

# Bucket (idempotent).
if gcloud storage buckets describe "gs://${MANIFEST_BUCKET}" >/dev/null 2>&1; then
  echo "Bucket gs://${MANIFEST_BUCKET} exists — skipping."
else
  gcloud storage buckets create "gs://${MANIFEST_BUCKET}" --location "${REGION}"
fi

gcloud storage cp "${MANIFEST}" "gs://${MANIFEST_BUCKET}/deploy-manifest.json"
echo "Uploaded gs://${MANIFEST_BUCKET}/deploy-manifest.json"
