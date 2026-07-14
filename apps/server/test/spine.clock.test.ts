import { describe, expect, test } from "bun:test";
import { createClock } from "../src/spine";
import type { TickSource } from "../src/spine";

describe("ClockRuntime", () => {
  test("tick fans out to every registered source in order", async () => {
    const clock = createClock();
    const calls: string[] = [];
    const source = (id: string): TickSource => ({
      id,
      tick: async () => {
        calls.push(id);
      },
    });
    clock.registerSource(source("a"));
    clock.registerSource(source("b"));
    const now = new Date();
    await clock.tick(now);
    expect(calls).toEqual(["a", "b"]);
  });

  test("sources receive the tick timestamp", async () => {
    const clock = createClock();
    let seen: Date | undefined;
    clock.registerSource({
      id: "capture",
      tick: async (now) => {
        seen = now;
      },
    });
    const now = new Date("2026-07-14T09:30:00Z");
    await clock.tick(now);
    expect(seen).toEqual(now);
  });

  test("a throwing source is isolated — later sources still run", async () => {
    const clock = createClock();
    const calls: string[] = [];
    clock.registerSource({
      id: "boom",
      tick: async () => {
        calls.push("boom");
        throw new Error("source exploded");
      },
    });
    clock.registerSource({
      id: "after",
      tick: async () => {
        calls.push("after");
      },
    });
    await clock.tick(new Date()); // must not throw
    expect(calls).toEqual(["boom", "after"]);
  });

  test("duplicate source ids are rejected", () => {
    const clock = createClock();
    clock.registerSource({ id: "dup", tick: async () => {} });
    expect(() => clock.registerSource({ id: "dup", tick: async () => {} })).toThrow(
      /already registered/,
    );
  });

  test("start/stop drive ticks on the interval without overlap", async () => {
    const clock = createClock();
    let running = 0;
    let overlapped = false;
    let ticks = 0;
    clock.registerSource({
      id: "slow",
      tick: async () => {
        running += 1;
        if (running > 1) overlapped = true;
        ticks += 1;
        await new Promise((r) => setTimeout(r, 25));
        running -= 1;
      },
    });
    clock.start({ intervalMs: 10 });
    await new Promise((r) => setTimeout(r, 120));
    clock.stop();
    const after = ticks;
    await new Promise((r) => setTimeout(r, 40));
    expect(ticks).toBe(after); // stopped means stopped
    expect(ticks).toBeGreaterThanOrEqual(2);
    expect(overlapped).toBe(false);
  });
});
