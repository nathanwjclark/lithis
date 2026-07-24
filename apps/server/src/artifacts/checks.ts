import type { CompleteFn } from "../agents";
import { requiredFields } from "./fields";
import { findResidualPlaceholders } from "./render";

/**
 * Verification checks. Two kinds, both of which must be able to FAIL loudly:
 *
 *  - deterministic: a named check from the registry below. An unknown ref is
 *    a FAILURE with an explicit finding — never a silent pass, because a
 *    typo'd check name would otherwise turn verification into a rubber stamp.
 *  - rubric: a prompt scored by the model through the same injectable
 *    CompleteFn seam the agents executor uses. With no model configured the
 *    check is SKIPPED, and a skipped check cannot pass: the outcome is
 *    passed:false with a finding naming the missing configuration.
 *
 * Deterministic check refs may carry arguments:
 *   "length-bounds:min=200,max=20000"
 */

export interface CheckContext {
  output: string;
  inputs: unknown;
  fieldsSchema: Record<string, unknown>;
  /** Parsed `key=value` pairs from the ref suffix. */
  args: Record<string, string>;
}

export interface CheckOutcome {
  passed: boolean;
  /** Always present — a passing check explains what it proved, too. */
  detail: string;
}

export type DeterministicCheck = (ctx: CheckContext) => CheckOutcome;

function numericArg(args: Record<string, string>, name: string): number | undefined {
  const raw = args[name];
  if (raw === undefined) return undefined;
  const n = Number(raw);
  if (!Number.isFinite(n)) {
    throw new Error(`check argument '${name}' must be a number, got '${raw}'`);
  }
  return n;
}

/** Placeholder-ish leftovers a human would call "unfinished". */
const TODO_MARKERS = /\b(TODO|TBD|FIXME|XXX|LOREM IPSUM|PLACEHOLDER|<INSERT[^>]*>)\b/gi;

export const DETERMINISTIC_CHECKS: Record<string, DeterministicCheck> = {
  /** No `{{…}}` residue survived rendering. */
  "no-unfilled-placeholders": ({ output }) => {
    const residue = findResidualPlaceholders(output);
    return residue.length === 0
      ? { passed: true, detail: "no '{{…}}' placeholder residue in the output" }
      : {
          passed: false,
          detail: `${residue.length} unfilled placeholder(s) survived rendering: ${residue.slice(0, 5).join(", ")}`,
        };
  },

  /** Every field the template declares required is present and non-blank. */
  "required-fields": ({ inputs, fieldsSchema }) => {
    const required = requiredFields(fieldsSchema);
    if (required.length === 0) {
      return {
        passed: false,
        detail:
          "required-fields check declared, but the template's fieldsSchema declares no required fields — the check asserts nothing",
      };
    }
    const record = (typeof inputs === "object" && inputs !== null ? inputs : {}) as Record<string, unknown>;
    const missing = required.filter((name) => {
      const value = record[name];
      if (value === undefined || value === null) return true;
      if (typeof value === "string" && value.trim() === "") return true;
      if (Array.isArray(value) && value.length === 0) return true;
      return false;
    });
    return missing.length === 0
      ? { passed: true, detail: `all ${required.length} required field(s) supplied and non-blank` }
      : { passed: false, detail: `required field(s) missing or blank: ${missing.join(", ")}` };
  },

  /** The rendered output actually has content. */
  "non-empty": ({ output }) =>
    output.trim().length > 0
      ? { passed: true, detail: `output has ${output.trim().length} non-whitespace character(s)` }
      : { passed: false, detail: "output is empty or whitespace-only" },

  /** Output length inside declared bounds — args: min, max (characters). */
  "length-bounds": ({ output, args }) => {
    const min = numericArg(args, "min");
    const max = numericArg(args, "max");
    if (min === undefined && max === undefined) {
      return {
        passed: false,
        detail:
          "length-bounds requires at least one of min=/max= in the check ref (e.g. 'length-bounds:min=200,max=20000')",
      };
    }
    const len = output.length;
    if (min !== undefined && len < min) {
      return { passed: false, detail: `output is ${len} characters, below the declared minimum ${min}` };
    }
    if (max !== undefined && len > max) {
      return { passed: false, detail: `output is ${len} characters, above the declared maximum ${max}` };
    }
    return {
      passed: true,
      detail: `output length ${len} is within [${min ?? "-"}, ${max ?? "-"}]`,
    };
  },

  /** No TODO/TBD/lorem-ipsum style unfinished markers survived into the output. */
  "no-todo-markers": ({ output }) => {
    const hits = [...output.matchAll(TODO_MARKERS)].map((m) => m[0]);
    return hits.length === 0
      ? { passed: true, detail: "no TODO/TBD/placeholder markers in the output" }
      : {
          passed: false,
          detail: `output still contains unfinished markers: ${[...new Set(hits)].slice(0, 5).join(", ")}`,
        };
  },
};

export const DETERMINISTIC_CHECK_REFS = Object.keys(DETERMINISTIC_CHECKS).sort();

/** Split "name:min=1,max=2" into the registry key and its arguments. */
export function parseCheckRef(ref: string): { name: string; args: Record<string, string> } {
  const colon = ref.indexOf(":");
  if (colon === -1) return { name: ref.trim(), args: {} };
  const name = ref.slice(0, colon).trim();
  const args: Record<string, string> = {};
  for (const pair of ref.slice(colon + 1).split(",")) {
    if (pair.trim() === "") continue;
    const eq = pair.indexOf("=");
    if (eq === -1) {
      args[pair.trim()] = "";
      continue;
    }
    args[pair.slice(0, eq).trim()] = pair.slice(eq + 1).trim();
  }
  return { name, args };
}

/**
 * Run one deterministic check ref. An unknown name fails with a finding that
 * names the registered refs; a check that throws fails with the error text.
 */
export function runDeterministicCheck(
  ref: string,
  ctx: Omit<CheckContext, "args">,
): CheckOutcome {
  const { name, args } = parseCheckRef(ref);
  const check = DETERMINISTIC_CHECKS[name];
  if (check === undefined) {
    return {
      passed: false,
      detail:
        `unknown deterministic check ref '${ref}' — no such check is registered. ` +
        `Registered: ${DETERMINISTIC_CHECK_REFS.join(", ")}. An unknown check can never pass.`,
    };
  }
  try {
    return check({ ...ctx, args });
  } catch (err) {
    return {
      passed: false,
      detail: `deterministic check '${ref}' errored: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

// ── rubric checks ───────────────────────────────────────────────────────────

const RUBRIC_SYSTEM = `You are a strict document verifier. You are given a rubric and a document.
Answer with a single line of JSON and nothing else:
{"pass": true|false, "reason": "<one sentence>"}
Judge ONLY the rubric. If the document does not clearly satisfy it, answer false.`;

/** How much of the artifact a rubric check sees (characters). */
export const RUBRIC_OUTPUT_BUDGET = 24_000;

export function buildRubricPrompt(prompt: string, output: string): string {
  const body =
    output.length > RUBRIC_OUTPUT_BUDGET
      ? `${output.slice(0, RUBRIC_OUTPUT_BUDGET)}\n…[truncated ${output.length - RUBRIC_OUTPUT_BUDGET} characters]`
      : output;
  return `RUBRIC:\n${prompt}\n\nDOCUMENT:\n<<<\n${body}\n>>>`;
}

/** Strict parse of the model's verdict — anything else is a failure, not a pass. */
export function parseRubricVerdict(text: string): CheckOutcome {
  const match = text.match(/\{[\s\S]*\}/);
  if (match === null) {
    return { passed: false, detail: `rubric verdict unparseable (no JSON object in the reply): ${text.slice(0, 200)}` };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(match[0]);
  } catch {
    return { passed: false, detail: `rubric verdict was not valid JSON: ${match[0].slice(0, 200)}` };
  }
  if (typeof parsed !== "object" || parsed === null) {
    return { passed: false, detail: "rubric verdict JSON was not an object" };
  }
  const pass = (parsed as Record<string, unknown>)["pass"];
  const reason = (parsed as Record<string, unknown>)["reason"];
  if (typeof pass !== "boolean") {
    return { passed: false, detail: `rubric verdict has no boolean 'pass' field: ${match[0].slice(0, 200)}` };
  }
  const detail = typeof reason === "string" && reason.trim() !== "" ? reason.trim() : "(model gave no reason)";
  return { passed: pass, detail };
}

export interface RubricRunnerDeps {
  complete?: CompleteFn;
  model: string;
}

/**
 * Score one rubric through the model seam. No model configured → SKIPPED,
 * and skipped means passed:false with an explicit finding (a check nobody ran
 * is not a check that passed).
 */
export async function runRubricCheck(
  prompt: string,
  output: string,
  deps: RubricRunnerDeps,
): Promise<CheckOutcome> {
  if (deps.complete === undefined) {
    return {
      passed: false,
      detail:
        `rubric check SKIPPED (no model configured: ANTHROPIC_API_KEY unset and no complete() seam injected) — ` +
        `a skipped check cannot pass. Rubric: ${prompt.slice(0, 160)}`,
    };
  }
  let turn;
  try {
    turn = await deps.complete(
      {
        model: deps.model,
        system: RUBRIC_SYSTEM,
        maxTokens: 512,
        messages: [{ role: "user", content: buildRubricPrompt(prompt, output) }],
        tools: [],
      },
      new AbortController().signal,
    );
  } catch (err) {
    return {
      passed: false,
      detail: `rubric check errored calling the model: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
  const text = turn.content
    .map((b) => (b.type === "text" ? b.text : ""))
    .filter((t) => t.length > 0)
    .join("\n");
  return parseRubricVerdict(text);
}
