# Issued invoice cannot open as a quotation

2026-10-01. Confidence: HIGH. User screenshot reproduces the exact frontend rejection. Severity: blocked expected navigation. Complexity: small explicit copy operation with persistence and history checks.

Expected: clicking Soumission from an existing completed invoice opens a quotation containing its details. The original numbered invoice and archived PDFs must remain retrievable.

Evidence chain:
1. web/app.js:1701 rejects every issuedNumber before type-switch initialization, with the exact screenshot message.
2. src-tauri/src/lib.rs:1079 rejects an issued record changing kind; direct save cannot bypass the UI restriction.
3. Native export_pdf also checks issued kind at :819. Invoice number identity and archive history belong to that original record.
4. The preceding missing-validity fix only addressed unissued drafts; its RCA explicitly retained this restriction. Existing test type_switch_keeps_unissued_content_and_blocks_issued_invoice_change pins it.
5. Root cause: the type-switch action has no path to create a quotation copy from an issued record. The guard dates to initial commit 1f77afe, so this is an unimplemented workflow, not a new export regression.

Fix: retain the original record's protection and add create_quote_from_invoice(id). Copy its current saved draft into a new quotation record, initialize absent validity from the original date +30 days, clear number/issuance and English review metadata, preserve entered French details/payments/tax selection, and retain original archives and invoice cursor. Flush edits first; clicking Soumission routes through the normal serialized native transition and leaves the new quotation open. Top Undo reopens the original invoice.

Risks/tests: new record limit and invalid/stale source rejection must be atomic. Native tests compare original records, versions, PDFs and cursor and verify restart/reload, custom validity and source data. Production click test rejects the old guard as a negative control. Installed UI test switches an existing issued invoice without exporting or issuing another number, restores the original, and deletes only the temporary quotation. Publish 0.1.32 after verification.

Implementation anchors reread immediately before changes; no material drift.
