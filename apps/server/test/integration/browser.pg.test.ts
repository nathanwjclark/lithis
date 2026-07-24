import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Server, ServerWebSocket } from "bun";
import { newUlid, nowIso } from "@lithis/core";
import type { ActionIntent, Evidence, PrincipalContext } from "@lithis/core";
import { createBrowserHostService } from "@lithis/browserhost";
import type { ChromeLaunchHandle, ChromeLauncher } from "@lithis/browserhost";
import { connectCdp, openBrowserSession } from "@lithis/sdk/browser";
import { createCredentialDirectory } from "../../src/connections";
import { createCustody, createEnvFileBackend, createLocalBrowserProfileStore } from "../../src/custody";
import { createEvidenceWriter } from "../../src/agents";
import { createHumanGate } from "../../src/humangate";
import { createActionIntentService } from "../../src/iam";
import type { ActionExecutor } from "../../src/iam";
import { createEventSpine } from "../../src/spine";
import { describePg, freshDb, truncateAll } from "../helpers/pg";

/**
 * P12-browser acceptance: a sealed profile mounts into a (fake-Chrome) pod, the
 * brokered CDP channel refuses cookie reads, and an ActionIntent batch runs the
 * full propose → gate → per-item verdicts → execute → receipt loop.
 *
 * No real Chrome and no real LinkedIn: the launcher is faked and the upstream
 * DevTools endpoint is a scripted websocket. Everything between custody and the
 * evidence row is the real implementation.
 */

// ── a scripted stand-in for the pod's DevTools endpoint ─────────────────────

interface FakeChrome {
  wsEndpoint: string;
  received: string[];
  stop(): void;
}

function startFakeChrome(): FakeChrome {
  const received: string[] = [];
  const server: Server<undefined> = Bun.serve<undefined>({
    port: 0,
    hostname: "127.0.0.1",
    fetch(req, srv) {
      if (srv.upgrade(req)) return undefined;
      return new Response("expected upgrade", { status: 400 });
    },
    websocket: {
      message(ws: ServerWebSocket<undefined>, message) {
        const command = JSON.parse(
          typeof message === "string" ? message : message.toString(),
        ) as { id: number; method: string; params?: Record<string, unknown> };
        received.push(command.method);
        const result: Record<string, unknown> = (() => {
          switch (command.method) {
            case "Target.getTargets":
              return { targetInfos: [{ targetId: "page-1", type: "page" }] };
            case "Target.attachToTarget":
              return { sessionId: "cdp-1" };
            case "Page.navigate":
              return { frameId: "frame-1" };
            case "Runtime.evaluate":
              return { result: { value: { found: true, value: "Jane Roe" } } };
            default:
              return {};
          }
        })();
        ws.send(JSON.stringify({ id: command.id, result }));
        if (command.method === "Page.navigate") {
          ws.send(JSON.stringify({ method: "Page.loadEventFired", params: {} }));
        }
      },
    },
  });
  return {
    wsEndpoint: `ws://127.0.0.1:${server.port}/devtools/browser/fake`,
    received,
    stop: () => server.stop(true),
  };
}

function fakeLauncher(wsEndpoint: string): ChromeLauncher {
  return {
    async launch({ userDataDir }): Promise<ChromeLaunchHandle> {
      return { wsEndpoint, userDataDir, close: async () => {} };
    },
  };
}

describePg("Sealed browser sessions + ActionIntent batches (integration)", () => {
  let root: string;
  let chrome: FakeChrome;

  beforeEach(async () => {
    await truncateAll(await freshDb());
    root = await mkdtemp(join(tmpdir(), "lithis-p12-"));
    chrome = startFakeChrome();
  });

  afterEach(async () => {
    chrome.stop();
    await rm(root, { recursive: true, force: true });
  });

  async function setup() {
    const db = await freshDb();
    const spine = createEventSpine(db);
    const credentials = createCredentialDirectory(db, spine);
    const profiles = createLocalBrowserProfileStore(join(root, "profiles"));
    const browserHost = createBrowserHostService({
      launcher: fakeLauncher(chrome.wsEndpoint),
      podRoot: join(root, "pods"),
      podId: "pod-test",
    });
    const custody = createCustody({
      db,
      spine,
      credentials,
      backend: createEnvFileBackend(undefined),
      profiles,
      browserHost,
    });
    const tenantId = newUlid();
    const p: PrincipalContext = { tenantId, principalId: newUlid(), kind: "agent" };
    return { db, spine, credentials, profiles, browserHost, custody, tenantId, p };
  }

  test("a sealed profile mounts, and the brokered CDP channel refuses cookie reads", async () => {
    const { spine, credentials, profiles, custody, browserHost, tenantId, p } = await setup();

    // Seed the sealed profile (the one-time interactive login lives here).
    const profileRef = "browser-profile:linkedin-main";
    const sealedDir = await profiles.prepare(profileRef);
    await Bun.write(join(sealedDir, "Default", "Cookies"), "sealed-li_at-bytes");

    const credential = await credentials.create({
      tenantId,
      kind: "browser_session",
      custodyBackendRef: profileRef,
    });

    const mount = await custody.mountSession(credential.id, p);
    expect(mount.credentialId).toBe(credential.id);
    expect(mount.host.podId).toBe("pod-test");
    // Brokered, single-use, loopback — never the pod's raw DevTools endpoint.
    expect(mount.cdpUrl).toContain(`/cdp/${mount.sessionId}?token=`);
    expect(mount.cdpUrl).not.toContain(new URL(chrome.wsEndpoint).port);

    // The mount is audited, and the event carries ids only.
    const mountEvents = await spine.readSince(
      { consumerId: "t", tenantId, afterSeq: 0n },
      { topics: ["browser.session.mounted"] },
    );
    expect(mountEvents).toHaveLength(1);
    expect(mountEvents[0]!.payload).toEqual({
      credentialId: credential.id,
      sessionId: mount.sessionId,
      podId: "pod-test",
    });
    const serialized = JSON.stringify(mountEvents[0], (_k, v: unknown) =>
      typeof v === "bigint" ? v.toString() : v,
    );
    expect(serialized).not.toContain("sealed-li_at-bytes");
    expect(serialized).not.toContain(sealedDir);

    // Drive the session through the real SDK client over the real broker.
    const session = await openBrowserSession(
      { mountRef: mount.sessionId, cdpUrl: mount.cdpUrl, policy: { minDelayMs: 0, jitterMs: 0, maxActionsPerHour: 100 } },
      { sleep: async () => {} },
    );
    const navigated = await session.perform({
      kind: "navigate",
      url: "https://www.linkedin.com/sales/search/people",
    });
    expect(navigated.ok).toBe(true);
    const extracted = await session.perform({
      kind: "extract",
      selector: '[data-anonymize="person-name"]',
    });
    expect(extracted).toEqual({ ok: true, extracted: "Jane Roe" });

    // The exact threat ADR-003 exists to prevent. A fresh attach (the token is
    // single-use) speaking raw CDP: the cookie read is refused at the broker
    // and never reaches the browser.
    const secondAttach = await browserHost.attach(mount.sessionId);
    const raw = await connectCdp(secondAttach.wsUrl);
    await expect(raw.send("Network.getAllCookies")).rejects.toThrow(/denied_method/);
    expect(chrome.received).not.toContain("Network.getAllCookies");
    await raw.close();

    // A CAPTCHA pauses; it is never solved.
    const captcha = await session.perform({ kind: "captcha_pause", reason: "bot check" });
    expect(captcha.ok).toBe(false);

    await session.close();
    await custody.releaseSession(mount.sessionId, credential.id, p);

    const released = await spine.readSince(
      { consumerId: "t2", tenantId, afterSeq: 0n },
      { topics: ["browser.session.released"] },
    );
    expect(released).toHaveLength(1);
  });

  test("mountSession refuses a non-browser_session credential", async () => {
    const { credentials, custody, tenantId, p } = await setup();
    const apiKey = await credentials.create({
      tenantId,
      kind: "api_key",
      custodyBackendRef: "env-file:SOMETHING",
    });
    await expect(custody.mountSession(apiKey.id, p)).rejects.toThrow(/not a 'browser_session'/);
  });

  test("an action batch runs propose → gate → per-item verdicts → execute with receipts", async () => {
    const { db, spine, tenantId, p } = await setup();
    const gate = createHumanGate(db, spine);
    const executed: ActionIntent[] = [];
    const executor: ActionExecutor = {
      async execute({ intent }) {
        executed.push(intent);
        if (intent.capability === "browser.linkedin.message") {
          return { ok: false, detail: "recipient does not accept messages" };
        }
        return { ok: true, externalId: `invite-${intent.id}` };
      },
    };
    const actions = createActionIntentService({
      db,
      spine,
      gate,
      evidence: createEvidenceWriter(db),
      executor,
    });

    const proposal = await actions.proposeBatch({
      tenantId,
      principalId: p.principalId,
      requestedBy: { kind: "principal", id: p.principalId },
      summary: "Connect with 3 ranked 2nd-degree prospects",
      items: [
        { capability: "browser.linkedin.connect", summary: "Connect with Jane Roe" },
        { capability: "browser.linkedin.connect", summary: "Connect with Sam Patel" },
        { capability: "browser.linkedin.message", summary: "Message Alex Kim" },
      ],
    });
    expect(proposal.intentIds).toHaveLength(3);

    // Nothing executes before a human resolves the gate.
    const proposed = await actions.listBatch(tenantId, proposal.batchId);
    expect(proposed.map((i) => i.status)).toEqual(["proposed", "proposed", "proposed"]);
    expect(executed).toHaveLength(0);

    const request = await gate.get(proposal.humanRequestId, tenantId);
    expect(request?.subjectKind).toBe("action_batch");
    expect(request?.subjectRef).toEqual({ kind: "action_batch", id: proposal.batchId });

    const [first, second, third] = proposal.intentIds as [string, string, string];
    await gate.resolve(
      proposal.humanRequestId,
      {
        by: { kind: "principal", id: p.principalId },
        at: nowIso(),
        verdict: "approved",
        comment: "approve 2 of 3",
        perItem: [
          { intentId: first, verdict: "approved" },
          { intentId: second, verdict: "denied" },
          { intentId: third, verdict: "approved" },
        ],
      },
      p,
    );

    // The consumer applies verdicts and (executeOnResolve) runs the approvals.
    const resolvedEvents = await spine.readSince(
      { consumerId: "t", tenantId, afterSeq: 0n },
      { topics: ["humangate.resolved"] },
    );
    expect(resolvedEvents).toHaveLength(1);
    await actions.handleResolved(resolvedEvents[0]!);

    const settled = await actions.listBatch(tenantId, proposal.batchId);
    const byId = new Map(settled.map((i) => [i.id, i]));
    expect(byId.get(first)!.status).toBe("executed");
    expect(byId.get(second)!.status).toBe("denied");
    expect(byId.get(third)!.status).toBe("failed");

    // The denied item never reached the executor.
    expect(executed.map((i) => i.id).sort()).toEqual([first, third].sort());

    // Every executed/failed item carries an Evidence receipt.
    for (const id of [first, third]) {
      const intent = byId.get(id)!;
      expect(intent.receiptRef?.kind).toBe("evidence");
      const rows: { id: string; summary: string; sources: unknown; kind: string }[] =
        await db.sql`select id, summary, sources, kind from agents.evidence where id = ${intent.receiptRef!.id}`;
      expect(rows).toHaveLength(1);
      const rawSources = rows[0]!.sources;
      const sources = (typeof rawSources === "string"
        ? JSON.parse(rawSources)
        : rawSources) as Evidence["sources"];
      expect(sources[0]!.ref).toEqual({ kind: "action_intent", id });
    }
    expect(byId.get(second)!.receiptRef).toBeUndefined();
    expect(byId.get(first)!.status).toBe("executed");

    const executedEvents = await spine.readSince(
      { consumerId: "t3", tenantId, afterSeq: 0n },
      { topics: ["iam.action_intent.executed", "iam.action_intent.failed"] },
    );
    expect(executedEvents.map((e) => e.topic).sort()).toEqual([
      "iam.action_intent.executed",
      "iam.action_intent.failed",
    ]);

    // Redelivery is safe: statuses do not move and nothing is re-sent.
    await actions.handleResolved(resolvedEvents[0]!);
    expect(executed).toHaveLength(2);
  });

  test("a batch with no executor wired fails loudly instead of pretending to send", async () => {
    const { db, spine, tenantId, p } = await setup();
    const gate = createHumanGate(db, spine);
    const actions = createActionIntentService({
      db,
      spine,
      gate,
      evidence: createEvidenceWriter(db),
      executeOnResolve: false,
    });
    const proposal = await actions.proposeBatch({
      tenantId,
      principalId: p.principalId,
      requestedBy: { kind: "principal", id: p.principalId },
      summary: "one connect",
      items: [{ capability: "browser.linkedin.connect", summary: "Connect with Jane Roe" }],
    });
    await gate.resolve(
      proposal.humanRequestId,
      {
        by: { kind: "principal", id: p.principalId },
        at: nowIso(),
        verdict: "approved",
        comment: "go",
      },
      p,
    );
    const resolved = await spine.readSince(
      { consumerId: "t", tenantId, afterSeq: 0n },
      { topics: ["humangate.resolved"] },
    );
    await actions.handleResolved(resolved[0]!);
    await expect(actions.executeBatch(tenantId, proposal.batchId)).rejects.toThrow(
      /no action executor/,
    );
  });
});
