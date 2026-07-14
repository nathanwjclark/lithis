import { describe, expect, test } from "bun:test";
import { expectStub } from "@lithis/evals";
import { COMMANDS, renderHelp, resolveCommand } from "../src/index";

function commandNamed(name: string) {
  const command = COMMANDS.find((c) => c.name === name);
  if (!command) throw new Error(`missing command '${name}'`);
  return command;
}

describe("resolveCommand", () => {
  test("empty argv and help aliases resolve to help", () => {
    expect(resolveCommand([])).toEqual({ kind: "help" });
    expect(resolveCommand(["help"])).toEqual({ kind: "help" });
    expect(resolveCommand(["--help"])).toEqual({ kind: "help" });
    expect(resolveCommand(["-h"])).toEqual({ kind: "help" });
  });

  test("resolves every command in the table by name", () => {
    for (const command of COMMANDS) {
      const resolved = resolveCommand([command.name]);
      expect(resolved).toEqual({ kind: "run", command, args: [] });
    }
  });

  test("forwards remaining argv as command args", () => {
    const resolved = resolveCommand(["stubs", "--json", "packages/sdk"]);
    expect(resolved).toEqual({
      kind: "run",
      command: commandNamed("stubs"),
      args: ["--json", "packages/sdk"],
    });
  });

  test("unknown commands are reported, not guessed", () => {
    expect(resolveCommand(["deploy"])).toEqual({ kind: "unknown", name: "deploy" });
    // Near-misses must not fuzzy-match.
    expect(resolveCommand(["stub"])).toEqual({ kind: "unknown", name: "stub" });
  });
});

describe("command table", () => {
  test("names are unique and the expected set", () => {
    const names = COMMANDS.map((c) => c.name);
    expect(new Set(names).size).toBe(names.length);
    expect(names.sort()).toEqual(
      ["dev", "eval", "init", "migrate", "new:connector", "new:pack", "new:skill", "stubs"].sort(),
    );
  });

  test("renderHelp lists every command with its description", () => {
    const help = renderHelp();
    for (const command of COMMANDS) {
      expect(help).toContain(command.name);
      expect(help).toContain(command.description);
    }
  });

  test("dev prints the runbook and exits 0 (real)", async () => {
    expect(await commandNamed("dev").handler([])).toBe(0);
  });
});

// `init` is REAL as of phase 1 (migrate + seed via runBunScript) — it is
// covered by running it against a live database, not asserted here.
describe("stubbed commands are loud", () => {
  const expected: Array<[name: string, stubId: string]> = [
    ["eval", "cli.eval"],
    ["new:connector", "cli.new.connector"],
    ["new:skill", "cli.new.skill"],
    ["new:pack", "cli.new.pack"],
  ];

  for (const [name, stubId] of expected) {
    test(`'${name}' throws NotImplementedError (${stubId})`, () => {
      const error = expectStub(() => commandNamed(name).handler([]));
      expect(error.stubId).toBe(stubId);
    });
  }
});
