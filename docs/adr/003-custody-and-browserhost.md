# ADR-003: Credential custody and sealed browser sessions

## Status

Accepted (2026-07-14).

## Context

Agents act through OAuth tokens, API keys, passwords, and — for portals with
no API (carrier extranets, LinkedIn) — real logged-in browser sessions. An
LLM-driven agent must never hold raw secrets in its context: transcripts are
stored, briefs are assembled from partially untrusted content, and prompt
injection is assumed. Browser cookies are the most dangerous credential of
all — a full session in one blob.

## Decision

A `custody` module brokers all credentials. `Credential` records store only
`custodyBackendRef` (env-file locally, Secret Manager on GCP) — never values.
Agents receive scoped, short-lived `BrokeredAuth` via
`Custody.getBrokered()`; every issuance is a spine event.

Browser sessions (`kind: 'browser_session'`) are **sealed custody assets**:
profiles mount ONLY into dedicated `apps/browserhost` pods (headed Chrome,
CDP broker, timing-only humanization, CAPTCHA = pause + notify a human).
Cookies never enter agent context; agents invoke brokered browser ACTIONS,
each capability-checked and evented. Browser connectors implement the same
`Connector` interface as API connectors.

## Consequences

- Prompt injection cannot exfiltrate what the agent never possessed.
- Every credential use is attributable (spine events) — sentinel's security
  watcher has a data source.
- Browserhost is an extra deployable and a real operational cost; that is the
  price of session sealing.
- Browser-pod egress is currently unrestricted (same trade-off as the
  cass/openclaw deployment) — acknowledged open question in TODOS.md and the
  threat model.
- Fine-grained browser-action capability taxonomy (read vs write vs outreach)
  is deferred with the policy layer (ADR-006).
