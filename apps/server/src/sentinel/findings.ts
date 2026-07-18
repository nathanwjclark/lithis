import { z } from "zod";
import { refSchema, slugSchema } from "@lithis/core";
import type { Ref, RunBrief } from "@lithis/core";
import type { BrokeredTool } from "../agents";
import type { HumanGate } from "../humangate";
import type { IdentityService } from "../iam";

/**
 * raise_finding — the sentinel-owned handler behind the generic extra-tool
 * seam (agents BrokeredTool). Any resident agent can raise a finding in v1;
 * charter roles guide who actually does (enforcement is policy-layer work,
 * TODOS.md). A finding becomes a HumanRequest{subjectKind:'watcher_finding'}:
 *
 * - severity critical → kind 'approval' (a human must act); info/warning →
 *   'notification' (ack suffices);
 * - confidential findings get a `[confidential]`-prefixed summary — the Slack
 *   card renders ONLY the summary, while citations (with excerpts) stay in the
 *   payload, visible in the portal inbox;
 * - evidenceIds is honestly [] in v1: Evidence rows mint at finishRun, AFTER
 *   this tool has already run — mid-run evidence minting is a listed follow-up.
 *   The citations in the payload carry the substantiation until then.
 *
 * Findings→card routing costs zero new delivery code: the existing
 * delivery.cards consumer on humangate.requested renders and routes the card.
 */

export const RAISE_FINDING_TOOL = "raise_finding";

/** "kind:id" (refToString form) → Ref, or undefined when unparseable. */
export function refFromString(s: string): Ref | undefined {
  const sep = s.indexOf(":");
  if (sep <= 0) return undefined;
  const parsed = refSchema.safeParse({ kind: s.slice(0, sep), id: s.slice(sep + 1) });
  return parsed.success ? parsed.data : undefined;
}

export const findingCitationSchema = z.object({
  /** "kind:id" pointer to the record the finding rests on (doc, event, run, ...). */
  ref: z.string().refine((s) => refFromString(s) !== undefined, {
    message: "citation ref must be '<kind>:<ulid>' naming a known ref kind",
  }),
  excerpt: z.string().optional(),
  whyRelevant: z.string().min(1),
});

export const FINDING_SEVERITIES = ["info", "warning", "critical"] as const;

/** The pinned payload shape for HumanRequest{subjectKind:'watcher_finding'}. */
export const watcherFindingPayloadSchema = z.object({
  watcherSlug: slugSchema,
  severity: z.enum(FINDING_SEVERITIES),
  confidential: z.boolean().default(false),
  citations: z.array(findingCitationSchema).min(1),
});
export type WatcherFindingPayload = z.infer<typeof watcherFindingPayloadSchema>;

/** What the model supplies — watcherSlug is resolved server-side from the acting principal. */
const raiseFindingInputSchema = z.object({
  summary: z.string().min(1),
  severity: z.enum(FINDING_SEVERITIES),
  confidential: z.boolean().default(false),
  citations: z.array(findingCitationSchema).min(1),
});

export interface RaiseFindingDeps {
  humanGate: HumanGate;
  identity: IdentityService;
}

export function createRaiseFindingTool(deps: RaiseFindingDeps): BrokeredTool {
  return {
    def: {
      name: RAISE_FINDING_TOOL,
      description:
        "Raise a watcher finding for human review. Use when something you observed warrants a " +
        "person's attention: severity 'critical' asks for approval to act, 'warning'/'info' " +
        "notify. Cite at least one record (as '<kind>:<id>', e.g. 'doc:01H...') with why it is " +
        "relevant. Set confidential: true for sensitive findings (e.g. model-welfare) — then " +
        "keep the summary high-level; excerpts belong only in the citations.",
      inputSchema: {
        type: "object",
        properties: {
          summary: {
            type: "string",
            description: "2-4 sentence finding summary — what a human reviewer reads first.",
          },
          severity: { type: "string", enum: [...FINDING_SEVERITIES] },
          confidential: {
            type: "boolean",
            description:
              "True for sensitive findings: the card shows only the summary (marked " +
              "[confidential]); citations stay in the payload for the portal.",
          },
          citations: {
            type: "array",
            minItems: 1,
            items: {
              type: "object",
              properties: {
                ref: {
                  type: "string",
                  description: "Record pointer as '<kind>:<id>', e.g. 'doc:01H...'.",
                },
                excerpt: { type: "string", description: "The relevant passage, quoted." },
                whyRelevant: { type: "string", description: "Why this record supports the finding." },
              },
              required: ["ref", "whyRelevant"],
              additionalProperties: false,
            },
          },
        },
        required: ["summary", "severity", "citations"],
        additionalProperties: false,
      },
    },

    async execute(brief: RunBrief, input: unknown): Promise<string> {
      const parsed = raiseFindingInputSchema.safeParse(input ?? {});
      if (!parsed.success) {
        throw new Error(
          `raise_finding input invalid: ${parsed.error.issues
            .map((i) => `${i.path.join(".")}: ${i.message}`)
            .join("; ")}`,
        );
      }
      const watcher = await deps.identity.getPrincipal(brief.principalId);
      if (watcher === null) {
        throw new Error(`raise_finding: acting principal ${brief.principalId} not found`);
      }
      const { summary, ...finding } = parsed.data;
      const payload = watcherFindingPayloadSchema.parse({
        watcherSlug: watcher.slug,
        ...finding,
      });
      const request = await deps.humanGate.request({
        tenantId: brief.tenantId,
        kind: payload.severity === "critical" ? "approval" : "notification",
        subjectKind: "watcher_finding",
        subjectRef: refFromString(payload.citations[0]!.ref)!,
        payload,
        evidenceIds: [], // honest v1 — Evidence rows mint at finishRun, after this tool runs
        summary: payload.confidential ? `[confidential] ${summary}` : summary,
        routing: {
          assignee: "tenant-admin",
          channelPrefs: ["slack"],
          escalationPath: [],
          followUpCount: 0,
        },
        requestedBy: { kind: "principal", id: brief.principalId },
      });
      return (
        `finding raised: human request ${request.id} ` +
        `(${request.kind}, ${payload.severity}${payload.confidential ? ", confidential" : ""})`
      );
    },
  };
}
