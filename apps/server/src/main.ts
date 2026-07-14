import { StubRegistry } from "@lithis/stubkit";
import { buildApp } from "./api";
import { loadConfig } from "./config";
import { applyMigrations, collectMigrations, createDb } from "./db";
import {
  createAgentsRuntime,
  createToolBroker,
  createUnconfiguredAgentExecutor,
  createUnconfiguredAgentHost,
} from "./agents";
import { createArtifactEngine } from "./artifacts";
import {
  createConnectionRegistry,
  createConnectorRuntime,
  createCredentialDirectory,
  createFeedExpectationTickSource,
  createPendingIngestSink,
  createSyncTickSource,
} from "./connections";
import { contextDepsFromConfig, createContextStore, createUnconfiguredContextStore } from "./context";
import { createCustody, createEnvFileBackend } from "./custody";
import { createDelivery } from "./delivery";
import { createHumanGate, slaTickSource } from "./humangate";
import { createIdentityService, createPolicyEngine } from "./iam";
import { createProcessEngine } from "./processes";
import { createWatcherHost } from "./sentinel";
import { createSkillRegistry } from "./skills";
import { createSorRuntime } from "./sor";
import { createClock, createEventSpine } from "./spine";
import { createLeaseReclaimTickSource, createWorkQueue } from "./work";

/**
 * Boot — parse config, connect Postgres when configured (running migrations
 * and constructing the REAL spine + identity over it), instantiate every
 * remaining module (registering their stubs), print the stub census so nobody
 * mistakes partial for complete, and serve the API when the role includes it.
 * The orchestrator role runs the dispatcher + clock loops.
 *
 * Convention for later phases: your newly-real service takes the shared deps
 * (db, spine, clock, ...) in its create function and occupies ONE line in the
 * services literal below — keep main.ts diffs one-line-per-phase.
 */
export async function boot(): Promise<void> {
  const config = loadConfig();

  const db = config.databaseUrl !== undefined ? createDb(config.databaseUrl) : undefined;
  if (db !== undefined) {
    const summary = await applyMigrations(config.databaseUrl!, collectMigrations());
    console.log(
      `migrations: ${summary.applied.length} applied, ${summary.skipped} already up to date`,
    );
  } else {
    console.log("DATABASE_URL not set — spine/iam run disabled; DB-less skeleton mode");
  }

  const spine = db !== undefined ? createEventSpine(db) : undefined;
  const clock = db !== undefined ? createClock() : undefined;

  // P3-connect wiring: credential directory → custody broker → connector
  // runtime → connection registry. DB-less skeleton mode skips it all (the
  // remaining custody mountSession stub still registers via module load).
  const connectivity = (() => {
    if (db === undefined || spine === undefined) return undefined;
    const credentials = createCredentialDirectory(db, spine);
    const custody = createCustody({
      db,
      spine,
      credentials,
      backend: createEnvFileBackend(config.secretsFile),
    });
    const connectorRuntime = createConnectorRuntime({
      getAuth: async (connection) => {
        const auth = await custody.issueFor(connection.credentialRef, connection.tenantId, {
          kind: "connection",
          id: connection.id,
        });
        return { kind: auth.kind, token: auth.brokerToken, expiresAt: auth.expiresAt };
      },
      redeem: async (brokerToken) => (await custody.redeem(brokerToken)).secret,
    });
    const connectionRegistry = createConnectionRegistry(db, spine, { probes: connectorRuntime });
    return { custody, connectorRuntime, connectionRegistry };
  })();

  // P7-agents wiring: the resident-agent runtime builds its own thin service
  // instances over the shared db/spine (identity/workQueue/contextStore are
  // stateless factories, so the duplicates are harmless).
  const agents =
    db !== undefined && spine !== undefined
      ? createAgentsRuntime({
          db,
          spine,
          config,
          identity: createIdentityService(db, spine),
          workQueue: createWorkQueue(db, spine),
          contextStore: createContextStore(db, spine, contextDepsFromConfig(config)),
        })
      : undefined;

  // Instantiate all module services so the census below is complete.
  const services = {
    ...(spine !== undefined ? { eventSpine: spine } : {}),
    ...(clock !== undefined ? { clock } : {}),
    ...(db !== undefined && spine !== undefined
      ? { identity: createIdentityService(db, spine) }
      : {}),
    policyEngine: createPolicyEngine(),
    ...(connectivity !== undefined
      ? { custody: connectivity.custody, connectionRegistry: connectivity.connectionRegistry }
      : {}),
    contextStore:
      db !== undefined && spine !== undefined
        ? createContextStore(db, spine, contextDepsFromConfig(config))
        : createUnconfiguredContextStore(),
    ...(db !== undefined && spine !== undefined ? { workQueue: createWorkQueue(db, spine) } : {}),
    processEngine: createProcessEngine(),
    ...(db !== undefined && spine !== undefined ? { humanGate: createHumanGate(db, spine) } : {}),
    ...(agents !== undefined
      ? { agentHost: agents.host, agentExecutor: agents.executor, toolBroker: agents.toolBroker }
      : {
          agentHost: createUnconfiguredAgentHost(),
          agentExecutor: createUnconfiguredAgentExecutor(),
          toolBroker: createToolBroker(),
        }),
    delivery: createDelivery(),
    skillRegistry: createSkillRegistry(),
    artifactEngine: createArtifactEngine(),
    sorRuntime: createSorRuntime(),
    watcherHost: createWatcherHost(),
  };

if (db !== undefined && spine !== undefined && clock !== undefined) {
    clock.registerSource(createLeaseReclaimTickSource(db, spine));
  }
  if (clock !== undefined && services.humanGate !== undefined) {
    clock.registerSource(slaTickSource(services.humanGate));
  }
  if (clock !== undefined && agents !== undefined) {
    clock.registerSource(agents.heartbeatTickSource);
  }

  console.log(`lithis server — role=${config.role} port=${config.port}`);
  console.log(StubRegistry.renderCensus());

  if (clock !== undefined && db !== undefined && spine !== undefined && connectivity !== undefined) {
    clock.registerSource(createFeedExpectationTickSource(db, spine));
    clock.registerSource(
      createSyncTickSource({
        db,
        spine,
        runtime: connectivity.connectorRuntime,
        sink: createPendingIngestSink(),
      }),
    );
  }

  if ((config.role === "orchestrator" || config.role === "all") && spine !== undefined) {
    spine.startDispatcher();
    clock?.start();
    console.log("orchestrator loops running: spine dispatcher (300ms poll), clock (30s tick)");
  }

  let server: ReturnType<typeof Bun.serve> | undefined;
  if (config.role === "api" || config.role === "all") {
    const app = buildApp({
      role: config.role,
...(services.humanGate !== undefined ? { humanGate: services.humanGate } : {}),
      ...(services.workQueue !== undefined ? { workQueue: services.workQueue } : {}),
      contextStore: services.contextStore,
    });
    server = Bun.serve({ port: config.port, fetch: app.fetch });
    console.log(`api listening on http://localhost:${config.port} — GET /health, GET /stubs`);
  } else {
    console.log(`role '${config.role}' serves no HTTP`);
  }

  const shutdown = async (): Promise<void> => {
    console.log("shutting down…");
    clock?.stop();
    await spine?.stopDispatcher();
    server?.stop();
    await db?.close();
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown());
  process.on("SIGTERM", () => void shutdown());
}

if (import.meta.main) {
  void boot();
}
