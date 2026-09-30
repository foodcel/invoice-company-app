# Release credential input encoding

Confidence: HIGH. Publishing stopped before creating a release; no assets were uploaded.

The publisher's `git credential fill` call (`scripts/publish-release.ps1:18`) received a UTF-8 BOM before `protocol=https` when invoked through Windows PowerShell 5. Git therefore rejected the first field and reported missing protocol. A safe probe piping the same non-secret protocol/host lines to Python reproduced bytes `EF BB BF` in PowerShell 5; the current PowerShell 7 sends no BOM. The credential request code is unchanged from earlier releases; this is a native-input encoding dependency.

Fix: set native output encoding to UTF-8 without a BOM around the credential request and restore the previous setting in finally. Re-read the named source anchor before editing. Validate the protocol/host probe without retrieving or printing a token, then run the publisher. This changes the release helper only; the installed app and installer payload do not change.
