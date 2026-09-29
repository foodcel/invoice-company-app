# Gates: Nemotron Windows release

OWNS: src-tauri/**, web/**, scripts/**, tests/**, README.md, CONTRACT.md, package.json, .gitignore

Scope: integrate local French capable speech into the Windows app, deliver a signed installer, and hand off the separate Pi migration.

- [x] G1: French transcription runs locally with no cloud speech API.
  EVIDENCE: Installed NeMo-Speech.cpp transcribed a 20-second French WAV with the bundled GGUF; SHA-256 of the installed model matched 3FC991D3...953A070B1. Realtime WebSocket gave its first French partial in 0.92 seconds on this PC with no cloud speech request.

- [ ] G2: Partial text appears during recording, and completed utterances trigger document field extraction.
  EVIDENCE: Realtime sample produced a partial in 0.92 seconds and a final after 9.7 seconds before recording stopped; app.js routes final events to ai_extract_document. A live microphone and general API-key test remain.

- [ ] G3: Work line speech remains reviewable before replacing a description.
  EVIDENCE: Source retains the original line until Accept; the local streaming test covers partial and final events. Live provider proposal not yet tested.

- [ ] G4: Settings distinguish local speech from cloud text AI.
  EVIDENCE: Settings copy and native command paths were reviewed; installed UI was not visually exercised.

- [x] G5: Updater-signed Windows installer contains the verified model, runtime, and notices and opens without terminal setup.
  EVIDENCE: 0.1.6 NSIS installer and Tauri updater .sig completed; silent install exited 0. Registry reports 0.1.6; installed model and runtime exist; installed model hash matches NVIDIA; installed runtime transcribed French; app process launched. state.json hash remained 3F51F08C...062E27064AC. This is not a Windows Authenticode code signature.

- [x] G6: Public release, update manifest, and installed version match.
  EVIDENCE: Public GitHub v0.1.6 release is published with installer, .sig, and latest.json. GitHub reports installer size 703941467 and SHA-256 matching the local release copy (87D0B06F...AD4B518). latest.json resolves to 0.1.6 and the exact installer URL. Git tag points at the source commit bb5e103; Windows registry reports installed version 0.1.6.

- [x] G7: Frontend and native regression tests pass.
  EVIDENCE: npm run check passed 11 tests; scripts/check-rust.cmd passed 16 native tests; git diff --check found no whitespace errors.

- [x] G8: Pi and OmyPi handoff exists without changing those installations.
  EVIDENCE: C:/Users/Mathys/Desktop/repos/buisness/PI_NEMOTRON_HANDOFF.md saved. No Pi or OmyPi files were edited in this turn.

- [ ] G9: Dad's i5-12400 machine gives acceptable latency and memory use.
  EVIDENCE: pending; requires a session on Dad's PC.
