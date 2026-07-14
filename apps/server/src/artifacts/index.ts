import type { Artifact, Evidence, PrincipalContext, Ulid } from "@lithis/core";
import { stubService } from "@lithis/stubkit";

/**
 * artifacts — template-driven document/image/video/email/report generation
 * plus verification. Verification IS Evidence (kind 'verification'); template
 * changes gate through HumanRequest{template_change}.
 */

export interface ArtifactTemplateRef {
  id: Ulid;
  version: string;
}

export interface VerificationReport {
  artifactId: Ulid;
  passed: boolean;
  findings: string[];
  /** The evidence record documenting exactly what was checked. */
  evidenceId: Ulid;
}

export interface ArtifactEngine {
  /** Fill + render a template; the draft artifact arrives with its render evidence. */
  render(
    t: ArtifactTemplateRef,
    inputs: unknown,
    p: PrincipalContext,
  ): Promise<{ artifact: Artifact; evidence: Evidence }>;
  /** Runs the template's deterministic + rubric checks; result is an Evidence record. */
  verify(artifactId: Ulid): Promise<VerificationReport>;
}

const artifactEngine = stubService<ArtifactEngine>(
  "server.artifacts.engine",
  ["render", "verify"],
  "LITHIS-STUB: template rendering and deterministic/rubric verification not implemented",
);

export function createArtifactEngine(): ArtifactEngine {
  return artifactEngine;
}
