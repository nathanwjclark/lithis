import { join } from "node:path";
import { stub } from "@lithis/stubkit";

/**
 * @lithis/cli — command table + argument resolution are REAL (unit-tested);
 * the scaffolding/eval commands are registered stubs. `src/cli.ts` is the bin
 * entrypoint.
 */

export type CommandHandler = (args: string[]) => number | Promise<number>;

export interface CliCommand {
  name: string;
  description: string;
  handler: CommandHandler;
}

/** Monorepo root, resolved from this file (packages/cli/src → repo root). */
export const REPO_ROOT = join(import.meta.dir, "..", "..", "..");

/** Run a repo script under bun, inheriting stdio; returns its exit code. */
function runBunScript(scriptRelPath: string, args: string[]): number {
  const result = Bun.spawnSync({
    cmd: ["bun", scriptRelPath, ...args],
    cwd: REPO_ROOT,
    stdout: "inherit",
    stderr: "inherit",
    stdin: "inherit",
  });
  return result.exitCode ?? 1;
}

const DEV_INSTRUCTIONS = `lithis dev — local development

  1. Start infrastructure (postgres+pgvector, minio):
       docker compose up -d postgres minio
  2. Run migrations:
       lithis migrate        (composes per-module migrations in dependency order)
  3. Start the server (all roles) and the portal:
       bun run dev:server
       bun run dev:portal
  4. Check what's real yet:
       lithis stubs          (static census; the running server also serves /stubs)

  Or run the whole demo path in containers: docker compose up
`;

export const COMMANDS: readonly CliCommand[] = [
  {
    name: "init",
    description: "Scaffold a new lithis workspace (tenant, env file, compose overrides)",
    handler: stub<CommandHandler>(
      "cli.init",
      "LITHIS-STUB: workspace scaffolding not implemented — lands with the spine + iam build-out",
    ),
  },
  {
    name: "dev",
    description: "Print the local development runbook (compose + dev servers)",
    handler: (_args) => {
      console.log(DEV_INSTRUCTIONS);
      return 0;
    },
  },
  {
    name: "migrate",
    description: "Compose and apply per-module migrations in dependency order",
    handler: (args) => runBunScript("apps/server/src/db/migrate.ts", args),
  },
  {
    name: "stubs",
    description: "Static stub census + honesty gate (stubscan)",
    handler: (args) => runBunScript("tooling/stubscan/src/cli.ts", args),
  },
  {
    name: "eval",
    description: "Run an eval suite (event-log replay) against a skill/connector",
    handler: stub<CommandHandler>(
      "cli.eval",
      "LITHIS-STUB: eval runner not implemented — needs the @lithis/evals replay harness",
    ),
  },
  {
    name: "new:connector",
    description: "Scaffold a connector in extensions/connectors/",
    handler: stub<CommandHandler>(
      "cli.new.connector",
      "LITHIS-STUB: connector scaffolding not implemented — author against @lithis/sdk/connectors manually for now",
    ),
  },
  {
    name: "new:skill",
    description: "Scaffold a skill in extensions/skills/",
    handler: stub<CommandHandler>(
      "cli.new.skill",
      "LITHIS-STUB: skill scaffolding not implemented — author against @lithis/sdk/skills manually for now",
    ),
  },
  {
    name: "new:pack",
    description: "Scaffold a pack in extensions/packs/",
    handler: stub<CommandHandler>(
      "cli.new.pack",
      "LITHIS-STUB: pack scaffolding not implemented — copy extensions/packs/insurance-brokerage as a reference for now",
    ),
  },
] as const;

export type ResolvedCommand =
  | { kind: "run"; command: CliCommand; args: string[] }
  | { kind: "help" }
  | { kind: "unknown"; name: string };

/** Pure argv → command resolution. argv excludes the runtime and script path. */
export function resolveCommand(argv: string[]): ResolvedCommand {
  const [name, ...rest] = argv;
  if (name === undefined || name === "help" || name === "--help" || name === "-h") {
    return { kind: "help" };
  }
  const command = COMMANDS.find((c) => c.name === name);
  if (!command) return { kind: "unknown", name };
  return { kind: "run", command, args: rest };
}

export function renderHelp(): string {
  const width = Math.max(...COMMANDS.map((c) => c.name.length));
  const lines = COMMANDS.map((c) => `  ${c.name.padEnd(width)}  ${c.description}`);
  return ["lithis <command> [args]", "", "Commands:", ...lines].join("\n");
}
