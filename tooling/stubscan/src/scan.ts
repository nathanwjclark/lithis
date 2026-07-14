/**
 * stubscan — static honesty gate for the lithis monorepo.
 *
 * Verifies, without executing anything:
 *   1. Every stub()/stubValue()/stubService() call site carries the searchable
 *      LITHIS-STUB token in a string literal (grep parity with the runtime registry).
 *   2. No silent placeholders outside tests: TODO-shaped `throw new Error(...)`,
 *      hand-constructed NotImplementedError, or *Data dummy identifiers.
 *   3. Stub ids are unique repo-wide.
 * And emits the stub census (the "what's real yet" inventory).
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

export interface StubSite {
  id: string;
  file: string;
  line: number;
  kind: "stub" | "stubValue" | "stubService";
  hasToken: boolean;
}

export interface Violation {
  rule:
    | "missing-token"
    | "non-literal-stub-id"
    | "todo-throw"
    | "raw-not-implemented"
    | "dummy-data-identifier"
    | "duplicate-stub-id";
  file: string;
  line: number;
  detail: string;
}

export interface ScanReport {
  scannedFiles: number;
  stubs: StubSite[];
  violations: Violation[];
}

const SOURCE_EXT = /\.(ts|tsx)$/;
const SKIP_DIRS = new Set(["node_modules", "dist", ".git", ".claude"]);
// The machinery itself and this scanner talk about the patterns they police.
const SELF_PATHS = [
  join("packages", "stubkit") + "/",
  join("tooling", "stubscan") + "/",
];

export function isTestPath(path: string): boolean {
  return /\.test\.tsx?$/.test(path) || /(^|\/)(test|tests|fixtures|__fixtures__)\//.test(path);
}

function isSelfPath(relPath: string): boolean {
  return SELF_PATHS.some((p) => relPath.startsWith(p));
}

export function listSourceFiles(root: string): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir)) {
      if (SKIP_DIRS.has(entry)) continue;
      const full = join(dir, entry);
      const st = statSync(full);
      if (st.isDirectory()) walk(full);
      else if (SOURCE_EXT.test(entry)) out.push(full);
    }
  };
  walk(root);
  return out.sort();
}

function lineOfIndex(content: string, index: number): number {
  let line = 1;
  for (let i = 0; i < index && i < content.length; i++) {
    if (content[i] === "\n") line += 1;
  }
  return line;
}

/** First string literal inside a window of text, if any. */
function firstStringLiteral(window: string): string | null {
  const m = window.match(/["'`]([^"'`\n]{1,200})["'`]/);
  return m?.[1] ?? null;
}

const STUB_CALL = /\b(stubService|stubValue|stub)\s*(?:<)?/g;
const TODO_THROW = /throw\s+new\s+Error\s*\(\s*["'`][^"'`\n]*\b(todo|not\s+implemented|unimplemented|wip|fixme)\b/gi;
const RAW_NIE = /new\s+NotImplementedError\s*\(/g;
const DUMMY_IDENT = /\b(mockData|dummyData|fakeData|MOCK_DATA|DUMMY_DATA|FAKE_DATA|sampleData)\b/g;
const TOKEN = "LITHIS-STUB:";
/** How far past the call name we look for the id + token (covers multi-line calls). */
const CALL_WINDOW = 500;

export function scanFile(relPath: string, content: string): { stubs: StubSite[]; violations: Violation[] } {
  const stubs: StubSite[] = [];
  const violations: Violation[] = [];
  const inTest = isTestPath(relPath);

  // 1. stub call sites → census + token check (skip declarations like `function stub(`)
  for (const match of content.matchAll(STUB_CALL)) {
    const idx = match.index ?? 0;
    const before = content.slice(Math.max(0, idx - 30), idx);
    if (/\b(function|import\s*\{[^}]*$|export\s+function)\s*$/.test(before)) continue;
    // must actually be a call: an opening paren within the generic/whitespace window
    const head = content.slice(idx, idx + 120);
    if (!/^(stubService|stubValue|stub)\s*(?:<[^\n]*?>)?\s*\(/.test(head)) continue;

    const window = content.slice(idx, idx + CALL_WINDOW);
    const line = lineOfIndex(content, idx);
    const id = firstStringLiteral(window.slice(window.indexOf("(") + 1));
    const kind = match[1] as StubSite["kind"];
    if (!id) {
      violations.push({
        rule: "non-literal-stub-id",
        file: relPath,
        line,
        detail: `${kind}() id must be a string literal so the census can see it statically`,
      });
      continue;
    }
    const hasToken = window.includes(TOKEN);
    stubs.push({ id, file: relPath, line, kind, hasToken });
    if (!hasToken) {
      violations.push({
        rule: "missing-token",
        file: relPath,
        line,
        detail: `${kind}('${id}', ...) reason must be a string literal starting with '${TOKEN}'`,
      });
    }
  }

  if (!inTest) {
    // 2a. TODO-shaped throws must be stub() instead
    for (const match of content.matchAll(TODO_THROW)) {
      violations.push({
        rule: "todo-throw",
        file: relPath,
        line: lineOfIndex(content, match.index ?? 0),
        detail: "TODO-shaped `throw new Error(...)` — declare it with stub() from @lithis/stubkit instead",
      });
    }
    // 2b. NotImplementedError may only be thrown by stubkit itself
    for (const match of content.matchAll(RAW_NIE)) {
      violations.push({
        rule: "raw-not-implemented",
        file: relPath,
        line: lineOfIndex(content, match.index ?? 0),
        detail: "construct stubs via stub()/stubValue()/stubService(), never `new NotImplementedError(...)` directly",
      });
    }
    // 2c. dummy-data identifiers are test-only
    for (const match of content.matchAll(DUMMY_IDENT)) {
      violations.push({
        rule: "dummy-data-identifier",
        file: relPath,
        line: lineOfIndex(content, match.index ?? 0),
        detail: `'${match[1]}' looks like inline dummy data — real data or a stubValue() only (tests/fixtures are exempt)`,
      });
    }
  }

  return { stubs, violations };
}

export function scanRepo(root: string): ScanReport {
  const files = listSourceFiles(root);
  const stubs: StubSite[] = [];
  const violations: Violation[] = [];
  let scanned = 0;

  for (const file of files) {
    const relPath = relative(root, file);
    if (isSelfPath(relPath)) continue;
    scanned += 1;
    const result = scanFile(relPath, readFileSync(file, "utf8"));
    stubs.push(...result.stubs);
    violations.push(...result.violations);
  }

  const seen = new Map<string, StubSite>();
  for (const site of stubs) {
    const prior = seen.get(site.id);
    if (prior) {
      violations.push({
        rule: "duplicate-stub-id",
        file: site.file,
        line: site.line,
        detail: `stub id '${site.id}' already declared at ${prior.file}:${prior.line}`,
      });
    } else {
      seen.set(site.id, site);
    }
  }

  return { scannedFiles: scanned, stubs, violations };
}

export function renderReport(report: ScanReport): string {
  const lines: string[] = [];
  const byPackage = new Map<string, StubSite[]>();
  for (const s of report.stubs) {
    const pkg = s.file.split("/").slice(0, 2).join("/");
    byPackage.set(pkg, [...(byPackage.get(pkg) ?? []), s]);
  }
  lines.push(`stubscan: ${report.scannedFiles} files scanned, ${report.stubs.length} stub(s) declared`);
  for (const [pkg, sites] of [...byPackage.entries()].sort()) {
    lines.push(`  ${pkg} (${sites.length})`);
    for (const s of sites.sort((a, b) => a.id.localeCompare(b.id))) {
      lines.push(`    - ${s.id}  ${s.file}:${s.line}`);
    }
  }
  if (report.violations.length > 0) {
    lines.push("", `VIOLATIONS (${report.violations.length}):`);
    for (const v of report.violations) {
      lines.push(`  ✗ [${v.rule}] ${v.file}:${v.line} — ${v.detail}`);
    }
  } else {
    lines.push("", "no violations — every placeholder is loud, registered, and searchable.");
  }
  return lines.join("\n");
}
