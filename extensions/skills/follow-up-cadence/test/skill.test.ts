import { describe, expect, test } from "bun:test";
import { newUlid, skillManifestSchema } from "@lithis/core";
import type { HumanRequest, WorkItem } from "@lithis/core";
import { NotImplementedError } from "@lithis/stubkit";
import type { SkillRunContext } from "@lithis/sdk/skills";
import { draftNudge, followUpCadenceManifest, run, sendEmailNudge } from "../src/index";

describe("follow-up-cadence manifest", () => {
  test("validates against skillManifestSchema", () => {
    expect(() => skillManifestSchema.parse(followUpCadenceManifest)).not.toThrow();
  });

  test("requires followUp bookkeeping + channel send capabilities", () => {
    expect(followUpCadenceManifest.capabilitiesRequired).toContain("work.followup.update");
    const sends = followUpCadenceManifest.capabilitiesRequired.filter((c) =>
      ["gmail.send", "m365.mail.send", "slack.chat.write"].includes(c),
    );
    expect(sends.length).toBeGreaterThanOrEqual(2);
  });

  test("has a weekday sweep schedule", () => {
    expect(followUpCadenceManifest.triggers?.schedule).toBe("0 9 * * 1-5");
  });
});

// 2026-07-16 is a Thursday.
const NOW = "2026-07-16T09:00:00.000Z";
const TENANT = "01ARZ3NDEKTSV4RRFFQ69G5FAV";

function dueItem(overrides: Partial<WorkItem["followUp"] & object> = {}): WorkItem {
  const entityId = newUlid();
  return {
    id: newUlid(),
    tenantId: TENANT,
    title: "chase the carrier for loss runs",
    body: "Waiting on the 5-year loss runs from the carrier.",
    status: "ready",
    createdAt: "2026-07-01T00:00:00.000Z",
    followUp: {
      counterpartRef: { kind: "entity", id: entityId },
      cadence: "0 9 * * 1-5",
      nextAt: "2026-07-16T09:00:00.000Z",
      ...overrides,
    },
  } as WorkItem;
}

interface Captured {
  ctx: SkillRunContext;
  sends: { title: string; markdown: string }[];
  contacts: { id: string; lastContactAt: string; nextAt: string }[];
  notifications: { summary: string; assigneePrincipalId?: string }[];
}

function fakeCtx(items: WorkItem[], opts: { pending?: HumanRequest[]; complete?: (p: string) => Promise<string> } = {}): Captured {
  const sends: Captured["sends"] = [];
  const contacts: Captured["contacts"] = [];
  const notifications: Captured["notifications"] = [];
  const ctx: SkillRunContext = {
    tenantId: TENANT,
    now: NOW,
    work: {
      dueFollowUps: async () => items,
      get: async (id) => items.find((i) => i.id === id),
      recordFollowUpContact: async (id, lastContactAt, nextAt) => {
        contacts.push({ id, lastContactAt, nextAt });
      },
      listRecent: async () => [],
    },
    approvals: {
      listPending: async () => opts.pending ?? [],
      notify: async (input) => {
        notifications.push({
          summary: input.summary,
          ...(input.assigneePrincipalId !== undefined
            ? { assigneePrincipalId: input.assigneePrincipalId }
            : {}),
        });
        return newUlid();
      },
    },
    deliver: {
      send: async (input) => {
        sends.push({ title: input.title, markdown: input.markdown });
        return { sent: true };
      },
    },
    ...(opts.complete !== undefined ? { complete: opts.complete } : {}),
  };
  return { ctx, sends, contacts, notifications };
}

describe("follow-up-cadence run", () => {
  test("draftNudge is deterministic from nudge-prompt.md with the item's facts", () => {
    const item = dueItem();
    const draft = draftNudge(item, NOW);
    expect(draft).toContain(item.title);
    expect(draft).toContain(item.id);
    expect(draft).toContain(`entity:${item.followUp!.counterpartRef.id}`);
    expect(draft).toContain("never (first nudge)");
    expect(draft).toContain(item.body);
    expect(draftNudge(item, NOW)).toBe(draft);
  });

  test("sweeps due items: sends the nudge, stamps lastContactAt, advances nextAt per cadence", async () => {
    const item = dueItem();
    const { ctx, sends, contacts } = fakeCtx([item]);
    const result = (await run({}, ctx)) as { swept: number; sent: { workItemId: string; nextAt: string }[] };
    expect(result.swept).toBe(1);
    expect(sends).toHaveLength(1);
    expect(sends[0]!.markdown).toContain("Outbound follow-up for");
    expect(contacts).toHaveLength(1);
    expect(contacts[0]!.lastContactAt).toBe(NOW);
    // Next weekday-09:00 fire after Thursday 09:00 is Friday 07-17 09:00 (local-time cron).
    const next = new Date(contacts[0]!.nextAt);
    expect(next.getTime()).toBeGreaterThan(Date.parse(NOW));
    expect(next.getHours()).toBe(9);
  });

  test("dryRun returns proposals and neither sends nor advances", async () => {
    const { ctx, sends, contacts } = fakeCtx([dueItem()]);
    const result = (await run({ dryRun: true }, ctx)) as {
      proposals: { kind: string; capability: string; markdown: string }[];
    };
    expect(result.proposals).toHaveLength(1);
    expect(result.proposals[0]!.kind).toBe("connector_send");
    expect(result.proposals[0]!.capability).toBe("slack.chat.write");
    expect(sends).toHaveLength(0);
    expect(contacts).toHaveLength(0);
  });

  test("escalates past escalateAfterDays via a notification, deduped against pending ones", async () => {
    const escalatee = newUlid();
    const item = dueItem({ escalateAfterDays: 10, escalateToPrincipalId: escalatee });
    // createdAt 07-01 → 15 days by NOW; threshold 10 → escalate.
    const first = fakeCtx([item]);
    const result = (await run({}, first.ctx)) as { escalated: string[] };
    expect(result.escalated).toEqual([item.id]);
    expect(first.notifications).toHaveLength(1);
    expect(first.notifications[0]!.assigneePrincipalId).toBe(escalatee);

    // A pending notification about the same item suppresses a duplicate.
    const second = fakeCtx([item], {
      pending: [
        { kind: "notification", subjectRef: { kind: "work_item", id: item.id } } as HumanRequest,
      ],
    });
    const again = (await run({}, second.ctx)) as { escalated: string[] };
    expect(again.escalated).toEqual([]);
    expect(second.notifications).toHaveLength(0);
  });

  test("LLM polish failure falls back to the deterministic template", async () => {
    const item = dueItem();
    const { ctx, sends } = fakeCtx([item], {
      complete: async () => {
        throw new Error("model unavailable");
      },
    });
    await run({}, ctx);
    expect(sends[0]!.markdown).toContain(item.title); // template facts survived
  });

  test("refuses to run without the work surface", async () => {
    await expect(run({}, { tenantId: TENANT, now: NOW })).rejects.toThrow(/work surface/);
  });

  test("the email nudge path is a loud registered stub (needs C-google/C-ms365)", () => {
    expect(() => sendEmailNudge(newUlid(), "hello")).toThrow(NotImplementedError);
  });
});
