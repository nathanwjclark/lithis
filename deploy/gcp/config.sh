#!/usr/bin/env bash
# lithis GCP reference deploy — shared configuration.
#
# Sourced by every numbered script. NOTHING secret lives in this file — secret
# VALUES come from your shell environment and go straight into Secret Manager
# (see 20-secrets.sh). This file only names resources.
#
# Usage:
#   export PROJECT_ID=my-gcp-project
#   ./00-enable-apis.sh && ./10-network.sh && ...

set -euo pipefail

# ── REQUIRED ─────────────────────────────────────────────────────────────────
# The GCP project to deploy into. No default on purpose.
: "${PROJECT_ID:?Set PROJECT_ID to your GCP project id (export PROJECT_ID=...)}"

# ── Optional overrides (sane defaults) ───────────────────────────────────────
export REGION="${REGION:-us-central1}"

# Network
export NETWORK="${NETWORK:-lithis-vpc}"
export SUBNET="${SUBNET:-lithis-subnet}"
export SUBNET_RANGE="${SUBNET_RANGE:-10.10.0.0/24}"
# Private Services Access range for Cloud SQL private IP.
export PSA_RANGE_NAME="${PSA_RANGE_NAME:-lithis-psa-range}"

# Artifact Registry
export AR_REPO="${AR_REPO:-lithis}"
export IMAGE_SERVER="${REGION}-docker.pkg.dev/${PROJECT_ID}/${AR_REPO}/lithis-server"
export IMAGE_PORTAL="${REGION}-docker.pkg.dev/${PROJECT_ID}/${AR_REPO}/lithis-portal"
export IMAGE_TAG="${IMAGE_TAG:-latest}"

# Cloud SQL (Postgres 16 + pgvector)
export SQL_INSTANCE="${SQL_INSTANCE:-lithis-pg}"
export SQL_TIER="${SQL_TIER:-db-custom-2-8192}"
export DB_NAME="${DB_NAME:-lithis}"
export DB_USER="${DB_USER:-lithis}"

# Secret Manager secret NAMES (values are provided via env at 20-secrets.sh time):
#   ANTHROPIC_API_KEY  → secret ${SECRET_ANTHROPIC}
#   DATABASE_URL       → secret ${SECRET_DATABASE_URL}
export SECRET_ANTHROPIC="${SECRET_ANTHROPIC:-lithis-anthropic-api-key}"
export SECRET_DATABASE_URL="${SECRET_DATABASE_URL:-lithis-database-url}"

# Cloud Run services
export SVC_SERVER="${SVC_SERVER:-lithis-server}"
export SVC_PORTAL="${SVC_PORTAL:-lithis-portal}"
# Role for the server service: api | orchestrator | worker | all.
# The reference deploy runs ONE service with role=all; split roles at scale.
export SERVER_ROLE="${SERVER_ROLE:-all}"

# Cloud Scheduler (external clock-tick backstop; see 80-schedulers.sh)
export SCHEDULER_JOB_CLOCK="${SCHEDULER_JOB_CLOCK:-lithis-clock-tick}"
export SCHEDULER_SA="${SCHEDULER_SA:-lithis-scheduler}"
export CLOCK_TICK_CRON="${CLOCK_TICK_CRON:-*/5 * * * *}"

# Deploy manifest bucket (feeds the portal infrastructure map; names only, never values)
export MANIFEST_BUCKET="${MANIFEST_BUCKET:-${PROJECT_ID}-lithis-deploy}"

gcloud config set project "${PROJECT_ID}" --quiet >/dev/null

# Repo root (two levels up from deploy/gcp/) — used as the build context.
export REPO_ROOT
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
