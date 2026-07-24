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
import { createArtifactEngine, createUnconfiguredArtifactEngine } from "./artifacts";
import {
  createConnectionRegistry,
  createConnectorRuntime,
  createCredentialDirectory,
  createFeedExpectationTickSource,
  createPendingIngestSink,
  createSyncTickSource,
} from "./connections";
import { contextDepsFromConfig, createContextStore, createUnconfiguredContextStore } from "./context";
import { createSlackConnector } from "@lithis/connector-slack";
import { createCustody, createEnvFileBackend } from "./custody";
import {
  attachDeliverySubscriptions,
  createDelivery,
  createSocketModeClient,
  createUnconfiguredDelivery,
} from "./delivery";
import { createHumanGate, slaTickSource } from "./humangate";
import { createIdentityService, createPolicyEngine, findDevSeed } from "./iam";
import {
  createProcessEngine,
  createUnconfiguredProcessEngine,
  subscribeProcessEngine,
} from "./processes";
import {
  attachSentinel,
  createRaiseFindingTool,
  createUnconfiguredWatcherHost,
  createWatcherHost,
} from "./sentinel";
import {
  createSkillRuntime,
  createSkillsService,
  createUnconfiguredSkillRegistry,
  ensureDevSkillsSeed,
} from "./skills";
import { followUpCadenceManifest, run as followUpCadenceRun } from "@lithis/skill-follow-up-cadence";
import { linkedinOutreachManifest, run as linkedinOutreachRun } from "@lithis/skill-linkedin-outreach";
import { weeklyReportManifest, run as weeklyReportRun } from "@lithis/skill-weekly-report";
import { createSorRuntime, createUnconfiguredSorRuntime } from "./sor";
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
    const authProvider = {
      getAuth: async (connection: import("@lithis/core").Connection) => {
        const auth = await custody.issueFor(connection.credentialRef, connection.tenantId, {
          kind: "connection" as const,
          id: connection.id,
        });
        return { kind: auth.kind, token: auth.brokerToken, expiresAt: auth.expiresAt };
      },
      redeem: async (brokerToken: string) => (await custody.redeem(brokerToken)).secret,
    };
    const connectorRuntime = createConnectorRuntime(authProvider);
    connectorRuntime.register(createSlackConnector); // P6-deliver: slack is a first-class citizen of every db-backed boot
    const connectionRegistry = createConnectionRegistry(db, spine, { probes: connectorRuntime });
    return { custody, authProvider, connectorRuntime, connectionRegistry };
  })();

  // Hoisted shared services: delivery composes over humangate/context/
  // connectivity, and the agents runtime shares the work queue + context store
  // (identity is a stateless factory, so its duplicate is harmless).
  const workQueue = db !== undefined && spine !== undefined ? createWorkQueue(db, spine) : undefined;
  const humanGate = db !== undefined && spine !== undefined ? createHumanGate(db, spine) : undefined;
  const contextStore =
    db !== undefined && spine !== undefined
      ? createContextStore(db, spine, contextDepsFromConfig(config))
      : createUnconfiguredContextStore();

  // P6-deliver wiring.
  const delivery =
    db !== undefined && spine !== undefined && connectivity !== undefined && humanGate !== undefined
      ? createDelivery({
          db,
          spine,
          humanGate,
          runtime: connectivity.connectorRuntime,
          auth: connectivity.authProvider,
          connections: connectivity.connectionRegistry,
          contextStore,
          ...(config.slackDeliveryChannel !== undefined
            ? { slackChannel: config.slackDeliveryChannel }
            : {}),
        })
      : createUnconfiguredDelivery();
  const deliveryReal =
    db !== undefined && spine !== undefined && connectivity !== undefined && humanGate !== undefined;

  // P10-skills wiring: the in-process registration seam (no dynamic code
  // loading) — every extension skill this build ships registers here.
  const skillRuntime = createSkillRuntime();
  const skillSource = (slug: string) => ({
    repo: "nathanwjclark/lithis",
    ref: "main",
    path: `extensions/skills/${slug}`,
  });
  skillRuntime.register({ slug: "weekly-report", kind: "report", manifest: weeklyReportManifest, run: weeklyReportRun, sourceRef: skillSource("weekly-report") });
  skillRuntime.register({ slug: "follow-up-cadence", kind: "workflow", manifest: followUpCadenceManifest, run: followUpCadenceRun, sourceRef: skillSource("follow-up-cadence") });
  skillRuntime.register({ slug: "linkedin-outreach", kind: "workflow", manifest: linkedinOutreachManifest, run: linkedinOutreachRun, sourceRef: skillSource("linkedin-outreach") });
  const skills =
    db !== undefined && spine !== undefined && workQueue !== undefined && humanGate !== undefined
      ? createSkillsService({
          db,
          spine,
          runtime: skillRuntime,
          humanGate,
          workQueue,
          config,
          ...(connectivity !== undefined ? { connections: connectivity.connectionRegistry } : {}),
          ...(deliveryReal ? { delivery } : {}),
        })
      : undefined;

  // P7-agents wiring (+ P13-sentinel: raise_finding rides the extra-tool
  // seam; P10-skills: manifest tools execute through the skill executor).
  const agents =
    db !== undefined && spine !== undefined && workQueue !== undefined
      ? createAgentsRuntime({
          db,
          spine,
          config,
          identity: createIdentityService(db, spine),
          workQueue,
          contextStore,
          ...(skills !== undefined ? { skills: skills.toolExecutor } : {}),
          ...(humanGate !== undefined
            ? {
                extraTools: [
                  createRaiseFindingTool({ humanGate, identity: createIdentityService(db, spine) }),
                ],
              }
            : {}),
        })
      : undefined;

  // P11-artifacts-sor wiring: both compose over db/spine/humangate/context.
  const artifacts = db !== undefined && spine !== undefined && humanGate !== undefined ? createArtifactEngine({ db, spine, humanGate, contextStore, config }) : undefined;
  const sorRuntime = db !== undefined && spine !== undefined && humanGate !== undefined ? createSorRuntime({ db, spine, humanGate, contextStore }) : undefined;

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
    contextStore,
    ...(workQueue !== undefined ? { workQueue } : {}),
    processEngine:
      db !== undefined && spine !== undefined && workQueue !== undefined && humanGate !== undefined
        ? createProcessEngine({
            db,
            spine,
            work: workQueue,
            gate: humanGate,
            ...(config.cascadeAutoWidth !== undefined
              ? { autoExecuteMaxWidth: config.cascadeAutoWidth }
              : {}),
          })
        : createUnconfiguredProcessEngine(),
    ...(humanGate !== undefined ? { humanGate } : {}),
    ...(agents !== undefined
      ? { agentHost: agents.host, agentExecutor: agents.executor, toolBroker: agents.toolBroker }
      : {
          agentHost: createUnconfiguredAgentHost(),
          agentExecutor: createUnconfiguredAgentExecutor(),
          toolBroker: createToolBroker(),
        }),
    delivery,
    skillRegistry: skills !== undefined ? skills.registry : createUnconfiguredSkillRegistry(),
    artifactEngine: artifacts ?? createUnconfiguredArtifactEngine(),
    sorRuntime: sorRuntime ?? createUnconfiguredSorRuntime(),
    watcherHost:
      db !== undefined && spine !== undefined
        ? createWatcherHost({ identity: createIdentityService(db, spine), contextStore, config })
        : createUnconfiguredWatcherHost(),
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
  if (clock !== undefined && skills !== undefined) {
    clock.registerSource(skills.scheduleTickSource);
  }
  // P10 dev-seed activation (dev tenant ONLY — prod activates via the API):
  // the seed skills walk the REAL propose → approve → activate lifecycle so
  // cron ticks fire locally out of the box.
  if (db !== undefined && skills !== undefined) {
    const devSeed = await findDevSeed(db);
    if (devSeed !== undefined) {
      try {
        const { activated } = await ensureDevSkillsSeed({
          registry: skills.registry,
          runtime: skillRuntime,
          humanGate: humanGate!,
          tenantId: devSeed.tenantId,
          principalId: devSeed.principalId,
        });
        if (activated.length > 0) console.log(`dev seed: activated skills ${activated.join(", ")}`);
      } catch (err) {
        console.error(`dev seed: skill activation failed — ${err instanceof Error ? err.message : err}`);
      }
    }
  }
  if (spine !== undefined && workQueue !== undefined && humanGate !== undefined) {
    subscribeProcessEngine(spine, services.processEngine);
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

  // P6-deliver: card + reply consumers ride the spine wherever the dispatcher
  // runs; the Socket Mode client is the inbound Slack transport when an
  // app-level token is configured (honest degrade to the HTTP ingress otherwise).
  if (deliveryReal) {
    attachDeliverySubscriptions(spine!, delivery);
  }
  let socketMode: ReturnType<typeof createSocketModeClient> | undefined;
  if (deliveryReal && config.slackAppToken !== undefined) {
    const registry = connectivity!.connectionRegistry;
    socketMode = createSocketModeClient({
      appToken: config.slackAppToken,
      onEvent: async (event) => {
        const slackConnections = await registry.findByConnector("slack");
        if (slackConnections.length !== 1) {
          console.error(
            `slack socket mode: expected exactly 1 slack connection to route inbound events, ` +
              `found ${slackConnections.length} — per-workspace routing lands with multi-tenant auth`,
          );
          return;
        }
        await delivery.ingestSlackEvent(slackConnections[0]!, event);
      },
    });
    void socketMode.start();
    console.log("slack socket mode: client starting (SLACK_APP_TOKEN set)");
  } else if (deliveryReal) {
    console.log(
      "slack socket mode: disabled (SLACK_APP_TOKEN unset) — inbound slack events only via POST /api/delivery/slack/events",
    );
  }

  if ((config.role === "orchestrator" || config.role === "all") && spine !== undefined) {
    // P13-sentinel: mint + host the default watcher fleet and bridge watched
    // events into owned WorkItems wherever the dispatcher runs.
    if (db !== undefined && workQueue !== undefined && agents !== undefined) {
      await attachSentinel({
        spine,
        identity: createIdentityService(db, spine),
        watcherHost: services.watcherHost,
        agentHost: agents.host,
        workQueue,
      });
      console.log("sentinel: default watchers resident; event→work bridge attached");
    }
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
      ...(skills !== undefined ? { skills: skills.registry } : {}),
      ...(artifacts !== undefined ? { artifacts } : {}),
      ...(sorRuntime !== undefined ? { sor: sorRuntime } : {}),
      ...(deliveryReal
        ? {
            delivery,
            slackConnectionFor: async (tenantId: string) =>
              (await connectivity!.connectionRegistry.findByConnector("slack", tenantId))[0],
          }
        : {}),
    });
    server = Bun.serve({ port: config.port, fetch: app.fetch });
    console.log(`api listening on http://localhost:${config.port} — GET /health, GET /stubs`);
  } else {
    console.log(`role '${config.role}' serves no HTTP`);
  }

  const shutdown = async (): Promise<void> => {
    console.log("shutting down…");
    clock?.stop();
    await socketMode?.stop();
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
