# GitHub Release asset name differs from update manifest

## Summary and assessment

The published 0.1.0 `latest.json` loads, but its installer URL returns HTTP 404. Reproduced with a HEAD request to the exact manifest URL on 2026-09-28. Severity: high for future updates. Complexity: moderate, as both release files and publishing must agree. Confidence: high.

## Evidence chain

1. `scripts/package-release.ps1:25-43` copies the installer with spaces in its filename into `release-output` and calls the manifest generator using that name.
2. `scripts/create-update-manifest.mjs:17-24` URL-encodes that basename, yielding a GitHub download URL containing `%20` spaces.
3. `scripts/publish-release.ps1:10-42` uploads that same file name to GitHub Releases. GitHub reports the published asset name with dots substituted for spaces: `Soumissions.et.factures_0.1.0_x64-setup.exe`.
4. The live release has three assets and the update feed matches the local manifest, but the manifest URL returns HTTP 404. The app's current-version check does not download the installer, so it could not expose this defect.

Root cause: the release build assumes GitHub preserves spaces in uploaded asset filenames. No production update has been issued; this is the initial release.

## Fix and verification

Package the signed installer and `.sig` under a safe ASCII basename without spaces for release upload. Make the manifest generator reject unsafe asset names and add a regression test. Update the publishing script to expect that safe basename and verify GitHub returns it unchanged before publishing. Replace the existing 0.1.0 release assets and manifest with the corrected names, then verify the manifest URL returns HTTP 200 and its file digest matches the uploaded installer. Signature validity depends on installer bytes, which remain unchanged when only the filename changes.
