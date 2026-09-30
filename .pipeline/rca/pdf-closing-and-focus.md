# PDF closing layout and email focus

Confidence: HIGH. Two independent read-only investigations reproduced the closing-layout mismatch in freshly generated French and English PDFs.

## Evidence / five whys

1. Notes and payments do not sit beside the bottom totals because their PDF position follows the item table (`web/pdf.js:488`, `:503`).
2. They follow the table because both use `cursor + 19`; adding an item moves them while totals stay fixed (`web/pdf.js:476`, `:494`).
3. Totals stay fixed because `drawTotals` uses `724 - totalsHeight` (`web/pdf.js:391`).
4. The preview looks correct because `.doc1-closing` bottom-aligns both columns using `margin-top:auto` and `align-items:end` (`web/style.css:277`, `web/app.js:311`). The PDF never measures a combined closing block.
5. The mismatch escaped checks because PDF tests asserted page count and totals, without content coordinates (`tests/pdf.test.mjs:86`, `:102`). Notes behavior originated in `1f77afe`; payments inherited it in `29ef141`. Email preview and sending both reuse this generator (`web/app.js:676`, `:679`).

The recipient focus outline overlaps its remove button because an outer outline with a positive offset is applied to every composer control (`web/email-composer.css:21`), including compact recipient inputs (`:43`). Replace outer outlines with inset rings, including invalid inputs.

## Fix boundary

Measure notes and payments together, paginate complete headed chunks, and bottom-align each left chunk above the footer. Preserve fixed totals on the final page. Check actual PDF text matrices before and after the fix, long content completeness, footer clearance, and render the resulting PDF. Add unit-price currency suffix and quantity step controls as requested. No real emails will be sent in verification.

Anchors rechecked against the current working tree before implementation; no source drift.
