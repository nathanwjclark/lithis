#!/usr/bin/env bun
/**
 * stubscan CLI.
 *
 *   bun tooling/stubscan/src/cli.ts            # census + violations, exit 1 on violations
 *   bun tooling/stubscan/src/cli.ts --json out.json
 *   bun tooling/stubscan/src/cli.ts --root /path/to/repo
 */

import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { renderReport, scanRepo } from "./scan";

function main(argv: string[]): number {
  let root = process.cwd();
  let jsonPath: string | null = null;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--root" && argv[i + 1]) root = resolve(argv[++i]!);
    else if (arg === "--json" && argv[i + 1]) jsonPath = resolve(argv[++i]!);
    else if (arg === "--help") {
      console.log("usage: stubscan [--root <dir>] [--json <out.json>]");
      return 0;
    }
  }

  const report = scanRepo(root);
  console.log(renderReport(report));

  if (jsonPath) {
    writeFileSync(
      jsonPath,
      JSON.stringify({ generatedAt: new Date().toISOString(), ...report }, null, 2),
    );
    console.log(`\ncensus written to ${jsonPath}`);
  }

  return report.violations.length > 0 ? 1 : 0;
}

process.exit(main(process.argv.slice(2)));
