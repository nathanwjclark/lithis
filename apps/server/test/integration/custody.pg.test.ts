import { beforeEach, expect, test } from "bun:test";
import { fileURLToPath } from "node:url";
import { newUlid } from "@lithis/core";
import type { PrincipalContext } from "@lithis/core";
import { expectStub } from "@lithis/evals";
import { createCredentialDirectory } from "../../src/connections";
import type { CredentialDirectory } from "../../src/connections";
import { createCustody, createEnvFileBackend } from "../../src/custody";
import type { CustodyRuntime } from "../../src/custody";
import { createEventSpine } from "../../src/spine";
import { describePg, freshDb, truncateAll } from "../helpers/pg";

const FIXTURE_SECRETS = fileURLToPath(new URL("../fixtures/custody.secrets.env", import.meta.url));
const FIXTURE_SECRET_VALUE = "xoxb-fixture-not-a-real-secret-0001";

describePg("Custody broker (integration)", () => {
  beforeEach(async () => {
    await truncateAll(await freshDb());
  });

  interface Setup {
    custody: CustodyRuntime;
    credentials: CredentialDirectory;
    tenantId: string;
    p: PrincipalContext;
    clock: { now: number };
  }

  async function setup(): Promise<Setup> {
    const db = await freshDb();
    const spine = createEventSpine(db);
    const credentials = createCredentialDirectory(db, spine);
    const clock = { now: Date.now() };
    const custody = createCustody({
      db,
      spine,
      credentials,
      backend: createEnvFileBackend(FIXTURE_SECRETS),
      nowMs: () => clock.now,
    });
    const tenantId = newUlid();
    const p: PrincipalContext = { tenantId, principalId: newUlid(), kind: "human" };
    return { custody, credentials, tenantId, p, clock };
  }

  test("getBrokered round-trips: opaque handle out, secret only via redeem, issuance evented", async () => {
    const db = await freshDb();
    const spine = createEventSpine(db);
    const { custody, credentials, tenantId, p } = await setup();
    const credential = await credentials.create({
      tenantId,
      kind: "api_key",
      custodyBackendRef: "env-file:FAKE_SLACK_TOKEN",
    });

    const auth = await custody.getBrokered(credential.id, p);
    expect(auth.credentialId).toBe(credential.id);
    expect(auth.kind).toBe("api_key");
    expect(auth.brokerToken).toStartWith("bkr_");
    expect(new Date(auth.expiresAt).getTime()).toBeGreaterThan(Date.now());
    // The secret NEVER rides the handle.
    expect(JSON.stringify(auth)).not.toContain(FIXTURE_SECRET_VALUE);

    const redeemed = await custody.redeem(auth.brokerToken);
    expect(redeemed).toEqual({
      credentialId: credential.id,
      kind: "api_key",
      secret: FIXTURE_SECRET_VALUE,
    });

    // Issuance is audited on the spine — and carries no secret material.
    const events = await spine.readSince(
      { consumerId: "t", tenantId, afterSeq: 0n },
      { topics: ["custody.credential.brokered"] },
    );
    expect(events.length).toBe(1);
    expect(events[0]!.payload).toEqual({
      credentialId: credential.id,
      kind: "api_key",
      expiresAt: auth.expiresAt,
    });
    const serialized = JSON.stringify(events[0], (_k, v: unknown) =>
      typeof v === "bigint" ? v.toString() : v,
    );
    expect(serialized).not.toContain(FIXTURE_SECRET_VALUE);
    expect(serialized).not.toContain(auth.brokerToken);
  });

  test("credential directory create emits custody.credential.created (metadata only)", async () => {
    const db = await freshDb();
    const spine = createEventSpine(db);
    const { credentials, tenantId } = await setup();
    const credential = await credentials.create({
      tenantId,
      kind: "oauth_token",
      custodyBackendRef: "env-file:FAKE_SLACK_TOKEN",
    });
    expect(await credentials.get(credential.id)).toEqual(credential);
    expect(await credentials.get(newUlid())).toBeNull();

    const events = await spine.readSince(
      { consumerId: "t", tenantId, afterSeq: 0n },
      { topics: ["custody.credential.created"] },
    );
    expect(events.length).toBe(1);
    expect(events[0]!.payload).toEqual({
      kind: "oauth_token",
      custodyBackendRef: "env-file:FAKE_SLACK_TOKEN",
    });
  });

  test("broker tokens expire after the ttl", async () => {
    const { custody, credentials, tenantId, p, clock } = await setup();
    const credential = await credentials.create({
      tenantId,
      kind: "api_key",
      custodyBackendRef: "env-file:FAKE_SLACK_TOKEN",
    });
    const auth = await custody.getBrokered(credential.id, p);
    expect((await custody.redeem(auth.brokerToken)).secret).toBe(FIXTURE_SECRET_VALUE);
    clock.now += 16 * 60_000; // past the 15-minute default ttl
    expect(custody.redeem(auth.brokerToken)).rejects.toThrow(/unknown or expired broker token/);
  });

  test("unknown and cross-tenant credentials answer identically: not found", async () => {
    const { custody, credentials, p } = await setup();
    expect(custody.getBrokered(newUlid(), p)).rejects.toThrow(/not found/);

    const foreign = await credentials.create({
      tenantId: newUlid(), // some OTHER tenant's credential
      kind: "api_key",
      custodyBackendRef: "env-file:FAKE_SLACK_TOKEN",
    });
    expect(custody.getBrokered(foreign.id, p)).rejects.toThrow(/not found/);
  });

  test("backend failures are loud: missing key, unsupported ref, unset secrets file", async () => {
    const db = await freshDb();
    const spine = createEventSpine(db);
    const { custody, credentials, tenantId, p } = await setup();
    const missing = await credentials.create({
      tenantId,
      kind: "api_key",
      custodyBackendRef: "env-file:NO_SUCH_KEY",
    });
    expect(custody.getBrokered(missing.id, p)).rejects.toThrow(/'NO_SUCH_KEY' not found/);

    const unsupported = await credentials.create({
      tenantId,
      kind: "api_key",
      custodyBackendRef: "gcp-secret-manager:projects/x/secrets/y",
    });
    expect(custody.getBrokered(unsupported.id, p)).rejects.toThrow(/unsupported custody backend ref/);

    const unconfigured = createCustody({
      db,
      spine,
      credentials,
      backend: createEnvFileBackend(undefined),
    });
    expect(unconfigured.getBrokered(missing.id, p)).rejects.toThrow(/LITHIS_SECRETS_FILE is not set/);
  });

  test("mountSession remains a loud stub", async () => {
    const { custody } = await setup();
    const err = expectStub(() => custody.mountSession(newUlid(), { podId: "pod-1" }));
    expect(err.stubId).toBe("server.custody.broker.mountSession");
  });
});
