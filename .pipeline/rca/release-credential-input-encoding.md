# Release credential input encoding

Confidence: HIGH. Publishing stopped before creating a release; no assets were uploaded.

The publisher's `git credential fill` call (`scripts/publish-release.ps1:18`) received a UTF-8 BOM before `protocol=https` when invoked through Windows PowerShell 5. Git therefore rejected the first field and reported missing protocol. A safe probe piping the same non-secret protocol/host lines to Python reproduced bytes `EF BB BF` in PowerShell 5; the current PowerShell 7 sends no BOM. The credential request code is unchanged from earlier releases; this is a native-input encoding dependency.

Setting native output encoding to UTF-8 without a BOM did not remove the BOM on this PowerShell 5 route; its safe probe still failed. Publishing from PowerShell 7 succeeded and v0.1.11's assets and public latest manifest were verified.

Final fix: hand off PowerShell 5 invocations to installed PowerShell 7 before any credential request, or give a clear requirement message when unavailable. Retain the scoped explicit native encoding in PowerShell 7. A repeat invocation must stop at the existing-release guard without replacing assets. This changes the release helper only; the installed app and installer payload do not change.

Verification: Windows PowerShell 5 invocation successfully reached the PowerShell 7 existing-release guard and returned `Release v0.1.11 already exists. No files were replaced.` This is the expected refusal for the safe repeat probe, not a failed upload.
