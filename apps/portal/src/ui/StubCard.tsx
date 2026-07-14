import type { StubbedResponse } from "./api";

/**
 * The "registered stub" card — honesty as UI. When a server endpoint responds
 * 501 with { stubId, reason }, we show exactly that: the stub id, the reason
 * (which carries the LITHIS-STUB: token), and nothing invented.
 */
export function StubCard({ stub }: { stub: StubbedResponse }) {
  return (
    <div className="stub-card">
      <div className="stub-card-badge">registered stub — not implemented</div>
      <code className="stub-id">{stub.stubId}</code>
      <p className="stub-reason">{stub.reason}</p>
    </div>
  );
}
