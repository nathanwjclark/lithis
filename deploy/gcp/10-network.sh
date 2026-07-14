#!/usr/bin/env bash
# VPC + subnet + Private Services Access, so Cloud SQL gets a private IP and
# Cloud Run reaches it via direct VPC egress. Idempotent: describe-or-create.
set -euo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/config.sh"

# 1. Custom-mode VPC.
if gcloud compute networks describe "${NETWORK}" >/dev/null 2>&1; then
  echo "VPC ${NETWORK} exists — skipping."
else
  gcloud compute networks create "${NETWORK}" --subnet-mode=custom
fi

# 2. Regional subnet (Cloud Run direct VPC egress attaches here).
if gcloud compute networks subnets describe "${SUBNET}" --region "${REGION}" >/dev/null 2>&1; then
  echo "Subnet ${SUBNET} exists — skipping."
else
  gcloud compute networks subnets create "${SUBNET}" \
    --network "${NETWORK}" \
    --region "${REGION}" \
    --range "${SUBNET_RANGE}"
fi

# 3. Allocated range for Private Services Access (Cloud SQL private IP).
if gcloud compute addresses describe "${PSA_RANGE_NAME}" --global >/dev/null 2>&1; then
  echo "PSA range ${PSA_RANGE_NAME} exists — skipping."
else
  gcloud compute addresses create "${PSA_RANGE_NAME}" \
    --global \
    --purpose=VPC_PEERING \
    --prefix-length=16 \
    --network "${NETWORK}"
fi

# 4. The service-networking peering itself.
if gcloud services vpc-peerings list --network "${NETWORK}" 2>/dev/null \
    | grep -q servicenetworking.googleapis.com; then
  echo "Service networking peering exists — skipping."
else
  gcloud services vpc-peerings connect \
    --service=servicenetworking.googleapis.com \
    --ranges="${PSA_RANGE_NAME}" \
    --network "${NETWORK}"
fi

echo "Network ready: ${NETWORK}/${SUBNET} (${REGION})."
