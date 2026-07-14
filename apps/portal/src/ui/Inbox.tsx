import { useCallback, useEffect, useState } from "react";
import type { HumanRequest } from "@lithis/core";
import { apiFetch, type ApiFailure } from "./api";
import { identity, serverUrl, type PortalIdentity } from "./config";
import { FailureCard } from "./FailureCard";
import { acceptsFreeAnswer, actionsFor, buildResolution, describeParty, humanizeKind } from "./resolve";

type InboxState =
  | { phase: "loading" }
  | { phase: "failed"; failure: ApiFailure }
  | { phase: "loaded"; requests: HumanRequest[] };

/**
 * The humangate inbox — REAL, end-to-end against the P2-gate routes:
 * GET /api/humangate/inbox and POST /api/humangate/:id/resolve (proxied
 * same-origin, identity headers attached). Failure modes render honestly:
 * a 501 stub card, a 503 module-unavailable card, or an HTTP/network error —
 * never fabricated requests.
 */
export function Inbox() {
  const id = identity();
  if (id === undefined) {
    return (
      <section>
        <h1>Inbox</h1>
        <IdentityCard />
      </section>
    );
  }
  return <InboxLoaded id={id} />;
}

/** Honest empty state when the portal has no dev identity to call the API with. */
function IdentityCard() {
  return (
    <div className="notbuilt-panel">
      <div className="stub-card-badge">identity not configured</div>
      <p>
        The lithis server authenticates with <code>x-lithis-tenant</code> /{" "}
        <code>x-lithis-principal</code> dev headers, and this portal was started without them —
        so it will not call the inbox API (the server would answer 400).
      </p>
      <p className="muted">
        Seed a dev tenant with <code>bun run --cwd apps/server src/iam/seed.ts</code>, then restart
        the portal with <code>LITHIS_TENANT=… LITHIS_PRINCIPAL=… bun run dev:portal</code>.
      </p>
    </div>
  );
}

function InboxLoaded({ id }: { id: PortalIdentity }) {
  const [state, setState] = useState<InboxState>({ phase: "loading" });
  const [includeResolved, setIncludeResolved] = useState(false);
  const [selectedId, setSelectedId] = useState<string | undefined>(undefined);

  const load = useCallback(async () => {
    setState({ phase: "loading" });
    const query = includeResolved ? "?includeResolved=true" : "";
    const result = await apiFetch<HumanRequest[]>(`/api/humangate/inbox${query}`, id);
    setState(result.ok ? { phase: "loaded", requests: result.data } : { phase: "failed", failure: result.failure });
  }, [id, includeResolved]);

  useEffect(() => {
    void load();
  }, [load]);

  /** Swap in the resolved request returned by the server without a refetch. */
  const onResolved = useCallback((updated: HumanRequest) => {
    setState((prev) => {
      if (prev.phase !== "loaded") return prev;
      return {
        phase: "loaded",
        requests: prev.requests.map((r) => (r.id === updated.id ? updated : r)),
      };
    });
  }, []);

  const selected =
    state.phase === "loaded" && selectedId !== undefined
      ? state.requests.find((r) => r.id === selectedId)
      : undefined;

  if (selected !== undefined) {
    return (
      <section>
        <p>
          <a href="#/inbox" onClick={() => setSelectedId(undefined)}>
            ← back to inbox
          </a>
        </p>
        <RequestDetail id={id} request={selected} onResolved={onResolved} />
      </section>
    );
  }

  return (
    <section>
      <h1>Inbox</h1>
      <p className="muted">
        Human requests routed to you — approvals, questions, notifications. Live from{" "}
        {serverUrl()}.
      </p>
      <label className="toggle">
        <input
          type="checkbox"
          checked={includeResolved}
          onChange={(e) => setIncludeResolved(e.target.checked)}
        />{" "}
        show resolved requests
      </label>
      {state.phase === "loading" && <p className="muted">Loading inbox…</p>}
      {state.phase === "failed" && <FailureCard failure={state.failure} what="the inbox" />}
      {state.phase === "loaded" && state.requests.length === 0 && (
        <div className="empty-state">
          {includeResolved
            ? "No human requests exist for this tenant yet."
            : "Inbox zero — no pending human requests."}
        </div>
      )}
      {state.phase === "loaded" &&
        state.requests.map((req) => (
          <button
            key={req.id}
            className="request-card request-row"
            onClick={() => setSelectedId(req.id)}
          >
            <div className="request-title">
              {req.kind} · {humanizeKind(req.subjectKind)} ·{" "}
              <span className={`state state-${req.state}`}>{req.state}</span>
            </div>
            <p className="request-summary">{req.summary}</p>
            <div className="request-meta">
              <span>evidence: {req.evidenceIds.length} item(s)</span>
              {req.options && req.options.length > 0 && (
                <span>options: {req.options.join(" / ")}</span>
              )}
              <span>created {req.createdAt}</span>
            </div>
          </button>
        ))}
    </section>
  );
}

function RequestDetail({
  id,
  request,
  onResolved,
}: {
  id: PortalIdentity;
  request: HumanRequest;
  onResolved: (updated: HumanRequest) => void;
}) {
  const [comment, setComment] = useState("");
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<ApiFailure | undefined>(undefined);

  const resolve = useCallback(
    async (body: { verdict: string; comment: string }) => {
      setBusy(true);
      setFailure(undefined);
      const result = await apiFetch<HumanRequest>(`/api/humangate/${request.id}/resolve`, id, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      setBusy(false);
      if (result.ok) {
        onResolved(result.data);
      } else {
        setFailure(result.failure);
      }
    },
    [id, request.id, onResolved],
  );

  const actions = actionsFor(request);
  const freeAnswer = acceptsFreeAnswer(request);

  return (
    <div className="request-card">
      <div className="request-title">
        {request.kind} · {humanizeKind(request.subjectKind)} ·{" "}
        <span className={`state state-${request.state}`}>{request.state}</span>
      </div>
      <p className="request-summary">{request.summary}</p>
      <div className="request-meta">
        <span>id: {request.id}</span>
        <span>requested by {describeParty(request.requestedBy)}</span>
        <span>assignee: {describeParty(request.routing.assignee)}</span>
        <span>
          subject: {request.subjectRef.kind} {request.subjectRef.id}
        </span>
        <span>created {request.createdAt}</span>
      </div>

      <h2>Evidence</h2>
      {request.evidenceIds.length === 0 && (
        <p className="muted">No evidence attached to this request.</p>
      )}
      {request.evidenceIds.length > 0 && (
        <ul className="stub-list">
          {request.evidenceIds.map((evidenceId) => (
            <li key={evidenceId}>
              <code className="stub-id">{evidenceId}</code>
              <span className="muted"> — evidence record (no fetch-by-id route exposed yet)</span>
            </li>
          ))}
        </ul>
      )}

      <h2>Payload</h2>
      <pre className="payload">{JSON.stringify(request.payload ?? null, null, 2)}</pre>

      {request.resolution !== undefined && (
        <>
          <h2>Resolution</h2>
          <div className="request-meta">
            <span>verdict: {request.resolution.verdict}</span>
            <span>by {describeParty(request.resolution.by)}</span>
            <span>at {request.resolution.at}</span>
          </div>
          {request.resolution.comment !== "" && <p>{request.resolution.comment}</p>}
        </>
      )}

      {request.state === "pending" && (
        <>
          <h2>{freeAnswer ? "Answer" : "Resolve"}</h2>
          <textarea
            className="comment"
            placeholder={freeAnswer ? "Type an answer…" : "Optional comment (denials deserve one)"}
            value={comment}
            onChange={(e) => setComment(e.target.value)}
            disabled={busy}
          />
          <div className="request-actions">
            {freeAnswer && (
              <button
                className="approve"
                disabled={busy || comment.trim() === ""}
                onClick={() => void resolve({ verdict: "answered", comment })}
              >
                Answer
              </button>
            )}
            {actions.map((action) => (
              <button
                key={action.label}
                className={action.style === "danger" ? "deny" : action.style === "primary" ? "approve" : "neutral"}
                disabled={busy}
                onClick={() => void resolve(buildResolution(action, comment))}
              >
                {action.label}
              </button>
            ))}
          </div>
        </>
      )}
      {failure !== undefined && <FailureCard failure={failure} what="the resolve call" />}
    </div>
  );
}
