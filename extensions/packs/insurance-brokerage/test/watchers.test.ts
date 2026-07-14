import { describe, expect, test } from "bun:test";
import { z } from "zod";
import { agentCharterSchema, isRegisteredTopic, slugSchema } from "@lithis/core";
import { njBrokerComplianceWatcher, packWatcherConfigs } from "../src/watchers";

/** Local schema for the { slug, role, wake } charter-config shape (wake reuses the core charter shape). */
const watcherCharterConfigSchema = z.object({
  slug: slugSchema,
  role: z.string().min(50),
  wake: agentCharterSchema.shape.wake,
});

describe("pack watcher charters", () => {
  test("every config validates against the { slug, role, wake } shape", () => {
    for (const config of packWatcherConfigs) {
      expect(() => watcherCharterConfigSchema.parse(config)).not.toThrow();
    }
  });

  test("nj-broker-compliance wakes on artifact events only", () => {
    expect(njBrokerComplianceWatcher.wake.onEvents).toEqual(["artifact.rendered", "artifact.verified"]);
    expect(njBrokerComplianceWatcher.wake.onMessages).toBe(false);
  });

  test("wake topics are registered spine topics", () => {
    for (const config of packWatcherConfigs) {
      for (const topic of config.wake.onEvents ?? []) {
        expect(isRegisteredTopic(topic)).toBe(true);
      }
    }
  });

  test("role prompt covers disclosure phrasing review of generated client docs", () => {
    expect(njBrokerComplianceWatcher.role).toContain("disclosure");
    expect(njBrokerComplianceWatcher.role).toContain("watcher_finding");
  });

  test("the pack does not duplicate the platform-default welfare watcher", () => {
    for (const config of packWatcherConfigs) {
      expect(config.wake.onEvents ?? []).not.toContain("conversation.message");
    }
  });
});
