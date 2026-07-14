import { useEffect, useState } from "react";
import type { StubRecord } from "@lithis/stubkit";
import { fetchCensus } from "./api";
import { filterByPrefixes } from "./census";
import { serverUrl } from "./config";
import type { Section } from "./route";

type PanelState =
  | { phase: "loading" }
  | { phase: "loaded"; records: StubRecord[] }
  | { phase: "error"; message: string };

/**
 * The consistent "not built yet" panel. No dummy data: it lists the registered
 * stubs behind this section, fetched live from the server's /stubs census.
 */
export function NotBuilt({ section }: { section: Section }) {
  const [state, setState] = useState<PanelState>({ phase: "loading" });
  const base = serverUrl();

  useEffect(() => {
    let cancelled = false;
    setState({ phase: "loading" });
    fetchCensus(base)
      .then((census) => {
        if (cancelled) return;
        setState({
          phase: "loaded",
          records: filterByPrefixes(census.records, section.stubPrefixes),
        });
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setState({ phase: "error", message: err instanceof Error ? err.message : String(err) });
      });
    return () => {
      cancelled = true;
    };
  }, [base, section]);

  return (
    <section>
      <h1>{section.label}</h1>
      <div className="notbuilt-panel">
        <div className="stub-card-badge">not built yet</div>
        <p>
          This page is part of the lithis skeleton. Nothing here is faked — the registered stubs
          behind it are listed below, straight from the server&apos;s live census.
        </p>
        {state.phase === "loading" && <p className="muted">Loading stub census…</p>}
        {state.phase === "error" && (
          <p className="error-text">
            Could not reach the lithis server at {base}: {state.message}
          </p>
        )}
        {state.phase === "loaded" && state.records.length === 0 && (
          <p className="muted">No registered stubs match this area yet.</p>
        )}
        {state.phase === "loaded" && state.records.length > 0 && (
          <ul className="stub-list">
            {state.records.map((record) => (
              <li key={record.id}>
                <code className="stub-id">{record.id}</code>
                <span className="stub-reason">{record.reason}</span>
              </li>
            ))}
          </ul>
        )}
      </div>
    </section>
  );
}
