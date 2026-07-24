import { describe, expect, test } from "bun:test";
import { expectStub } from "@lithis/evals";
import {
  DETERMINISTIC_CHECK_REFS,
  FieldsSchemaUnsupportedError,
  FieldsValidationError,
  TemplateRenderError,
  collectRootFields,
  createUnconfiguredArtifactEngine,
  findResidualPlaceholders,
  parseCheckRef,
  parseRubricVerdict,
  renderTemplate,
  renderVisualArtifact,
  runDeterministicCheck,
  runRubricCheck,
  validateInputs,
} from "../../src/artifacts";

/**
 * P11 unit coverage for the artifacts module's pure logic: the strict
 * renderer, the JSON-Schema-subset input validator, and the check registry.
 * The Postgres lifecycle (template gate → render → verify → Evidence) lives in
 * test/integration/artifacts.pg.test.ts. Fixture data below is exactly where
 * fixture data belongs.
 */

const RENEWAL_TEMPLATE = `# Renewal summary for {{client_name}}

Policy {{policy_number}} with {{carrier}} expires {{expiration_date}}.

## Coverages
{{#each coverages}}
- {{line}}: {{limit}} (premium {{premium}})
{{/each}}

Prepared by {{preparer.name}} ({{preparer.email}}).
`;

const RENEWAL_INPUTS = {
  client_name: "Harbour Freight Logistics",
  policy_number: "GL-99120",
  carrier: "Meridian Casualty",
  expiration_date: "2026-11-01",
  coverages: [
    { line: "General Liability", limit: "$2,000,000", premium: 41250 },
    { line: "Auto", limit: "$1,000,000", premium: 18900 },
  ],
  preparer: { name: "Dana Okafor", email: "dana@brokerage.example" },
};

const ULID = "01ARZ3NDEKTSV4RRFFQ69G5FAV";

describe("artifacts renderer (strict)", () => {
  test("fills scalars, nested paths and each-blocks deterministically", () => {
    const first = renderTemplate(RENEWAL_TEMPLATE, RENEWAL_INPUTS);
    const second = renderTemplate(RENEWAL_TEMPLATE, RENEWAL_INPUTS);
    expect(first.output).toBe(second.output);
    expect(first.output).toContain("Renewal summary for Harbour Freight Logistics");
    expect(first.output).toContain("- General Liability: $2,000,000 (premium 41250)");
    expect(first.output).toContain("- Auto: $1,000,000 (premium 18900)");
    expect(first.output).toContain("Prepared by Dana Okafor (dana@brokerage.example)");
    expect(findResidualPlaceholders(first.output)).toEqual([]);
    expect(first.usedFields).toContain("coverages");
    expect(first.usedFields).toContain("preparer.email");
  });

  test("an unfilled placeholder is an ERROR, never a blank", () => {
    const { coverages: _dropped, ...withoutCoverages } = RENEWAL_INPUTS;
    expect(() => renderTemplate(RENEWAL_TEMPLATE, withoutCoverages)).toThrow(TemplateRenderError);
    expect(() => renderTemplate("Hello {{missing}}", {})).toThrow(
      /'\{\{missing\}\}' has no value in scope/,
    );
  });

  test("null and undefined never render as text", () => {
    expect(() => renderTemplate("{{a}}", { a: null })).toThrow(/resolved to null/);
    expect(() => renderTemplate("{{a}}", { a: undefined })).toThrow(/resolved to undefined/);
    expect(() => renderTemplate("{{a}}", {})).toThrow(/has no value in scope/);
  });

  test("objects and arrays cannot be substituted as scalars", () => {
    expect(() => renderTemplate("{{a}}", { a: { b: 1 } })).toThrow(/only strings, numbers/);
    expect(() => renderTemplate("{{a}}", { a: [1, 2] })).toThrow(/an array/);
  });

  test("unbalanced or malformed tags fail loudly", () => {
    expect(() => renderTemplate("{{#each xs}}{{this}}", { xs: [] })).toThrow(/not closed/);
    expect(() => renderTemplate("{{/each}}", {})).toThrow(/no matching/);
    expect(() => renderTemplate("{{ oops", {})).toThrow(/unterminated/);
    expect(() => renderTemplate("{{}}", {})).toThrow(/empty placeholder/);
    expect(() => renderTemplate("{{#if x}}y{{/if}}", { x: 1 })).toThrow(/unsupported block/);
  });

  test("each over a non-array is an error; an empty list renders nothing", () => {
    expect(() => renderTemplate("{{#each xs}}x{{/each}}", { xs: "nope" })).toThrow(
      /expects an array/,
    );
    expect(renderTemplate("A{{#each xs}}x{{/each}}B", { xs: [] }).output).toBe("AB");
  });

  test("nested each blocks resolve against the innermost item", () => {
    const out = renderTemplate(
      "{{#each groups}}[{{name}}{{#each items}}:{{this}}{{/each}}]{{/each}}",
      { groups: [{ name: "a", items: [1, 2] }, { name: "b", items: [] }] },
    );
    expect(out.output).toBe("[a:1:2][b]");
  });

  test("collectRootFields sees root references only", () => {
    expect(collectRootFields(RENEWAL_TEMPLATE)).toEqual([
      "carrier",
      "client_name",
      "coverages",
      "expiration_date",
      "policy_number",
      "preparer",
    ]);
  });
});

describe("artifacts fieldsSchema validator", () => {
  const schema = {
    type: "object",
    properties: {
      client_name: { type: "string" },
      premium: { type: "number" },
      active: { type: "boolean" },
      coverages: {
        type: "array",
        items: { type: "object", properties: { line: { type: "string" } }, required: ["line"] },
      },
    },
    required: ["client_name", "coverages"],
  };

  test("accepts conforming inputs", () => {
    expect(
      validateInputs(schema, { client_name: "Acme", coverages: [{ line: "GL" }] }),
    ).toBeTruthy();
  });

  test("reports every issue: missing, wrong type, unknown field", () => {
    try {
      validateInputs(schema, { premium: "lots", surprise: 1, coverages: [{ line: 2 }] });
      throw new Error("expected FieldsValidationError");
    } catch (err) {
      expect(err).toBeInstanceOf(FieldsValidationError);
      const issues = (err as FieldsValidationError).issues.join(" | ");
      expect(issues).toContain("client_name: required field is missing");
      expect(issues).toContain("premium: expected number, got string");
      expect(issues).toContain("surprise: unknown field");
      expect(issues).toContain("coverages[0].line: expected string, got number");
    }
  });

  test("an unsupported JSON Schema keyword is LOUD, never silently ignored", () => {
    expect(() =>
      validateInputs(
        { type: "object", properties: { a: { type: "string", pattern: "^x" } } },
        { a: "x" },
      ),
    ).toThrow(FieldsSchemaUnsupportedError);
    expect(() =>
      validateInputs({ type: "object", properties: { a: { type: "string", default: "x" } } }, {}),
    ).toThrow(/unsupported keyword 'default'/);
  });
});

describe("artifacts check registry", () => {
  const ctx = { output: "hello world", inputs: {}, fieldsSchema: {} };

  test("registry is the documented set", () => {
    expect(DETERMINISTIC_CHECK_REFS).toEqual([
      "length-bounds",
      "no-todo-markers",
      "no-unfilled-placeholders",
      "non-empty",
      "required-fields",
    ]);
  });

  test("an UNKNOWN check ref fails with an explicit finding — never a silent pass", () => {
    const outcome = runDeterministicCheck("no-such-check", ctx);
    expect(outcome.passed).toBe(false);
    expect(outcome.detail).toContain("unknown deterministic check ref 'no-such-check'");
    expect(outcome.detail).toContain("An unknown check can never pass");
  });

  test("no-unfilled-placeholders catches residue", () => {
    expect(runDeterministicCheck("no-unfilled-placeholders", ctx).passed).toBe(true);
    const bad = runDeterministicCheck("no-unfilled-placeholders", { ...ctx, output: "hi {{name}}" });
    expect(bad.passed).toBe(false);
    expect(bad.detail).toContain("{{name}}");
  });

  test("required-fields reads the template's own schema", () => {
    const fieldsSchema = { type: "object", properties: { a: { type: "string" } }, required: ["a"] };
    expect(
      runDeterministicCheck("required-fields", { ...ctx, inputs: { a: "x" }, fieldsSchema }).passed,
    ).toBe(true);
    expect(
      runDeterministicCheck("required-fields", { ...ctx, inputs: { a: "  " }, fieldsSchema }).passed,
    ).toBe(false);
    // A required-fields check on a schema with no required fields asserts nothing — say so.
    expect(runDeterministicCheck("required-fields", ctx).passed).toBe(false);
  });

  test("length-bounds parses args and needs at least one bound", () => {
    expect(parseCheckRef("length-bounds:min=2,max=40")).toEqual({
      name: "length-bounds",
      args: { min: "2", max: "40" },
    });
    expect(runDeterministicCheck("length-bounds:min=2,max=40", ctx).passed).toBe(true);
    expect(runDeterministicCheck("length-bounds:min=400", ctx).passed).toBe(false);
    expect(runDeterministicCheck("length-bounds", ctx).passed).toBe(false);
    expect(runDeterministicCheck("length-bounds:min=abc", ctx).passed).toBe(false);
  });

  test("no-todo-markers and non-empty", () => {
    expect(runDeterministicCheck("no-todo-markers", ctx).passed).toBe(true);
    expect(runDeterministicCheck("no-todo-markers", { ...ctx, output: "premium: TBD" }).passed).toBe(
      false,
    );
    expect(runDeterministicCheck("non-empty", { ...ctx, output: "  \n " }).passed).toBe(false);
  });
});

describe("artifacts rubric checks", () => {
  test("no model configured ⇒ SKIPPED, and a skipped check cannot pass", async () => {
    const outcome = await runRubricCheck("Is it polite?", "hello", { model: "claude-sonnet-5" });
    expect(outcome.passed).toBe(false);
    expect(outcome.detail).toContain("SKIPPED");
    expect(outcome.detail).toContain("a skipped check cannot pass");
  });

  test("scripted model turns drive the verdict", async () => {
    const outcome = await runRubricCheck("Names the expiry date", "expires 2026-11-01", {
      complete: async () => ({
        content: [
          {
            type: "text" as const,
            text: '{"pass": true, "reason": "states the expiry"}',
            citations: null,
          },
        ],
        stopReason: "end_turn",
        usage: { inputTokens: 10, outputTokens: 5 },
      }),
      model: "claude-sonnet-5",
    });
    expect(outcome).toEqual({ passed: true, detail: "states the expiry" });
  });

  test("an unparseable or erroring model reply FAILS the check", async () => {
    expect(parseRubricVerdict("sure, looks good!").passed).toBe(false);
    expect(parseRubricVerdict('{"reason": "nope"}').passed).toBe(false);
    const outcome = await runRubricCheck("x", "y", {
      complete: () => Promise.reject(new Error("429 overloaded")),
      model: "claude-sonnet-5",
    });
    expect(outcome.passed).toBe(false);
    expect(outcome.detail).toContain("429 overloaded");
  });
});

describe("artifacts stubs + config degrade", () => {
  test("image/video rendering is a loud registered stub", () => {
    const err = expectStub(() =>
      renderVisualArtifact({ id: ULID, version: "1" }, {}, {
        tenantId: ULID,
        principalId: ULID,
        kind: "agent",
      }),
    );
    expect(err.stubId).toBe("server.artifacts.engine.render.visual");
    expect(err.reason).toStartWith("LITHIS-STUB:");
  });

  test("DB-less mode fails with a config error, not a stub", () => {
    const engine = createUnconfiguredArtifactEngine();
    expect(() => engine.listTemplates(ULID)).toThrow(/DATABASE_URL is not set/);
  });
});
