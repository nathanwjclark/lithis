/**
 * @lithis/stubkit — the honesty machinery.
 *
 * Every unimplemented interface or placeholder in lithis MUST be declared through
 * this package. A stub is loud (throws on use), deterministic (never returns
 * plausible fake data), and searchable (its reason string carries the
 * `LITHIS-STUB:` token, so `grep -r "LITHIS-STUB:"` finds every stub in source,
 * and the runtime registry exposes the same set at /stubs).
 *
 * This package itself ships fully implemented — it is the one place stubbing
 * is forbidden.
 */

export const STUB_TOKEN = "LITHIS-STUB:";

/** Symbol used to mark stub functions/values so tools can detect them without invoking. */
export const STUB_MARKER: unique symbol = Symbol.for("lithis.stub");

export class NotImplementedError extends Error {
  readonly stubId: string;
  readonly reason: string;

  constructor(stubId: string, reason: string) {
    super(`${STUB_TOKEN.replace(":", "")} '${stubId}' invoked but not implemented — ${reason}`);
    this.name = "NotImplementedError";
    this.stubId = stubId;
    this.reason = reason;
  }
}

export interface StubRecord {
  /** Unique dot-namespaced id, e.g. "server.context.store.search". */
  id: string;
  /** Human reason; MUST start with the LITHIS-STUB: token. */
  reason: string;
  registeredAt: string;
  invocations: number;
}

export interface StubCensus {
  total: number;
  invoked: number;
  records: StubRecord[];
}

class StubRegistryImpl {
  private stubs = new Map<string, StubRecord>();

  register(id: string, reason: string): StubRecord {
    if (!id || !/^[a-z0-9_.:-]+$/i.test(id)) {
      throw new Error(`stubkit: invalid stub id '${id}' (use dot-namespaced identifiers)`);
    }
    if (!reason.startsWith(STUB_TOKEN)) {
      throw new Error(
        `stubkit: stub '${id}' reason must start with '${STUB_TOKEN}' so it is greppable — got: ${reason}`,
      );
    }
    const existing = this.stubs.get(id);
    if (existing) {
      throw new Error(`stubkit: duplicate stub id '${id}' (first registered ${existing.registeredAt})`);
    }
    const record: StubRecord = {
      id,
      reason,
      registeredAt: new Date().toISOString(),
      invocations: 0,
    };
    this.stubs.set(id, record);
    return record;
  }

  recordInvocation(id: string): void {
    const record = this.stubs.get(id);
    if (record) record.invocations += 1;
  }

  get(id: string): StubRecord | undefined {
    return this.stubs.get(id);
  }

  list(): StubRecord[] {
    return [...this.stubs.values()].sort((a, b) => a.id.localeCompare(b.id));
  }

  census(): StubCensus {
    const records = this.list();
    return {
      total: records.length,
      invoked: records.filter((r) => r.invocations > 0).length,
      records,
    };
  }

  /** Human-readable census block for boot logs. */
  renderCensus(): string {
    const { total, records } = this.census();
    if (total === 0) return "stubkit: no registered stubs — everything wired is real.";
    const lines = records.map((r) => `  - ${r.id}  (${r.invocations}x)  ${r.reason}`);
    return [`stubkit: ${total} registered stub(s) — these paths FAIL when exercised:`, ...lines].join("\n");
  }

  /** Test-only: clear the registry. */
  reset(): void {
    this.stubs.clear();
  }
}

export const StubRegistry = new StubRegistryImpl();

interface StubMarked {
  [STUB_MARKER]: string;
}

/** True if the given function or value was produced by stubkit. */
export function isStub(value: unknown): value is StubMarked {
  return (
    (typeof value === "function" || (typeof value === "object" && value !== null)) &&
    STUB_MARKER in (value as object)
  );
}

/**
 * Declare an unimplemented function. Calling it throws NotImplementedError.
 *
 *   export const search = stub<ContextStore["search"]>(
 *     "server.context.store.search",
 *     "LITHIS-STUB: hybrid FTS+vector search not implemented yet",
 *   );
 */
export function stub<F extends (...args: never[]) => unknown>(id: string, reason: string): F {
  StubRegistry.register(id, reason);
  const fn = (..._args: never[]): never => {
    StubRegistry.recordInvocation(id);
    throw new NotImplementedError(id, reason);
  };
  Object.defineProperty(fn, STUB_MARKER, { value: id, enumerable: false });
  Object.defineProperty(fn, "name", { value: `stub:${id}`, configurable: true });
  return fn as unknown as F;
}

/**
 * Declare an unimplemented value/object. ANY property access throws — placeholder
 * data can never silently flow through the system as if it were real.
 */
export function stubValue<T extends object>(id: string, reason: string): T {
  StubRegistry.register(id, reason);
  const target = Object.create(null) as object;
  return new Proxy(target, {
    get(_t, prop) {
      if (prop === STUB_MARKER) return id;
      if (prop === Symbol.toStringTag) return `LithisStub(${id})`;
      // Promise-interop probe: `await stubValue(...)` checks for `.then`. Returning
      // undefined would let a stub await-through silently, so we throw here too —
      // only the marker and tag are inspectable without failing.
      StubRegistry.recordInvocation(id);
      throw new NotImplementedError(id, `${reason} (property '${String(prop)}' accessed)`);
    },
    has(_t, prop) {
      return prop === STUB_MARKER || prop === Symbol.toStringTag;
    },
  }) as T;
}

/**
 * Declare a service whose listed methods are all unimplemented. Each method is
 * registered individually (`${id}.${method}`) so the census shows exactly which
 * capabilities are missing.
 */
export function stubService<T extends object>(
  id: string,
  methods: ReadonlyArray<keyof T & string>,
  reason: string,
): T {
  const service: Record<string, unknown> = {};
  for (const method of methods) {
    service[method] = stub(`${id}.${method}`, reason);
  }
  Object.defineProperty(service, STUB_MARKER, { value: id, enumerable: false });
  return service as T;
}
