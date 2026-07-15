import { describe, expect, test } from "bun:test";
import { newUlid } from "@lithis/core";
import type { HumanRequest } from "@lithis/core";
import {
  decodeAnchor,
  encodeAnchor,
  parseReplyVerdict,
  renderDigest,
  renderHumanRequestCard,
  renderNudge,
  replyInstructions,
  shouldIngestInbound,
  unwrapSlackEvent,
} from "../src/delivery";

function request(overrides: Partial<HumanRequest> = {}): HumanRequest {
  const at = new Date().toISOString();
  return {
    id: newUlid(),
    tenantId: newUlid(),
    kind: "approval",
    subjectKind: "action",
    subjectRef: { kind: "action_intent", id: newUlid() },
    payload: undefined,
    evidenceIds: [],
    summary: "Send the renewal follow-up email to Acme?",
    routing: {
      assignee: "underwriter",
      channelPrefs: ["slack"],
      escalationPath: [],
      followUpCount: 0,
    },
    state: "pending",
    requestedBy: { kind: "principal", id: newUlid() },
    createdAt: at,
    updatedAt: at,
    ...overrides,
  };
}

type Block = { type: string; text?: { text: string }; elements?: { text: string }[] };

function flatten(blocks: Block[]): string {
  return blocks
    .map((b) => b.text?.text ?? (b.elements ?? []).map((e) => e.text).join(" "))
    .join("\n");
}

describe("renderHumanRequestCard", () => {
  test("carries summary, subject, evidence, request id, and the reply vocabulary", () => {
    const evidence = [newUlid(), newUlid()];
    const r = request({ evidenceIds: evidence, options: ["send now", "hold"] });
    const card = renderHumanRequestCard(r);
    expect(card.text).toBe(r.summary);
    const text = flatten(card.blocks as Block[]);
    expect(text).toContain(r.summary);
    expect(text).toContain(`action_intent:${r.subjectRef.id}`);
    for (const id of evidence) expect(text).toContain(id);
    expect(text).toContain(r.id);
    expect(text).toContain("`send now`");
    expect(text).toContain(replyInstructions("approval"));
    expect((card.blocks[0] as Block).type).toBe("header");
  });

  test("empty evidence renders honestly as none, not a fake list", () => {
    const text = flatten(renderHumanRequestCard(request()).blocks as Block[]);
    expect(text).toContain("no attached evidence");
  });

  test("each kind advertises exactly the vocabulary inbound parses", () => {
    expect(replyInstructions("approval")).toContain("*approve*");
    expect(replyInstructions("approval")).toContain("*deny*");
    expect(replyInstructions("question")).toContain("*answer:*");
    expect(replyInstructions("notification")).toContain("*ack*");
  });
});

describe("renderDigest / renderNudge", () => {
  test("digest lists request ids and counts", () => {
    const ids = [newUlid(), newUlid(), newUlid()];
    const digest = renderDigest("Weekly pending approvals", ids);
    const text = flatten(digest.blocks as Block[]);
    for (const id of ids) expect(text).toContain(id);
    expect(text).toContain("3 pending request(s)");
    expect(flatten(renderDigest("Empty", []).blocks as Block[])).toContain("Nothing pending");
  });

  test("nudge counts ordinals and repeats the reply instructions", () => {
    const r = request({ kind: "question" });
    expect(renderNudge(r, 1).text).toContain("1st follow-up");
    expect(renderNudge(r, 2).text).toContain("2nd follow-up");
    expect(renderNudge(r, 4).text).toContain("4th follow-up");
    expect(flatten(renderNudge(r, 1).blocks as Block[])).toContain(replyInstructions("question"));
  });
});

describe("anchor codec (channel:ts — the slack connector's externalId shape)", () => {
  test("round-trips and rejects malformed anchors", () => {
    expect(encodeAnchor("C0100AL5K9", "1718000000.000100")).toBe("C0100AL5K9:1718000000.000100");
    expect(decodeAnchor("C0100AL5K9:1718000000.000100")).toEqual({
      channel: "C0100AL5K9",
      ts: "1718000000.000100",
    });
    expect(decodeAnchor("no-separator")).toBeUndefined();
    expect(decodeAnchor(":leading")).toBeUndefined();
    expect(decodeAnchor("trailing:")).toBeUndefined();
  });
});

describe("parseReplyVerdict", () => {
  const approval = { kind: "approval" as const };
  const question = { kind: "question" as const, options: ["Standard tier", "Premium tier"] };
  const notification = { kind: "notification" as const };

  test("approval: approve/deny vocabulary with comments preserved", () => {
    expect(parseReplyVerdict(approval, "approve")).toEqual({ verdict: "approved", comment: "approve" });
    expect(parseReplyVerdict(approval, "Approve! Looks good to me")).toEqual({
      verdict: "approved",
      comment: "Approve! Looks good to me",
    });
    expect(parseReplyVerdict(approval, "LGTM")).toMatchObject({ verdict: "approved" });
    expect(parseReplyVerdict(approval, "deny — wrong quote attached")).toMatchObject({
      verdict: "denied",
      comment: "deny — wrong quote attached",
    });
    expect(parseReplyVerdict(approval, "rejected.")).toMatchObject({ verdict: "denied" });
  });

  test("question: explicit answer prefix or an exact option match", () => {
    expect(parseReplyVerdict(question, "answer: Premium, they asked for it")).toEqual({
      verdict: "answered",
      comment: "Premium, they asked for it",
    });
    expect(parseReplyVerdict(question, "Answer - 42")).toEqual({ verdict: "answered", comment: "42" });
    expect(parseReplyVerdict(question, "premium tier")).toEqual({
      verdict: "answered",
      comment: "Premium tier",
    });
    expect(parseReplyVerdict(question, "answer:")).toBeUndefined(); // empty answer is not an answer
  });

  test("notification: ack only", () => {
    expect(parseReplyVerdict(notification, "ack")).toMatchObject({ verdict: "acknowledged" });
    expect(parseReplyVerdict(notification, "Acknowledged, thanks")).toMatchObject({
      verdict: "acknowledged",
    });
  });

  test("chatter never resolves anything", () => {
    expect(parseReplyVerdict(approval, "what quote is this about?")).toBeUndefined();
    expect(parseReplyVerdict(approval, "")).toBeUndefined();
    expect(parseReplyVerdict(approval, "   ")).toBeUndefined();
    expect(parseReplyVerdict(question, "hmm let me check")).toBeUndefined();
    expect(parseReplyVerdict(notification, "ok")).toBeUndefined();
  });
});

describe("inbound slack event schemas", () => {
  const message = {
    type: "message",
    channel: "C0100AL5K9",
    ts: "1718000001.000200",
    text: "approve",
    user: "U0200USER",
    thread_ts: "1718000000.000100",
  };

  test("unwraps both event_callback envelopes and bare events", () => {
    expect(unwrapSlackEvent(message)?.text).toBe("approve");
    expect(
      unwrapSlackEvent({ type: "event_callback", team_id: "T01", event: message })?.channel,
    ).toBe("C0100AL5K9");
    expect(unwrapSlackEvent({ type: "url_verification", challenge: "x" })).toBeUndefined();
    expect(unwrapSlackEvent("garbage")).toBeUndefined();
  });

  test("ingestion policy: humans in, bots and room noise out", () => {
    expect(shouldIngestInbound(unwrapSlackEvent(message)!)).toBe(true);
    expect(shouldIngestInbound(unwrapSlackEvent({ ...message, bot_id: "B01" })!)).toBe(false);
    expect(shouldIngestInbound(unwrapSlackEvent({ ...message, subtype: "channel_join" })!)).toBe(false);
    expect(shouldIngestInbound(unwrapSlackEvent({ ...message, text: "  " })!)).toBe(false);
    expect(shouldIngestInbound(unwrapSlackEvent({ ...message, subtype: "thread_broadcast" })!)).toBe(true);
  });
});
