import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { cronNext, refToString } from "@lithis/core";
import type { WorkItem } from "@lithis/core";
import type { SkillRun, SkillRunContext } from "@lithis/sdk/skills";
import { stub } from "@lithis/stubkit";

export { followUpCadenceManifest } from "./manifest";

/**
 * follow-up-cadence — REAL sweep over due WorkItem.followUp entries. Per
 * ADR-002, external follow-ups are connector sends, NOT HumanRequests: draft
 * the nudge deterministically from nudge-prompt.md (the selfModBounds
 * target), optionally polish it with one LLM pass (template fallback on any
 * error), send it via the delivery surface, then stamp lastContactAt and
 * advance nextAt per cadence. Escalation past escalateAfterDays opens a
 * HumanRequest{kind:"notification"} to the configured principal (internal →
 * gate is correct; delivery auto-cards it). dryRun returns the proposed
 * sends without sending or advancing anything.
 */

/**
 * Per-counterpart email nudges need entity→channel resolution plus the
 * C-google/C-ms365 send paths, none of which exist yet. Registered so the
 * census shows the gap; nothing calls it — v1 nudges go to the Slack
 * delivery channel, labeled for the counterpart.
 */
export const sendEmailNudge = stub<(workItemId: string, markdown: string) => Promise<void>>(
  "skill.follow-up-cadence.send.email",
  "LITHIS-STUB: per-counterpart email nudge not implemented — needs entity→channel resolution and the C-google/C-ms365 send connectors; v1 routes nudges to the Slack delivery channel",
);

const TEMPLATE = readFileSync(
  fileURLToPath(new URL("./nudge-prompt.md", import.meta.url)),
  "utf8",
);

const DAY_MS = 24 * 3_600_000;

function daysBetween(fromIso: string, toIso: string): number {
  return Math.floor((Date.parse(toIso) - Date.parse(fromIso)) / DAY_MS);
}

/** Deterministic draft: nudge-prompt.md with the item's facts substituted. */
export function draftNudge(item: WorkItem, nowIso: string): string {
  const followUp = item.followUp!;
  const lastContact =
    followUp.lastContactAt !== undefined
      ? `${daysBetween(followUp.lastContactAt, nowIso)} day(s) ago (${followUp.lastContactAt.slice(0, 10)})`
      : "never (first nudge)";
  return TEMPLATE.replaceAll("{{title}}", item.title)
    .replaceAll("{{workItemId}}", item.id)
    .replaceAll("{{counterpart}}", refToString(followUp.counterpartRef))
    .replaceAll("{{lastContact}}", lastContact)
    .replaceAll("{{body}}", item.body)
    .trim();
}

async function polish(ctx: SkillRunContext, draft: string): Promise<string> {
  if (ctx.complete === undefined) return draft;
  try {
    const polished = await ctx.complete(
      `Polish this follow-up nudge into a short, friendly, professional message. ` +
        `Keep every fact; do not invent any. Reply with the message only.\n\n${draft}`,
    );
    return polished.trim().length > 0 ? polished.trim() : draft;
  } catch {
    return draft; // template fallback — an LLM hiccup never blocks the cadence
  }
}

interface NudgeProposal {
  kind: "connector_send";
  capability: "slack.chat.write";
  workItemId: string;
  counterpart: string;
  markdown: string;
}

export const run: SkillRun = async (input, ctx) => {
  if (ctx.work === undefined) {
    throw new Error("follow-up-cadence needs the work surface — none was provided to this run");
  }
  const dryRun = input["dryRun"] === true;
  const workItemId = typeof input["workItemId"] === "string" ? input["workItemId"] : undefined;

  const due: WorkItem[] =
    workItemId !== undefined
      ? [await ctx.work.get(workItemId)].filter(
          (w): w is WorkItem => w !== undefined && w.followUp !== undefined,
        )
      : await ctx.work.dueFollowUps(ctx.now);

  const proposals: NudgeProposal[] = [];
  const sent: { workItemId: string; nextAt: string }[] = [];
  const notSent: { workItemId: string; detail?: string }[] = [];
  const escalated: string[] = [];

  for (const item of due) {
    const followUp = item.followUp!;
    const markdown = await polish(ctx, draftNudge(item, ctx.now));
    const counterpart = refToString(followUp.counterpartRef);

    if (dryRun) {
      proposals.push({
        kind: "connector_send",
        capability: "slack.chat.write",
        workItemId: item.id,
        counterpart,
        markdown,
      });
      continue;
    }

    // Escalation check BEFORE this nudge advances the cadence: the item has
    // waited on the counterpart for escalateAfterDays since it was opened.
    // De-duplicated against already-pending notifications for this item.
    if (
      followUp.escalateAfterDays !== undefined &&
      daysBetween(item.createdAt, ctx.now) >= followUp.escalateAfterDays &&
      ctx.approvals !== undefined
    ) {
      const pending = await ctx.approvals.listPending();
      const already = pending.some(
        (r) => r.kind === "notification" && r.subjectRef.id === item.id,
      );
      if (!already) {
        await ctx.approvals.notify({
          summary:
            `Follow-up escalation: "${item.title}" has waited on ${counterpart} for ` +
            `${daysBetween(item.createdAt, ctx.now)} day(s) (threshold ${followUp.escalateAfterDays}).`,
          subjectRef: { kind: "work_item", id: item.id },
          ...(followUp.escalateToPrincipalId !== undefined
            ? { assigneePrincipalId: followUp.escalateToPrincipalId }
            : {}),
          payload: { workItemId: item.id, escalateAfterDays: followUp.escalateAfterDays },
        });
        escalated.push(item.id);
      }
    }

    const outcome =
      ctx.deliver !== undefined
        ? await ctx.deliver.send({
            kind: "nudge",
            title: `Follow-up due: ${item.title} → ${counterpart}`,
            markdown: `_Outbound follow-up for ${counterpart}:_\n\n${markdown}`,
            workItemId: item.id,
          })
        : { sent: false, detail: "no deliver surface provided to this run" };

    if (outcome.sent) {
      const nextAt = cronNext(followUp.cadence, new Date(ctx.now));
      if (nextAt === undefined) {
        throw new Error(
          `cadence '${followUp.cadence}' on work item ${item.id} never fires within the scan window`,
        );
      }
      await ctx.work.recordFollowUpContact(item.id, ctx.now, nextAt.toISOString());
      sent.push({ workItemId: item.id, nextAt: nextAt.toISOString() });
    } else {
      notSent.push({
        workItemId: item.id,
        ...(outcome.detail !== undefined ? { detail: outcome.detail } : {}),
      });
    }
  }

  return { swept: due.length, dryRun, ...(dryRun ? { proposals } : { sent, notSent, escalated }) };
};
