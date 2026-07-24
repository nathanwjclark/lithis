import { z } from "zod";
import { defineEventType } from "../events";
import { ulidSchema } from "../ids";

/**
 * Sealed-browser-session topics. Payloads carry IDS ONLY — never a profile
 * path, a DevTools endpoint, or cookie material (ADR-003). The security
 * watcher (sentinel) reads these: mounts, releases, and every CDP command the
 * broker refused.
 */

export const T_BROWSER_SESSION_MOUNTED = defineEventType({
  topic: "browser.session.mounted",
  description:
    "A sealed browser_session credential was unsealed into a browserhost pod (subject: the credential).",
  payload: z.object({ credentialId: ulidSchema, sessionId: ulidSchema, podId: z.string().min(1) }),
});

export const T_BROWSER_SESSION_RELEASED = defineEventType({
  topic: "browser.session.released",
  description: "A mounted browser session was re-sealed into custody and its pod torn down.",
  payload: z.object({ credentialId: ulidSchema, sessionId: ulidSchema }),
});

export const T_BROWSER_CDP_DENIED = defineEventType({
  topic: "browser.cdp.denied",
  description:
    "The CDP broker refused a command against a mounted session (cookie/storage read, " +
    "non-allow-listed method, or profile-material scripting). Never silently dropped.",
  payload: z.object({
    sessionId: ulidSchema,
    method: z.string().min(1),
    rule: z.enum(["denied_method", "not_allow_listed", "denied_script"]),
  }),
});
