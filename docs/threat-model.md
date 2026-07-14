# Threat model — DRAFT

> **Status: honest draft.** This documents the boundaries the architecture
> commits to and the ones it explicitly does NOT yet have. Written against the
> skeleton; revisit at every build-out phase. Open questions are listed at the
> bottom — they are real gaps, not rhetorical ones.

## Assets

- Tenant data in the context store and generated SoRs.
- Credentials: OAuth tokens, API keys, passwords, **browser sessions** (the
  worst one — a full logged-in identity in a profile).
- The agents' ability to ACT externally: send email, message on Slack,
  operate carrier portals and LinkedIn, write SoRs, modify their own skills.
- The audit trail itself (the spine).

## Adversaries considered

- **Content-level attackers**: anyone who can get text in front of an agent —
  email senders, document authors, web pages, portal counterparties. Prompt
  injection is assumed to be attempted routinely.
- **A compromised or misbehaving agent** (injected, buggy, or misaligned).
- **A curious/careless internal user** with portal access.
- Out of scope for now: malicious tenant admins, infrastructure-level
  attackers with Postgres/GCP access, supply-chain attacks on dependencies.

## Boundary 1: prompt injection

**Position: untrusted content is data, never instructions.**

- Every record carries `origin.trust: internal|partner|untrusted`
  (`packages/core/src/origin.ts`). Connector-synced and inbound content lands
  as **quarantined** Docs (`quarantined: true` is the schema default).
- **Fencing is enforced at brief assembly** — the single place context
  becomes prompt. Quarantined/partner/untrusted content is rendered inside
  data fences with its origin labeled, never spliced into instruction
  positions. (Brief assembly is currently a stub; the fencing contract is
  this paragraph plus the schema defaults.)
- Blast-radius limits when injection lands anyway: agents hold no raw
  secrets (custody brokering), externally-visible actions gate through
  HumanRequests/ActionIntents with Evidence, tool issuance is scoped by the
  ToolBroker, and every effect is a spine event — detection and audit are
  structural.

**Honest caveat:** fencing reduces, it does not eliminate. A gated-approval
model assumes the human actually reads the evidence card.

## Boundary 2: credential custody

- `Credential` rows store `custodyBackendRef` (env-file locally, Secret
  Manager on GCP) — **never values**. The GCP scripts pipe secret values from
  the operator's shell into Secret Manager and mount them into Cloud Run **by
  name** (`deploy/gcp/20-secrets.sh`, `60-deploy-server.sh`); nothing secret
  is ever committed or echoed.
- Agents receive scoped `BrokeredAuth` from `Custody.getBrokered()`; raw
  material stays out of prompts and transcripts. Every issuance is an event.

## Boundary 3: browser-session sealing

- `browser_session` credentials mount ONLY into `browserhost` pods; cookies
  never enter agent context. Agents get brokered browser ACTIONS,
  capability-checked and evented. CAPTCHA = pause + notify, never bypass.
- Humanization is **timing-only** — lithis does not attempt fingerprint
  spoofing or detection evasion beyond pacing.

## Boundary 4: egress posture

- **Workbench**: `egressPolicy: 'pr_only'` — code leaves per-tenant dev
  containers only as pull requests.
- **Server**: on GCP, Cloud Run egress routes through the VPC for private
  ranges; the server is `--no-allow-unauthenticated` by default.
- **Browserhost**: egress is currently **unrestricted** (same trade-off as
  the reference cass/openclaw deployment). A sealed session with open egress
  is still a strong boundary for credential theft, but not for data
  exfiltration by a compromised agent driving the browser. Tracked in
  TODOS.md.

## Boundary 5: the audit trail

- Append-only spine via transactional outbox; every agent effect is evented.
- `Event.prevHash/hash` reserve a tamper-evident chain — **not yet chained or
  verified** (TODOS.md). Until then, spine integrity reduces to Postgres
  access control.

## Open questions (the actual TODO list)

1. **Browserhost egress** — allowlist portals? per-request approval at the
   browser layer? Currently open.
2. **Event-chain verification** — fields exist; chaining + a verification job
   do not.
3. **Policy layer** — Grants/Mandates/PolicyEngine wiring deferred
   ([ADR-006](adr/006-policy-layer-deferred.md)); until then capability creep
   is caught by human review of `capabilityDiff`, not enforced intersection.
4. **Brief-assembly fencing spec** — the contract needs to become executable
   (tests that assert quarantined content cannot appear outside fences).
5. **Approval fatigue as a security failure mode** — humans who rubber-stamp
   evidence cards defeat every gate. Batching helps; metrics on
   time-to-approve vs. evidence-opened would tell us if it's happening.
6. **Transcript sensitivity** — transcripts are blobs in object storage;
   they may quote partner data. Retention and access policy undefined.
7. **Multi-tenant isolation depth** — row-level tenancy + schema-per-module
   today; no per-tenant encryption or RLS-enforced-by-DB review yet.
