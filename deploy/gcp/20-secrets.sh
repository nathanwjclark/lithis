#!/usr/bin/env bash
# Secret Manager entries. Creates the secret CONTAINERS idempotently; adds a
# version only when the corresponding env var is set in YOUR shell.
#
# REQUIRED env (values, never stored in this repo):
#   ANTHROPIC_API_KEY   — the Anthropic API key the agent executor uses.
#   DATABASE_URL        — postgres://USER:PASSWORD@PRIVATE_IP:5432/DB
#                         (private IP known after 40-cloudsql.sh — it is fine
#                          to run 40 first and re-run this script for the URL).
#
# Values are piped via --data-file=- and never echoed. Re-running with an env
# var set adds a NEW secret version (Cloud Run reads :latest).
set -euo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/config.sh"

ensure_secret() {
  local name="$1"
  if gcloud secrets describe "${name}" >/dev/null 2>&1; then
    echo "Secret ${name} exists — skipping create."
  else
    gcloud secrets create "${name}" --replication-policy=automatic
  fi
}

add_version_if_set() {
  local name="$1" value="${2:-}"
  if [ -n "${value}" ]; then
    printf '%s' "${value}" | gcloud secrets versions add "${name}" --data-file=-
    echo "Added a new version to ${name}."
  else
    echo "No value in env for ${name} — container ensured, version NOT added."
  fi
}

ensure_secret "${SECRET_ANTHROPIC}"
add_version_if_set "${SECRET_ANTHROPIC}" "${ANTHROPIC_API_KEY:-}"

ensure_secret "${SECRET_DATABASE_URL}"
add_version_if_set "${SECRET_DATABASE_URL}" "${DATABASE_URL:-}"

echo "Secrets ready: ${SECRET_ANTHROPIC}, ${SECRET_DATABASE_URL} (names only — values live in Secret Manager)."
