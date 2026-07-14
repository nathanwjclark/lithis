import { credentialSchema, newUlid, nowIso } from "@lithis/core";
import type { Credential, Ulid } from "@lithis/core";
import { txSql } from "../db";
import type { Db } from "../db";
import type { EventSpine } from "../spine";
import type { CredentialDirectory, NewCredential } from "./index";
import { rowToCredential } from "./shared";
import type { CredentialRow } from "./shared";

/**
 * Credential RECORDS — metadata only. The row stores WHERE the secret lives
 * (custodyBackendRef, e.g. "env-file:SLACK_BOT_TOKEN"), never the value; the
 * custody module resolves refs to material through its backend and this
 * directory is its lookup seam.
 */
export function createPgCredentialDirectory(db: Db, spine: EventSpine): CredentialDirectory {
  return {
    async create(input: NewCredential): Promise<Credential> {
      const id = newUlid();
      const at = nowIso();
      const credential = credentialSchema.parse({ ...input, id, createdAt: at, updatedAt: at });
      await db.withTx(async (tx) => {
        await txSql(tx)`
          insert into connections.credentials
            (id, tenant_id, kind, custody_backend_ref, holder_connection_id,
             rotates_at, created_at, updated_at)
          values
            (${id}, ${credential.tenantId}, ${credential.kind},
             ${credential.custodyBackendRef}, ${credential.holderConnectionId ?? null},
             ${credential.rotatesAt ?? null}, ${at}, ${at})`;
        await spine.append(tx, {
          tenantId: credential.tenantId,
          topic: "custody.credential.created",
          subjectRefs: [{ kind: "credential", id }],
          actor: { kind: "credential", id },
          payload: { kind: credential.kind, custodyBackendRef: credential.custodyBackendRef },
        });
      });
      return credential;
    },

    async get(credentialId: Ulid): Promise<Credential | null> {
      const rows: CredentialRow[] = await db.sql`
        select * from connections.credentials where id = ${credentialId}`;
      const row = rows[0];
      return row === undefined ? null : rowToCredential(row);
    },
  };
}
