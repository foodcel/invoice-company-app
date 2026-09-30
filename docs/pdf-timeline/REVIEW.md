# Two-panel timeline release review

User selected the outlined two-panel PDF with connected dated payments, requested print-friendly color use, reviewed extreme pagination examples, and authorized implementation and publication on 2026-09-30.

## Implementation

- `web/pdf.js`: shared French/English quote/invoice export renderer; measured two-panel closing, grayscale payment timeline, subtle balance background. Long supporting details flow at full width, final panels reference their page ranges, and retain the final three payments. Every payment still appears once, in the entered order. Totals are computed from all payments and appear once.
- Work descriptions continue across table pages with repeated table headings; avoid leaving only one or two lines on the next page when space permits.
- `web/style.css`: editor and existing HTML print preview show the same outlined panels and connected dated-payment rows. Empty note/payment panels are hidden.
- Existing PDF save and email preview/attachment paths reuse `createPdf`. No credentials, account settings, invoice numbers, saved documents or save-directory schema changes.

## Verification limits

Saved-PDF content, geometry, continuation headers, both document kinds/languages and 500-row histories verified by the production tests. Browser inspection uses the production preview function/styles with synthetic data. Physical printing, live Outlook delivery and live AI are not rerun for this layout change.

## Rules drift

No AGENTS.md exists in the app or parent repository scope. No rules-file edits needed.
