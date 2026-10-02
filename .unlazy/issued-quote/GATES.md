# Issued-invoice quotation switch

User steering added a top whole-document AI correction button. It covers project/client/address writing and every description/note, keeps numeric/email fields untouched, and shares manual-preserving top Undo.

- [x] G1: Native quote copy preserves source invoice/history/PDF bytes and numbering, initializes validity, and rejects invalid sources atomically.
  CHECK: scripts/check-rust.cmd
  EXPECT: test result: ok
  EVIDENCE: Rust library tests: 102 passed, 1 ignored. New tests compare original records, versions and PDF bytes; stale/unissued sources leave state unchanged.
- [x] G2: Production Soumission click opens a quote copy for issued invoices; original defect fails the same assertion.
  CHECK: npm run check
  EXPECT: fail 0
  EVIDENCE: npm run check: 170 passed, 0 failed; production click test includes the old issued guard as an isolated negative control.
- [x] G3: Installed 0.1.32 UI switches a real issued record to a quote with the same details and readable preview; clean test teardown preserves originals.
  EVIDENCE: installed-receipt.json; INSTALLED_032_SWITCH_AND_AI_PASSED. Preserved all 14 records, 9 PDF hashes, history, selection and invoice cursor 2063; temporary drafts deleted. Installed quotation screenshot inspected.
- [ ] G4: Signed 0.1.32 release and update feed are public and match tested package.
  EVIDENCE: pending
- [x] G5: Header AI corrects project/client/addresses/descriptions/notes, preserves numeric values, and all corrections share top Undo.
  CHECK: node tests/whole-document-ui.mjs
  EXPECT: WHOLE_DOCUMENT_UI_PASSED
  EVIDENCE: WHOLE_DOCUMENT_UI_PASSED checks=3 (controlled adapter); writing-page UI 6 checks and AI queue UI 5 checks. Installed live-provider run also passed correction and manual-preserving Undo; no runtime errors. Controlled screenshot inspected.

Rules drift: no AGENTS.md exists in the workspace or applicable ancestor scope; no rules edits apply. README/CONTRACT updated for the new command and header action. Cargo.lock diff changes only the app version. Signed installer verified with the configured updater key and rejects a corrupted digest.
