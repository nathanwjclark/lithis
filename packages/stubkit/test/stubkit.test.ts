import { afterEach, describe, expect, test } from "bun:test";
import {
  NotImplementedError,
  STUB_MARKER,
  STUB_TOKEN,
  StubRegistry,
  isStub,
  stub,
  stubService,
  stubValue,
} from "@lithis/stubkit";

afterEach(() => StubRegistry.reset());

describe("stub()", () => {
  test("throws NotImplementedError with the stub id when invoked", () => {
    const search = stub<(q: string) => string[]>("test.search", "LITHIS-STUB: search not built");
    expect(() => search("hello")).toThrow(NotImplementedError);
    try {
      search("hello");
    } catch (err) {
      expect(err).toBeInstanceOf(NotImplementedError);
      expect((err as NotImplementedError).stubId).toBe("test.search");
      expect((err as NotImplementedError).message).toContain("test.search");
    }
  });

  test("rejects when awaited from an async caller", async () => {
    const fetchThing = stub<() => Promise<number>>("test.fetch", "LITHIS-STUB: fetch not built");
    const wrapper = async () => fetchThing();
    await expect(wrapper()).rejects.toBeInstanceOf(NotImplementedError);
  });

  test("registers in the StubRegistry and counts invocations", () => {
    const f = stub<() => void>("test.counted", "LITHIS-STUB: counting");
    expect(StubRegistry.get("test.counted")?.invocations).toBe(0);
    expect(() => f()).toThrow();
    expect(() => f()).toThrow();
    expect(StubRegistry.get("test.counted")?.invocations).toBe(2);
  });

  test("rejects reasons that do not carry the LITHIS-STUB token", () => {
    expect(() => stub("test.bad", "just not done yet")).toThrow(/LITHIS-STUB/);
  });

  test("rejects duplicate ids", () => {
    stub("test.dup", "LITHIS-STUB: first");
    expect(() => stub("test.dup", "LITHIS-STUB: second")).toThrow(/duplicate/);
  });

  test("rejects malformed ids", () => {
    expect(() => stub("bad id with spaces", "LITHIS-STUB: nope")).toThrow(/invalid stub id/);
  });

  test("is detectable without invoking", () => {
    const f = stub<() => void>("test.marked", "LITHIS-STUB: marked");
    expect(isStub(f)).toBe(true);
    expect((f as unknown as Record<symbol, string>)[STUB_MARKER]).toBe("test.marked");
    expect(isStub(() => {})).toBe(false);
  });
});

describe("stubValue()", () => {
  test("throws on any property access", () => {
    interface Config {
      apiUrl: string;
    }
    const cfg = stubValue<Config>("test.config", "LITHIS-STUB: config shape undecided");
    expect(() => cfg.apiUrl).toThrow(NotImplementedError);
  });

  test("throws when awaited (then-probe must not pass silently)", async () => {
    const v = stubValue<object>("test.awaited", "LITHIS-STUB: no data");
    await expect((async () => await (v as Promise<unknown>))()).rejects.toBeInstanceOf(NotImplementedError);
  });

  test("marker is inspectable without throwing", () => {
    const v = stubValue<object>("test.inspect", "LITHIS-STUB: inspectable");
    expect(isStub(v)).toBe(true);
  });
});

describe("stubService()", () => {
  interface Store {
    put(x: string): Promise<void>;
    get(x: string): Promise<string>;
  }

  test("registers one stub per method", () => {
    const store = stubService<Store>("test.store", ["put", "get"], "LITHIS-STUB: store not built");
    expect(StubRegistry.get("test.store.put")).toBeDefined();
    expect(StubRegistry.get("test.store.get")).toBeDefined();
    expect(() => store.put("x")).toThrow(NotImplementedError);
  });
});

describe("StubRegistry census", () => {
  test("census reports totals and invocation state", () => {
    const a = stub<() => void>("test.a", "LITHIS-STUB: a");
    stub<() => void>("test.b", "LITHIS-STUB: b");
    expect(() => a()).toThrow();
    const census = StubRegistry.census();
    expect(census.total).toBe(2);
    expect(census.invoked).toBe(1);
    expect(census.records.map((r) => r.id)).toEqual(["test.a", "test.b"]);
  });

  test("renderCensus mentions every stub id and the token", () => {
    stub<() => void>("test.render", "LITHIS-STUB: render me");
    const text = StubRegistry.renderCensus();
    expect(text).toContain("test.render");
    expect(text).toContain(STUB_TOKEN);
  });

  test("empty registry renders the all-real message", () => {
    expect(StubRegistry.renderCensus()).toContain("everything wired is real");
  });
});
