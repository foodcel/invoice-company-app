# Email composer retains a stale document recipient

Confidence: HIGH. Source confirms the defect and the isolated production UI reproduced it: the saved document contains changed@example.com while the reopened composer visibly retains camille@example.com. Browser read-back of email strings is redacted, so screenshot plus isolated save receipt provide the evidence.

## Five whys

1. The reopened composer renders an old recipient/greeting from its cached model (`web/email-composer.js:433`, `:457`).
2. Restoration prefers the whole remembered model over fresh document defaults (`:399`).
3. The cache key uses only document ID, kind, and language, which do not change when email/client/project changes (`:397`).
4. Closing unconditionally remembers the model and clearing the overlay does not clear the map (`:638`, `:3`).
5. No source baseline is stored or compared (`:481`), although the host flushes edits and supplies fresh document state (`web/app.js:667`, `:675`). Introduced in `34a4483`.

## Fix

Remember the source email, automatic subject/body and PDF content fingerprint. Refresh the source recipient on a document-email change while preserving extra recipients; refresh only untouched message defaults. Preserve custom text and CC. Clear stale unsubmitted attachment metadata. Accepted/uncertain attempts retain their original PDF and duplicate-send lock until the user explicitly confirms another send. No real provider calls in checks. Rechecked source anchors before implementation.
