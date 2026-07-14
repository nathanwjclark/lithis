import { describe, expect, test } from "bun:test";
import { classifyFailure, failureMessage } from "../src/ui/api";

describe("failureMessage", () => {
  test("prefers a JSON { error } body", () => {
    expect(failureMessage(500, JSON.stringify({ error: "boom" }))).toBe("boom");
  });

  test("falls back to a JSON { message } body", () => {
    expect(failureMessage(400, JSON.stringify({ message: "bad input" }))).toBe("bad input");
  });

  test("plain-text bodies (hono HTTPException) pass through", () => {
    expect(failureMessage(503, "humangate is unavailable — server booted without DATABASE_URL")).toBe(
      "humangate is unavailable — server booted without DATABASE_URL",
    );
  });

  test("empty bodies become HTTP <status>", () => {
    expect(failureMessage(500, "")).toBe("HTTP 500");
    expect(failureMessage(404, "   ")).toBe("HTTP 404");
  });

  test("JSON without error/message becomes HTTP <status>", () => {
    expect(failureMessage(500, JSON.stringify({ other: 1 }))).toBe("HTTP 500");
  });
});

describe("classifyFailure", () => {
  test("501 with { stubId, reason } is a registered stub", () => {
    const failure = classifyFailure(
      501,
      JSON.stringify({ stubId: "server.delivery.render", reason: "LITHIS-STUB: not built" }),
    );
    expect(failure).toEqual({
      kind: "stub",
      stub: { stubId: "server.delivery.render", reason: "LITHIS-STUB: not built" },
    });
  });

  test("501 without a stub body is a plain http failure", () => {
    expect(classifyFailure(501, "nope")).toEqual({ kind: "http", status: 501, message: "nope" });
  });

  test("503 is unavailable (config condition, not a stub)", () => {
    const failure = classifyFailure(503, "work queue unavailable — server started without DATABASE_URL");
    expect(failure).toEqual({
      kind: "unavailable",
      message: "work queue unavailable — server started without DATABASE_URL",
    });
  });

  test("other statuses are http failures with the server's message", () => {
    expect(classifyFailure(409, "illegal transition pending -> pending")).toEqual({
      kind: "http",
      status: 409,
      message: "illegal transition pending -> pending",
    });
    expect(classifyFailure(404, JSON.stringify({ error: "no such request" }))).toEqual({
      kind: "http",
      status: 404,
      message: "no such request",
    });
  });
});
