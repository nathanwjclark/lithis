# lithis — GCP reference deploy

Numbered, idempotent bash scripts that stand up the reference topology:
Cloud Run (server + portal), Cloud SQL Postgres 16 + pgvector (private IP),
Secret Manager, Artifact Registry, Cloud Scheduler, and a GCS-hosted
`deploy-manifest.json` that feeds the portal's infrastructure map.

**This directory is the ONLY gcp-aware place in the repo.** `@lithis/core` and
`apps/server` never import cloud SDKs (enforced by lint); cloud specifics live
behind adapters (`SpineDriver` → Pub/Sub, custody backend → Secret Manager)
and in these scripts. Local dev needs none of this — `docker compose up` at the
repo root is the whole story.

## Order

Every script sources `config.sh`, is safe to re-run (describe-or-create
guards), and never contains a secret value.

```bash
export PROJECT_ID=my-project          # REQUIRED (see config.sh for overrides)

./00-enable-apis.sh                   # enable the service APIs
./10-network.sh                       # VPC + subnet + private services access
./20-secrets.sh                       # secret CONTAINERS (values from env, see below)
./30-artifact-registry.sh             # docker repo
./40-cloudsql.sh                      # pg16 + pgvector, private IP (needs LITHIS_DB_PASSWORD)
DATABASE_URL=postgres://... ./20-secrets.sh   # re-run to store the URL 40 printed
./50-build-images.sh                  # cloud build from repo root, both Dockerfiles
./60-deploy-server.sh                 # cloud run, role env, secrets mounted by name
./70-deploy-portal.sh                 # cloud run, pointed at the server URL
./80-schedulers.sh                    # external clock-tick BACKSTOP (see note)
./90-deploy-manifest.sh               # write + upload deploy-manifest.json
```

## Secrets

`20-secrets.sh` creates the Secret Manager containers idempotently and adds a
version **only** when the value is present in your shell env
(`ANTHROPIC_API_KEY`, `DATABASE_URL`). Values are piped, never echoed, never
written to this repo. Cloud Run mounts them by **name** (`:latest`).

## The clock

The lithis clock is an in-process loop on any server with
`LITHIS_ROLE=orchestrator` or `all` — the reference deploy (one service,
role=all) needs no external tick. `80-schedulers.sh` installs a Cloud
Scheduler POST to `/internal/clock/tick` purely as a backstop for split-role
topologies where the orchestrator can scale to zero.

## The deploy manifest

`90-deploy-manifest.sh` describes what is deployed — service/job/secret
**names**, URLs, regions, image tags — and uploads it to
`gs://$PROJECT_ID-lithis-deploy/deploy-manifest.json`. The portal renders it
in the infrastructure map. Secret values never appear in the manifest.

## Roles

The server image is one binary with role flags. Reference: one Cloud Run
service with `SERVER_ROLE=all`. To split: run `60-deploy-server.sh` once per
role with `SVC_SERVER` and `SERVER_ROLE` overridden — exactly one
`orchestrator` (it owns the dispatcher and the clock).
