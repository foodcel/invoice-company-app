# Subscription request HTTP 400

## Summary and assessment

User signed in with Pro, then the app reported HTTP 400 and claimed subscription access was refused.

| Dimension | Assessment |
|---|---|
| Severity | High: all three text workflows share the rejected request builder. |
| Complexity | Small: remove an unsupported field and preserve safe provider diagnostics. |
| Confidence | HIGH for request-contract violation and misleading error; the exact server error and corrected live inference still require verification. |

## Expected vs actual and evidence chain

1. User reports successful sign-in followed by HTTP 400 during inference (live failure reported, not independently reproduced).
2. `src-tauri/src/subscription_ai.rs:380-382` includes `max_output_tokens` in every subscription Responses request.
3. OpenAI explicitly requires omitting this field on this route: https://developers.openai.com/siwc/token-sharing-open-source/preview-limitations . Unsupported capabilities produce HTTP 400: https://developers.openai.com/siwc/token-sharing-open-source/errors-and-recovery .
4. `src-tauri/src/ai.rs:193-202` routes rewrite, translation and document extraction through this shared builder, carrying token limits inherited from the former generic API adapter.
5. `src-tauri/src/subscription_ai.rs:384` discards response body/code/param/request ID and labels every error as denied subscription access. Hence a malformed request is displayed as an account problem.

Original behavior in newly added, uncommitted subscription adapter; not a regression in released v0.1.11.

## Fix and risks

Re-read these anchors before editing. Centralize the subscription request body without unsupported token limits; preserve bounded safe code, parameter and request ID on failed HTTP responses. Keep strict JSON output, store=false, stream=true and completed-stream requirements. No billing fallback, credential replacement or OAuth retry. Validate against the user's saved connection using synthetic text only (one request per workflow, maximum three, sequential; stop on failure). Native microphone capture and Business credentials are out of scope for this defect.

## Validation

Regression test actual builder omission of every documented forbidden field, required transport flags and schema preservation. Test HTTP 400 unsupported-field diagnostic separately from 403 eligibility denial, malformed bodies and bounded identifiers. Run `scripts/check-rust.cmd`, `npm run check`, opt-in ignored synthetic live workflow probe, then package/install the corrected build. Keep live success separate from unit tests. Do not publish Dad's update until actual subscription inference is established.

## Verified live follow-up

Removing the unsupported field changed the result to accepted inference, exposing a second parser defect. Three bounded diagnostic requests established that this live route emits final text through `response.output_item.done` but returns an empty `response.output` array in `response.completed`. The old parser discarded these completed items. Corrected parser retains completed items, requires the successful terminal event, and rejects failures, interrupted streams, duplicate items and external actions. Transport diagnostics contained only event types/indexes/lengths; no credentials or customer data were printed. Temporary diagnostics were removed.

One subsequent three-call live acceptance run passed: rewrite retained oak/four steps/installation; English translation retained line count and empty notes; extraction identified the synthetic client, quantity 2 and price 100 while keeping unspecified address/date absent. Source path: ignored `subscription_ai::tests::live_subscription_document_workflows`; production `ai` adapters and production stream parser, saved user-authorized OAuth subscription connection; no API key or billing fallback. Total live requests: six (three initial parser diagnostics and three passing workflows), sequential, 90-second per-request transport bound. This proves text AI access, not native microphone capture or Business inference.
