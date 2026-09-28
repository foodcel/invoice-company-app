# Invoice number control is hard to find

## Summary and assessment

| Severity | Complexity | Confidence |
| --- | --- | --- |
| Medium: Dad cannot readily correct the proposed next number | Low: expose existing backend command near its displayed value | High: the control and command are present in source, but the control is only rendered inside Recent Documents |

## Expected and actual

Expected: an unissued invoice shows its proposed number with an obvious way to change the next number. Already issued invoices keep their assigned number. Actual: the proposal appears in the editor (`web/app.js:305`), while the editable setting is appended to the Recent Documents dialog (`web/app.js:263`). Source reproduction verified; the installed UI was not independently exercised for this report.

## Evidence chain

1. The editor renders the proposed number as text without an edit action (`web/app.js:305`).
2. The only number input appears after the recent-document list and only while that dialog is open (`web/app.js:261-263`). The event handler calls `set_next_invoice_number` only from this control (`web/app.js:560-578`).
3. The backend already persists the next number and refuses values at or below the highest issued invoice (`src-tauri/src/lib.rs:351-382`). The export path fixes an invoice number only after the PDF is written (`src-tauri/src/lib.rs:540-552`).
4. Git blame attributes the UI and backend design to the initial app commit `1f77afe`; this is an original discoverability gap, not a recent regression.

## Root cause and fix

The number edit command was placed in an unrelated document-history dialog. Put an explicit edit affordance beside the number in the invoice editor and open a small number-setting dialog with manual entry and step controls. Reuse the existing confirmed backend command. Explain that the control sets the next number and cannot renumber an issued invoice. Keep the backend as authority.

## Alternatives and risks

An inline editable number would be faster but could imply that an already issued invoice can be renumbered. Recreating historical invoice 2059 requires a separate revision or import workflow; lowering the next number past an issued invoice would risk duplicate numbers. No backend numbering rule should change for this UI fix.

## Validation

- Re-read the cited code anchors before editing; stop if materially changed.
- Run frontend checks and backend tests, including number-sequence tests.
- Verify the visible number dialog at narrow and wide widths; cancel must be inert, confirm must update the preview, and the next PDF must use the chosen number.
