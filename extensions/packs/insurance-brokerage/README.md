# @lithis/pack-insurance-brokerage

The flagship domain pack: everything a commercial-lines brokerage needs to run
SMB underwriting on lithis. A pack is **authored data** — process templates,
SoR descriptors, schema extensions, and watcher charters — consumed by engines
that live in the server. All four surfaces here are real, validated data; the
engines that execute them are the skeleton's stubs.

## Contents

- **`process-underwriting.ts`** — the `underwriting-smb` ProcessTemplate
  (mode `fixed`, 8 nodes): intake → loss history / exposure analysis →
  carrier appetite match → quote comparison → compliance check → proposal →
  bind request. Human gates where money and liability move
  (`loss_history_analysis`, `quote_comparison`, `compliance_check`,
  `bind_request` are `always`); `compliance_check` and `bind_request` are
  protected nodes that no instance-level graph change may skip. Exported as a
  DRAFT: server-assigned fields (id, tenantId, timestamps) are attached at
  proposal time.
- **`sor-ams.ts`** — the AMS (agency management system) SorDescriptor draft:
  `clients`, `policies`, `carriers`, `commissions` tables with entity bindings
  back into the context store (`clients.legal_name` / `carriers.name` →
  `company`). The SoR runtime adds `_entityRef` + `_origin` columns to every
  table; migrations are approval-gated.
- **`schema-pack.ts`** — context-store extensions: entity types `carrier` and
  `policy_line`; doc types `loss_run`, `acord_submission`, `quote`, `binder`;
  link verbs `insures/insured_by`, `broker_of/brokered_by`,
  `quoted/quoted_by`.
- **`watchers.ts`** — pack-level watcher-agent charters (sentinel is agents +
  configs, not framework schemas): an `nj-broker-compliance` watcher that
  reviews generated client documents for required broker disclosure phrasing,
  waking on `artifact.rendered` / `artifact.verified`. The platform-default
  welfare watcher already covers `conversation.message`, so the pack does not
  duplicate it.

## The demo narrative this pack powers

A loss run lands on the carrier SFTP (filedrop connector) mid-underwriting →
distill links it to the case → the instance-bound WatchRule fires → the
Invalidator stales `loss_history_analysis` and its dependents → reruns produce
fresh evidence → the gated nodes come back to the broker as evidence-first
approval cards → compliance check re-verifies disclosure phrasing before the
proposal ever reaches the client.
