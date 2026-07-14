# @lithis/browserhost

Headed-Chrome session pods — the ONLY place browser-session credentials are
ever unsealed.

## What this will be

- **Session pods.** Each mounted browser session is a real, headed Chrome
  running in an isolated pod. Agents never run a browser themselves; they
  drive one remotely through a brokered CDP connection.
- **Custody-mounted sealed profiles.** Browser sessions (cookies, local
  storage, device fingerprint) are sealed custody assets (`Credential` of kind
  `browser_session`). `custody.mountSession()` mounts the profile directly
  into the pod — cookie material never enters agent context, transcripts, or
  logs. Release re-seals the profile back into custody.
- **CDP broker.** The pod exposes a scoped Chrome DevTools Protocol endpoint;
  every action through it is capability-checked and emitted as a spine event,
  so browser activity is fully auditable.
- **Timing-only humanization.** Pacing (delays, jitter, dwell time, hourly
  action caps) is the entire humanization surface. No fake mouse curves, no
  fingerprint spoofing beyond the sealed profile itself. The policy is a real,
  zod-validated config (`humanizationPolicySchema`) with a shipped default.
- **CAPTCHA = pause + notify.** Hitting a CAPTCHA (or any bot-check
  interstitial) pauses the session and raises a `HumanRequest` notification —
  a human completes it in the headed browser. Lithis never auto-solves
  CAPTCHAs; `captcha: 'pause_and_notify'` is a literal type, not an option.

## Status

Skeleton. The `HumanizationPolicy` schema and `defaultHumanizationPolicy` are
real; the `BrowserHostService` implementation is a registered stub
(`browserhost.host.*`) until build-out phase 7 (browserhost + linkedin pack).
