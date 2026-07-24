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

Real as of **P12-browser**. There are no stubs left in this package.

| Piece | File | What it does |
|---|---|---|
| Pod runtime | `src/host.ts` | mount (unseal → launch) / attach (broker) / release (re-seal → delete pod) |
| Chrome seam | `src/launcher.ts` | spawns the system Chrome with `--remote-debugging-port=0 --user-data-dir=<pod dir>`, reads the DevTools endpoint off stderr |
| CDP broker | `src/broker.ts` | Bun websocket proxy with a single-use token; refused commands get a CDP error + a reported denial |
| Broker policy | `src/cdp-policy.ts` | allow-list ∪ hard deny-list (cookies, DOM/IndexedDB/CacheStorage storage, request interception, devtools escape hatches) |
| Policy config | `src/policy.ts` | `humanizationPolicySchema` + `defaultHumanizationPolicy` |

The tests never require a real browser: the `ChromeLauncher` is injected, and
the broker is exercised against a scripted upstream websocket.

### Configuration

- `LITHIS_CHROME_BINARY` — the headed Chrome/Chromium executable. Unset falls
  back to the standard macOS/Linux install paths; nothing found is a loud
  error at mount time, never a silent degrade.
- Sealed profiles are resolved by **custody**, not by this package
  (`LITHIS_BROWSER_PROFILE_DIR`, default `~/.lithis/profiles`, one directory
  per credential). Object-storage-backed sealing lands with P15-gcp.

### Known residual risk

`Runtime.evaluate` is on the allow-list — navigating and extracting requires
page scripting, and page script can read JS-visible (non-`httpOnly`) cookies.
The broker scans evaluate/callFunctionOn payloads for `document.cookie`,
`localStorage`, `sessionStorage`, `indexedDB` and `navigator.credentials` as
defense in depth, but that is a guard, not a sandbox. The session cookies that
matter (LinkedIn's `li_at`, most portal auth) are `httpOnly` and unreachable
from page script by construction; what the deny-list closes is every
*wholesale profile export* path. A fine-grained expression/capability policy
belongs with the policy layer (ADR-006).
