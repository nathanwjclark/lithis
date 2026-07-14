import { describe, expect, test } from "bun:test";
import { newUlid } from "@lithis/core";
import { createTokenVault, DEFAULT_BROKER_TTL_MS } from "../src/custody/broker";
import { parseSecretsFile } from "../src/custody/envfile";

describe("custody token vault", () => {
  test("mints opaque tokens that redeem to the entry — never embedding the secret", () => {
    const vault = createTokenVault();
    const credentialId = newUlid();
    const { brokerToken, expiresAt } = vault.mint({
      credentialId,
      kind: "api_key",
      secret: "super-secret-value",
    });
    expect(brokerToken).toStartWith("bkr_");
    expect(brokerToken).not.toContain("super-secret-value");
    expect(new Date(expiresAt).getTime()).toBeGreaterThan(Date.now());
    expect(vault.redeem(brokerToken)).toEqual({
      credentialId,
      kind: "api_key",
      secret: "super-secret-value",
    });
  });

  test("tokens expire after the ttl and unknown tokens never redeem", () => {
    let now = 1_000_000;
    const vault = createTokenVault({ ttlMs: 15 * 60_000, nowMs: () => now });
    const { brokerToken } = vault.mint({ credentialId: newUlid(), kind: "oauth_token", secret: "s" });
    now += 14 * 60_000;
    expect(vault.redeem(brokerToken).secret).toBe("s"); // still live at 14 min
    now += 2 * 60_000; // 16 min total — past the 15 min ttl
    expect(() => vault.redeem(brokerToken)).toThrow(/unknown or expired broker token/);
    expect(() => vault.redeem("bkr_never-minted")).toThrow(/unknown or expired broker token/);
  });

  test("default ttl is 15 minutes", () => {
    expect(DEFAULT_BROKER_TTL_MS).toBe(15 * 60 * 1000);
  });

  test("every mint yields a distinct token", () => {
    const vault = createTokenVault();
    const entry = { credentialId: newUlid(), kind: "api_key" as const, secret: "s" };
    const tokens = new Set(Array.from({ length: 50 }, () => vault.mint(entry).brokerToken));
    expect(tokens.size).toBe(50);
  });
});

describe("custody env-file parsing", () => {
  test("parses KEY=VALUE lines, comments, blanks, and quoted values", () => {
    const parsed = parseSecretsFile(
      [
        "# fixture comment",
        "",
        "PLAIN=value",
        "SPACED = padded ",
        'DQUOTED="with spaces"',
        "SQUOTED='single'",
        "WITH_EQUALS=a=b=c",
        "not-a-kv-line",
      ].join("\n"),
    );
    expect(parsed.get("PLAIN")).toBe("value");
    expect(parsed.get("SPACED")).toBe("padded");
    expect(parsed.get("DQUOTED")).toBe("with spaces");
    expect(parsed.get("SQUOTED")).toBe("single");
    expect(parsed.get("WITH_EQUALS")).toBe("a=b=c");
    expect(parsed.has("not-a-kv-line")).toBe(false);
  });
});
