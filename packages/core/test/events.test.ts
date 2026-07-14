import { describe, expect, test } from "bun:test";
import { z } from "zod";
import {
  defineEventType,
  eventSchema,
  getEventType,
  isRegisteredTopic,
  listEventTypes,
  newUlid,
  nowIso,
  validateEventPayload,
} from "@lithis/core";
import { ids } from "./fixtures";

describe("event envelope", () => {
  test("round-trips with bigint seq and causal ids", () => {
    const event = eventSchema.parse({
      id: newUlid(),
      tenantId: ids.tenant,
      seq: "42",
      topic: "context.doc.created",
      subjectRefs: [{ kind: "doc", id: ids.doc }],
      payload: { docType: "loss_run", connectorSlug: "filedrop" },
      actor: { kind: "connection", id: ids.connection },
      causationId: newUlid(),
      correlationId: newUlid(),
      at: nowIso(),
    });
    expect(event.seq).toBe(42n);
    expect(event.topic).toBe("context.doc.created");
  });

  test("rejects malformed topics", () => {
    const base = {
      id: newUlid(),
      tenantId: ids.tenant,
      seq: "1",
      subjectRefs: [],
      payload: {},
      actor: { kind: "principal" as const, id: ids.agentPrincipal },
      at: nowIso(),
    };
    expect(eventSchema.safeParse({ ...base, topic: "single" }).success).toBe(false);
    expect(eventSchema.safeParse({ ...base, topic: "Bad.Topic" }).success).toBe(false);
  });
});

describe("topic registry", () => {
  test("the initial catalog is registered on import (spot checks across domains)", () => {
    for (const topic of [
      "session.started",
      "context.doc.created",
      "context.doc.distilled",
      "work.item.status_changed",
      "process.cascade.executed",
      "humangate.superseded",
      "conversation.message",
      "feed.expectation.missed",
      "skill.version.activated",
      "agent.woke",
    ]) {
      expect(isRegisteredTopic(topic)).toBe(true);
    }
    expect(listEventTypes().length).toBeGreaterThanOrEqual(25);
  });

  test("every registered topic has a description and a payload schema", () => {
    for (const def of listEventTypes()) {
      expect(def.description.length).toBeGreaterThan(10);
      expect(def.payload).toBeDefined();
    }
  });

  test("payload validation enforces the registered schema", () => {
    expect(() =>
      validateEventPayload("work.item.status_changed", { from: "ready", to: "claimed", attempt: 0 }),
    ).not.toThrow();
    expect(() => validateEventPayload("work.item.status_changed", { from: 1 })).toThrow();
    expect(() => validateEventPayload("never.registered.topic", {})).toThrow(/not registered/);
  });

  test("duplicate topic registration throws", () => {
    expect(() =>
      defineEventType({ topic: "session.started", description: "dup", payload: z.object({}) }),
    ).toThrow(/already registered/);
  });

  test("conversation.message carries what welfare watchers need", () => {
    expect(() =>
      validateEventPayload("conversation.message", {
        direction: "inbound",
        channel: "slack",
        docId: newUlid(),
      }),
    ).not.toThrow();
  });
});
