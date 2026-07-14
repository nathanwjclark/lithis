# Processes and invalidation

Authored, versioned process templates instantiate into runs whose nodes ARE
[WorkItems](work-graph.md) (`kind: 'process_node'`) — node state lives on the
WorkItem; there is no second state machine.

## Templates and modes

From `packages/core/src/process.ts`:

```
ProcessTemplate { slug, version, mode: 'fixed'|'adaptive'|'dynamic',
                  nodes: NodeDef[], edges: {from,to,kind:'depends_on'}[],
                  changePolicy: { allowAddNodes, allowSkip, protectedNodes[] },
                  approvalRequestId? }
NodeDef { key, title, instructions, skillRef?, inputSelectors: SelectorSpec[],
          resultSchemaRef, gate: 'always'|'auto_below_threshold'|'never', evidenceSpec? }
ProcessRun { templateRef? /* null = dynamic */, subjectRef, status, graphRevision }
```

- **fixed**: the graph is the graph.
- **adaptive**: agents may propose instance-graph changes within
  `changePolicy` — via `proposeGraphChange()`, which gates through a
  `HumanRequest{subjectKind:'template_change'}`-style review, never silently.
- **dynamic**: no template; the orchestrating agent mints the graph.

`instantiate(template, subject, bindings)` mints the node WorkItems +
WorkEdges and **binds WatchRules per instance** — selectors × bindings, so
"new information arrived" matches against THIS case's entities and doc types.

## WatchRules

```
WatchRule { processRunId, nodeKey,
            match: { topics[], docTypes?, entityRefs?, pathGlobs?, connectorKinds? },
            mode: 'deterministic'|'interpret' }
```

`deterministic` = code decides a match. `interpret` = ONE LLM run asserts
"doc D affects node N" as an auditable event; below a confidence bar it
becomes a `HumanRequest{kind:'question'}` — never a silent rerun.

## The Invalidator

**The Invalidator (pure code) is the ONLY writer of `stale`.** Three cause
sources, one mechanism (`InvalidationCause.kind`):

1. `denial` / `modification` — human deny/modify, fired at resolution time so
   dependents never sit approved on repudiated inputs;
2. `watch_deterministic` — a deterministic WatchRule matched new information;
3. `watch_interpreted` — an Interpreter assertion event.

`planInvalidation(cause)` is pure and dry-run-always: it walks `depends_on`
transitively into a `CascadePlan { dirtyNodeKey, affected[], width }`. Plans
over a width threshold become a `HumanRequest{subjectKind:'cascade_plan'}`;
small plans auto-execute. `inputsHash` on RunResults is a **suppressor**
(short-circuits no-op reruns), never an invalidation authority.

## The 7-step walkthrough

A loss-run lands in a carrier portal mid-underwriting:

1. Connector pull → `Blob(trust:'partner')` + quarantined Doc →
   `context.doc.created`; the distill pass links entities →
   `context.doc.distilled`. (Entity-scoped WatchRules subscribe to
   `distilled`; path/type rules may fire on `created`.)
2. `processes` matches instance-bound WatchRules → deterministic cause; or an
   Interpreter run asserts the cause as an event.
3. `Invalidator.plan(cause)` → `CascadePlan`. Over-threshold width → the plan
   itself gates as `HumanRequest{cascade_plan}`; small plans auto-execute.
4. `execute(plan)`: the dirty node's RunResult flips `superseded: true`, the
   node goes `done → stale → ready`; affected dependents go `stale`; their
   granted HumanRequests flip to **`superseded`** (original approvers
   notified via `humangate.superseded`); in-flight leases are revoked →
   `AbortSignal` → Run `cancelled`.
5. The rerun carries `trigger.cause: 'new_information'` (or
   `'denial'`/`'modification'` with the reviewer comment in
   `RunBrief.reworkInput`). Dependents stay stale-blocked until upstream done.
6. **Short-circuit:** if the rerun's RunResult hashes equal to the superseded
   one, downstream gets `diff: "no change"` Evidence and
   `auto_below_threshold` gates auto-approve — cascade storms die out.
7. Each gated rerun → Evidence + RunResult →
   `HumanRequest{node_result}` → `delivery` renders evidence-first cards →
   resolution events unlock dependents. Sentinel, reports, and cost metering
   ride the same event stream.

## inputsHash

The contract (see `packages/core/src/runs.ts`): sha256 over sorted
`[refKind, refId, contentDigest]` tuples — blob → its sha256, doc → body-blob
sha + frontmatter revision, run_result → canonical resultJson hash,
entity → revision. Equal hash downstream ⇒ "no change" evidence; unequal ⇒
nothing — invalidation decisions belong to the Invalidator's causes.
