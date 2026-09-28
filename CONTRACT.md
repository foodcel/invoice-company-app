# Windows app integration contract

The selected `mockups/index.html` is the visual source. `app/web/` is the Vite input, `app/dist/` is its bundled output, and `app/src-tauri/` is the local Windows host. The app works without a server for document entry, storage, printing and PDF creation. French is the default language. Do not add customer facts or work details that Dad did not enter.

## Draft JSON

Use the mockup's field names: `id`, `kind` (`soumission` or `facture`), `date`, `validUntil`, `dueDate`, `client`, `shipTo`, `address`, `contact`, `email`, `project`, `notes`, `deposit`, and `items` (`description`, `quantity`, `price`). Date strings are `YYYY-MM-DD`; text fields remain strings. `invoiceNumber` is a displayed number supplied by the backend. `issuedNumber` is `null` until the first successful invoice export and stays fixed thereafter. The UI must never advance invoice numbering on draft save, print, or repeated export. The backend is the authority for `invoiceNumber` and `issuedNumber`.

## Native commands

- `load_state() -> { current, records, nextInvoiceNumber }`: load the current draft and searchable recent records. A record contains `{ id, draft, updatedAt, exports }`. The current draft is included in records. A first run returns a fresh quote draft.
- `save_draft({ draft }) -> { current, records, nextInvoiceNumber }`: atomically persist the editable draft. The backend preserves any existing `issuedNumber`, and returns its authoritative invoice number. Trigger after a short typing pause and on field blur/structural changes.
- `new_draft({ kind }) -> { current, records, nextInvoiceNumber }`: save the previous current draft, create a blank draft of that kind, and make it current. This is the confirmed Reset/new-document action.
- `open_draft({ id }) -> { current, records, nextInvoiceNumber }`: make a recent draft current.
- `export_pdf({ draft, pdfBytes, expectedInvoiceNumber, language }) -> { path, filename, invoiceNumber, snapshot }`: validate and atomically write the completed PDF to `Documents/Entreprise/À classer/`, with an automatic safe name. `pdfBytes` is an array of unsigned bytes. For invoices, reject stale `expectedInvoiceNumber`; issue the number only after a successful file write, then keep it on all later exports of that document. Quotes have no public number. Repeated exports of one document retain its number and use a collision-safe file path. Return a new snapshot. `language` is `fr` or `en`.
- `restore_previous({ id }) -> { current, records, nextInvoiceNumber }`: restore a recoverable earlier version of a record without changing an already issued invoice number.
- `set_next_invoice_number({ number }) -> { current, records, nextInvoiceNumber }`: change the number proposed for the next new invoice, starting at 2060 on first run. Require an explicit confirmation in the UI. Reject nonpositive values and any number already issued or lower than the highest issued number; never renumber an issued invoice. Persist this setting for future invoices.

All commands return clear errors without replacing the last good saved data. The backend owns the local data file and a separate recoverable backup. Do not put secrets or customer data in the repository.

## UI and PDF module

`app/web/pdf.js` exports `createPdf(draft, { invoiceNumber, language }) -> Promise<Uint8Array>`. It renders a US Letter customer PDF with company logo, real-text company name/address/phone, item descriptions with wrapping and multiple pages as needed, totals, deposit if present, and the confirmed TPS/TVQ registration numbers. It must encode the supplied client data without HTML execution. English output must be reviewed before use; no silent translation. `app/web/app.js` imports this function and invokes `export_pdf` only after field validation. Print displays only the customer document.

The packaged UI should keep the mockup's single selected design, including the two large document choices, side-by-side editor and large preview, light/dark modes, date picker, multiline work lines, line mic/AI icons, recent documents, Undo, and validation. The first release completes the manual workflow. Display voice/AI controls as unavailable or clearly coming later until a verified app API integration exists; never imply they processed customer data.
