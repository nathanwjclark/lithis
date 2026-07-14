import { describe, expect, test } from "bun:test";
import { newUlid } from "@lithis/core";
import { expectStub } from "@lithis/evals";
import { createLithisClient } from "../src/index";

describe("createLithisClient", () => {
  test("validates the base URL for real", () => {
    expect(() => createLithisClient("not a url")).toThrow(TypeError);
  });

  test("can be called repeatedly (single stub registration)", () => {
    const a = createLithisClient("http://localhost:8080");
    const b = createLithisClient("https://lithis.example.com");
    expect(b).toBe(a);
  });

  test("every client method throws NotImplementedError from the sdk.client stub", () => {
    const client = createLithisClient("http://localhost:8080");
    expect(expectStub(() => client.inbox()).stubId).toBe("sdk.client.inbox");
    expect(
      expectStub(() =>
        client.resolveRequest(newUlid(), {
          by: { kind: "principal", id: newUlid() },
          verdict: "approved",
          comment: "looks right",
        }),
      ).stubId,
    ).toBe("sdk.client.resolveRequest");
    expect(expectStub(() => client.search({ text: "loss runs for acme" })).stubId).toBe(
      "sdk.client.search",
    );
    expect(
      expectStub(() => client.openWorkItem({ kind: "oneoff", title: "Chase the regulator" }))
        .stubId,
    ).toBe("sdk.client.openWorkItem");
    expect(expectStub(() => client.stubs()).stubId).toBe("sdk.client.stubs");
  });
});
