# Release 0.1.31

- [x] G1: Existing tested 0.1.31 installer is packaged with accurate release notes and matching update manifest.
  CHECK: scripts/package-release.ps1 -SkipBuild
  EXPECT: Release files ready
  EVIDENCE: package-release.ps1 -SkipBuild exits 0, 168 tests pass, three matching release files prepared. No rules file is present in workspace/ancestors; rules-check-drift: The rules file is still accurate for these changes — no edits needed. Documentation amended for current writing/print/tax behavior. Source upload excludes local invoice/screenshots; public PDF fixture uses synthetic identity and descriptions, and all 168 checks pass again.
- [x] G2: Installer signature verifies against the installed updater key; tampered content is rejected.
  CHECK: node tests/verify-local-installer.mjs docs/app-cleanup/release-031/signature-receipt.json
  EXPECT: LOCAL_SIGNED_INSTALLER_VERIFIED
  EVIDENCE: LOCAL_SIGNED_INSTALLER_VERIFIED version=0.1.31 bytes=825124977. Trusted metadata and signature verify; altered digest rejected. SHA256 24f9ebfa35c7580e3f639e000ae8a2dc69edd1204fb695b397d4677e359f5619. docs/app-cleanup/release-031/signature-receipt.json.
- [x] G3: Public stable release has the matching installer, signature and latest.json; live updater endpoint resolves to 0.1.31.
  CHECK: node tmp/verify-public-release-031.mjs
  EXPECT: PUBLIC_RELEASE_031_VERIFIED
  EVIDENCE: publish-release.ps1 exits 0; all three assets uploaded. PUBLIC_RELEASE_031_VERIFIED: public stable tag v0.1.31, latest updater endpoint returns matching manifest, installer HEAD 200 with exact 825124977 bytes, server SHA256 digest matches signed local artifact, downloaded .sig matches manifest. Public feed checker rejects an isolated wrong-version metadata copy (PUBLIC_FEED_WRONG_VERSION_REJECTED). Source commit 7cff255 pushed before release creation. docs/app-cleanup/release-031/public-receipt.json and negative-receipt.json.
- [x] G4: Original 0.1.21 updater transport detects 0.1.31 and shows its startup update offer, without changing real documents.
  CHECK: node tmp/check-old-updater-probe-031.mjs published
  EXPECT: NATIVE_021_OFFERS_031_VERIFIED
  EVIDENCE: Actual 0.1.21 executable with only an equal-length isolated app identifier replacement; native updater version/key/endpoint unchanged. Startup offer displays 0.1.31; plugin updater result reports currentVersion 0.1.21, version 0.1.31. Real business-state hash unchanged. No installation invoked. Owned process closed normally and recorded PID exited. docs/app-cleanup/release-031/native-published.json and startup-update-offer.png. This is local compatibility proof, not a Dad-PC installation claim.
