# Dated payments release

Scope: approved option 1, legacy deposits, saved rows, preview, French/English PDFs, signed update.

- [x] P1: Older deposits load as one undated payment; editing, reopening and restoring preserve rows and invoice numbers.
  CHECK: scripts\check-rust.cmd
  EXPECT: test result: ok.
  EVIDENCE: 19 Rust tests passed, including legacy migration, reopen, recovery, version restoration, rejected export and unchanged invoice sequence.
- [x] P2: Payment totals, blank rows, invalid values, dated PDF text and long payment lists are verified.
  CHECK: npm run check
  EXPECT: fail 0
  EVIDENCE: 16 app tests passed. The production event listener test exercises typing and payment Add/Remove, and rejects the previous undefined-variable defect. PDF extraction found both dated payments in French and English and all 90 entries plus 48 notes over 7 Letter pages. Rendered first French/English and last long-list pages were inspected. Isolated mutations that ignore rows or omit printed details failed their respective checks.
- [x] P3: The frontend and signed Windows installer build successfully.
  CHECK: powershell -NoProfile -ExecutionPolicy Bypass -File scripts/package-release.ps1
  EXPECT: Release files ready:
  EVIDENCE: v0.1.11 NSIS installer (671.31 MiB), updater signature and latest.json generated successfully. Manifest version, exact installer URL and signature checked. Installer SHA256: 4D10563B749D3F04AEB8A77847F680AAC691C694D61DAF0E43C0B1A8AB209EAA.
- [ ] P4: The public latest release contains the matching installer, signature and manifest; updater URL serves the new version.
  EVIDENCE: pending public release and manifest verification.
- [x] P5: The PC installation reports the new version and existing draft data is preserved.
  EVIDENCE: silent installer exited 0; registry and executable version are 0.1.11. Installed executable matches every build byte except Tauri's three-byte package marker (UNK becomes NSS for NSIS, verified against tauri-utils platform.rs). Normal and Codex-virtualized draft files keep their pre-install SHA256; private backups are in ignored test-output/pre-v0.1.11.

Native click-through and Dad-PC update installation must be checked on the actual device. They are not claimed by source, unit tests, or build success.

Rules drift: no AGENTS.md exists in this checkout. CONTRACT.md and README.md now document authoritative payment rows, legacy migration, totals and PDF pagination. No new rules file was created.
