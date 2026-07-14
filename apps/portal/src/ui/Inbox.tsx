import { useCallback, useEffect, useState } from "react";
import type { HumanRequest } from "@lithis/core";
import { isStubbedResponse, type StubbedResponse } from "./api";
import { serverUrl } from "./config";
import { StubCard } from "./StubCard";

type InboxState =
  | { phase: "loading" }
  | { phase: "stubbed"; stub: StubbedResponse }
  | { phase: "loaded"; requests: HumanRequest[] }
  | { phase: "error"; message: string };

type CardNotice = { kind: "stub"; stub: StubbedResponse } | { kind: "error"; message: string };

/**
 * The humangate inbox. Wired for real against GET /api/humangate/inbox — while
 * that endpoint is a registered stub, its 501 { stubId, reason } response is
 * the content: we render the stub card, never fabricated requests.
 */
export function Inbox() {
  const [state, setState] = useState<InboxState>({ phase: "loading" });
  const [notices, setNotices] = useState<Record<string, CardNotice>>({});
  const base = serverUrl();

  const load = useCallback(async () => {
    setState({ phase: "loading" });
    try {
      const res = await fetch(`${base}/api/humangate/inbox`);
      if (res.status === 501) {
        const body: unknown = await res.json();
        if (isStubbedResponse(body)) {
          setState({ phase: "stubbed", stub: body });
          return;
        }
        setState({ phase: "error", message: "501 response without a { stubId, reason } body" });
        return;
      }
      if (!res.ok) {
        setState({ phase: "error", message: `GET /api/humangate/inbox responded ${res.status}` });
        return;
      }
      const requests = (await res.json()) as HumanRequest[];
      setState({ phase: "loaded", requests });
    } catch (err: unknown) {
      setState({ phase: "error", message: err instanceof Error ? err.message : String(err) });
    }
  }, [base]);

  useEffect(() => {
    void load();
  }, [load]);

  const resolve = useCallback(
    async (id: string, verdict: "approved" | "denied") => {
      try {
        const res = await fetch(`${base}/api/humangate/requests/${id}/resolve`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ verdict, comment: "" }),
        });
        if (res.status === 501) {
          const body: unknown = await res.json();
          if (isStubbedResponse(body)) {
            setNotices((prev) => ({ ...prev, [id]: { kind: "stub", stub: body } }));
            return;
          }
        }
        if (!res.ok) {
          setNotices((prev) => ({
            ...prev,
            [id]: { kind: "error", message: `POST resolve responded ${res.status}` },
          }));
          return;
        }
        await load();
      } catch (err: unknown) {
        setNotices((prev) => ({
          ...prev,
          [id]: { kind: "error", message: err instanceof Error ? err.message : String(err) },
        }));
      }
    },
    [base, load],
  );

  return (
    <section>
      <h1>Inbox</h1>
      <p className="muted">Human requests routed to you — approvals, questions, notifications.</p>
      {state.phase === "loading" && <p className="muted">Loading inbox…</p>}
      {state.phase === "error" && (
        <p className="error-text">
          Could not load the inbox from {base}: {state.message}
        </p>
      )}
      {state.phase === "stubbed" && <StubCard stub={state.stub} />}
      {state.phase === "loaded" && state.requests.length === 0 && (
        <div className="empty-state">Inbox zero — no pending human requests.</div>
      )}
      {state.phase === "loaded" &&
        state.requests.map((req) => {
          const notice = notices[req.id];
          return (
            <div key={req.id} className="request-card">
              <div className="request-title">
                {req.kind} · {req.subjectKind.replace(/_/g, " ")}
              </div>
              <p className="request-summary">{req.summary}</p>
              <div className="request-meta">
                <span>state: {req.state}</span>
                <span>evidence: {req.evidenceIds.length} item(s)</span>
                {req.options && req.options.length > 0 && (
                  <span>options: {req.options.join(" / ")}</span>
                )}
              </div>
              {req.state === "pending" && (
                <div className="request-actions">
                  <button className="approve" onClick={() => void resolve(req.id, "approved")}>
                    Approve
                  </button>
                  <button className="deny" onClick={() => void resolve(req.id, "denied")}>
                    Deny
                  </button>
                </div>
              )}
              {notice?.kind === "stub" && <StubCard stub={notice.stub} />}
              {notice?.kind === "error" && <p className="error-text">{notice.message}</p>}
            </div>
          );
        })}
    </section>
  );
}
