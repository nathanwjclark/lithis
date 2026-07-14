import { describe, expect, test } from "bun:test";
import { newUlid } from "@lithis/core";
import { decideSla, isDue, nextFollowUpAt } from "../src/humangate/sla";
import type { HumanRequestRouting } from "../src/humangate/sla";

const assigneeId = newUlid();
const escalation1 = newUlid();

function routing(overrides: Partial<HumanRequestRouting> = {}): HumanRequestRouting {
  return {
    assignee: { kind: "principal", id: assigneeId },
    channelPrefs: ["portal"],
    slaHours: 4,
    escalationPath: [{ kind: "principal", id: escalation1 }, "cro"],
    followUpCount: 0,
    nextFollowUpAt: "2026-07-14T10:00:00.000Z",
    ...overrides,
  };
}

const t = (iso: string): Date => new Date(iso);

describe("isDue", () => {
  test("due exactly at and after nextFollowUpAt, not before", () => {
    const r = routing();
    expect(isDue(r, t("2026-07-14T09:59:59.000Z"))).toBe(false);
    expect(isDue(r, t("2026-07-14T10:00:00.000Z"))).toBe(true);
    expect(isDue(r, t("2026-07-15T00:00:00.000Z"))).toBe(true);
  });

  test("never due without a scheduled wake", () => {
    const { nextFollowUpAt: _none, ...rest } = routing();
    expect(isDue(rest, t("2030-01-01T00:00:00.000Z"))).toBe(false);
  });
});

describe("nextFollowUpAt", () => {
  test("reschedules slaHours from now", () => {
    expect(nextFollowUpAt(routing({ slaHours: 4 }), t("2026-07-14T10:00:00.000Z"))).toBe(
      "2026-07-14T14:00:00.000Z",
    );
  });

  test("undefined without slaHours — nothing to reschedule from", () => {
    const { slaHours: _none, ...rest } = routing();
    expect(nextFollowUpAt(rest, t("2026-07-14T10:00:00.000Z"))).toBeUndefined();
  });
});

describe("decideSla — the ladder", () => {
  test("first due sweep follows up with the current assignee and reschedules", () => {
    const d = decideSla(routing(), t("2026-07-14T10:00:00.000Z"));
    expect(d.action).toBe("follow_up");
    expect(d.routing.followUpCount).toBe(1);
    expect(d.routing.assignee).toEqual({ kind: "principal", id: assigneeId });
    expect(d.routing.nextFollowUpAt).toBe("2026-07-14T14:00:00.000Z");
  });

  test("subsequent sweeps escalate along escalationPath in order", () => {
    const second = decideSla(routing({ followUpCount: 1 }), t("2026-07-14T14:00:00.000Z"));
    expect(second.action).toBe("escalate");
    expect(second.routing.assignee).toEqual({ kind: "principal", id: escalation1 });
    expect(second.routing.followUpCount).toBe(2);
    expect(second.routing.nextFollowUpAt).toBe("2026-07-14T18:00:00.000Z");

    const third = decideSla(second.routing, t("2026-07-14T18:00:00.000Z"));
    expect(third.action).toBe("escalate");
    expect(third.routing.assignee).toBe("cro"); // role-string escalation target
    expect(third.routing.followUpCount).toBe(3);
  });

  test("expires once the escalation path is exhausted, clearing the wake", () => {
    const d = decideSla(routing({ followUpCount: 3 }), t("2026-07-15T00:00:00.000Z"));
    expect(d.action).toBe("expire");
    expect(d.routing.followUpCount).toBe(3);
    expect(d.routing.nextFollowUpAt).toBeUndefined();
    expect("nextFollowUpAt" in d.routing).toBe(false); // absent, not undefined (exactOptionalPropertyTypes)
  });

  test("empty escalation path: one follow-up, then expiry", () => {
    const first = decideSla(routing({ escalationPath: [] }), t("2026-07-14T10:00:00.000Z"));
    expect(first.action).toBe("follow_up");
    const second = decideSla(first.routing, t("2026-07-14T14:00:00.000Z"));
    expect(second.action).toBe("expire");
  });

  test("a pinned wake without slaHours follows up once and never fires again", () => {
    const { slaHours: _none, ...noSla } = routing();
    const d = decideSla(noSla, t("2026-07-14T10:00:00.000Z"));
    expect(d.action).toBe("follow_up");
    expect(d.routing.nextFollowUpAt).toBeUndefined();
    expect(isDue(d.routing, t("2030-01-01T00:00:00.000Z"))).toBe(false);
  });
});
