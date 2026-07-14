import { describe, expect, test } from "bun:test";
import { isStub, NotImplementedError } from "@lithis/stubkit";

/**
 * Shared assertion for stubbed module services: every method throws
 * NotImplementedError carrying the dot-namespaced stub id — the skeleton's
 * honesty contract. Each module keeps its own test file under test/modules/
 * so an implementing phase deletes only its own cases (and replaces them
 * with real behavioral tests).
 */

export interface StubServiceCase {
  name: string;
  service: object;
  idPrefix: string;
  methods: string[];
}

export function describeStubService(c: StubServiceCase): void {
  describe(c.name, () => {
    test("is marked as a stub", () => {
      expect(isStub(c.service)).toBe(true);
    });

    for (const method of c.methods) {
      test(`${method}() throws NotImplementedError with stub id ${c.idPrefix}.${method}`, () => {
        const fn = (c.service as Record<string, (...args: unknown[]) => unknown>)[method];
        expect(fn).toBeInstanceOf(Function);
        expect(() => fn!()).toThrow(NotImplementedError);
        try {
          fn!();
        } catch (err) {
          expect((err as NotImplementedError).stubId).toBe(`${c.idPrefix}.${method}`);
          expect((err as NotImplementedError).reason).toStartWith("LITHIS-STUB:");
        }
      });
    }
  });
}
