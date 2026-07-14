import { describe, expect, test } from "bun:test";
import {
  createSlackClient,
  listAllChannels,
  SlackApiError,
  SlackHttpError,
  SlackRateLimitError,
} from "../src/client";
import { fakeSlackFetch } from "./helpers/fake-slack";
import authTestOk from "./fixtures/auth.test.ok.json";
import authTestInvalid from "./fixtures/auth.test.invalid.json";
import listPage1 from "./fixtures/conversations.list.page1.json";
import listPage2 from "./fixtures/conversations.list.page2.json";
import rateLimited from "./fixtures/rate-limited.429.json";

function sleepRecorder(): { sleeps: number[]; sleep: (ms: number) => Promise<void> } {
  const sleeps: number[] = [];
  return {
    sleeps,
    sleep: async (ms) => {
      sleeps.push(ms);
    },
  };
}

describe("slack client transport", () => {
  test("sends the bearer token and hits slack.com/api by default", async () => {
    const fake = fakeSlackFetch([{ method: "auth.test", body: authTestOk }]);
    const client = createSlackClient({ token: "xoxb-secret", fetch: fake.fetch });
    const result = await client.authTest();
    expect(result.team_id).toBe("T0100TEAM01");
    expect(fake.calls[0]?.authorization).toBe("Bearer xoxb-secret");
    expect(fake.calls[0]?.httpMethod).toBe("POST");
  });

  test("ok:false surfaces as SlackApiError with the slack error code", async () => {
    const fake = fakeSlackFetch([{ method: "auth.test", body: authTestInvalid }]);
    const client = createSlackClient({ token: "xoxb-bad", fetch: fake.fetch });
    await expect(client.authTest()).rejects.toThrow(SlackApiError);
    await client.authTest().then(
      () => {
        throw new Error("expected invalid_auth");
      },
      (err: unknown) => {
        expect((err as SlackApiError).code).toBe("invalid_auth");
      },
    );
  });

  test("non-2xx non-429 responses surface as SlackHttpError", async () => {
    const fake = fakeSlackFetch([{ method: "auth.test", body: "gateway down", status: 502 }]);
    const client = createSlackClient({ token: "xoxb", fetch: fake.fetch });
    await expect(client.authTest()).rejects.toThrow(SlackHttpError);
  });

  test("429 honors Retry-After then succeeds on retry", async () => {
    const fake = fakeSlackFetch([
      {
        method: "conversations.list",
        body: rateLimited,
        status: 429,
        headers: { "retry-after": "7" },
        times: 1,
      },
      { method: "conversations.list", body: listPage2 },
    ]);
    const recorder = sleepRecorder();
    const client = createSlackClient({ token: "xoxb", fetch: fake.fetch, sleep: recorder.sleep });
    const page = await client.conversationsList();
    expect(page.channels.map((c) => c.id)).toEqual(["C0300CHRLE3", "C0400DELTA4"]);
    expect(recorder.sleeps).toEqual([7000]);
    expect(fake.callsTo("conversations.list")).toHaveLength(2);
  });

  test("persistent 429 exhausts retries and throws SlackRateLimitError", async () => {
    const fake = fakeSlackFetch([
      { method: "conversations.list", body: rateLimited, status: 429, headers: { "retry-after": "2" } },
    ]);
    const recorder = sleepRecorder();
    const client = createSlackClient({
      token: "xoxb",
      fetch: fake.fetch,
      sleep: recorder.sleep,
      maxRateLimitRetries: 2,
    });
    await expect(client.conversationsList()).rejects.toThrow(SlackRateLimitError);
    // 2 retries → 2 sleeps of Retry-After seconds before giving up.
    expect(recorder.sleeps).toEqual([2000, 2000]);
  });

  test("429 with a missing/garbled Retry-After falls back to 1s", async () => {
    const fake = fakeSlackFetch([
      { method: "auth.test", body: rateLimited, status: 429, times: 1 },
      { method: "auth.test", body: authTestOk },
    ]);
    const recorder = sleepRecorder();
    const client = createSlackClient({ token: "xoxb", fetch: fake.fetch, sleep: recorder.sleep });
    await client.authTest();
    expect(recorder.sleeps).toEqual([1000]);
  });
});

describe("listAllChannels pagination", () => {
  test("walks next_cursor pages to the end and stops on empty cursor", async () => {
    const fake = fakeSlackFetch([
      {
        method: "conversations.list",
        match: (p) => p.cursor === undefined,
        body: listPage1,
      },
      {
        method: "conversations.list",
        match: (p) => p.cursor === "dGVhbTpDMDMwMENIQVJMSTM=",
        body: listPage2,
      },
    ]);
    const client = createSlackClient({ token: "xoxb", fetch: fake.fetch });
    const channels = await listAllChannels(client, { types: "public_channel,private_channel" });
    expect(channels.map((c) => c.id)).toEqual([
      "C0100ALPHA1",
      "C0200BRAVO2",
      "C0300CHRLE3",
      "C0400DELTA4",
    ]);
    const calls = fake.callsTo("conversations.list");
    expect(calls).toHaveLength(2);
    expect(calls[0]?.params.types).toBe("public_channel,private_channel");
  });
});
