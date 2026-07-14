/**
 * Pure helpers behind the Inbox resolve UI. REAL code, unit tested — the
 * verdict rules mirror packages/core humangate: approval → approve/deny,
 * question → answered (preset option or typed answer), notification →
 * acknowledge. `pending` is the only resolvable state.
 */

import type { HumanRequest, Ref } from "@lithis/core";

export type ResolveVerdict = "approved" | "denied" | "answered" | "acknowledged";

export interface ResolveAction {
  verdict: ResolveVerdict;
  label: string;
  /** Preset comment (question options render one button per option). */
  presetComment?: string;
  style: "primary" | "danger" | "neutral";
}

type Resolvable = Pick<HumanRequest, "kind" | "state"> & { options?: string[] | undefined };

/** The one-click actions a request offers. Empty when not pending. */
export function actionsFor(req: Resolvable): ResolveAction[] {
  if (req.state !== "pending") return [];
  switch (req.kind) {
    case "approval":
      return [
        { verdict: "approved", label: "Approve", style: "primary" },
        { verdict: "denied", label: "Deny", style: "danger" },
      ];
    case "question":
      return (req.options ?? []).map((option) => ({
        verdict: "answered" as const,
        label: option,
        presetComment: option,
        style: "primary" as const,
      }));
    case "notification":
      return [{ verdict: "acknowledged", label: "Acknowledge", style: "neutral" }];
  }
}

/** Questions also take a typed free-text answer (verdict `answered`). */
export function acceptsFreeAnswer(req: Resolvable): boolean {
  return req.state === "pending" && req.kind === "question";
}

/**
 * The resolve body POSTed to /api/humangate/:id/resolve — by/at are
 * server-set from the identity headers. `comment` is always present in the
 * schema (deny-comments have a first-class home), so it defaults to "".
 */
export function buildResolution(
  action: Pick<ResolveAction, "verdict" | "presetComment">,
  comment: string,
): { verdict: ResolveVerdict; comment: string } {
  return { verdict: action.verdict, comment: action.presetComment ?? comment };
}

/** Render an assignee/requestedBy — a Ref or a plain role string. */
export function describeParty(party: Ref | string): string {
  if (typeof party === "string") return `role: ${party}`;
  return `${party.kind} ${party.id}`;
}

/** "action_batch" → "action batch" for card badges. */
export function humanizeKind(value: string): string {
  return value.replace(/_/g, " ");
}
