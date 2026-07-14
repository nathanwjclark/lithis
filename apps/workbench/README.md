# @lithis/workbench

The cloud development environment (pillar 5): per-tenant containers running
Claude Code, reachable as a real web app.

## What this will be

- **Per-tenant containers.** Each tenant gets isolated workspace containers;
  a workspace is a `Workspace` record in `@lithis/core` (`provisioning →
  active → idle → archived`) owned by a principal and bound to one repo+branch.
- **Real web app.** The workbench UI attaches to a running container over a
  brokered tunnel — a browser-based Claude Code session, not SSH-into-a-box.
- **PR-only egress.** Workspace containers cannot push to default branches or
  reach arbitrary hosts; the only way work leaves a workspace is a pull
  request. `Workspace.egressPolicy` is the literal `'pr_only'` — there is no
  other mode.
- **Sessions are spine events.** Every workspace lifecycle transition emits
  `workspace.status_changed` on the event spine, and workbench activity happens
  inside first-class `Session` records — sentinel watcher agents can see
  everything the workbench does.

## Status

Skeleton. The `WorkbenchHost` interface is real and typed against
`@lithis/core`; the implementation is a registered stub (`workbench.host.*`)
that throws `NotImplementedError` until the container runtime lands
(build-out phase 10).
