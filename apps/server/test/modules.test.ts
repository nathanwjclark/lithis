import { describe, expect, test } from "bun:test";
import { isStub, NotImplementedError } from "@lithis/stubkit";
import { createAgentExecutor, createAgentHost, createToolBroker } from "../src/agents";
import { createArtifactEngine } from "../src/artifacts";
import { createConnectionRegistry } from "../src/connections";
import { createContextStore } from "../src/context";
import { createCustody } from "../src/custody";
import { createDelivery } from "../src/delivery";
import { createHumanGate } from "../src/humangate";
import { createIdentityService, createPolicyEngine } from "../src/iam";
import { createProcessEngine } from "../src/processes";
import { createWatcherHost } from "../src/sentinel";
import { createSkillRegistry } from "../src/skills";
import { createSorRuntime } from "../src/sor";
import { createClock, createEventSpine } from "../src/spine";
import { createWorkQueue } from "../src/work";

/**
 * Every module factory returns a stubService whose methods all throw
 * NotImplementedError carrying the dot-namespaced stub id — the skeleton's
 * honesty contract.
 */

interface ServiceCase {
  name: string;
  service: object;
  idPrefix: string;
  methods: string[];
}

const cases: ServiceCase[] = [
  {
    name: "spine EventSpine",
    service: createEventSpine(),
    idPrefix: "server.spine.events",
    methods: ["append", "subscribe", "readSince"],
  },
  { name: "spine Clock", service: createClock(), idPrefix: "server.spine.clock", methods: ["tick"] },
  {
    name: "iam PolicyEngine (deferred)",
    service: createPolicyEngine(),
    idPrefix: "server.iam.policy",
    methods: ["check"],
  },
  {
    name: "iam IdentityService",
    service: createIdentityService(),
    idPrefix: "server.iam.identity",
    methods: ["createTenant", "createPrincipal", "getCharter"],
  },
  {
    name: "custody Custody",
    service: createCustody(),
    idPrefix: "server.custody.broker",
    methods: ["getBrokered", "mountSession"],
  },
  {
    name: "context ContextStore",
    service: createContextStore(),
    idPrefix: "server.context.store",
    methods: ["putBlob", "ingestDoc", "distill", "search", "paths"],
  },
  {
    name: "work WorkQueue",
    service: createWorkQueue(),
    idPrefix: "server.work.queue",
    methods: ["open", "claim", "heartbeat", "release", "complete", "addNote"],
  },
  {
    name: "processes ProcessEngine",
    service: createProcessEngine(),
    idPrefix: "server.processes.engine",
    methods: ["instantiate", "onEvent", "planInvalidation", "executeInvalidation", "proposeGraphChange"],
  },
  {
    name: "humangate HumanGate",
    service: createHumanGate(),
    idPrefix: "server.humangate.gate",
    methods: ["request", "resolve", "inbox", "tick"],
  },
  {
    name: "agents AgentHost",
    service: createAgentHost(),
    idPrefix: "server.agents.host",
    methods: ["ensure", "wake", "status"],
  },
  {
    name: "agents AgentExecutor",
    service: createAgentExecutor(),
    idPrefix: "server.agents.executor",
    methods: ["execute"],
  },
  {
    name: "agents ToolBroker",
    service: createToolBroker(),
    idPrefix: "server.agents.toolbroker",
    methods: ["toolsFor"],
  },
  {
    name: "connections ConnectionRegistry",
    service: createConnectionRegistry(),
    idPrefix: "server.connections.registry",
    methods: ["register", "list", "health", "recordFeedSeen"],
  },
  {
    name: "delivery Delivery",
    service: createDelivery(),
    idPrefix: "server.delivery.delivery",
    methods: ["render", "route"],
  },
  {
    name: "skills SkillRegistry",
    service: createSkillRegistry(),
    idPrefix: "server.skills.registry",
    methods: ["propose", "activate", "forPrincipal"],
  },
  {
    name: "artifacts ArtifactEngine",
    service: createArtifactEngine(),
    idPrefix: "server.artifacts.engine",
    methods: ["render", "verify"],
  },
  {
    name: "sor SorRuntime",
    service: createSorRuntime(),
    idPrefix: "server.sor.runtime",
    methods: ["propose", "apply", "table"],
  },
  {
    name: "sentinel WatcherHost",
    service: createWatcherHost(),
    idPrefix: "server.sentinel.watcherhost",
    methods: ["list", "ensureDefaults"],
  },
];

describe("stubbed module services", () => {
  for (const c of cases) {
    describe(c.name, () => {
      test("is marked as a stub", () => {
        expect(isStub(c.service)).toBe(true);
      });

      for (const method of c.methods) {
        test(`${method}() throws NotImplementedError with stub id ${c.idPrefix}.${method}`, () => {
          const fn = (c.service as Record<string, (...args: unknown[]) => unknown>)[method];
          expect(fn).toBeInstanceOf(Function);
          expect(() => fn!()).toThrow(NotImplementedError);
          try {
            fn!();
          } catch (err) {
            expect((err as NotImplementedError).stubId).toBe(`${c.idPrefix}.${method}`);
            expect((err as NotImplementedError).reason).toStartWith("LITHIS-STUB:");
          }
        });
      }
    });
  }

  test("factories return singletons (stub ids register exactly once)", () => {
    expect(createWorkQueue()).toBe(createWorkQueue());
    expect(createEventSpine()).toBe(createEventSpine());
    expect(createHumanGate()).toBe(createHumanGate());
  });
});
