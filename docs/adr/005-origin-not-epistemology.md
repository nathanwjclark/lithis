# ADR-005: Origin provenance, no epistemology layer

## Status

Accepted (2026-07-14). Supersedes the pre-amendment design's per-record
epistemology (status/source/confidence/lastVerifiedAt) carried over from
autoco.

## Context

The earlier design graded every context record's truthiness: confidence
scores, verification states, embedded review requests. In practice that put a
second review workflow inside the data layer, competing with the review
states that already live on WorkItem and HumanRequest — two places to answer
"has a human looked at this?", guaranteed to disagree. It also bloated every
schema and implied maintenance jobs to keep gradings fresh. Separately,
provenance ("who made this") and content trust ("can this be instructions?")
were two shapes (Provenance + Blob.trust) doing one job.

## Decision

- The context store **just stores information**. No fact-grading fields
  anywhere in `@lithis/core` context schemas.
- ONE merged provenance shape, stamped on blobs, docs, entities, links,
  artifacts, and generated SoR rows (`_origin`):
  `Origin { by: principal|connection, method: code|llm|human|external,
  trust: internal|partner|untrusted, sessionId?, at }`.
- Human-review states live ONLY on WorkItem and HumanRequest. Doubts about a
  record become `HumanRequest{subjectKind:'record_field'}`, whose resolution
  writes the answer back to the record.
- `origin.sessionId` makes Sessions the universal provenance trail: anything
  an agent creates traces to a session with a transcript and a cost.

## Consequences

- Schemas are smaller; ingest has no grading pass; nothing needs periodic
  re-verification jobs.
- "How much do we trust this?" is answered structurally (origin.trust +
  quarantine) for the injection boundary, and procedurally (gates + evidence)
  for decisions — not by a stored confidence float.
- If confidence tracking is ever genuinely needed, it returns as an optional
  overlay, not core schema (recorded in TODOS.md).
