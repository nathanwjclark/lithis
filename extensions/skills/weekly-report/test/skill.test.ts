import { describe, expect, test } from "bun:test";
import { skillManifestSchema } from "@lithis/core";
import type { HumanRequest, WorkItem } from "@lithis/core";
import type { SkillRunContext } from "@lithis/sdk/skills";
import { run, weeklyReportManifest, weekStartOf } from "../src/index";

describe("weekly-report manifest", () => {
  test("validates against skillManifestSchema", () => {
    expect(() => skillManifestSchema.parse(weeklyReportManifest)).not.toThrow();
  });

  test("requires read + delivery capabilities only", () => {
    expect(weeklyReportManifest.capabilitiesRequired).toContain("context.search");
    expect(weeklyReportManifest.capabilitiesRequired).toContain("delivery.send");
    // A report skill must never carry outreach capabilities.
    expect(weeklyReportManifest.capabilitiesRequired).not.toContain("browser.linkedin.connect");
  });

  test("is schedule-triggered weekly", () => {
    expect(weeklyReportManifest.triggers?.schedule).toBe("0 8 * * 1");
  });
});

describe("weekStartOf", () => {
  test("returns the Monday of the containing week (UTC)", () => {
    expect(weekStartOf("2026-07-16T15:30:00.000Z")).toBe("2026-07-13T00:00:00.000Z"); // Thu → Mon
    expect(weekStartOf("2026-07-13T00:00:00.000Z")).toBe("2026-07-13T00:00:00.000Z"); // Mon → itself
    expect(weekStartOf("2026-07-19T23:59:00.000Z")).toBe("2026-07-13T00:00:00.000Z"); // Sun → prior Mon
  });
});

const NOW = "2026-07-16T08:00:00.000Z";

function item(title: string, status: WorkItem["status"]): WorkItem {
  return { title, status } as WorkItem;
}

describe("weekly-report run", () => {
  test("compiles real counts + titles, degrades relationships honestly, delivers one digest", async () => {
    const sent: unknown[] = [];
    const ctx: SkillRunContext = {
      tenantId: "01ARZ3NDEKTSV4RRFFQ69G5FAV",
      now: NOW,
      work: {
        listRecent: async () => [
          item("reconcile ledger", "done"),
          item("chase the carrier", "blocked"),
          item("summarize renewals", "done"),
          item("in flight thing", "running"),
        ],
        dueFollowUps: async () => [],
        get: async () => undefined,
        recordFollowUpContact: async () => {},
      },
      approvals: {
        listPending: async () =>
          [{ kind: "approval", summary: "Send the renewal email?" } as HumanRequest],
        notify: async () => "01ARZ3NDEKTSV4RRFFQ69G5FAV",
      },
      connections: {
        list: async () => [
          {
            connectorSlug: "slack",
            displayName: "Acme workspace",
            status: "healthy",
            health: { lastOkAt: "2026-07-15T00:00:00.000Z" },
          } as never,
        ],
      },
      deliver: {
        send: async (input) => {
          sent.push(input);
          return { sent: true, deliveryRecordId: "01ARZ3NDEKTSV4RRFFQ69G5FAV" };
        },
      },
    };

    const result = (await run({}, ctx)) as {
      weekOf: string;
      markdown: string;
      delivery: { sent: boolean };
    };
    expect(result.weekOf).toBe("2026-07-13T00:00:00.000Z");
    expect(result.markdown).toContain("Completed: **2**");
    expect(result.markdown).toContain("Blocked: **1**");
    expect(result.markdown).toContain("reconcile ledger");
    expect(result.markdown).toContain("chase the carrier");
    expect(result.markdown).toContain("**1** pending request(s)");
    expect(result.markdown).toContain("Send the renewal email?");
    expect(result.markdown).toContain("unavailable (no relationship read surface yet)");
    expect(result.markdown).toContain("slack (Acme workspace) — healthy");
    expect(result.delivery.sent).toBe(true);
    expect(sent).toHaveLength(1);
    expect((sent[0] as { kind: string }).kind).toBe("digest");
  });

  test("absent surfaces render honest unavailable lines — never fake counts", async () => {
    const result = (await run({}, { tenantId: "01ARZ3NDEKTSV4RRFFQ69G5FAV", now: NOW })) as {
      markdown: string;
      delivery: { sent: boolean; detail?: string };
    };
    expect(result.markdown).toContain("unavailable (no work surface provided to this run)");
    expect(result.markdown).toContain("unavailable (no approvals surface provided to this run)");
    expect(result.markdown).toContain("unavailable (no connections surface provided to this run)");
    expect(result.delivery.sent).toBe(false);
    expect(result.delivery.detail).toContain("no deliver surface");
  });

  test("sections input filters what is compiled", async () => {
    const result = (await run(
      { sections: ["approvals"] },
      { tenantId: "01ARZ3NDEKTSV4RRFFQ69G5FAV", now: NOW },
    )) as { markdown: string; sections: string[] };
    expect(result.sections).toEqual(["approvals"]);
    expect(result.markdown).not.toContain("no work surface");
  });
});
