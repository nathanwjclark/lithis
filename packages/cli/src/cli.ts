#!/usr/bin/env bun
import { NotImplementedError } from "@lithis/stubkit";
import { renderHelp, resolveCommand } from "./index";

/** Bin entrypoint for `lithis`. All logic lives (tested) in ./index.ts. */

const resolved = resolveCommand(process.argv.slice(2));

if (resolved.kind === "help") {
  console.log(renderHelp());
  process.exit(0);
}

if (resolved.kind === "unknown") {
  console.error(`lithis: unknown command '${resolved.name}'\n`);
  console.error(renderHelp());
  process.exit(2);
}

try {
  const code = await resolved.command.handler(resolved.args);
  process.exit(code);
} catch (error) {
  if (error instanceof NotImplementedError) {
    // Loud, honest failure: the stub census owns this path.
    console.error(error.message);
    process.exit(1);
  }
  throw error;
}
