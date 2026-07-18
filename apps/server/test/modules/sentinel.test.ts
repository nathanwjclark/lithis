import { describe, expect, test } from "bun:test";
import { newUlid } from "@lithis/core";
import type { HumanRequest, Principal, RunBrief } from "@lithis/core";
import type { NewHumanRequest } from "../../src/humangate";
import type { IdentityService } from "../../src/iam";
import {
  createRaiseFindingTool,
  createUnconfiguredWatcherHost,
  defaultWatcherCharters,
  refFromString,
  watcherFindingPayloadSchema,
  RAISE_FINDING_TOOL,
} from "../../src/sentinel";

/**
 * Sentinel units — the shipped watcher configs, the finding payload contract,
 * and the raise_finding tool over fake collaborators (fakes are exactly right
 * here: the tool's HumanGate/Identity calls are the behavior under test; the
 * real gate is covered by the pg integration suite).
 */

describe("default watcher charters", () => {
  test("ships the four default watchers with unique slugs", () => {
    expect(defaultWatcherCharters.length).toBe(4);
    expect(new Set(defaultWatcherCharters.map((c) => c.slug))).toEqual(
      new Set(["compliance-watcher", "welfare-watcher", "security-watcher", "data-quality-watcher"]),
    );
  });

  test("the welfare watcher rides conversation.message", () => {
    const welfare = defaultWatcherCharters.find((c) => c.slug === "welfare-watcher");
    expect(welfare?.wake.onEvents).toEqual(["conversation.message"]);
    expect(welfare?.wake.onMessages).toBe(false);
  });
});

describe("watcher finding payload schema", () => {
  test("requires at least one parseable citation", () => {
    const base = { watcherSlug: "welfare-watcher", severity: "warning" };
    expect(watcherFindingPayloadSchema.safeParse({ ...base, citations: [] }).success).toBe(false);
    expect(
      watcherFindingPayloadSchema.safeParse({
        ...base,
        citations: [{ ref: "not-a-ref", whyRelevant: "x" }],
      }).success,
    ).toBe(false);
    const ok = watcherFindingPayloadSchema.parse({
      ...base,
      citations: [{ ref: `doc:${newUlid()}`, whyRelevant: "the concerning message" }],
    });
    expect(ok.confidential).toBe(false); // defaulted
  });

  test("refFromString round-trips 'kind:id' and rejects unknown kinds", () => {
    const id = newUlid();
    expect(refFromString(`doc:${id}`)).toEqual({ kind: "doc", id });
    expect(refFromString(`flurb:${id}`)).toBeUndefined();
    expect(refFromString("doc")).toBeUndefined();
  });
});

describe("raise_finding tool", () => {
  interface Harness {
    execute: (input: unknown) => Promise<string>;
    requests: NewHumanRequest[];
    brief: RunBrief;
  }

  function harness(): Harness {
    const requests: NewHumanRequest[] = [];
    const tenantId = newUlid();
    const principalId = newUlid();
    const watcher: Principal = {
      id: principalId,
      tenantId,
      kind: "agent",
      slug: "welfare-watcher",
      displayName: "Welfare Watcher",
      status: "active",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    const identity = {
      getPrincipal: async (id: string) => (id === principalId ? watcher : null),
    } as unknown as IdentityService;
    const humanGate = {
      request: async (r: NewHumanRequest): Promise<HumanRequest> => {
        requests.push(r);
        const at = new Date().toISOString();
        return { ...r, id: newUlid(), state: "pending", createdAt: at, updatedAt: at };
      },
    } as unknown as import("../../src/humangate").HumanGate;
    const tool = createRaiseFindingTool({ humanGate, identity });
    const brief: RunBrief = {
      tenantId,
      principalId,
      contextSlice: "brief",
      budget: { usd: 1, maxMinutes: 5 },
    };
    return { execute: (input) => tool.execute(brief, input), requests, brief };
  }

  const citation = { ref: `doc:${newUlid()}`, excerpt: "quoted text", whyRelevant: "shows the pattern" };

  test("def: named raise_finding with a citations-required schema", () => {
    const tool = createRaiseFindingTool({
      humanGate: {} as never,
      identity: {} as never,
    });
    expect(tool.def.name).toBe(RAISE_FINDING_TOOL);
    expect((tool.def.inputSchema["required"] as string[])).toEqual([
      "summary",
      "severity",
      "citations",
    ]);
  });

  test("warning finding → notification with the pinned payload and the watcher slug", async () => {
    const h = harness();
    const result = await h.execute({
      summary: "A concerning interaction pattern",
      severity: "warning",
      citations: [citation],
    });
    expect(result).toContain("finding raised: human request");
    expect(h.requests.length).toBe(1);
    const r = h.requests[0]!;
    expect(r.kind).toBe("notification");
    expect(r.subjectKind).toBe("watcher_finding");
    expect(r.subjectRef).toEqual(refFromString(citation.ref)!);
    expect(r.summary).toBe("A concerning interaction pattern");
    expect(r.evidenceIds).toEqual([]);
    expect(r.requestedBy).toEqual({ kind: "principal", id: h.brief.principalId });
    const payload = watcherFindingPayloadSchema.parse(r.payload);
    expect(payload.watcherSlug).toBe("welfare-watcher");
    expect(payload.citations).toEqual([citation]);
  });

  test("critical → approval; confidential prefixes the summary, citations stay in payload", async () => {
    const h = harness();
    await h.execute({
      summary: "Immediate action needed",
      severity: "critical",
      confidential: true,
      citations: [citation],
    });
    const r = h.requests[0]!;
    expect(r.kind).toBe("approval");
    expect(r.summary).toBe("[confidential] Immediate action needed");
    const payload = watcherFindingPayloadSchema.parse(r.payload);
    expect(payload.confidential).toBe(true);
    expect(payload.citations[0]!.excerpt).toBe("quoted text");
  });

  test("invalid input throws (no citations / bad ref) without opening a request", async () => {
    const h = harness();
    await expect(
      h.execute({ summary: "x", severity: "warning", citations: [] }),
    ).rejects.toThrow(/raise_finding input invalid/);
    await expect(
      h.execute({ summary: "x", severity: "warning", citations: [{ ref: "nope", whyRelevant: "y" }] }),
    ).rejects.toThrow(/raise_finding input invalid/);
    expect(h.requests.length).toBe(0);
  });
});

describe("unconfigured watcher host", () => {
  test("fails loudly naming the missing configuration", () => {
    const host = createUnconfiguredWatcherHost();
    expect(() => host.ensureDefaults(newUlid())).toThrow(/DATABASE_URL is not set/);
    expect(() => host.list(newUlid())).toThrow(/DATABASE_URL is not set/);
  });
});
