# Gates: v0.1.18 PDF and editor fixes

OWNS: web/pdf.js, web/app.js, web/style.css, web/email-composer.css, tests/pdf-closing.test.mjs, tests/check.mjs, package.json, package-lock.json, src-tauri/Cargo.toml, src-tauri/Cargo.lock, src-tauri/tauri.conf.json, scripts/publish-release.ps1, docs/pdf-layout/**, .pipeline/rca/pdf-closing-and-focus.md

Scope: Correct customer PDF closing layout, inset email focus, refreshed source recipient, notes mic/AI controls, price currency suffix, quantity arrows and phone spacing; publish a signed update. Five footer redesigns and spelling suggestions remain proposals.

- [x] G1: PDF notes/payments stay bottom-left across French/English copies and table heights; long content survives without footer collisions.
  CHECK: node --test tests/pdf-closing.test.mjs
  EXPECT: fail 0
  EVIDENCE: saved-PDF text positions pass; original layout failed negative control (closing at 570 vs totals at 722). Rendered closing-fr.png visually inspected.
- [x] G2: Existing app and backend checks pass.
  CHECK: npm run check
  EXPECT: fail 0
  EVIDENCE: 57 frontend tests pass, 14 email checks include negative probes; backend 55 pass, one live subscription test ignored. Notes production-handler tests include cancel, late results, failures and work-line regression. No new live provider, microphone or email-delivery claim.
- [x] G3: Rendered PDF and isolated production UI visually verified, quantity arrows update amounts and saved draft.
  EVIDENCE: editor-proof.png, email-focus-proof.png, email-refresh-proof.png and notes-controls-proof.png. Notes width corrected after visual review; inset focus, currency symbol, quantity totals and source email visible. No live email sent.
- [ ] G4: Signed v0.1.18 installer is publicly published and latest manifest matches local signature; local installation preserves data.
  EVIDENCE: local v0.1.18 installed, state hash preserved; executable equals final build with documented NSIS bundle marker normalization. Public publication pending.

Rules drift: no AGENTS.md in app/parent scope. No rule edits needed.
