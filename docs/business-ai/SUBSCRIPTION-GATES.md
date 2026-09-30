# Subscription-only release

User requirement: only existing subscription quota; no pay-as-you-go credentials, general API providers or billing fallback. OpenAI personal subscription login and Business workspace tokens are separate authorized connections. Z.ai and Claude connections must not claim support absent vendor authorization.

- [x] S1: Backend rejects legacy API providers and cannot read or send their keys; existing draft stores migrate provider selection without losing documents.
  CHECK: Rust provider policy and migration regression tests.
- [x] S2: Settings contain only subscription credentials/login; each provider requires its own connection. No key/billing route survives in current web/native runtime.
  CHECK: production settings tests, route scan, web build.
- [x] S3: OpenAI OAuth uses app identity, loopback callback, one-time state/nonce/PKCE, signature/issuer/audience/expiry validation, granted plan scope, protected credentials and serialized refresh. Failures never apply incomplete text or trigger API fallback.
  CHECK: callback, permission, JWT, refresh-state and stream-completion negative tests; local encryption round trip.
- [x] S4: Windows package builds and installed settings match this release; invoice data is preserved.
  CHECK: signed package identity and native settings inspection.
- [x] S5: A user-authorized subscription login and three real synthetic document requests succeed.
  CHECK: user completes browser authorization; completed rewrite, translation and extraction receipts. Credential presence/model catalogue alone is not success.

## RCA

Historical RCA (fixed): `ai.rs` parsed OpenAI/Z.ai API providers and `text_json` sent their Windows vault credentials to general billing endpoints. `lib.rs` accepted them as persisted selections, and `web/app.js` offered API key entry. Original assumption was generic API access, inconsistent with the user's clarified subscription-only contract. Both billing adapters have been removed; legacy selections migrate to an unconnected ChatGPT subscription connection. Business token support remains separate from documented direct OpenAI subscription OAuth. Source: https://developers.openai.com/siwc/token-sharing-open-source/sign-in and models-and-inference. Claude explicitly requires approval for third-party subscription login: https://code.claude.com/docs/en/agent-sdk/overview . Z.ai restricts unsupported tools/scenarios: https://docs.z.ai/devpack/faq . User declined further Z.ai integration; no new provider work is authorized.

## Current evidence

- Provider rejection and legacy store migration passed; existing draft identity, client content and number are retained.
- 33 web checks passed, including private Business token handling, both subscription settings, opaque login request, cancellation, disconnected readiness, and surfaced native authorization errors.
- 30 Rust checks passed for v0.1.14 (one live-only test excluded by default); 33 web checks passed. Request-field omission and completed-item fallback have regression coverage.
- Peer review confirmed no billing fallback; all five initial auth issues were fixed. Final review identified and fixed cancellation of an in-flight rotating refresh. Production concurrency wrapper now completes protected refresh persistence before rejecting a changed session and cancels only inference.
- Local state backup before installation: %LOCALAPPDATA%/invoice-app-safety-backups/before-subscription-only-0.1.13.json.
- User completed private Pro sign-in in v0.1.13. The opt-in production-adapter probe passed completed rewrite, English translation and form extraction on the corrected source. See `.pipeline/rca/subscription-http-400.md` for actual failures, fixes, request budget and assertions. Personal subscription inference is verified; Business inference and actual microphone recording are not established by this probe.
- v0.1.14 signed updater installer built and installed with exit 0. Desktop shortcut resolves to product version 0.1.14. Before/after hashes confirm document state and protected OAuth credentials unchanged by installation. Native app starts, renders the editor, and displays the retained personal connection in settings.
- Installed Test connection was initiated once (at most three extra synthetic requests), but a fresh capture subsequently showed busy controls. The user closed the app and window capture became unavailable before a fresh terminal result was verified. An initially visible success message may have been stale and is not counted as native inference proof. The three completed source-adapter live workflows above remain independently verified. Native manual test can be repeated by the user in the installed corrected version; microphone recording remains separate.
