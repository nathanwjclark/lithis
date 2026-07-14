import type { ClockRuntime, TickSource } from "./index";

/**
 * The clock — ONE loop (orchestrator role) is the single tick source. Domains
 * register TickSources (work: schedules + lease reclaim; humangate: SLA
 * follow-ups; connections: feed grace windows) and react inside their own
 * tick; the clock only sequences and isolates them. It emits no events itself
 * — sources emit domain events. Having zero sources registered is real
 * phase-1 state, not a placeholder: the loop, registry, and error isolation
 * are all live.
 */
export function createClockRuntime(): ClockRuntime {
  const sources: TickSource[] = [];
  let timer: ReturnType<typeof setInterval> | undefined;
  let tickInFlight: Promise<void> | undefined;

  async function tick(now: Date): Promise<void> {
    for (const source of [...sources]) {
      try {
        await source.tick(now);
      } catch (err) {
        // One failing source never stops the others.
        console.error(`clock: tick source '${source.id}' failed:`, err);
      }
    }
  }

  async function runTick(): Promise<void> {
    if (tickInFlight !== undefined) return; // never overlap ticks
    tickInFlight = tick(new Date()).finally(() => {
      tickInFlight = undefined;
    });
    await tickInFlight;
  }

  return {
    tick,
    registerSource(s: TickSource): void {
      if (sources.some((existing) => existing.id === s.id)) {
        throw new Error(`clock: tick source '${s.id}' is already registered`);
      }
      sources.push(s);
    },
    start(opts?: { intervalMs?: number }): void {
      if (timer !== undefined) return;
      timer = setInterval(() => void runTick(), opts?.intervalMs ?? 30_000);
    },
    stop(): void {
      if (timer !== undefined) {
        clearInterval(timer);
        timer = undefined;
      }
    },
  };
}
