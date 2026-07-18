import { describe, expect, test } from "bun:test";
import { newUlid } from "@lithis/core";
import type { SkillManifest } from "@lithis/core";
import { createSkillScheduleTickSource, minuteKey } from "../src/skills";
import type { ActiveSkillRef, SkillTrigger } from "../src/skills";

/**
 * The "skills.schedule" TickSource units — fake listActive/invoker, real
 * cron matching + per-(skill, UTC minute) dedupe. Durable run rows are
 * covered by test/integration/skills.pg.test.ts.
 */

function activeSkill(schedule: string | undefined): ActiveSkillRef {
  const manifest: SkillManifest = {
    description: `skill ${newUlid()}`,
    inputSchema: { type: "object" },
    capabilitiesRequired: [],
    ...(schedule !== undefined ? { triggers: { schedule } } : {}),
    selfModBounds: { modifiablePaths: [], forbidden: [] },
  };
  return {
    tenantId: newUlid(),
    skillId: newUlid(),
    versionId: newUlid(),
    slug: `skill-${newUlid().toLowerCase()}`,
    manifest,
  };
}

function rig(skills: ActiveSkillRef[]) {
  const invoked: { slug: string; trigger: SkillTrigger }[] = [];
  const source = createSkillScheduleTickSource({
    listActive: async () => skills,
    invoker: {
      invoke: async (s, trigger) => {
        invoked.push({ slug: s.slug, trigger });
        return {
          id: newUlid(),
          tenantId: s.tenantId,
          skillId: s.skillId,
          versionId: s.versionId,
          trigger,
          input: {},
          status: "succeeded",
          startedAt: new Date().toISOString(),
        };
      },
    },
  });
  return { source, invoked };
}

// Local-time date helper (cronMatches evaluates in local time).
const at = (h: number, m: number) => new Date(2026, 6, 20, h, m); // Monday 2026-07-20

describe("skills.schedule tick source", () => {
  test("fires matching schedules with trigger 'schedule'; skips non-matching and unscheduled", async () => {
    const nineOclock = activeSkill("0 9 * * 1-5");
    const eightOclock = activeSkill("0 8 * * 1");
    const unscheduled = activeSkill(undefined);
    const { source, invoked } = rig([nineOclock, eightOclock, unscheduled]);
    expect(source.id).toBe("skills.schedule");

    await source.tick(at(9, 0));
    expect(invoked).toEqual([{ slug: nineOclock.slug, trigger: "schedule" }]);

    await source.tick(at(8, 0));
    expect(invoked).toHaveLength(2);
    expect(invoked[1]).toEqual({ slug: eightOclock.slug, trigger: "schedule" });
  });

  test("dedupes per (skill, minute): a second tick in the same minute never re-fires", async () => {
    const skill = activeSkill("* * * * *");
    const { source, invoked } = rig([skill]);
    const now = at(9, 0);
    await source.tick(now);
    await source.tick(new Date(now.getTime() + 30_000)); // same minute
    expect(invoked).toHaveLength(1);
    await source.tick(new Date(now.getTime() + 60_000)); // next minute
    expect(invoked).toHaveLength(2);
  });

  test("minuteKey is UTC-minute granular", () => {
    expect(minuteKey(new Date("2026-07-20T09:00:59.999Z"))).toBe("2026-07-20T09:00");
    expect(minuteKey(new Date("2026-07-20T09:01:00.000Z"))).toBe("2026-07-20T09:01");
  });
});
