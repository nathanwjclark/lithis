import { describe, expect, test } from "bun:test";
import { z } from "zod";
import { agentCharterSchema, isRegisteredTopic, slugSchema } from "@lithis/core";
import { NotImplementedError, isStub } from "@lithis/stubkit";
import { bdAgentCharterConfig, salesNavCardSelectors } from "../src/index";

describe("salesNavCardSelectors (stub values, real type)", () => {
  test("is a registered stub value", () => {
    expect(isStub(salesNavCardSelectors)).toBe(true);
  });

  test("any selector access throws NotImplementedError until the crm scraper migrates", () => {
    expect(() => salesNavCardSelectors.name).toThrow(NotImplementedError);
    expect(() => salesNavCardSelectors.title).toThrow(NotImplementedError);
    expect(() => salesNavCardSelectors.company).toThrow(NotImplementedError);
    expect(() => salesNavCardSelectors.mutualCount).toThrow(NotImplementedError);
    expect(() => salesNavCardSelectors.profileUrl).toThrow(NotImplementedError);
    expect(() => salesNavCardSelectors.pagination).toThrow(NotImplementedError);
  });
});

/** Local schema for the { slug, role, wake } charter-config shape (wake reuses the core charter shape). */
const charterConfigSchema = z.object({
  slug: slugSchema,
  role: z.string().min(100),
  wake: agentCharterSchema.shape.wake,
});

describe("bdAgentCharterConfig (real data)", () => {
  test("validates against the { slug, role, wake } shape", () => {
    expect(() => charterConfigSchema.parse(bdAgentCharterConfig)).not.toThrow();
  });

  test("runs nightly and listens for batch resolutions + messages", () => {
    expect(bdAgentCharterConfig.wake.heartbeat).toBe("30 2 * * *");
    expect(bdAgentCharterConfig.wake.onMessages).toBe(true);
    for (const topic of bdAgentCharterConfig.wake.onEvents ?? []) {
      expect(isRegisteredTopic(topic)).toBe(true);
    }
  });

  test("role prompt encodes the guardrails: degree 2, ActionIntent batches, no unapproved contact", () => {
    expect(bdAgentCharterConfig.role).toContain("degree 2");
    expect(bdAgentCharterConfig.role).toContain("ActionIntent batch");
    expect(bdAgentCharterConfig.role).toContain("NEVER contact anyone without an approved batch");
  });
});
