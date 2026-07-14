#!/usr/bin/env bash
# Cloud SQL: Postgres 16 with private IP on the lithis VPC. pgvector ships with
# Cloud SQL Postgres 16 — it still needs `CREATE EXTENSION vector` per database,
# which `lithis migrate` runs as its first migration (context module).
#
# REQUIRED env:
#   LITHIS_DB_PASSWORD  — password for the ${DB_USER} database user.
#                         Used once here, never written to disk by this script.
#
# After this script: compose DATABASE_URL from the printed private IP and
# re-run 20-secrets.sh with DATABASE_URL set to store it in Secret Manager.
set -euo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/config.sh"

: "${LITHIS_DB_PASSWORD:?Set LITHIS_DB_PASSWORD for the ${DB_USER} database user}"

# 1. Instance (private IP only — no public address).
if gcloud sql instances describe "${SQL_INSTANCE}" >/dev/null 2>&1; then
  echo "Cloud SQL instance ${SQL_INSTANCE} exists — skipping create."
else
  gcloud sql instances create "${SQL_INSTANCE}" \
    --database-version=POSTGRES_16 \
    --tier="${SQL_TIER}" \
    --region="${REGION}" \
    --network="projects/${PROJECT_ID}/global/networks/${NETWORK}" \
    --no-assign-ip
fi

# 2. Database.
if gcloud sql databases describe "${DB_NAME}" --instance "${SQL_INSTANCE}" >/dev/null 2>&1; then
  echo "Database ${DB_NAME} exists — skipping."
else
  gcloud sql databases create "${DB_NAME}" --instance "${SQL_INSTANCE}"
fi

# 3. User (idempotent: set-password on re-run instead of failing).
if gcloud sql users list --instance "${SQL_INSTANCE}" --format='value(name)' | grep -qx "${DB_USER}"; then
  echo "User ${DB_USER} exists — updating password from env."
  gcloud sql users set-password "${DB_USER}" --instance "${SQL_INSTANCE}" --password "${LITHIS_DB_PASSWORD}"
else
  gcloud sql users create "${DB_USER}" --instance "${SQL_INSTANCE}" --password "${LITHIS_DB_PASSWORD}"
fi

PRIVATE_IP="$(gcloud sql instances describe "${SQL_INSTANCE}" \
  --format='value(ipAddresses[0].ipAddress)')"

echo "Cloud SQL ready: ${SQL_INSTANCE} (private IP ${PRIVATE_IP})."
echo "Next: export DATABASE_URL=\"postgres://${DB_USER}:<password>@${PRIVATE_IP}:5432/${DB_NAME}\" and re-run 20-secrets.sh."
