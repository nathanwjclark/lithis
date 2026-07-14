/**
 * Round-trip coverage for the remaining record schemas: one plausible fixture
 * per record, parsed and spot-checked. Fixture data lives here — in tests —
 * which is exactly where mock data belongs.
 */

import { describe, expect, test } from "bun:test";
import {
  actionIntentSchema,
  agentCharterSchema,
  artifactSchema,
  cascadePlanSchema,
  connectionSchema,
  credentialSchema,
  evidenceSchema,
  feedExpectationSchema,
  invalidationCauseSchema,
  newUlid,
  nowIso,
  principalSchema,
  processRunSchema,
  processTemplateSchema,
  reportDefinitionSchema,
  runBriefSchema,
  runOutcomeSchema,
  runResultSchema,
  runSchema,
  sessionSchema,
  skillSchema,
  skillVersionSchema,
  sorDescriptorSchema,
  templateSchema,
  tenantSchema,
  watchRuleSchema,
  workspaceSchema,
} from "@lithis/core";
import { baseRecord, ids } from "./fixtures";

describe("iam", () => {
  test("tenant + principal + resident agent charter", () => {
    tenantSchema.parse({
      id: ids.tenant,
      slug: "acme-brokerage",
      name: "Acme Brokerage",
      status: "active",
      createdAt: nowIso(),
      updatedAt: nowIso(),
    });
    principalSchema.parse({
      ...baseRecord(ids.agentPrincipal),
      kind: "agent",
      slug: "bd-agent",
      displayName: "BD Agent",
      status: "active",
    });
    const charter = agentCharterSchema.parse({
      principalId: ids.agentPrincipal,
      tenantId: ids.tenant,
      role: "Business development: work the prospect pipeline, propose outreach batches.",
      promptRef: { kind: "doc", id: ids.doc },
      memoryBlobId: ids.memoryBlob,
      modelPolicy: { plan: "claude-opus-4-8", execute: "claude-sonnet-5", index: "claude-haiku-4-5" },
      budgets: { usdPerRun: 2, usdPerDay: 40 },
      wake: { heartbeat: "0 * * * *", onEvents: ["humangate.resolved"], onMessages: true },
      createdAt: nowIso(),
      updatedAt: nowIso(),
    });
    expect(charter.wake.onMessages).toBe(true);
  });

  test("action intent batch member", () => {
    const intent = actionIntentSchema.parse({
      ...baseRecord(newUlid()),
      batchId: newUlid(),
      principalId: ids.agentPrincipal,
      capability: "browser.linkedin.connect",
      params: { profileUrl: "https://linkedin.com/in/example", message: "Hi —" },
      counterpartRef: { kind: "entity", id: ids.entityPerson },
      status: "proposed",
    });
    expect(intent.status).toBe("proposed");
  });
});

describe("sessions & runs", () => {
  test("session → run → result → evidence chain", () => {
    sessionSchema.parse({
      ...baseRecord(ids.session),
      principalId: ids.agentPrincipal,
      kind: "loop",
      startedAt: nowIso(),
      cost: { tokensIn: 1200, tokensOut: 800, usd: 0.04 },
    });
    const run = runSchema.parse({
      ...baseRecord(ids.run),
      principalId: ids.agentPrincipal,
      sessionId: ids.session,
      workItemId: ids.workItem,
      model: "claude-sonnet-5",
      trigger: { cause: "new_information", eventId: newUlid() },
      status: "done",
      cost: { tokensIn: 9000, tokensOut: 2100, usd: 0.12 },
      startedAt: nowIso(),
      endedAt: nowIso(),
    });
    expect(run.trigger.cause).toBe("new_information");

    const result = runResultSchema.parse({
      ...baseRecord(ids.runResult),
      runId: ids.run,
      workItemId: ids.workItem,
      attempt: 2,
      resultJson: { lossRatio: 0.62, flags: ["2019-claim-attribution"] },
      summary: "Loss ratio 0.62 across 36 months; one attribution anomaly.",
      evidenceIds: [ids.evidence],
      inputRefs: [{ kind: "doc", id: ids.doc }],
      inputsHash: "b".repeat(64),
    });
    expect(result.superseded).toBe(false);

    const evidence = evidenceSchema.parse({
      ...baseRecord(ids.evidence),
      runId: ids.run,
      producedBy: { kind: "run", id: ids.run },
      kind: "excerpt",
      sources: [
        {
          ref: { kind: "doc", id: ids.doc },
          locator: "page:4",
          excerpt: "Claim #8841 · 2019-03-02 · $48,200",
          whyRelevant: "The claim whose attribution the reviewer disputed.",
        },
      ],
      summary: "Loss-run page 4, claim table.",
      contentHash: "c".repeat(64),
      at: nowIso(),
    });
    expect(evidence.sources[0]?.whyRelevant).toContain("reviewer");
  });

  test("brief and outcome contracts", () => {
    runBriefSchema.parse({
      tenantId: ids.tenant,
      principalId: ids.agentPrincipal,
      workItemId: ids.workItem,
      contextSlice: "## Node\nloss_history …",
      reworkInput: { comment: "recheck the 2019 claim attribution" },
      resultSchemaRef: "insurance-brokerage/loss-history-result@1",
      budget: { usd: 2, maxMinutes: 30 },
    });
    const outcome = runOutcomeSchema.parse({
      status: "done",
      resultJson: { ok: true },
      cost: { tokensIn: 1, tokensOut: 1, usd: 0.001 },
      newTasks: [{ title: "Verify carrier appetite for umbrella line" }],
    });
    expect(outcome.newTasks[0]?.body).toBe("");
  });
});

describe("processes", () => {
  test("template validates node/edge integrity", () => {
    const template = processTemplateSchema.parse({
      ...baseRecord(newUlid()),
      slug: "underwriting-smb",
      version: "0.1.0",
      mode: "fixed",
      nodes: [
        {
          key: "intake",
          title: "Intake & document inventory",
          instructions: "Inventory submission docs; list gaps.",
          resultSchemaRef: "insurance-brokerage/intake-result@1",
          gate: "never",
        },
        {
          key: "loss_history",
          title: "Loss-history analysis",
          instructions: "Analyze loss runs; compute ratios; flag anomalies.",
          inputSelectors: [{ description: "loss runs for the case", docTypes: ["loss_run"] }],
          resultSchemaRef: "insurance-brokerage/loss-history-result@1",
          gate: "always",
          evidenceSpec: "cite the claim rows behind every ratio",
        },
      ],
      edges: [{ from: "intake", to: "loss_history", kind: "depends_on" }],
      changePolicy: { allowAddNodes: false, allowSkip: false, protectedNodes: ["loss_history"] },
    });
    expect(template.nodes).toHaveLength(2);

    const badEdge = processTemplateSchema.safeParse({
      ...baseRecord(newUlid()),
      slug: "bad",
      version: "0.1.0",
      mode: "fixed",
      nodes: [
        { key: "a", title: "A", instructions: "x", resultSchemaRef: "r", gate: "never" },
      ],
      edges: [{ from: "a", to: "ghost", kind: "depends_on" }],
      changePolicy: { allowAddNodes: false, allowSkip: false, protectedNodes: [] },
    });
    expect(badEdge.success).toBe(false);
  });

  test("run + instance-bound watch rule + invalidation shapes", () => {
    processRunSchema.parse({
      ...baseRecord(ids.processRun),
      templateRef: { id: newUlid(), version: "0.1.0" },
      subjectRef: { kind: "entity", id: ids.entityCompany },
      status: "active",
      graphRevision: 0,
    });
    watchRuleSchema.parse({
      id: newUlid(),
      tenantId: ids.tenant,
      processRunId: ids.processRun,
      nodeKey: "loss_history",
      match: {
        topics: ["context.doc.distilled"],
        docTypes: ["loss_run"],
        entityRefs: [{ kind: "entity", id: ids.entityCompany }],
      },
      mode: "deterministic",
    });
    invalidationCauseSchema.parse({
      kind: "watch_deterministic",
      processRunId: ids.processRun,
      nodeKey: "loss_history",
      eventId: newUlid(),
    });
    const plan = cascadePlanSchema.parse({
      processRunId: ids.processRun,
      dirtyNodeKey: "loss_history",
      affected: ["pricing", "proposal"],
      width: 3,
    });
    expect(plan.affected).toContain("pricing");
  });
});

describe("connectivity & custody", () => {
  test("connection + feed expectation + credential (no secret material anywhere)", () => {
    const connection = connectionSchema.parse({
      ...baseRecord(ids.connection),
      connectorSlug: "filedrop",
      displayName: "Carrier SFTP",
      credentialRef: ids.credential,
      scopes: ["read"],
      status: "healthy",
      health: { lastOkAt: nowIso() },
      syncState: { cursorsByFeed: { "loss-runs": "mtime:1720000000" } },
    });
    expect(connection.status).toBe("healthy");

    feedExpectationSchema.parse({
      ...baseRecord(newUlid()),
      connectionId: ids.connection,
      key: "carrier-sftp:loss-runs",
      expectCadence: "0 6 * * 1",
      graceMinutes: 240,
      onMiss: "both",
    });

    const credential = credentialSchema.parse({
      ...baseRecord(ids.credential),
      kind: "browser_session",
      custodyBackendRef: "secret-manager://lithis-browser-linkedin",
      holderConnectionId: ids.connection,
    });
    expect(JSON.stringify(credential)).not.toContain("password");
  });
});

describe("skills / artifacts / sor / workspace", () => {
  test("skill version with capability diff and checksum binding", () => {
    skillSchema.parse({
      ...baseRecord(ids.skill),
      slug: "weekly-report",
      kind: "report",
      status: "active",
      shared: true,
    });
    const version = skillVersionSchema.parse({
      ...baseRecord(ids.skillVersion),
      skillId: ids.skill,
      semver: "0.2.0",
      sourceRef: { repo: "github.com/nathanwjclark/lithis", ref: "abc1234", path: "extensions/skills/weekly-report" },
      checksum: "d".repeat(64),
      manifest: {
        description: "Weekly BD digest",
        inputSchema: { type: "object" },
        capabilitiesRequired: ["context.search"],
        selfModBounds: { modifiablePaths: ["report.md.hbs"], forbidden: ["manifest.json"] },
      },
      capabilityDiff: { added: ["context.search"], removed: [] },
      authoredBy: { kind: "principal", id: ids.agentPrincipal },
      status: "proposed",
    });
    expect(version.capabilityDiff.added).toContain("context.search");

    reportDefinitionSchema.parse({
      ...baseRecord(newUlid()),
      slug: "bd-weekly",
      skillRef: { kind: "skill", id: ids.skill },
      schedule: "0 7 * * 1",
      audience: [{ channel: "slack", target: "#bd" }],
    });
  });

  test("template + artifact with verification-as-evidence", () => {
    templateSchema.parse({
      ...baseRecord(ids.template),
      slug: "proposal-letter",
      version: "1.0.0",
      kind: "document",
      fieldsSchema: { type: "object", required: ["clientName"] },
      bodyBlobId: ids.blob,
      checks: [
        { kind: "deterministic", ref: "checks/no-unfilled-fields" },
        { kind: "rubric", prompt: "Does the letter follow NJ broker disclosure phrasing rules?" },
      ],
    });
    const artifact = artifactSchema.parse({
      ...baseRecord(newUlid()),
      templateRef: { id: ids.template, version: "1.0.0" },
      inputsJson: { clientName: "Acme Logistics" },
      outputBlobId: newUlid(),
      verification: { passed: true, findings: [], evidenceId: ids.evidence },
      state: "verified",
      producedByRunId: ids.run,
    });
    expect(artifact.verification?.passed).toBe(true);
  });

  test("sor descriptor bans reserved column names and records gated migrations", () => {
    const descriptor = sorDescriptorSchema.parse({
      ...baseRecord(newUlid()),
      slug: "ams",
      displayName: "Agency Management System",
      version: 1,
      tables: [
        {
          name: "policies",
          description: "Bound policies",
          columns: [
            { name: "policy_number", type: "text", nullable: false },
            { name: "client_name", type: "text", entityBinding: "company" },
            { name: "premium", type: "numeric" },
          ],
        },
      ],
      migrations: [
        { version: 1, sqlBlobId: newUlid(), appliedBy: "human", approvalRequestId: ids.humanRequest },
      ],
    });
    expect(descriptor.tables[0]?.columns).toHaveLength(3);

    const reserved = sorDescriptorSchema.safeParse({
      ...baseRecord(newUlid()),
      slug: "bad",
      displayName: "Bad",
      version: 1,
      tables: [
        {
          name: "t",
          description: "x",
          columns: [{ name: "_origin", type: "jsonb" }],
        },
      ],
    });
    expect(reserved.success).toBe(false);
  });

  test("workspace is PR-only egress", () => {
    const workspace = workspaceSchema.parse({
      ...baseRecord(newUlid()),
      principalId: ids.humanPrincipal,
      repoRef: { url: "github.com/nathanwjclark/lithis", branch: "skeleton" },
      status: "active",
      egressPolicy: "pr_only",
      lastActiveAt: nowIso(),
    });
    expect(workspace.egressPolicy).toBe("pr_only");
  });
});
