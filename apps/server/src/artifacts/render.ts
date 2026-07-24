/**
 * The template renderer — small, strict, deterministic, dependency-free.
 *
 * The language is deliberately tiny (two constructs) because the failure mode
 * we care about is a document that LOOKS finished while silently missing a
 * fact. Everything here fails loudly instead:
 *
 *   {{ field }}                 scalar substitution
 *   {{#each list}} … {{/each}}  block over an array (nestable; `{{this}}` is
 *                               the current item when it is a scalar)
 *
 * Strict mode is not optional:
 *   - a placeholder with no value in scope is a RenderError (never blank);
 *   - a value that is null/undefined is a RenderError (never "null");
 *   - an unclosed / mismatched block is a RenderError;
 *   - a lone `{{` or a `}}` with no opener is a RenderError;
 *   - `{{#each}}` over a non-array is a RenderError.
 *
 * Values are inserted verbatim (these are text/markdown artifacts, not HTML);
 * escaping belongs to whichever surface later renders the output.
 */

export class TemplateRenderError extends Error {
  constructor(
    message: string,
    /** 1-based line in the template body where the problem is. */
    readonly line: number,
  ) {
    super(`template render failed at line ${line}: ${message}`);
    this.name = "TemplateRenderError";
  }
}

// ── lexer ───────────────────────────────────────────────────────────────────

type Token =
  | { type: "text"; value: string; line: number }
  | { type: "var"; name: string; line: number }
  | { type: "each_open"; name: string; line: number }
  | { type: "each_close"; line: number };

const TAG_OPEN = "{{";
const TAG_CLOSE = "}}";
/** Identifiers inside tags: `this`, `a`, `a.b.c`. Nothing else parses. */
const PATH_RE = /^[a-zA-Z_][a-zA-Z0-9_]*(\.[a-zA-Z_][a-zA-Z0-9_]*)*$/;

function lineAt(source: string, index: number): number {
  let line = 1;
  for (let i = 0; i < index && i < source.length; i++) {
    if (source[i] === "\n") line += 1;
  }
  return line;
}

export function tokenize(source: string): Token[] {
  const tokens: Token[] = [];
  let cursor = 0;

  while (cursor < source.length) {
    const open = source.indexOf(TAG_OPEN, cursor);
    if (open === -1) {
      const tail = source.slice(cursor);
      const strayClose = tail.indexOf(TAG_CLOSE);
      if (strayClose !== -1) {
        throw new TemplateRenderError(
          "'}}' with no matching '{{' — literal braces are not supported",
          lineAt(source, cursor + strayClose),
        );
      }
      tokens.push({ type: "text", value: tail, line: lineAt(source, cursor) });
      break;
    }
    if (open > cursor) {
      const chunk = source.slice(cursor, open);
      const strayClose = chunk.indexOf(TAG_CLOSE);
      if (strayClose !== -1) {
        throw new TemplateRenderError(
          "'}}' with no matching '{{' — literal braces are not supported",
          lineAt(source, cursor + strayClose),
        );
      }
      tokens.push({ type: "text", value: chunk, line: lineAt(source, cursor) });
    }

    const close = source.indexOf(TAG_CLOSE, open + TAG_OPEN.length);
    const line = lineAt(source, open);
    if (close === -1) {
      throw new TemplateRenderError("unterminated '{{' — no closing '}}'", line);
    }
    const inner = source.slice(open + TAG_OPEN.length, close).trim();
    cursor = close + TAG_CLOSE.length;

    if (inner === "") {
      throw new TemplateRenderError("empty placeholder '{{}}'", line);
    }
    if (inner.startsWith("#each")) {
      const name = inner.slice("#each".length).trim();
      if (!PATH_RE.test(name)) {
        throw new TemplateRenderError(
          `'{{#each ${name}}}' — expected a field path like '{{#each items}}'`,
          line,
        );
      }
      tokens.push({ type: "each_open", name, line });
      continue;
    }
    if (inner === "/each") {
      tokens.push({ type: "each_close", line });
      continue;
    }
    if (inner.startsWith("#") || inner.startsWith("/")) {
      throw new TemplateRenderError(
        `unsupported block '{{${inner}}}' — this renderer supports '{{#each x}}…{{/each}}' only`,
        line,
      );
    }
    if (!PATH_RE.test(inner)) {
      throw new TemplateRenderError(
        `'{{${inner}}}' is not a field path — expected e.g. '{{client_name}}' or '{{policy.number}}'`,
        line,
      );
    }
    tokens.push({ type: "var", name: inner, line });
  }

  return tokens;
}

// ── scope resolution ────────────────────────────────────────────────────────

/** Innermost-first stack of scopes; `this` is the current each-item. */
interface Scope {
  value: unknown;
  /** True for each-item scopes, where `{{this}}` is meaningful. */
  isItem: boolean;
}

type Resolved = { found: true; value: unknown } | { found: false };

function lookupIn(container: unknown, path: string[]): Resolved {
  let current = container;
  for (const segment of path) {
    if (typeof current !== "object" || current === null || Array.isArray(current)) {
      return { found: false };
    }
    if (!Object.prototype.hasOwnProperty.call(current, segment)) return { found: false };
    current = (current as Record<string, unknown>)[segment];
  }
  return { found: true, value: current };
}

function resolvePath(stack: Scope[], name: string): Resolved {
  const path = name.split(".");
  for (let i = stack.length - 1; i >= 0; i--) {
    const scope = stack[i]!;
    if (path[0] === "this") {
      if (!scope.isItem) continue;
      return path.length === 1 ? { found: true, value: scope.value } : lookupIn(scope.value, path.slice(1));
    }
    const hit = lookupIn(scope.value, path);
    if (hit.found) return hit;
  }
  return { found: false };
}

function stringify(value: unknown, name: string, line: number): string {
  if (value === null || value === undefined) {
    throw new TemplateRenderError(
      `'{{${name}}}' resolved to ${value === null ? "null" : "undefined"} — a template never renders a blank for a missing value`,
      line,
    );
  }
  const t = typeof value;
  if (t === "string") return value as string;
  if (t === "number") {
    if (!Number.isFinite(value as number)) {
      throw new TemplateRenderError(`'{{${name}}}' resolved to a non-finite number`, line);
    }
    return String(value);
  }
  if (t === "boolean") return String(value);
  throw new TemplateRenderError(
    `'{{${name}}}' resolved to ${Array.isArray(value) ? "an array" : `a ${t}`} — only strings, numbers and booleans can be substituted (use '{{#each}}' for lists)`,
    line,
  );
}

// ── renderer ────────────────────────────────────────────────────────────────

/** Index just past the `{{/each}}` matching the `{{#each}}` at `openIndex`. */
function endOfBlock(tokens: Token[], openIndex: number, line: number): number {
  let depth = 0;
  for (let i = openIndex; i < tokens.length; i++) {
    const t = tokens[i]!;
    if (t.type === "each_open") depth += 1;
    else if (t.type === "each_close") {
      depth -= 1;
      if (depth === 0) return i + 1;
    }
  }
  throw new TemplateRenderError("'{{#each}}' is not closed — missing '{{/each}}'", line);
}

export interface RenderResult {
  output: string;
  /** Every field path actually consumed, sorted — the render evidence trail. */
  usedFields: string[];
}

/**
 * Render `source` with `inputs` in strict mode. Throws TemplateRenderError on
 * any unfilled or unknown placeholder — there is no lenient mode by design.
 */
export function renderTemplate(source: string, inputs: unknown): RenderResult {
  const tokens = tokenize(source);
  const used = new Set<string>();

  // Recursive descent over the token stream; `index` is shared via the return
  // value so nested blocks resume where the inner render stopped.
  function run(start: number, stack: Scope[], stopAtClose: boolean): { text: string; next: number } {
    let out = "";
    let i = start;
    while (i < tokens.length) {
      const token = tokens[i]!;
      if (token.type === "text") {
        out += token.value;
        i += 1;
        continue;
      }
      if (token.type === "var") {
        const hit = resolvePath(stack, token.name);
        if (!hit.found) {
          throw new TemplateRenderError(
            `'{{${token.name}}}' has no value in scope — every placeholder must be filled`,
            token.line,
          );
        }
        used.add(token.name);
        out += stringify(hit.value, token.name, token.line);
        i += 1;
        continue;
      }
      if (token.type === "each_close") {
        if (!stopAtClose) {
          throw new TemplateRenderError("'{{/each}}' with no matching '{{#each}}'", token.line);
        }
        return { text: out, next: i + 1 };
      }
      // each_open
      const hit = resolvePath(stack, token.name);
      if (!hit.found) {
        throw new TemplateRenderError(
          `'{{#each ${token.name}}}' has no value in scope`,
          token.line,
        );
      }
      if (!Array.isArray(hit.value)) {
        throw new TemplateRenderError(
          `'{{#each ${token.name}}}' expects an array, got ${hit.value === null ? "null" : typeof hit.value}`,
          token.line,
        );
      }
      used.add(token.name);
      const items = hit.value;
      // The block's extent is computed structurally (not by rendering), so an
      // unbalanced block is an error even when the list is empty.
      const bodyEnd = endOfBlock(tokens, i, token.line);
      for (const item of items) {
        out += run(i + 1, [...stack, { value: item, isItem: true }], true).text;
      }
      i = bodyEnd;
    }
    if (stopAtClose) {
      throw new TemplateRenderError(
        "'{{#each}}' is not closed — missing '{{/each}}'",
        tokens[tokens.length - 1]?.line ?? 1,
      );
    }
    return { text: out, next: i };
  }

  const { text } = run(0, [{ value: inputs, isItem: false }], false);
  return { output: text, usedFields: [...used].sort() };
}

/**
 * The ROOT-scope field names a template body references (`{{x.y}}` → `x`),
 * excluding anything inside an `{{#each}}` block (those resolve against the
 * item). Used at template-registration time to reject a body that references
 * fields its fieldsSchema never declares — a typo caught at approval time
 * instead of render time.
 */
export function collectRootFields(source: string): string[] {
  const tokens = tokenize(source);
  const names = new Set<string>();
  let depth = 0;
  for (const token of tokens) {
    if (token.type === "each_close") {
      depth -= 1;
      continue;
    }
    if (token.type === "each_open") {
      if (depth === 0) names.add(token.name.split(".")[0]!);
      depth += 1;
      continue;
    }
    if (token.type === "var" && depth === 0 && token.name !== "this") {
      names.add(token.name.split(".")[0]!);
    }
  }
  return [...names].sort();
}

/** Placeholder-shaped residue in a rendered output (the no-unfilled check). */
export function findResidualPlaceholders(output: string): string[] {
  const hits: string[] = [];
  for (const m of output.matchAll(/\{\{[^}]*\}\}/g)) hits.push(m[0]);
  return hits;
}
