import { SQL } from "bun";

/**
 * db — the shared Postgres access layer (Bun's built-in SQL client; zero
 * dependencies). Modules receive a `Db` and run their mutations inside
 * `withTx`, passing the opaque `DbTx` handle to anything that must commit
 * atomically with them — most importantly `EventSpine.append` (the
 * transactional outbox). `txSql` unwraps the handle back into a SQL instance;
 * it is published here so every module can write its OWN tables inside a
 * shared transaction (cross-module table access remains forbidden by
 * convention).
 */

export * from "./migrate";

/** Opaque handle to the transaction a mutation is writing in (outbox contract). */
export interface DbTx {
  readonly __brand: "DbTx";
}

const TX_SQL = Symbol("lithis.dbtx.sql");

interface DbTxInternal extends DbTx {
  [TX_SQL]: SQL;
}

export interface Db {
  /** The pooled client — single statements and reads outside a transaction. */
  readonly sql: SQL;
  /** Run fn inside one transaction (BEGIN/COMMIT, ROLLBACK on throw). */
  withTx<T>(fn: (tx: DbTx) => Promise<T>): Promise<T>;
  close(): Promise<void>;
}

/** Unwrap a DbTx into its transaction-scoped SQL instance. */
export function txSql(tx: DbTx): SQL {
  const inner = (tx as DbTxInternal)[TX_SQL];
  if (inner === undefined) {
    throw new Error("txSql: received a foreign object — DbTx handles are created by Db.withTx");
  }
  return inner;
}

export function createDb(databaseUrl: string): Db {
  // bigint: int8 outside i32 range comes back as BigInt; rows are still always
  // parsed through zod (eventSchema.seq is z.coerce.bigint()) before use.
  const sql = new SQL({ url: databaseUrl, bigint: true });
  return {
    sql,
    async withTx<T>(fn: (tx: DbTx) => Promise<T>): Promise<T> {
      return (await sql.begin(async (inner) => {
        const handle: DbTxInternal = { __brand: "DbTx", [TX_SQL]: inner as unknown as SQL };
        return await fn(handle);
      })) as T;
    },
    async close(): Promise<void> {
      await sql.close({ timeout: 5 });
    },
  };
}
