# Invoice number reuse and editor polish

## Assessment

| Severity | Complexity | Confidence |
| --- | --- | --- |
| Medium: Dad cannot prepare a deliberate correction with a prior invoice number | Medium: storage and export invariants span Rust and the editor | High: every rejection and visual mismatch is traced to explicit code |

## Expected and actual

The user expects an explicit warning and choice to reuse an issued number, with old PDFs preserved and future automatic numbering unaffected. The current command rejects any number at or below the highest issued number (`src-tauri/src/lib.rs:426-434`), and the store validator rejects duplicate issued numbers (`src-tauri/src/lib.rs:930-943`). The UI shows the backend error after the confirmation (`web/app.js:1104-1124`). The appearance issues come from fixed CSS rules (`web/style.css:114-156`) and preview/editor templates (`web/app.js:228-240,410-435`).

## Evidence chain

1. Reuse fails because the command returns an error for `number <= highest` (`lib.rs:432-434`).
2. That rule exists because a draft takes its number from the global next value (`lib.rs:218-223,674-680`).
3. Export also reads that global value (`lib.rs:487-502,537-562`), and finalization advances it (`lib.rs:632-646`).
4. Store validation enforces unique issued numbers and proposed number equal to the global next (`lib.rs:930-943`).
5. Root cause: the data model has no independently selected, explicitly approved number for a single unissued invoice. The global sequence cannot represent a correction without changing every draft and the next automatic number.

The icon and spacing mismatches are direct CSS/template behavior: delete is 34 px versus 40 px controls (`style.css:119,153`), amount has no control border (`style.css:150-151`), the mic is always accented (`style.css:120`), focus/hover rings are external (`style.css:79-104`), and status/proposed text is rendered explicitly (`app.js:240,410-411`). These are longstanding UI choices, not recent regressions.

## Fix and validation

Persist a per-draft manual number with an explicit acknowledgement for older/used numbers. Keep the normal global sequence for new invoices. Recheck the selected number during export, preserve collision-safe PDF filenames, and test reopening plus issuing a reused number. Polish the chosen editor template and CSS; verify light/dark and narrow/wide layouts. Build and install the new package only after source checks pass. Existing user data and PDFs must remain intact.
