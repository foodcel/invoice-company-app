# AI-independent email output — 0.1.33

- [x] G1: Failed/pending/disconnected AI cannot block Send, PDF or Print; current text and Undo survive and late responses cannot alter it.
  CHECK: npm run check
  EXPECT: fail 0
  EVIDENCE: PowerShell, app root, npm run check exit 0: tests 175, pass 175, fail 0. New integration test runs production output functions and real PDF generator; isolated former mandatory-AI gate fails the same composer assertion. No provider calls or external sends.
- [x] G2: Real browser interactions reach the composer and mocked send with an actual generated PDF after AI failure. No external mail is sent.
  CHECK: node tests/ai-optional-output-ui.mjs
  EXPECT: AI_OPTIONAL_OUTPUT_UI_PASSED
  EVIDENCE: PowerShell, app root, node tests/ai-optional-output-ui.mjs exit 0: AI_OPTIONAL_OUTPUT_UI_PASSED scenarios=3. Failed, pending and disconnected AI each produce one real PDF and one mocked send with no AI started by output. Screenshot inspected. Initial harness incorrectly expected simultaneous automatic correction on a queued row; corrected to use a separate note and reran successfully.
- [x] G3: Native checks pass, including any response-limit repair and existing archive/numbering behavior.
  CHECK: scripts/check-rust.cmd --lib --release
  EXPECT: test result: ok
  EVIDENCE: scripts/check-rust.cmd --lib --release exit 0: 106 passed, 0 failed, 1 ignored. Includes four new synthetic HTTP response-limit tests; no provider login or live AI call.
- [x] G4: Installed 0.1.33 opens the email composer after disconnected AI fails, preserves user data, and has a verified signed installer.
  EVIDENCE: build-windows.cmd exit 0; installer exit 0; installed-ai-optional-output.mjs exit 0 (real local AI credential failure, actual composer, six records and number cursor preserved, temporary draft removed). Two preexisting missing PDF references remain missing; no existing PDF bytes were available on this PC. verify-release.mjs exit 0 validates installer signature and rejects a tampered digest. No external send or live AI request.
- [x] G5: The configured automatic updater endpoint publicly serves the correct signed 0.1.33 package.
  EVIDENCE: User explicitly approved making the repository public again. gh repo edit succeeded; node scripts/verify-release.mjs --public exited 0 with PUBLIC_RELEASE_VERIFIED. Anonymous latest-release metadata, configured manifest, signature asset, installer HTTP 200/size and remote SHA-256 all match the tested installer. Dad-PC installation/delivery acceptance remains pending.

Native prerequisite: initial check could not run because Visual Studio had no C++/SDK components. Standard Windows administrator prompt approved by user; installation completed with exit 0, then native tests passed.
Release access history: initially PRIVATE and anonymous latest-release lookup returned 404. After the signed installer was ready, the user explicitly approved restoring PUBLIC visibility. The visibility change and anonymous release verification then succeeded.
Rules check: no repository AGENTS.md found; supplied user review policy remains applicable. README and CONTRACT now describe AI-independent output. Claude has not reviewed this.
Installed probe calibration: the first attempt stopped on preexisting missing PDF paths; now records both present hashes and absent paths. Mocking the installed Tauri bridge failed because its invoke property is immutable; replaced with a real disconnected-AI failure. Removed an incorrect assumption that disconnected Outlook disables Send: the composer shows its connection status, with actual send validation covered by helper tests. Final installed probe passed; no application change was needed for these harness corrections.
