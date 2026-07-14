import { describe, expect, test } from "bun:test";
import {
  acceptsFreeAnswer,
  actionsFor,
  buildResolution,
  describeParty,
  humanizeKind,
} from "../src/ui/resolve";

describe("actionsFor", () => {
  test("approvals offer approve and deny", () => {
    const actions = actionsFor({ kind: "approval", state: "pending" });
    expect(actions.map((a) => a.verdict)).toEqual(["approved", "denied"]);
    expect(actions.map((a) => a.label)).toEqual(["Approve", "Deny"]);
    expect(actions[1]?.style).toBe("danger");
  });

  test("questions offer one answered-action per preset option", () => {
    const actions = actionsFor({ kind: "question", state: "pending", options: ["Yes", "No"] });
    expect(actions).toEqual([
      { verdict: "answered", label: "Yes", presetComment: "Yes", style: "primary" },
      { verdict: "answered", label: "No", presetComment: "No", style: "primary" },
    ]);
  });

  test("questions without options offer no one-click actions (free answer only)", () => {
    expect(actionsFor({ kind: "question", state: "pending" })).toEqual([]);
  });

  test("notifications offer acknowledge", () => {
    expect(actionsFor({ kind: "notification", state: "pending" }).map((a) => a.verdict)).toEqual([
      "acknowledged",
    ]);
  });

  test("non-pending requests offer nothing", () => {
    expect(actionsFor({ kind: "approval", state: "approved" })).toEqual([]);
    expect(actionsFor({ kind: "question", state: "answered", options: ["Yes"] })).toEqual([]);
    expect(actionsFor({ kind: "notification", state: "expired" })).toEqual([]);
  });
});

describe("acceptsFreeAnswer", () => {
  test("only pending questions take a typed answer", () => {
    expect(acceptsFreeAnswer({ kind: "question", state: "pending" })).toBe(true);
    expect(acceptsFreeAnswer({ kind: "question", state: "answered" })).toBe(false);
    expect(acceptsFreeAnswer({ kind: "approval", state: "pending" })).toBe(false);
    expect(acceptsFreeAnswer({ kind: "notification", state: "pending" })).toBe(false);
  });
});

describe("buildResolution", () => {
  test("uses the preset comment when the action carries one", () => {
    expect(buildResolution({ verdict: "answered", presetComment: "Yes" }, "typed")).toEqual({
      verdict: "answered",
      comment: "Yes",
    });
  });

  test("falls back to the typed comment (deny-comments have a home)", () => {
    expect(buildResolution({ verdict: "denied" }, "wrong carrier")).toEqual({
      verdict: "denied",
      comment: "wrong carrier",
    });
  });

  test("comment is always present, defaulting to empty", () => {
    expect(buildResolution({ verdict: "approved" }, "")).toEqual({
      verdict: "approved",
      comment: "",
    });
  });
});

describe("describeParty", () => {
  test("role strings and refs both render", () => {
    expect(describeParty("underwriting")).toBe("role: underwriting");
    expect(describeParty({ kind: "principal", id: "01ARZ3NDEKTSV4RRFFQ69G5FAV" })).toBe(
      "principal 01ARZ3NDEKTSV4RRFFQ69G5FAV",
    );
  });
});

describe("humanizeKind", () => {
  test("underscores become spaces", () => {
    expect(humanizeKind("action_batch")).toBe("action batch");
    expect(humanizeKind("approval")).toBe("approval");
  });
});
