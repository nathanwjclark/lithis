import type { ApiFailure } from "./api";
import { StubCard } from "./StubCard";

/**
 * Honest rendering for every ApiFailure — degradation is UI state, not fake
 * data. A 501 registered stub gets the stub card; a 503 (module missing its
 * database) gets an "unavailable" card; anything else is an error card with
 * the server's own message.
 */
export function FailureCard({ failure, what }: { failure: ApiFailure; what: string }) {
  switch (failure.kind) {
    case "stub":
      return <StubCard stub={failure.stub} />;
    case "unavailable":
      return (
        <div className="notbuilt-panel">
          <div className="stub-card-badge">module unavailable</div>
          <p>
            The server answered 503 for {what} — usually a boot without <code>DATABASE_URL</code>,
            a configuration condition rather than missing code.
          </p>
          <p className="muted">{failure.message}</p>
        </div>
      );
    case "http":
      return (
        <p className="error-text">
          Loading {what} failed — HTTP {failure.status}: {failure.message}
        </p>
      );
    case "network":
      return (
        <p className="error-text">
          Could not reach the portal/server for {what}: {failure.message}
        </p>
      );
  }
}
