import { describe, expect, test } from "bun:test";
import { z } from "zod";
import { docSchema, originSchema } from "@lithis/core";
import { createSlackClient } from "../src/client";
import { decodeCursor, encodeCursor, messageSlug, tsGreaterThan } from "../src/normalize";
import { syncChannelMessages } from "../src/sync";
import type { FixtureRoute } from "./helpers/fake-slack";
import { fakeConnection, fakeSlackFetch, recordingSink } from "./helpers/fake-slack";
import listPage1 from "./fixtures/conversations.list.page1.json";
import listPage2 from "./fixtures/conversations.list.page2.json";
import generalPage1 from "./fixtures/conversations.history.general.page1.json";
import generalPage2 from "./fixtures/conversations.history.general.page2.json";
import projPage1 from "./fixtures/conversations.history.proj-lithis.page1.json";
import historyEmpty from "./fixtures/conversations.history.empty.json";
import usersAlice from "./fixtures/users.info.alice.json";
import usersBob from "./fixtures/users.info.bob.json";
import rateLimited from "./fixtures/rate-limited.429.json";

/** The doc-input contract: the Doc fields a connector is allowed to supply. */
const docInputSchema = z.object({
  type: z.string().min(1),
  slug: docSchema.shape.slug,
  title: docSchema.shape.title,
  bodyBlobId: docSchema.shape.bodyBlobId,
  frontmatter: z.record(z.unknown()),
  origin: originSchema,
});

function listRoutes(): FixtureRoute[] {
  return [
    { method: "conversations.list", match: (p) => p.cursor === undefined, body: listPage1 },
    { method: "conversations.list", match: (p) => p.cursor !== undefined, body: listPage2 },
  ];
}

function historyRoutes(): FixtureRoute[] {
  return [
    {
      method: "conversations.history",
      match: (p) => p.channel === "C0100ALPHA1" && p.cursor === undefined,
      body: generalPage1,
    },
    {
      method: "conversations.history",
      match: (p) => p.channel === "C0100ALPHA1" && p.cursor === "bmV4dF90czoxNzE4MDUwMDAwMDAwMjAw",
      body: generalPage2,
    },
    {
      method: "conversations.history",
      match: (p) => p.channel === "C0300CHRLE3",
      body: projPage1,
    },
  ];
}

function userRoutes(): FixtureRoute[] {
  return [
    { method: "users.info", match: (p) => p.user === "U0100ALICE1", body: usersAlice },
    { method: "users.info", match: (p) => p.user === "U0200BOBBY2", body: usersBob },
  ];
}

const clientOpts = { token: "xoxb-test" };

describe("channel-messages fixture-replay sync", () => {
  test("first sync lands blobs + typed docs from member channels only", async () => {
    const fake = fakeSlackFetch([...listRoutes(), ...historyRoutes(), ...userRoutes()]);
    const client = createSlackClient({ ...clientOpts, fetch: fake.fetch });
    const connection = fakeConnection();
    const sink = recordingSink();

    const cursor = await syncChannelMessages(client, connection, null, sink);

    // general: 2 thread messages + 1 bot_message (channel_join skipped);
    // proj-lithis: 1 file_share + 1 plain. random (not member) and
    // old-initiative (archived) are never fetched.
    expect(sink.docs).toHaveLength(5);
    expect(sink.blobs).toHaveLength(5);
    const fetchedChannels = new Set(
      fake.callsTo("conversations.history").map((c) => c.params.channel),
    );
    expect([...fetchedChannels].sort()).toEqual(["C0100ALPHA1", "C0300CHRLE3"]);

    // every doc input satisfies the core contract (slug/title/origin shapes)
    for (const { input } of sink.docs) {
      expect(() => docInputSchema.parse(input)).not.toThrow();
      expect(input.type).toBe("message");
      expect(input.origin.by).toEqual({ kind: "connection", id: connection.id });
      expect(input.origin.method).toBe("external");
    }

    // bodyBlobId wires each doc to the blob that was put for it
    const blobIds = new Set(sink.blobs.map((b) => b.ref.id));
    for (const { input } of sink.docs) expect(blobIds.has(input.bodyBlobId)).toBe(true);

    // blob bytes are the verbatim slack message JSON
    const first = sink.blobs[0]!;
    const decoded = JSON.parse(new TextDecoder().decode(first.input.bytes)) as { ts?: string };
    expect(typeof decoded.ts).toBe("string");
    expect(first.input.mediaType).toBe("application/json");

    // author resolution: alice via display_name, bob falls back to real_name
    const bySlug = new Map(sink.docs.map((d) => [d.input.slug, d.input]));
    const aliceDoc = bySlug.get(messageSlug("C0100ALPHA1", "1718100000.000100"))!;
    expect(aliceDoc.frontmatter.userName).toBe("alice");
    expect(aliceDoc.title).toContain("#general — alice");
    const bobDoc = bySlug.get(messageSlug("C0100ALPHA1", "1718100300.000400"))!;
    expect(bobDoc.frontmatter.userName).toBe("Bob Okafor");
    expect(bobDoc.frontmatter.threadTs).toBe("1718100000.000100");
    // users.info is cached per user per sync
    expect(fake.callsTo("users.info")).toHaveLength(2);

    // the bot message and the file_share both made it in
    expect(bySlug.get(messageSlug("C0100ALPHA1", "1718050000.000200"))?.frontmatter.botId).toBe(
      "B0500ROBOT5",
    );
    const fileShare = bySlug.get(messageSlug("C0300CHRLE3", "1718200500.000700"))!;
    expect(fileShare.frontmatter.subtype).toBe("file_share");
    expect(fileShare.title).toContain("(message 1718200500.000700)"); // empty text degrades honestly

    // durable cursor: newest SEEN ts per channel (channel_join counts as seen)
    const decodedCursor = decodeCursor(cursor);
    expect(decodedCursor.channels).toEqual({
      C0100ALPHA1: "1718100300.000400",
      C0300CHRLE3: "1718200500.000700",
    });
  });

  test("re-sync from the returned cursor is idempotent: oldest bound, no new docs", async () => {
    const firstCursor = encodeCursor({
      v: 1,
      channels: { C0100ALPHA1: "1718100300.000400", C0300CHRLE3: "1718200500.000700" },
    });
    const fake = fakeSlackFetch([
      ...listRoutes(),
      { method: "conversations.history", body: historyEmpty },
    ]);
    const client = createSlackClient({ ...clientOpts, fetch: fake.fetch });
    const sink = recordingSink();

    const next = await syncChannelMessages(client, fakeConnection(), firstCursor, sink);

    expect(sink.docs).toHaveLength(0);
    expect(sink.blobs).toHaveLength(0);
    for (const call of fake.callsTo("conversations.history")) {
      const expected = call.params.channel === "C0100ALPHA1" ? "1718100300.000400" : "1718200500.000700";
      expect(call.params.oldest).toBe(expected);
    }
    // watermarks survive an empty pull unchanged
    expect(decodeCursor(next).channels).toEqual(decodeCursor(firstCursor).channels);
  });

  test("a 429 mid-sync retries per Retry-After and the sync still completes", async () => {
    const sleeps: number[] = [];
    const fake = fakeSlackFetch([
      {
        method: "conversations.history",
        body: rateLimited,
        status: 429,
        headers: { "retry-after": "3" },
        times: 1,
      },
      ...listRoutes(),
      ...historyRoutes(),
      ...userRoutes(),
    ]);
    const client = createSlackClient({
      ...clientOpts,
      fetch: fake.fetch,
      sleep: async (ms) => {
        sleeps.push(ms);
      },
    });
    const sink = recordingSink();
    await syncChannelMessages(client, fakeConnection(), null, sink);
    expect(sleeps).toEqual([3000]);
    expect(sink.docs).toHaveLength(5);
  });

  test("rejects an unknown cursor payload instead of silently starting over", () => {
    expect(() => decodeCursor("not json")).toThrow("not valid JSON");
    expect(() => decodeCursor(JSON.stringify({ v: 2, channels: {} }))).toThrow("unknown shape");
    expect(decodeCursor(null)).toEqual({ v: 1, channels: {} });
  });

  test("cursor codec round-trips with stable key order", () => {
    const encoded = encodeCursor({ v: 1, channels: { B: "2.0", A: "1.0" } });
    expect(encoded).toBe('{"v":1,"channels":{"A":"1.0","B":"2.0"}}');
    expect(decodeCursor(encoded).channels).toEqual({ A: "1.0", B: "2.0" });
  });

  test("slack ts ordering compares numerically per segment", () => {
    expect(tsGreaterThan("1718100300.000400", "1718100000.000100")).toBe(true);
    expect(tsGreaterThan("1718100000.000100", "1718100000.000090")).toBe(true);
    expect(tsGreaterThan("1718100000.000100", "1718100000.000100")).toBe(false);
  });
});
