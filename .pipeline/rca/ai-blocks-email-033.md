# AI failure prevents ordinary document output

2026-10-22. Severity: high (email workflow unavailable). Complexity: moderate (async ownership and attachment consistency). Confidence: HIGH for the email blocker; provider response cause investigated separately.

Expected: Send, PDF and Print use the document's current text even if optional AI is disconnected, failed or pending. Existing accepted corrections remain; late replies cannot change the reviewed attachment. Normal document, archive, recipient and Outlook checks remain active.

Actual/reproduction: user's screenshot exactly matches the improvement queue failure thrown at web/ai-improvement-queue.js:36 and prefixed by composeEmail at web/app.js:969. Production-source tests will reproduce it with a rejected provider, without sending email.

Evidence chain:
1. Email composer never opens because composeEmail awaits finishWritingForOutput before opening it (web/app.js:966-983).
2. That function awaits improvements.drain and automatic.ensureAll (web/app.js:206-213).
3. drain rejects any current failed queued improvement (web/ai-improvement-queue.js:34-36); ensureAll also starts new proofreading requests and rejects their errors (web/automatic-corrections.js:100-117).
4. Attachment export and Print call the same mandatory function (web/app.js:882,918). Bypassing only the composer would fail again at attachment creation.
5. Root: optional writing assistance became an output prerequisite in 7cff255 (v0.1.31). The user's latest requirement explicitly supersedes the earlier correction-before-output preference.

Fix: cancel unapplied queue work and invalidate pending proofreading ownership while retaining current text, accepted patches and Undo. Do not start or wait for AI during output preparation. Preserve formatting and page-capacity validation. Replace the retry-before-output message with an accurate optional-AI status. Explicit AI buttons continue to request corrections.

Tests: use real correction managers with rejected and delayed fake providers; run the actual production composer/export/print functions and real PDF generation. Confirm mocked mail is submitted once with the current attachment, invalid documents/archive failures still block, late replies cannot mutate output, and Undo still reverses accepted corrections. Inject the former mandatory AI calls in an isolated source string and require regression failure. Browser UI and installed composer checks use synthetic data and blocked external sends. No actual email is authorized.

History search: deja is unavailable on PATH. Current chat, git history and current source establish the decision and implementation. Anchors reread immediately before editing.

## Connection-size error

Read-only sidecar traced the exact message to subscription_ai.rs:68-75: the shared JSON reader rejects more than 512,000 bytes. text_request fetches /models through that reader before inference (:422). Token refresh and signing-key responses share it (:284,315); the screenshot does not prove which endpoint was too large. The SSE reader has a distinct 2,000,000-byte limit and different error (:430-436), so changing generated-output/stream limits is not justified.

Confidence HIGH that the exact message comes from the JSON reader; MODERATE that catalogue growth triggered it. Scope the repair to independent limits: keep auth at 512,000 bytes, allow models up to 4 MiB, label catalogue oversize failures safely, retain bounded reading and JSON validation. Use synthetic HTTP responses above the old limit and at boundaries, with no live login/provider calls. This addresses the documented shared-limit defect; actual Dad-PC connection recovery remains unverified.
