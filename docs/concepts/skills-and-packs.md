# Skills and packs

**Git for definitions, Postgres for state.** Skills, process templates, doc
templates, and packs are authored in git via branches + PRs; the runtime
registry stores checksum-bound refs — never source.

## Skills

From `packages/core/src/skills.ts`:

```
Skill        { slug, kind: 'tool'|'report'|'workflow'|'ui_capability',
               shared, currentVersionId?, status }
SkillVersion { skillId, semver, sourceRef: { repo, ref, path }, checksum,
               manifest: { description, inputSchema, capabilitiesRequired[],
                           triggers?, selfModBounds: { modifiablePaths[], forbidden[] } },
               capabilityDiff: { added[], removed[] },
               evalRunId?, approvalRequestId?, authoredBy,
               status: 'proposed'|'approved'|'active'|'retired'|'rejected' }
```

## The lifecycle (self-modification included)

Agents may improve their own skills — inside guardrails. Every change, human-
or agent-authored, walks the same pipeline:

```
propose → evals run → PR → human approval → activate
```

1. **Propose** (`SkillRegistry.propose`) — emits `skill.version.proposed`;
   agent edits must stay within the prior version's `selfModBounds`.
2. **Evals** — the version's eval run must pass before it is approvable
   (`evalRunId`).
3. **capabilityDiff** — computed against the prior version: capabilities
   added/removed. This is the **capability-creep check** a human actually
   reviews; a "summarize" skill that suddenly wants `gmail.send` is a one-line
   diff, not a code hunt.
4. **PR + approval** — the source change merges via PR; a
   `HumanRequest{subjectKind:'skill_change'}` carries the diff + eval result.
5. **Activate** — bound to the approved `checksum`, exactly that content.
   Emits `skill.version.activated`.

`ToolBroker.toolsFor(principal, manifest)` issues tools from
`capabilitiesRequired` at run time (grant intersection deferred —
[ADR-006](../adr/006-policy-layer-deferred.md)).

## Reports are skills

There is no reporting engine. A report is a skill (`kind: 'report'`) + a
recurring WorkItem + `delivery`. `ReportDefinition { slug, skillRef, schedule,
audience, format, approvalPolicy }` exists so the portal Reports tab has
something to list.

## Packs

Packs (`extensions/packs/*`) are the domain-vertical extension point: a pack
ships **data, not engine code** —

- ProcessTemplates (e.g. the insurance-brokerage underwriting process),
- SorDescriptors (e.g. the AMS system-of-record),
- SchemaPacks (entity/doc types + link verbs),
- watcher-agent charters + configs,
- doc/artifact templates and skills.

`packs/insurance-brokerage` and `packs/linkedin-bd` are the two flagships in
the skeleton. Because packs are authored data validated by `@lithis/core`
schemas, the schemas are real even while the engines that execute them are
stubs — a pack you write today survives implementation.
