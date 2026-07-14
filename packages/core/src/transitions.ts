/**
 * Transition tables — executable state machines. The tables in work.ts and
 * humangate.ts are the authoritative definition of what moves are legal;
 * services validate through these helpers and tests exercise the tables
 * directly.
 */

export type TransitionTable<S extends string> = Readonly<Record<S, readonly S[]>>;

export function canTransition<S extends string>(
  table: TransitionTable<S>,
  from: S,
  to: S,
): boolean {
  return table[from].includes(to);
}

export class IllegalTransitionError<S extends string> extends Error {
  constructor(
    readonly from: S,
    readonly to: S,
    subject: string,
  ) {
    super(`illegal ${subject} transition: '${from}' → '${to}'`);
    this.name = "IllegalTransitionError";
  }
}

export function assertTransition<S extends string>(
  table: TransitionTable<S>,
  from: S,
  to: S,
  subject: string,
): void {
  if (!canTransition(table, from, to)) {
    throw new IllegalTransitionError(from, to, subject);
  }
}

/** All states reachable (transitively) from `start`. */
export function reachableStates<S extends string>(table: TransitionTable<S>, start: S): Set<S> {
  const seen = new Set<S>([start]);
  const queue: S[] = [start];
  while (queue.length > 0) {
    const s = queue.pop() as S;
    for (const next of table[s]) {
      if (!seen.has(next)) {
        seen.add(next);
        queue.push(next);
      }
    }
  }
  return seen;
}
