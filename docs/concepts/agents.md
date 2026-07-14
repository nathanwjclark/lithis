# Agents

lithis agents are **residents, not invocations** — long-lived, openclaw-style
daemons with durable memory that decide for themselves what to do when they
wake. The framework delivers wake reasons and enforces budgets; the agent does
the thinking.

## Principals and charters

An agent is an ordinary `Principal { kind: 'agent' }` plus an `AgentCharter`
(`packages/core/src/iam.ts`):

```
AgentCharter { principalId, role, promptRef /* doc — versioned like everything */,
               memoryBlobId /* durable agent notebook */,
               modelPolicy: { plan, execute, index },
               budgets: { usdPerRun, usdPerDay },
               wake: { heartbeat?: Cron, onEvents?: EventSelector[], onMessages: boolean } }
```

The memory blob is the agent's notebook — read at every wake, appended by the
agent itself.

## The AgentHost

`AgentHost` (stubbed in `apps/server/src/agents`) runs resident agents:

```ts
ensure(principalId): Promise<AgentHandle>;   // start/resume the daemon per its charter
wake(principalId, reason): Promise<void>;    // 'heartbeat'|'message'|'event'|'work_available'|'manual'
status(principalId): Promise<AgentStatus>;   // running | idle | sleeping(until) | stopped
```

The loop inside an agent: **wake → open Session → read charter + own memory +
inbox + claimable work → act (runs, tool calls, outbound comms, WorkNotes) →
set own next wake → close Session.** Wakes and sleeps are events
(`agent.woke { reason }`, `agent.slept { nextWakeAt? }`).

## Sessions: first-class provenance

Every wake, chat thread, executor run, and workbench stint happens inside a
`Session` (`packages/core/src/session.ts`):

```
Session { principalId, kind: 'loop'|'chat'|'run'|'workbench',
          channelRef?, transcriptBlobId?, startedAt, endedAt?, summary?, cost }
```

Runs carry `sessionId`; anything created (docs, entities, links, notes,
artifacts) points back via `origin.sessionId`. Ask "where did this record come
from?" and the answer is a session with a transcript and a cost.

## Runs and the executor

A `Run` is one agent execution inside a session, with an explicit trigger
cause (`initial | schedule | event | human | denial | modification |
new_information | upstream_invalidation`) and metered cost. The
`AgentExecutor` (Claude Agent SDK inside, stubbed) has one method:

```ts
execute(brief: RunBrief, signal: AbortSignal): Promise<RunOutcome>;
```

`RunBrief` carries the rendered context slice, `reworkInput` (reviewer
comment + modification on denial reruns), the result schema, and the budget.
`RunOutcome` carries status, resultJson, evidence drafts, new tasks, a
blocker, cost, and the transcript ref. The `AbortSignal` is load-bearing:
lease revocation during an invalidation cascade aborts in-flight runs.

Results are per-attempt `RunResult` rows — **superseded, never overwritten** —
and cite immutable `Evidence` (excerpts, screenshots, diffs, verifications)
with sources and "why relevant" annotations. Evidence is what humans review at
the [gate](human-gate.md).

## The ToolBroker

THE scope choke point:

```ts
toolsFor(p: PrincipalContext, manifest?: SkillManifest): ToolSet;
```

Tools are issued from the charter plus skill manifests
(`capabilitiesRequired`); every tool call becomes a spine event. Capabilities
tagged `network_only` are pre-filtered by [audience](context.md). Grant
intersection is deferred with the policy layer
([ADR-006](../adr/006-policy-layer-deferred.md)) — today the capability-creep
check is skill `capabilityDiff` + human review.

## Budgets and cost

Charter budgets (`usdPerRun`, `usdPerDay`) are enforced by the host; every
Run and Session records `{ tokensIn, tokensOut, usd }`, and cost roll-ups are
projections over `run.finished`/`session.ended` events — the spine is the
cost ledger.
