#!/usr/bin/env bash
# Cloud Scheduler skeleton for the EXTERNAL clock tick.
#
# The lithis clock (recurring schedules, followUp.nextAt wakes, FeedExpectation
# grace windows, HumanRequest SLA follow-ups) runs IN-PROCESS on the server
# when LITHIS_ROLE is `orchestrator` or `all` — the reference deploy needs no
# external tick at all. This job exists as a BACKSTOP / for topologies where
# the orchestrator is scaled to zero: it POSTs to the server's clock endpoint
# on a cadence so time-based wakes still fire.
set -euo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/config.sh"

SERVER_URL="$(gcloud run services describe "${SVC_SERVER}" --region "${REGION}" --format='value(status.url)')"
if [ -z "${SERVER_URL}" ]; then
  echo "ERROR: server service ${SVC_SERVER} not found — run 60-deploy-server.sh first." >&2
  exit 1
fi

# 1. Service account the scheduler authenticates as (server is private).
SA_EMAIL="${SCHEDULER_SA}@${PROJECT_ID}.iam.gserviceaccount.com"
if gcloud iam service-accounts describe "${SA_EMAIL}" >/dev/null 2>&1; then
  echo "Service account ${SA_EMAIL} exists — skipping."
else
  gcloud iam service-accounts create "${SCHEDULER_SA}" --display-name "lithis scheduler tick"
fi

# Allow it to invoke the server (idempotent: add-iam-policy-binding dedupes).
gcloud run services add-iam-policy-binding "${SVC_SERVER}" \
  --region "${REGION}" \
  --member "serviceAccount:${SA_EMAIL}" \
  --role roles/run.invoker \
  --quiet >/dev/null

# 2. The tick job itself.
if gcloud scheduler jobs describe "${SCHEDULER_JOB_CLOCK}" --location "${REGION}" >/dev/null 2>&1; then
  echo "Scheduler job ${SCHEDULER_JOB_CLOCK} exists — updating."
  ACTION=update
else
  ACTION=create
fi
gcloud scheduler jobs ${ACTION} http "${SCHEDULER_JOB_CLOCK}" \
  --location "${REGION}" \
  --schedule "${CLOCK_TICK_CRON}" \
  --uri "${SERVER_URL}/internal/clock/tick" \
  --http-method POST \
  --oidc-service-account-email "${SA_EMAIL}" \
  --quiet

echo "Clock-tick backstop ready: ${SCHEDULER_JOB_CLOCK} (${CLOCK_TICK_CRON}) → ${SERVER_URL}/internal/clock/tick"
