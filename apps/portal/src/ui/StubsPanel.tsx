import { useEffect, useState } from "react";
import type { StubCensus } from "@lithis/stubkit";
import { fetchCensus } from "./api";
import { groupCensus } from "./census";
import { serverUrl } from "./config";

type PanelState =
  | { phase: "loading" }
  | { phase: "loaded"; census: StubCensus }
  | { phase: "error"; message: string };

/**
 * "What's real yet" — renders the server's live stub census, grouped by area
 * prefix, with invocation counts. Every id listed here fails loudly when
 * exercised; everything NOT listed is real.
 */
export function StubsPanel() {
  const [state, setState] = useState<PanelState>({ phase: "loading" });
  const base = serverUrl();

  useEffect(() => {
    let cancelled = false;
    fetchCensus(base)
      .then((census) => {
        if (!cancelled) setState({ phase: "loaded", census });
      })
      .catch((err: unknown) => {
        if (!cancelled) {
          setState({ phase: "error", message: err instanceof Error ? err.message : String(err) });
        }
      });
    return () => {
      cancelled = true;
    };
  }, [base]);

  return (
    <section>
      <h1>What&apos;s real yet</h1>
      <p className="muted">
        The live stub census from {base}/stubs. Every entry below is a declared, registered stub —
        it throws NotImplementedError when exercised. Anything not listed is real.
      </p>
      {state.phase === "loading" && <p className="muted">Loading census…</p>}
      {state.phase === "error" && (
        <p className="error-text">
          Could not reach the lithis server at {base}: {state.message}
        </p>
      )}
      {state.phase === "loaded" && (
        <>
          <p>
            <strong>{state.census.total}</strong> registered stubs,{" "}
            <strong>{state.census.invoked}</strong> invoked at least once.
          </p>
          {state.census.total === 0 && (
            <div className="empty-state">No registered stubs — everything wired is real.</div>
          )}
          {groupCensus(state.census.records).map((group) => (
            <div key={group.area} className="census-group">
              <h2>
                <code>{group.area}</code>{" "}
                <span className="muted">
                  {group.records.length} stubs · {group.invocations} invocations
                </span>
              </h2>
              <ul className="stub-list">
                {group.records.map((record) => (
                  <li key={record.id}>
                    <code className="stub-id">{record.id}</code>
                    <span className="invocations">{record.invocations}×</span>
                    <span className="stub-reason">{record.reason}</span>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </>
      )}
    </section>
  );
}
