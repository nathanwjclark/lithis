import { describe, expect, test } from "bun:test";
import { ZodError } from "zod";
import { loadConfig, SERVER_ROLES } from "../src/config";

describe("loadConfig", () => {
  test("defaults: role 'all', port 4400, no urls", () => {
    const cfg = loadConfig({});
    expect(cfg).toEqual({ role: "all", port: 4400 });
    expect(cfg.databaseUrl).toBeUndefined();
    expect(cfg.objectStoreUrl).toBeUndefined();
  });

  test("parses every valid role", () => {
    for (const role of SERVER_ROLES) {
      expect(loadConfig({ LITHIS_ROLE: role }).role).toBe(role);
    }
  });

  test("rejects an unknown role", () => {
    expect(() => loadConfig({ LITHIS_ROLE: "frontend" })).toThrow(ZodError);
  });

  test("coerces PORT from string", () => {
    expect(loadConfig({ PORT: "8080" }).port).toBe(8080);
  });

  test("rejects non-numeric and out-of-range PORT", () => {
    expect(() => loadConfig({ PORT: "not-a-port" })).toThrow(ZodError);
    expect(() => loadConfig({ PORT: "0" })).toThrow(ZodError);
    expect(() => loadConfig({ PORT: "70000" })).toThrow(ZodError);
  });

  test("passes through DATABASE_URL and OBJECT_STORE_URL when present", () => {
    const cfg = loadConfig({
      DATABASE_URL: "postgres://lithis:lithis@localhost:5432/lithis",
      OBJECT_STORE_URL: "http://localhost:9000/lithis",
    });
    expect(cfg.databaseUrl).toBe("postgres://lithis:lithis@localhost:5432/lithis");
    expect(cfg.objectStoreUrl).toBe("http://localhost:9000/lithis");
  });

  test("ignores unrelated env vars", () => {
    const cfg = loadConfig({ HOME: "/home/demo", LITHIS_ROLE: "api" });
    expect(cfg).toEqual({ role: "api", port: 4400 });
  });
});
