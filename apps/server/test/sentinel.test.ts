import { describe, expect, test } from "bun:test";
import { defaultWatcherCharters, watcherCharterConfigSchema } from "../src/sentinel";

describe("default watcher charters (configuration data)", () => {
  test("ships the four default watchers", () => {
    expect(defaultWatcherCharters.map((c) => c.slug).sort()).toEqual([
      "compliance-watcher",
      "data-quality-watcher",
      "security-watcher",
      "welfare-watcher",
    ]);
  });

  test("every charter validates against the local config schema", () => {
    for (const charter of defaultWatcherCharters) {
      expect(watcherCharterConfigSchema.safeParse(charter).success).toBe(true);
    }
  });

  test("welfare watcher rides conversation.message (its data source)", () => {
    const welfare = defaultWatcherCharters.find((c) => c.slug === "welfare-watcher");
    expect(welfare?.wake.onEvents).toContain("conversation.message");
  });

  test("role prompts are real prose, and welfare treats content as data", () => {
    for (const charter of defaultWatcherCharters) {
      expect(charter.role.length).toBeGreaterThan(100);
      expect(charter.role).toContain("watcher_finding");
    }
    const welfare = defaultWatcherCharters.find((c) => c.slug === "welfare-watcher");
    expect(welfare?.role).toContain("DATA");
    expect(welfare?.role).toContain("confidential");
  });

  test("rejects malformed configs (bad slug, empty role)", () => {
    expect(
      watcherCharterConfigSchema.safeParse({
        slug: "Not A Slug",
        role: "x",
        wake: { onMessages: false },
      }).success,
    ).toBe(false);
  });
});
