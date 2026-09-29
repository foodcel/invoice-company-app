# Gates: English copies, AI text, and voice

OWNS: web/app.js, web/style.css, web/pdf.js, src-tauri/src/lib.rs, src-tauri/Cargo.toml, tests/**, docs/**

Scope: Save and export reviewed English customer copies while preserving the French document; provide provider configuration, line dictation and rewriting, and document dictation that visibly fills fields while recording.

- [x] G1: French documents and invoice sequencing remain correct after English copy export
  CHECK: npm run check
  EXPECT: fail 0
  EVIDENCE: npm run check passed 10 tests, including French PDF totals and English PDF paths; Rust export sequencing tests passed.

- [x] G2: The frontend bundles with the English review UI and PDF renderer
  CHECK: npm run build
  EXPECT: built in
  EVIDENCE: npm run build succeeded for v0.1.5 and its assets were included in the Windows bundle.

- [x] G3: The native storage and export tests pass with English copy persistence
  CHECK: scripts\check-rust.cmd
  EXPECT: test result: ok.
  EVIDENCE: scripts\check-rust.cmd passed 16 tests for v0.1.5.

- [x] G4: A saved English copy can be reopened and exported without overwriting the French draft
  EVIDENCE: reviewed_english_copy_survives_reopen_and_shares_one_invoice_number and stale-copy tests passed; English invoice PDF rendered and its identifiers, amounts and line text were extracted.

- [ ] G5: Provider credentials stay out of source, drafts, backups, and exported PDFs
  EVIDENCE: provider key path uses Windows Credential Manager and draft JSON has no key field; no actual key was supplied for a live persistence check.

- [x] G6: English PDF keeps invoice number, dates, amounts, tax rates, and tax identifiers unchanged
  EVIDENCE: English quote and invoice PDF tests passed on US Letter; invoice PDF text extraction confirmed invoice number, amounts, and tax identifiers.

- [ ] G7: Line dictation and AI enhancement propose prose, bullets, and another version without changing the saved description until accepted
  EVIDENCE: line proposal state and selected-provider API paths built; a real API key and microphone are still needed for end-to-end proof.

- [ ] G8: Whole-document dictation applies validated fields in stages while recording, preserves pre-existing values, and saves the result
  EVIDENCE: voice merge test passed for existing fields, dates, repeated items, and manual corrections; live short-segment capture and extraction remain unverified.

- [ ] G9: OpenAI and Z.ai both have actual transcription and text paths; errors or missing keys leave drafts intact
  EVIDENCE: both selected-provider request paths compile; response-shape tests passed, but neither provider has been called with a real general API key.

- [x] G10: Microphone capture stops and releases the device, including when an error or cancellation occurs
  EVIDENCE: simulated 5-second WAV, final flush, cancellation, and callback-error cleanup tests passed; live Windows microphone permission remains unverified.

- [x] G11: A signed 0.1.5 Windows installer and update manifest are produced, and this PC installs the candidate
  EVIDENCE: NSIS signed installer and latest.json generated; silent install exited 0; Windows registry and installed executable report 0.1.5; installed app process started and was stopped after smoke check.
