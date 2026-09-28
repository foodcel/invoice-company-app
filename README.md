# Soumissions et factures

Windows application for Ébénisterie de l'Hermitage inc. to prepare quotations and invoices. Manual entry works without an AI service. A reviewed English customer copy can be saved beside each French draft and exported as a separate PDF. With a configured general API key, the app can transcribe and improve one work line or fill document fields from speech.

The Windows icon is the approved **Document** concept (`src-tauri/icons/icon-source.svg`). To regenerate its Windows assets after editing that source, run `npm run tauri -- icon src-tauri/icons/icon-source.svg` and retain `icon.png` and `icon.ico` in `src-tauri/icons`.

## For Dad

1. Install the Windows setup program once, then open **Soumissions et factures** from the Start menu or desktop shortcut.
2. Choose **Soumission** or **Facture**, enter the customer and work details, and review the page on the right.
3. The form saves automatically; **Enregistrer le brouillon** saves immediately. **Documents récents** reopens earlier work.
4. Choose **Créer le PDF** to save a customer copy in `Documents\Entreprise\À classer`. Use **Dossier des PDF** in the top bar to choose a different folder or return to the default. The choice is remembered after closing the app and applies to both PDF and Print. **Imprimer** first explains where it will save the PDF, then opens Windows printing. The PDF name uses the customer's name and the invoice number when applicable. If a PDF with the same name exists, the app keeps it and tells you the new copy's name.

For an English-speaking customer, open **Réglages IA** and select OpenAI or Z.ai, then enter a **general API key** for that provider. The key is stored in Windows Credential Manager, separately from document data and PDFs. A Codex subscription or Z.ai Coding Plan key may not be authorized for this general business API. The app never switches providers automatically. You can continue creating French documents if there is no key or no internet connection.

After completing the French text, click **Traduire en anglais**. The app sends only the project name, work descriptions, and client notes to the selected provider. Review and edit the proposed English copy, then click **Confirmer cette copie**. It is saved with the original document, can be reopened from **Documents récents**, and displays an English preview. **Créer le PDF** or **Imprimer** while viewing English uses the same invoice number and numeric fields as the French document; the PDF name includes `_EN`. A later French text change makes the English copy out of date and blocks English export until it is refreshed and confirmed again. French draft entry and French PDF export never require AI.

The small microphone on a work line records that line only. Press it again to finish; the app transcribes the recording and proposes a cleaner description. **Texte clair**, **Liste à puces**, and **Autre version** request AI alternatives. You can edit the proposal, **Accepter** it, or use the X to keep the original. The small stars button proposes improvements for a typed line. Neither action changes the saved description before acceptance.

The microphone in the document header fills the document while you speak. It sends consecutive short audio segments to the selected provider and adds recognized fields after each segment is processed. Press the microphone again to stop, then check every field and price. Existing filled fields are protected, and manual corrections made during dictation are retained. If analysis fails after speech was recognized, the words remain visible for retry or copying. The app saves recognized changes as a draft; dictation never creates a PDF or issues an invoice number. Audio is not saved as a local file, but segments and recognized text are sent to the chosen provider. An internet connection, microphone permission, and a working general API key are required.

The next invoice number starts at **2060**. Saving a draft does not issue a number. The first successful PDF export of an invoice fixes its number; later saves and exports of that invoice keep it. Use **Modifier le n°** beside the displayed invoice number to change the next unissued number; an issued invoice cannot be renumbered.

## Build and test on Windows

The build PC needs Node.js, Rust (MSVC toolchain), Microsoft C++ Build Tools, and the Tauri updater signing key. Run from this folder:

```powershell
npm install
npm run check
scripts\check-rust.cmd
scripts\build-windows.cmd
scripts\package-release.ps1 -SkipBuild
```

The per-user NSIS installer is written under `src-tauri\target\release\bundle\nsis\`. Dad's PC does not need Node, Rust, or a terminal. It needs a supported x64 Windows version and WebView2; the installer can acquire WebView2 when internet access is available.
The package script places the installer, its updater signature, and `latest.json` together in `release-output\v<version>\` for a GitHub Release with the same `v<version>` tag. Omit `-SkipBuild` when packaging a new code version.
After reviewing those files, run `scripts\publish-release.ps1` on a PC signed in to GitHub. It uploads the three files as a draft and publishes the release only after all uploads succeed. It never replaces an existing release.

## Data, backup, and updates

- Drafts and invoice numbers are stored under the app's per-user local data folder in `state.json`; a separate recovery copy is kept in `recovery\state.backup.json`. A failed or interrupted export does not silently reuse an issued invoice number.
- Exported PDFs go to `Documents\Entreprise\À classer` by default, or the folder chosen with **Dossier des PDF**, and are never overwritten by a later export. Changing the folder affects future exports only; earlier files stay where they were. If a chosen folder becomes unavailable, exporting fails visibly and no invoice number is issued. A later sorting agent may organize these files, but is not part of this release.
- The app checks for updates only when the user chooses the update action. Signed updates use a `latest.json` file and the matching NSIS installer from the public GitHub Releases repository. The signing **private** key stays outside this repository at `%USERPROFILE%\.tauri\invoice-company-app.key`; back it up securely before distributing the app. Losing it prevents updates to an installed version that trusts this key.
- Increasing the version in both `package.json` and `src-tauri/tauri.conf.json`, building with the same key, and publishing the installer, `.sig`, and generated `latest.json` are necessary for each update. See `docs/tauri-windows-delivery.md` for the delivery details.

The first installation and updates should be exercised on Dad's actual PC before relying on them for business records. Keep an independent copy of the app's data folder and exported PDFs as part of the normal computer backup.

The API integration has been checked against provider documentation and local response fixtures. It has not been exercised with a real key or microphone on this PC, so successful live AI and voice calls still require a configured account and an end-to-end check. AI translations and work-line rewrites remain proposals until a person confirms them. Dictated document fields are saved as they are recognized and must be reviewed before a customer PDF is created.
