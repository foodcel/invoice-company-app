# Soumissions et factures

Windows application for Ébénisterie de l'Hermitage inc. to prepare quotations and invoices. Manual entry works without an AI service. The Français / English switch creates or opens an English customer copy in the document preview; creating its PDF confirms the current copy. The bundled Nemotron 3.5 model transcribes speech locally; a saved ChatGPT (OpenAI) or Claude (Anthropic) API key lets the app improve a work line or fill document fields from recognized speech.

The Windows icon is the approved **Document** concept (`src-tauri/icons/icon-source.svg`). To regenerate its Windows assets after editing that source, run `npm run tauri -- icon src-tauri/icons/icon-source.svg` and retain `icon.png` and `icon.ico` in `src-tauri/icons`.

## For Dad

1. Install the Windows setup program once, then open **Soumissions et factures** from the Start menu or desktop shortcut.
2. Choose **Soumission** or **Facture**, enter the customer and work details, and review the page on the right.
3. The form saves automatically; **Enregistrer le brouillon** saves immediately. **Documents récents** reopens earlier work.
4. Choose **Créer le PDF** to save a customer copy in `Documents\Entreprise\À classer`. Use **Dossier des PDF** in the top bar to choose a different folder or return to the default. The choice is remembered after closing the app and applies to archived PDFs. **Imprimer** opens Windows printing without archiving a PDF or issuing an invoice number. Cancelling printing leaves the draft editable. **Enregistrer le brouillon** saves only in the app; **Créer le PDF** saves an archived customer copy and keeps the editable document in the app. The PDF name uses the customer's name and the invoice number when applicable. If a PDF with the same name exists, the app keeps it and tells you the new copy's name.

For an English-speaking customer, open **Réglages → Intelligence artificielle**, choose **ChatGPT** or **Claude**, paste that service’s API key and choose **Enregistrer la clé**. There is no login: an API key always works, and each service bills usage to the account that issued the key. The key is stored in the Windows Credential Manager, separated from drafts and PDFs, and both keys can be saved at the same time (the selected service is the one used). ChatGPT keys come from platform.openai.com (API keys) and Claude keys from console.anthropic.com (API keys). Manual French documents remain available without a key or an internet connection.

Choose **Tester la connexion** after saving a key: it runs rewriting, translation and field extraction on synthetic examples, so only a completed response proves the key works. Requests go straight to `api.openai.com` (Responses API, structured JSON output, nothing stored) or `api.anthropic.com` (Messages API, structured JSON output). The OpenAI model is picked from the models the key can use (preference list in `src-tauri/src/api_ai.rs`); Claude uses `claude-sonnet-5-5`. Previous ChatGPT subscription, Business and Z.ai selections migrate to ChatGPT with no key saved; add a key to use AI again.

After completing the French text, choose **English** in the language switch. The app sends only the project name, work descriptions, and client notes to the selected provider, saves the translation with the draft, and shows the English customer preview. Review that preview before choosing **Créer le PDF** or **Imprimer**; creating the PDF confirms the current English copy. Printing does not archive it. The English PDF uses the same invoice number and numeric fields as the French document, with `_EN` in its filename. A later change to French source text returns the preview to French; choosing English again refreshes the translation. French draft entry and French PDF export never require AI.

The small microphone on a work line records that line only. Press it again to finish; the app transcribes the recording and proposes a cleaner description. **Texte clair**, **Liste à puces**, and **Autre version** request AI alternatives. You can edit the proposal, **Accepter** it, or use the X to keep the original. The small stars button proposes improvements for a typed line. Neither action changes the saved description before acceptance.

The microphone in the document header fills the document while you speak. A transcript appears during speech. After an utterance ends, the selected text AI interprets the recognized words and updates fields. Press the microphone again to stop, then check every field and price. Existing filled fields are protected, and manual corrections made during dictation are retained. If analysis fails after speech was recognized, the words remain visible for retry or copying. The app saves recognized changes as a draft; dictation never creates a PDF or issues an invoice number. Audio is processed on this computer by Nemotron and is not sent to the text provider; recognized text and document content are sent to the chosen provider for interpretation. An internet connection and a saved API key are needed for field filling, line rewriting, and English translation, but not for local transcription.

The next invoice number starts at **2060**. Saving a draft does not issue a number. The first successful PDF export of an invoice fixes its number; later saves and exports of that invoice keep it. Use the pen beside the displayed number to change an unissued invoice number; an issued invoice cannot be renumbered.

In **Au besoin**, enter each deposit or received payment as its own row. Choose its date on the right, and use **Ajouter un paiement** (or **Ajouter un dépôt**) below the rows to add another. Dates are optional; an older deposit stays intact and is marked **Date non précisée** until a date is entered. Blank rows do not appear on the customer document. The French and English PDFs list each positive payment, its date, the combined amount, and the remaining balance after tax. Payments do not change the tax calculation or invoice number.

## Build and test on Windows

The build PC needs Node.js, Rust (MSVC toolchain), Microsoft C++ Build Tools, and the Tauri updater signing key. `build-windows.cmd` downloads and SHA-256 verifies the pinned Windows CPU runtime and 742 MB Nemotron model, then bundles both into the installer. Run from this folder:

```powershell
npm install
npm run check
scripts\check-rust.cmd
scripts\build-windows.cmd
scripts\package-release.ps1 -SkipBuild
```

The per-user NSIS installer is written under `src-tauri\target\release\bundle\nsis\`. Dad's PC does not need Node, Rust, or a terminal. It needs a supported x64 Windows version and WebView2; the installer can acquire WebView2 when internet access is available.
The package script places the installer, its updater signature, and `latest.json` together in `release-output\v<version>\` for a GitHub Release with the same `v<version>` tag. Omit `-SkipBuild` when packaging a new code version.
After reviewing those files, run `scripts\publish-release.ps1` in PowerShell 7 on a PC signed in to GitHub. An invocation from Windows PowerShell 5 hands off to `pwsh` when available. It uploads the three files as a draft and publishes the release only after all uploads succeed. It never replaces an existing release.

## Data, backup, and updates

- Drafts and invoice numbers are stored under the app's per-user local data folder in `state.json`; a separate recovery copy is kept in `recovery\state.backup.json`. A failed or interrupted export does not silently reuse an issued invoice number.
- Exported PDFs go to `Documents\Entreprise\À classer` by default, or the folder chosen with **Dossier des PDF**, and are never overwritten by a later export. Changing the folder affects future exports only; earlier files stay where they were. If a chosen folder becomes unavailable, exporting fails visibly and no invoice number is issued. A later sorting agent may organize these files, but is not part of this release.
- The app checks for updates only when the user chooses the update action. Signed updates use a `latest.json` file and the matching NSIS installer from the public GitHub Releases repository. The signing **private** key stays outside this repository at `%USERPROFILE%\.tauri\invoice-company-app.key`; back it up securely before distributing the app. Losing it prevents updates to an installed version that trusts this key.
- Increasing the version in both `package.json` and `src-tauri/tauri.conf.json`, building with the same key, and publishing the installer, `.sig`, and generated `latest.json` are necessary for each update. See `docs/tauri-windows-delivery.md` for the delivery details.

The first installation and updates should be exercised on Dad's actual PC before relying on them for business records. Keep an independent copy of the app's data folder and exported PDFs as part of the normal computer backup. The bundled model is [NVIDIA Nemotron 3.5 ASR Streaming 0.6B](https://huggingface.co/nvidia/nemotron-3.5-asr-streaming-0.6b), distributed under OpenMDW-1.1; the native runtime is [NeMo-Speech.cpp](https://github.com/NVIDIA/NeMo-Speech.cpp). Their license and notices are included in the package.

The local Nemotron runtime was exercised with a French recording over both file transcription and realtime WebSocket on this PC. The text AI integration has been checked against provider documentation and local response fixtures. It has not been exercised with a real API key or live microphone on this PC, so field filling, rewriting, translation, and microphone input still require an end-to-end check. Review the English preview before creating its PDF; work-line rewrites still require explicit acceptance. Dictated document fields are saved as completed utterances are interpreted and must be reviewed before a customer PDF is created.

## Current behavior (0.1.33)

These details supersede earlier workflow descriptions below and above: work-description stars queue improvements and apply results automatically. Edited descriptions and notes receive automatic French proofreading after leaving the field. The top Undo removes all AI corrections while preserving manual edits. PDF, Print and Send use the current text without requiring an AI connection or successful corrections. Starting output cancels unapplied improvements and invalidates late correction replies while retaining completed edits and Undo. Ordinary document validation, PDF saving and Outlook checks still apply. AI features require a saved ChatGPT or Claude API key and internet access.

The AI button at the top corrects project/client names, billing/worksite addresses, all work descriptions and client notes together. It preserves quantities, prices, payment amounts, dates, telephone numbers and email addresses. Clicking **Soumission** on an issued invoice opens a separate quotation containing its current details; the original invoice, its number and its archived PDFs remain available in Documents. The top Undo can reopen the original invoice.

Print only prints the in-memory document; cancelling it does not archive a PDF or issue an invoice number. Save Draft saves only the editable draft. Create PDF archives a new PDF version. The compact Letter layout repeats identity information on work continuation pages, keeps full totals on the final page, and displays no per-page subtotal. Older editable drafts use automatic province detection. Switching an unissued invoice to a quotation supplies a missing document date +30-day validity. The app offers available signed updates after startup and also supports a manual check in Settings.

## API-key AI

The AI settings offer two services, each with its own API key: ChatGPT (OpenAI Responses API) and Claude (Anthropic Messages API). Keys are held in Windows Credential Manager and never saved in drafts, PDFs or source files. The old ChatGPT subscription sign-in, ChatGPT Business tokens and the bundled Codex CLI were removed, so the installer no longer carries `resources/codex`.

The provider test makes three synthetic requests: rewriting, English translation, and document-field extraction. A stored key alone is not proof that it works; only the completed test is.
