# Packaged preview logo missing

## Summary and assessment

The installed Windows app shows an empty reserved logo area in the document preview. Reproduced in the installed 0.1.0 package on 2026-09-28. Severity: medium (customer-facing print layout). Complexity: low. Confidence: high (the built bundle proves the requested URL and actual asset name differ).

## Evidence chain

1. `web/app.js:208` inserts `<img src="./assets/business-card-image.png">` as a literal string.
2. `vite.config.js:3-7` builds `web/` into `dist/` with Vite. `dist/assets/` contains `business-card-image-DPD7R9k7.png`, with no `business-card-image.png`.
3. The built JavaScript still contains the literal original URL, while CSS `web/style.css:14` references the asset through its stylesheet and Vite rewrites it to the fingerprinted filename.
4. The installed app screenshot shows the CSS-based header mark but an empty `.paper-mark` area. This localizes the failure to the dynamic preview image URL rather than the source image or crop.

Root cause: Vite cannot rewrite an asset URL embedded as a plain string inside the generated HTML template. This was introduced when the preview mark changed from CSS background to `<img>` during print repair; this repository has no earlier commits to blame.

## Fix and verification

Import the PNG as a module in `web/app.js` and interpolate the resolved URL into the image `src`. Recheck that the built JS references the fingerprinted image, then rebuild and install the signed NSIS package. Verify the mark appears in the installed preview and Windows print preview; cancel printing. The existing PDF generator uses a separate embedded image path and needs no change.
