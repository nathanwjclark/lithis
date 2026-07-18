import { beforeEach, expect, test } from "bun:test";
import { newUlid, nowIso } from "@lithis/core";
import type { Connection, GitRef, PrincipalContext, Ref } from "@lithis/core";
import { createSlackConnector } from "@lithis/connector-slack";
import { followUpCadenceManifest, run as followUpCadenceRun } from "@lithis/skill-follow-up-cadence";
import { weeklyReportManifest, run as weeklyReportRun } from "@lithis/skill-weekly-report";
import { skillToolName } from "../../src/agents";
import {
  createConnectionRegistry,
  createConnectorRuntime,
  createCredentialDirectory,
} from "../../src/connections";
import { createContextStore, createLocalBlobStorage } from "../../src/context";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createCustody } from "../../src/custody";
import { createDelivery } from "../../src/delivery";
import type { DeliveryRuntime } from "../../src/delivery";
import { createHumanGate } from "../../src/humangate";
import type { HumanGate } from "../../src/humangate";
import {
  SkillChecksumMismatchError,
  SkillNotApprovedError,
  createSkillRuntime,
  createSkillsService,
  ensureDevSkillsSeed,
} from "../../src/skills";
import type { SkillRuntime, SkillsService } from "../../src/skills";
import { createEventSpine } from "../../src/spine";
import type { EventSpineRuntime } from "../../src/spine";
import { createWorkQueue } from "../../src/work";
import type { WorkQueue } from "../../src/work";
import type { Db } from "../../src/db";
import { describePg, freshDb, truncateAll } from "../helpers/pg";

/**
 * P10 acceptance over real Postgres — the plan's three proofs:
 *   1. a due WorkItem.followUp + the skills.schedule tick → Slack nudge
 *      delivery row, succeeded skill_runs row, advanced lastContactAt/nextAt;
 *   2. weekly-report compiles REAL counts/titles into markdown + a digest
 *      delivery row;
 *   3. the full lifecycle propose → approve → checksum-bound activate,
 *      including the checksum-mismatch rejection.
 * Fixture Slack transport (fixture data in tests — where it belongs); real
 * spine, humangate, work queue, custody, delivery, registry throughout.
 */

const CARD_CHANNEL = "C0100CARDS";
const BOT_TOKEN = "xoxb-fixture-bot-token";
const GIT_REF: GitRef = { repo: "nathanwjclark/lithis", ref: "main", path: "extensions/skills" };

interface PostedMessage {
  body: { channel: string; text?: string; blocks?: unknown[] };
}

function fakeSlack(): { fetch: typeof globalThis.fetch; posted: PostedMessage[] } {
  let tsCounter = 0;
  const posted: PostedMessage[] = [];
  const fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(
      typeof input === "string" ? input : input instanceof URL ? input.href : input.url,
    );
    if (url.pathname.split("/").pop() !== "chat.postMessage") {
      throw new Error("fake slack: unexpected method");
    }
    const body = JSON.parse(String(init?.body)) as PostedMessage["body"];
    tsCounter += 1;
    posted.push({ body });
    return Response.json({ ok: true, channel: body.channel, ts: `1718000000.${tsCounter}` });
  }) as typeof globalThis.fetch;
  return { fetch, posted };
}

interface Rig {
  db: Db;
  spine: EventSpineRuntime;
  gate: HumanGate;
  workQueue: WorkQueue;
  delivery: DeliveryRuntime;
  runtime: SkillRuntime;
  skills: SkillsService;
  connection: Connection;
  posted: PostedMessage[];
  tenantId: string;
  adminId: string;
}

async function buildRig(): Promise<Rig> {
  const db = await freshDb();
  const spine = createEventSpine(db);
  const gate = createHumanGate(db, spine);
  const workQueue = createWorkQueue(db, spine);
  const tenantId = newUlid();
  const adminId = newUlid();

  const credentials = createCredentialDirectory(db, spine);
  const custody = createCustody({
    db,
    spine,
    credentials,
    backend: {
      async getSecret(ref: string): Promise<string> {
        if (ref !== "env-file:SLACK_BOT_TOKEN") throw new Error(`no secret for ${ref}`);
        return BOT_TOKEN;
      },
    },
  });
  const auth = {
    getAuth: async (connection: Connection) => {
      const brokered = await custody.issueFor(connection.credentialRef, connection.tenantId, {
        kind: "connection" as const,
        id: connection.id,
      });
      return { kind: brokered.kind, token: brokered.brokerToken, expiresAt: brokered.expiresAt };
    },
    redeem: async (brokerToken: string) => (await custody.redeem(brokerToken)).secret,
  };
  const slack = fakeSlack();
  const connectorRuntime = createConnectorRuntime(auth);
  connectorRuntime.register((provider) => createSlackConnector(provider, { fetch: slack.fetch }));
  const registry = createConnectionRegistry(db, spine, { probes: connectorRuntime });
  const credential = await credentials.create({
    tenantId,
    kind: "oauth_token",
    custodyBackendRef: "env-file:SLACK_BOT_TOKEN",
  });
  const connection = await registry.register({
    tenantId,
    connectorSlug: "slack",
    displayName: "Fixture workspace",
    credentialRef: credential.id,
    scopes: ["chat:write"],
  });

  const contextStore = createContextStore(db, spine, {
    blobs: createLocalBlobStorage(mkdtempSync(join(tmpdir(), "lithis-skills-blobs-"))),
  });
  const delivery = createDelivery({
    db,
    spine,
    humanGate: gate,
    runtime: connectorRuntime,
    auth,
    connections: registry,
    contextStore,
    slackChannel: CARD_CHANNEL,
  });

  const runtime = createSkillRuntime();
  runtime.register({
    slug: "weekly-report",
    kind: "report",
    manifest: weeklyReportManifest,
    run: weeklyReportRun,
    sourceRef: GIT_REF,
  });
  runtime.register({
    slug: "follow-up-cadence",
    kind: "workflow",
    manifest: followUpCadenceManifest,
    run: followUpCadenceRun,
    sourceRef: GIT_REF,
  });
  const skills = createSkillsService({
    db,
    spine,
    runtime,
    humanGate: gate,
    workQueue,
    connections: registry,
    delivery,
    config: { slackDeliveryChannel: CARD_CHANNEL },
  });

  return {
    db,
    spine,
    gate,
    workQueue,
    delivery,
    runtime,
    skills,
    connection,
    posted: slack.posted,
    tenantId,
    adminId,
  };
}

const asAdmin = (rig: Rig): PrincipalContext => ({
  tenantId: rig.tenantId,
  principalId: rig.adminId,
  kind: "human",
});

async function activateThroughLifecycle(rig: Rig, slug: string): Promise<string> {
  const registration = rig.runtime.resolve(slug)!;
  const { versionId, approvalRequestId } = await rig.skills.registry.propose({
    tenantId: rig.tenantId,
    slug,
    kind: registration.kind,
    semver: "0.1.0",
    sourceRef: registration.sourceRef,
    manifest: registration.manifest,
    authoredBy: { kind: "principal", id: rig.adminId },
  });
  await rig.gate.resolve(
    approvalRequestId,
    { by: { kind: "principal", id: rig.adminId }, at: nowIso(), verdict: "approved", comment: "lgtm" },
    asAdmin(rig),
  );
  await rig.skills.registry.activate(versionId, rig.tenantId);
  return versionId;
}

/**
 * The most recent local Monday at the given hour, never in the future — a
 * real minute the "0 h * * 1"/"0 9 * * 1-5" crons fire at, chosen so the
 * fake tick clock and the rows' REAL db timestamps live in the same
 * reporting week (listRecent filters real updated_at against the tick week).
 */
function recentMonday(h: number): Date {
  const d = new Date();
  d.setHours(h, 0, 0, 0);
  d.setDate(d.getDate() - ((d.getDay() + 6) % 7));
  if (d.getTime() > Date.now()) d.setDate(d.getDate() - 7);
  return d;
}

describePg("skills (integration)", () => {
  beforeEach(async () => {
    await truncateAll(await freshDb());
  });

  test("ACCEPTANCE 3: full lifecycle — propose gates via skill_change, activate is checksum-bound", async () => {
    const rig = await buildRig();
    const registration = rig.runtime.resolve("weekly-report")!;
    const authoredBy: Ref = { kind: "principal", id: rig.adminId };

    const { skillId, versionId, approvalRequestId } = await rig.skills.registry.propose({
      tenantId: rig.tenantId,
      slug: "weekly-report",
      kind: "report",
      semver: "0.1.0",
      sourceRef: registration.sourceRef,
      manifest: registration.manifest,
      authoredBy,
    });

    // The gate request carries the capability diff + the honest eval gap.
    const request = (await rig.gate.get(approvalRequestId, rig.tenantId))!;
    expect(request.kind).toBe("approval");
    expect(request.subjectKind).toBe("skill_change");
    expect(request.state).toBe("pending");
    const payload = request.payload as { evals: string; capabilityDiff: { added: string[] } };
    expect(payload.evals).toBe("not_run (P16-evals pending)");
    expect(payload.capabilityDiff.added).toEqual([...registration.manifest.capabilitiesRequired]);

    // Not approved yet → activation refuses (409 at the API layer).
    await expect(rig.skills.registry.activate(versionId, rig.tenantId)).rejects.toThrow(
      SkillNotApprovedError,
    );
    expect(await rig.skills.registry.forPrincipal(asAdmin(rig))).toHaveLength(0);

    await rig.gate.resolve(
      approvalRequestId,
      { by: authoredBy, at: nowIso(), verdict: "approved", comment: "capabilities look right" },
      asAdmin(rig),
    );
    await rig.skills.registry.activate(versionId, rig.tenantId);

    const active = await rig.skills.registry.forPrincipal(asAdmin(rig));
    expect(active).toHaveLength(1);
    expect(active[0]!.slug).toBe("weekly-report");
    expect(active[0]!.currentVersionId).toBe(versionId);

    // Checksum mismatch: a TAMPERED manifest gets approved, but activation
    // re-derives the checksum from the REGISTERED runtime manifest and refuses.
    const tampered = {
      ...registration.manifest,
      capabilitiesRequired: [...registration.manifest.capabilitiesRequired, "gmail.send"],
    };
    const second = await rig.skills.registry.propose({
      tenantId: rig.tenantId,
      slug: "weekly-report",
      kind: "report",
      semver: "0.2.0",
      sourceRef: registration.sourceRef,
      manifest: tampered,
      authoredBy,
    });
    // capabilityDiff vs the now-active version shows exactly the creep.
    const secondRequest = (await rig.gate.get(second.approvalRequestId, rig.tenantId))!;
    expect((secondRequest.payload as { capabilityDiff: { added: string[] } }).capabilityDiff.added).toEqual(
      ["gmail.send"],
    );
    await rig.gate.resolve(
      second.approvalRequestId,
      { by: authoredBy, at: nowIso(), verdict: "approved", comment: "oops" },
      asAdmin(rig),
    );
    await expect(rig.skills.registry.activate(second.versionId, rig.tenantId)).rejects.toThrow(
      SkillChecksumMismatchError,
    );
    // The prior version stays active; the tampered one never went live.
    const stillActive = await rig.skills.registry.forPrincipal(asAdmin(rig));
    expect(stillActive[0]!.currentVersionId).toBe(versionId);

    // The spine tells the story.
    const events = await rig.spine.readSince(
      { consumerId: "assert", tenantId: rig.tenantId, afterSeq: 0n },
      { topics: ["skill.*"] },
      100,
    );
    const topics = events.map((e) => e.topic);
    expect(topics.filter((t) => t === "skill.version.proposed")).toHaveLength(2);
    expect(topics.filter((t) => t === "skill.version.activated")).toHaveLength(1);
    expect(skillId).toBe(active[0]!.id);
  });

  test("ACCEPTANCE 1: due follow-up + schedule tick → Slack nudge, succeeded run row, advanced cadence", async () => {
    const rig = await buildRig();
    await activateThroughLifecycle(rig, "follow-up-cadence");

    const counterpartId = newUlid();
    const itemId = await rig.workQueue.open({
      tenantId: rig.tenantId,
      kind: "oneoff",
      title: "chase the carrier for loss runs",
      body: "Waiting on 5-year loss runs.",
      ownerPrincipalId: rig.adminId,
      priority: 0.5,
      sourceRefs: [],
      followUp: {
        counterpartRef: { kind: "entity", id: counterpartId },
        cadence: "0 9 * * 1-5",
        nextAt: "2026-07-10T09:00:00.000Z", // past due
      },
    });

    // The cadence skill's manifest schedule is 0 9 * * 1-5 (local time).
    const tickAt = recentMonday(9);
    await rig.skills.scheduleTickSource.tick(tickAt);

    // One Slack nudge, labeled as the counterpart's outbound follow-up.
    expect(rig.posted).toHaveLength(1);
    expect(rig.posted[0]!.body.channel).toBe(CARD_CHANNEL);
    expect(JSON.stringify(rig.posted[0]!.body.blocks)).toContain("Outbound follow-up for");
    expect(JSON.stringify(rig.posted[0]!.body.blocks)).toContain(counterpartId);

    // The delivery ledger row is honest.
    const deliveries: { kind: string; status: string; target: string }[] = await rig.db.sql`
      select kind, status, target from delivery.deliveries where tenant_id = ${rig.tenantId}`;
    expect(deliveries).toEqual([{ kind: "nudge", status: "sent", target: CARD_CHANNEL }]);

    // A succeeded durable run row with the schedule trigger.
    const runs = await rig.skills.registry.runsFor(rig.tenantId, "follow-up-cadence");
    expect(runs).toHaveLength(1);
    expect(runs[0]!.trigger).toBe("schedule");
    expect(runs[0]!.status).toBe("succeeded");
    expect((runs[0]!.result as { sent: unknown[] }).sent).toHaveLength(1);

    // lastContactAt stamped at the tick minute; nextAt advanced per cadence.
    const item = (await rig.workQueue.get(itemId))!;
    expect(item.followUp!.lastContactAt).toBe(tickAt.toISOString());
    expect(Date.parse(item.followUp!.nextAt)).toBeGreaterThan(tickAt.getTime());

    // Same-minute redelivery is deduped; run.started/finished rode the spine.
    await rig.skills.scheduleTickSource.tick(new Date(tickAt.getTime() + 20_000));
    expect(await rig.skills.registry.runsFor(rig.tenantId, "follow-up-cadence")).toHaveLength(1);
    const events = await rig.spine.readSince(
      { consumerId: "assert2", tenantId: rig.tenantId, afterSeq: 0n },
      { topics: ["skill.run.*"] },
      100,
    );
    expect(events.map((e) => e.topic)).toEqual(["skill.run.started", "skill.run.finished"]);
    expect(events[1]!.payload).toMatchObject({ slug: "follow-up-cadence", status: "succeeded" });
  });

  test("ACCEPTANCE 2: weekly-report compiles real counts/titles and lands a digest delivery row", async () => {
    const rig = await buildRig();
    await activateThroughLifecycle(rig, "weekly-report");

    // Real graph state: one done item, one blocked item (driven through the
    // real claim/complete protocol), one pending approval assigned to a
    // DIFFERENT principal (proving the tenant-wide listPending read).
    const worker: PrincipalContext = { tenantId: rig.tenantId, principalId: newUlid(), kind: "agent" };
    const zeroCost = { tokensIn: 0, tokensOut: 0, usd: 0 };
    const openItem = (title: string, priority: number) =>
      rig.workQueue.open({
        tenantId: rig.tenantId,
        kind: "oneoff",
        title,
        body: "",
        ownerPrincipalId: worker.principalId,
        priority,
        sourceRefs: [],
      });
    await openItem("reconcile ledger", 0.9);
    await openItem("chase the carrier", 0.5);
    const first = (await rig.workQueue.claim(worker, {}))!;
    await rig.workQueue.complete(first, {
      status: "done",
      evidenceDrafts: [],
      newTasks: [],
      cost: zeroCost,
    });
    const second = (await rig.workQueue.claim(worker, {}))!;
    await rig.workQueue.complete(second, {
      status: "blocked",
      blocker: "carrier unresponsive",
      evidenceDrafts: [],
      newTasks: [],
      cost: zeroCost,
    });
    await rig.gate.request({
      tenantId: rig.tenantId,
      kind: "approval",
      subjectKind: "action",
      subjectRef: { kind: "action_intent", id: newUlid() },
      payload: {},
      evidenceIds: [],
      summary: "Send the renewal follow-up email to Acme?",
      routing: {
        assignee: { kind: "principal", id: newUlid() }, // someone else's inbox
        channelPrefs: ["portal"],
        escalationPath: [],
        followUpCount: 0,
      },
      requestedBy: { kind: "principal", id: rig.adminId },
    });

    // Fire via the real tick minute for "0 8 * * 1" (local Monday 08:00).
    await rig.skills.scheduleTickSource.tick(recentMonday(8));

    const runs = await rig.skills.registry.runsFor(rig.tenantId, "weekly-report");
    expect(runs).toHaveLength(1);
    expect(runs[0]!.status).toBe("succeeded");
    const result = runs[0]!.result as { markdown: string; delivery: { sent: boolean } };
    expect(result.markdown).toContain("Completed: **1**");
    expect(result.markdown).toContain("Blocked: **1**");
    expect(result.markdown).toContain("reconcile ledger");
    expect(result.markdown).toContain("chase the carrier");
    expect(result.markdown).toContain("Send the renewal follow-up email to Acme?");
    expect(result.markdown).toContain("unavailable (no relationship read surface yet)");
    expect(result.markdown).toContain("slack (Fixture workspace)");
    expect(result.delivery.sent).toBe(true);

    expect(rig.posted).toHaveLength(1);
    expect(rig.posted[0]!.body.text).toContain("Weekly digest");
    const deliveries: { kind: string; status: string }[] = await rig.db.sql`
      select kind, status from delivery.deliveries where tenant_id = ${rig.tenantId}`;
    expect(deliveries).toEqual([{ kind: "digest", status: "sent" }]);
  });

  test("active-but-unregistered slug → an honest failed run row, never a silent skip", async () => {
    const rig = await buildRig();
    await activateThroughLifecycle(rig, "weekly-report");

    // A different server build without the registration (drift scenario).
    const bareSkills = createSkillsService({
      db: rig.db,
      spine: rig.spine,
      runtime: createSkillRuntime(),
      humanGate: rig.gate,
      workQueue: rig.workQueue,
      config: {},
    });
    await bareSkills.scheduleTickSource.tick(recentMonday(8));

    const runs = await rig.skills.registry.runsFor(rig.tenantId, "weekly-report");
    expect(runs).toHaveLength(1);
    expect(runs[0]!.status).toBe("failed");
    expect(runs[0]!.error).toContain("not registered in this server build");
  });

  test("agent tool path: the broker tool name executes the active skill; inactive tenants are refused", async () => {
    const rig = await buildRig();
    await activateThroughLifecycle(rig, "weekly-report");
    const toolName = skillToolName(weeklyReportManifest.description);

    const outcome = (await rig.skills.toolExecutor.tryExecuteTool(
      asAdmin(rig),
      toolName,
      { sections: ["approvals"] },
    ))!;
    expect(outcome.isError).toBe(false);
    expect(JSON.parse(outcome.result) as { sections: string[] }).toMatchObject({
      sections: ["approvals"],
    });
    const runs = await rig.skills.registry.runsFor(rig.tenantId, "weekly-report");
    expect(runs[0]!.trigger).toBe("tool");

    // Unknown tool names fall through (undefined) — the executor errors, not us.
    expect(await rig.skills.toolExecutor.tryExecuteTool(asAdmin(rig), "skill_nope", {})).toBeUndefined();

    // Registered but not active for this tenant → is_error, no execution.
    const foreign: PrincipalContext = { tenantId: newUlid(), principalId: newUlid(), kind: "agent" };
    const refused = (await rig.skills.toolExecutor.tryExecuteTool(foreign, toolName, {}))!;
    expect(refused.isError).toBe(true);
    expect(refused.result).toContain("not active for this tenant");
  });

  test("dev seed activates both seed skills through the REAL lifecycle, idempotently", async () => {
    const rig = await buildRig();
    const first = await ensureDevSkillsSeed({
      registry: rig.skills.registry,
      runtime: rig.runtime,
      humanGate: rig.gate,
      tenantId: rig.tenantId,
      principalId: rig.adminId,
    });
    expect(first.activated.sort()).toEqual(["follow-up-cadence", "weekly-report"]);
    const active = await rig.skills.registry.forPrincipal(asAdmin(rig));
    expect(active.map((s) => s.slug).sort()).toEqual(["follow-up-cadence", "weekly-report"]);

    // Every activation rode a resolved skill_change approval — the real gate.
    const requests = await rig.gate.listPending(rig.tenantId);
    expect(requests).toHaveLength(0);

    const again = await ensureDevSkillsSeed({
      registry: rig.skills.registry,
      runtime: rig.runtime,
      humanGate: rig.gate,
      tenantId: rig.tenantId,
      principalId: rig.adminId,
    });
    expect(again.activated).toEqual([]);
  });
});
