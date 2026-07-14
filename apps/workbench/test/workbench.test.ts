import { describe, expect, test } from "bun:test";
import { newUlid } from "@lithis/core";
import { NotImplementedError, isStub } from "@lithis/stubkit";
import { createWorkbenchHost } from "../src/index";

describe("WorkbenchHost (stub)", () => {
  const host = createWorkbenchHost();

  test("is a registered stub service", () => {
    expect(isStub(host)).toBe(true);
  });

  test("provision throws NotImplementedError", () => {
    expect(() => host.provision(newUlid(), { url: "https://github.com/acme/repo", branch: "main" })).toThrow(
      NotImplementedError,
    );
  });

  test("attach throws NotImplementedError", () => {
    expect(() => host.attach(newUlid())).toThrow(NotImplementedError);
  });

  test("archive throws NotImplementedError", () => {
    expect(() => host.archive(newUlid())).toThrow(NotImplementedError);
  });

  test("list throws NotImplementedError", () => {
    expect(() => host.list(newUlid())).toThrow(NotImplementedError);
  });
});
