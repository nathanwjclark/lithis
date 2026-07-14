import { StubRegistry } from "@lithis/stubkit";
import { buildApp } from "./api";
import { loadConfig } from "./config";
import { createAgentExecutor, createAgentHost, createToolBroker } from "./agents";
import { createArtifactEngine } from "./artifacts";
import { createConnectionRegistry } from "./connections";
import { createContextStore } from "./context";
import { createCustody } from "./custody";
import { createDelivery } from "./delivery";
import { createHumanGate } from "./humangate";
import { createIdentityService, createPolicyEngine } from "./iam";
import { createProcessEngine } from "./processes";
import { createWatcherHost } from "./sentinel";
import { createSkillRegistry } from "./skills";
import { createSorRuntime } from "./sor";
import { createClock, createEventSpine } from "./spine";
import { createWorkQueue } from "./work";

/**
 * Boot — parse config, instantiate every module (registering their stubs),
 * print the stub census so nobody mistakes the skeleton for a product, and
 * serve the API when the role includes it. No DB connection in the skeleton.
 */
export function boot(): void {
  const config = loadConfig();

  // Instantiate all module services so the census below is complete.
  const services = {
    eventSpine: createEventSpine(),
    clock: createClock(),
    policyEngine: createPolicyEngine(),
    identity: createIdentityService(),
    custody: createCustody(),
    contextStore: createContextStore(),
    workQueue: createWorkQueue(),
    processEngine: createProcessEngine(),
    humanGate: createHumanGate(),
    agentHost: createAgentHost(),
    agentExecutor: createAgentExecutor(),
    toolBroker: createToolBroker(),
    connectionRegistry: createConnectionRegistry(),
    delivery: createDelivery(),
    skillRegistry: createSkillRegistry(),
    artifactEngine: createArtifactEngine(),
    sorRuntime: createSorRuntime(),
    watcherHost: createWatcherHost(),
  };

  console.log(`lithis server — role=${config.role} port=${config.port}`);
  console.log(StubRegistry.renderCensus());

  if (config.role === "api" || config.role === "all") {
    const app = buildApp({
      role: config.role,
      humanGate: services.humanGate,
      workQueue: services.workQueue,
      contextStore: services.contextStore,
    });
    Bun.serve({ port: config.port, fetch: app.fetch });
    console.log(`api listening on http://localhost:${config.port} — GET /health, GET /stubs`);
  } else {
    console.log(`role '${config.role}' serves no HTTP; orchestrator/worker loops are stubbed (see census above)`);
  }
}

if (import.meta.main) {
  boot();
}
