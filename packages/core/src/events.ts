import { z } from "zod";
import { isoDateTimeSchema, ulidSchema } from "./ids";
import { refSchema } from "./refs";

/**
 * The event spine envelope + the topic registry. Every mutation in lithis
 * emits an Event via the transactional outbox; topics are dot-namespaced and
 * MUST be registered with defineEventType() (emitting an unregistered topic
 * is a bug — the registry is how payloads stay validated and replayable).
 */

export const topicSchema = z
  .string()
  .regex(
    /^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$/,
    "dot-namespaced topic, e.g. 'context.doc.created'",
  );
export type Topic = z.infer<typeof topicSchema>;

export const eventSeveritySchema = z.enum(["info", "warning", "critical"]);

export const eventSchema = z.object({
  id: ulidSchema,
  tenantId: ulidSchema,
  /** Monotonic per-tenant sequence assigned by the outbox (bigint as string in JSON). */
  seq: z.coerce.bigint(),
  topic: topicSchema,
  subjectRefs: z.array(refSchema),
  payload: z.unknown(),
  actor: refSchema,
  /** The event that directly caused this one. */
  causationId: ulidSchema.optional(),
  /** The whole causal chain / workflow instance. */
  correlationId: ulidSchema.optional(),
  severity: eventSeveritySchema.optional(),
  at: isoDateTimeSchema,
  /** Optional tamper-evident hash chain — fields modeled, chaining deferred (TODOS.md). */
  prevHash: z.string().optional(),
  hash: z.string().optional(),
});
export type Event = z.infer<typeof eventSchema>;

export interface EventTypeDef<P extends z.ZodTypeAny = z.ZodTypeAny> {
  topic: Topic;
  description: string;
  payload: P;
}

const registry = new Map<string, EventTypeDef>();

/**
 * Register an event topic with its payload schema. Domains call this at module
 * load; the registry is complete before the first event is emitted.
 */
export function defineEventType<P extends z.ZodTypeAny>(def: EventTypeDef<P>): EventTypeDef<P> {
  const topic = topicSchema.parse(def.topic);
  if (registry.has(topic)) {
    throw new Error(`event topic '${topic}' is already registered`);
  }
  registry.set(topic, def);
  return def;
}

export function getEventType(topic: string): EventTypeDef | undefined {
  return registry.get(topic);
}

export function listEventTypes(): EventTypeDef[] {
  return [...registry.values()].sort((a, b) => a.topic.localeCompare(b.topic));
}

export function isRegisteredTopic(topic: string): boolean {
  return registry.has(topic);
}

/** Validate a payload against its topic's registered schema. Throws on unregistered topics. */
export function validateEventPayload(topic: string, payload: unknown): unknown {
  const def = registry.get(topic);
  if (!def) {
    throw new Error(`event topic '${topic}' is not registered — call defineEventType() first`);
  }
  return def.payload.parse(payload);
}

/** Test-only: clear the registry (topics.ts re-registers on import). */
export function resetEventTypeRegistryForTests(): void {
  registry.clear();
}
