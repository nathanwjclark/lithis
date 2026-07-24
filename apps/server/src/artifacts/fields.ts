/**
 * `Template.fieldsSchema` is a JSON Schema document (core types it as
 * `z.record(z.unknown())`). Rather than take a JSON-Schema dependency, P11
 * implements a deliberately SMALL, STRICT subset validator:
 *
 *   root:      type:"object", properties, required, additionalProperties, title, description
 *   property:  type: string|number|integer|boolean|array|object,
 *              enum, items (array), properties/required/additionalProperties (object),
 *              title, description, default is NOT supported (see below)
 *
 * An unsupported keyword is a LOUD error, never a silent pass — a template
 * whose schema this validator cannot fully enforce must not render at all.
 * `default` is rejected on purpose: silently materialising an unsupplied field
 * is exactly the "looks finished, is not" failure the artifacts module exists
 * to prevent. Widening the subset is a deliberate, tested change.
 */

const ROOT_KEYWORDS = new Set([
  "$schema",
  "$id",
  "type",
  "title",
  "description",
  "properties",
  "required",
  "additionalProperties",
]);

const PROPERTY_KEYWORDS = new Set([
  "type",
  "title",
  "description",
  "enum",
  "items",
  "properties",
  "required",
  "additionalProperties",
]);

const SCALAR_TYPES = new Set(["string", "number", "integer", "boolean"]);
const ALL_TYPES = new Set([...SCALAR_TYPES, "array", "object"]);

export class FieldsSchemaUnsupportedError extends Error {
  constructor(message: string) {
    super(
      `template fieldsSchema is not supported by the P11 validator: ${message}. ` +
        `Supported: type (${[...ALL_TYPES].join("|")}), properties, required, ` +
        `additionalProperties, items, enum, title, description.`,
    );
    this.name = "FieldsSchemaUnsupportedError";
  }
}

export class FieldsValidationError extends Error {
  constructor(readonly issues: string[]) {
    super(`template inputs do not satisfy fieldsSchema: ${issues.join("; ")}`);
    this.name = "FieldsValidationError";
  }
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function assertKeywords(node: Record<string, unknown>, allowed: Set<string>, where: string): void {
  for (const key of Object.keys(node)) {
    if (!allowed.has(key)) {
      throw new FieldsSchemaUnsupportedError(`unsupported keyword '${key}' at ${where}`);
    }
  }
}

function checkNode(node: unknown, where: string): void {
  if (!isPlainObject(node)) {
    throw new FieldsSchemaUnsupportedError(`${where} must be a schema object`);
  }
  assertKeywords(node, PROPERTY_KEYWORDS, where);
  const type = node["type"];
  if (typeof type !== "string" || !ALL_TYPES.has(type)) {
    throw new FieldsSchemaUnsupportedError(
      `${where} must declare a single supported 'type' (got ${JSON.stringify(type)})`,
    );
  }
  if (node["enum"] !== undefined && !Array.isArray(node["enum"])) {
    throw new FieldsSchemaUnsupportedError(`${where}.enum must be an array`);
  }
  if (type === "array") {
    if (node["items"] === undefined) {
      throw new FieldsSchemaUnsupportedError(`${where} is an array but declares no 'items'`);
    }
    checkNode(node["items"], `${where}.items`);
  }
  if (type === "object") {
    const props = node["properties"];
    if (props !== undefined) {
      if (!isPlainObject(props)) {
        throw new FieldsSchemaUnsupportedError(`${where}.properties must be an object`);
      }
      for (const [name, sub] of Object.entries(props)) checkNode(sub, `${where}.properties.${name}`);
    }
  }
}

/** Structural check of the schema document itself; throws on anything unsupported. */
export function assertSupportedFieldsSchema(schema: Record<string, unknown>): void {
  assertKeywords(schema, ROOT_KEYWORDS, "fieldsSchema");
  const type = schema["type"];
  if (type !== undefined && type !== "object") {
    throw new FieldsSchemaUnsupportedError(`fieldsSchema.type must be 'object' (got ${String(type)})`);
  }
  const props = schema["properties"];
  if (props !== undefined) {
    if (!isPlainObject(props)) {
      throw new FieldsSchemaUnsupportedError("fieldsSchema.properties must be an object");
    }
    for (const [name, sub] of Object.entries(props)) checkNode(sub, `fieldsSchema.properties.${name}`);
  }
  const required = schema["required"];
  if (required !== undefined && !Array.isArray(required)) {
    throw new FieldsSchemaUnsupportedError("fieldsSchema.required must be an array of names");
  }
}

/** The declared required field names (empty when the schema declares none). */
export function requiredFields(schema: Record<string, unknown>): string[] {
  const required = schema["required"];
  return Array.isArray(required) ? required.filter((r): r is string => typeof r === "string") : [];
}

function typeOfValue(value: unknown): string {
  if (Array.isArray(value)) return "array";
  if (value === null) return "null";
  return typeof value;
}

function validateValue(value: unknown, node: Record<string, unknown>, path: string, issues: string[]): void {
  const type = node["type"] as string;
  const actual = typeOfValue(value);

  if (type === "integer") {
    if (actual !== "number" || !Number.isInteger(value)) {
      issues.push(`${path}: expected integer, got ${actual}`);
      return;
    }
  } else if (type === "number") {
    if (actual !== "number" || !Number.isFinite(value)) {
      issues.push(`${path}: expected number, got ${actual}`);
      return;
    }
  } else if (actual !== type) {
    issues.push(`${path}: expected ${type}, got ${actual}`);
    return;
  }

  const allowed = node["enum"];
  if (Array.isArray(allowed) && !allowed.some((a) => a === value)) {
    issues.push(`${path}: ${JSON.stringify(value)} is not one of ${JSON.stringify(allowed)}`);
    return;
  }

  if (type === "array") {
    const items = node["items"] as Record<string, unknown>;
    (value as unknown[]).forEach((item, i) => validateValue(item, items, `${path}[${i}]`, issues));
    return;
  }

  if (type === "object") {
    validateObject(value as Record<string, unknown>, node, path, issues);
  }
}

function validateObject(
  value: Record<string, unknown>,
  node: Record<string, unknown>,
  path: string,
  issues: string[],
): void {
  const props = isPlainObject(node["properties"]) ? node["properties"] : {};
  const required = Array.isArray(node["required"]) ? (node["required"] as string[]) : [];

  for (const name of required) {
    if (!Object.prototype.hasOwnProperty.call(value, name) || value[name] === undefined) {
      issues.push(`${path}${path === "" ? "" : "."}${name}: required field is missing`);
    }
  }
  for (const [name, sub] of Object.entries(props)) {
    if (!Object.prototype.hasOwnProperty.call(value, name)) continue;
    const child = value[name];
    if (child === undefined) continue;
    validateValue(child, sub as Record<string, unknown>, `${path}${path === "" ? "" : "."}${name}`, issues);
  }
  // Unknown keys are rejected unless the schema explicitly allows them —
  // a typo'd input name must never quietly become an unfilled placeholder.
  if (node["additionalProperties"] !== true) {
    for (const name of Object.keys(value)) {
      if (!Object.prototype.hasOwnProperty.call(props, name)) {
        issues.push(`${path}${path === "" ? "" : "."}${name}: unknown field (not declared in fieldsSchema)`);
      }
    }
  }
}

/**
 * Validate `inputs` against the template's fieldsSchema. Throws
 * FieldsSchemaUnsupportedError if the schema uses anything this validator
 * cannot enforce, and FieldsValidationError listing EVERY issue otherwise.
 */
export function validateInputs(
  schema: Record<string, unknown>,
  inputs: unknown,
): Record<string, unknown> {
  assertSupportedFieldsSchema(schema);
  if (!isPlainObject(inputs)) {
    throw new FieldsValidationError([`inputs must be an object, got ${typeOfValue(inputs)}`]);
  }
  const issues: string[] = [];
  validateObject(inputs, schema, "", issues);
  if (issues.length > 0) throw new FieldsValidationError(issues);
  return inputs;
}
