# Gates: v0.1.19 two-panel payment timeline

OWNS: web/pdf.js, web/app.js, web/style.css, tests/pdf-closing.test.mjs, package.json, package-lock.json, src-tauri/Cargo.toml, src-tauri/Cargo.lock, src-tauri/tauri.conf.json, scripts/publish-release.ps1, docs/pdf-timeline/**

Scope: Implement the approved print-friendly two-panel timeline in French/English quotations/invoices, preserve every entry across continuation pages, publish a signed update and verify the local installation.

- [x] G1: Saved PDFs keep all work, notes and date/amount pairs, have no overlaps, and show final totals once in both languages and document kinds.
  CHECK: node --test tests/pdf-closing.test.mjs
  EXPECT: fail 0
  EVIDENCE: frontend-checks.txt: 62 tests passed. Saved-PDF observer checks 500 date/amount pairs in each language and document kind, notes once, 100-step work description without word loss, overlap/bounds checks. Negative controls inject clipping and overlap and are caught. Near-full closing layouts stay below continuation headers. No live provider calls.
- [ ] G2: App checks, backend checks and release build pass.
  CHECK: npm run check
  EXPECT: fail 0
  EVIDENCE: 62 frontend tests and 55 backend tests pass (one explicit live-provider test ignored); final signed installer build pending.
- [x] G3: Normal and extreme PDF pages and editor preview visually match the selected two-panel timeline with restrained ink use.
  EVIDENCE: 19 rendered pages inspected: French invoice and English quote, 9-page work example and 8-page note/payment example. editor-preview.png captures isolated production preview function/styles with synthetic data. No cuts, overlaps or large colored blocks. Existing print flow uses the matching styled document; no physical printer test. Email export tests execute the production export handler with actual new PDF bytes and isolated native transport; no email sent.
- [ ] G4: Public latest manifest, signature and installer digest match v0.1.19; local installed version and saved state are verified.
  EVIDENCE: pending
