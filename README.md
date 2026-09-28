# Soumissions et factures

Windows application for Ébénisterie de l'Hermitage inc. to prepare French quotations and invoices. The first release focuses on manual entry. Voice dictation, AI rewriting, and English translation are visibly unavailable until they can be implemented and reviewed.

The Windows icon is the approved **Document** concept (`src-tauri/icons/icon-source.svg`). To regenerate its Windows assets after editing that source, run `npm run tauri -- icon src-tauri/icons/icon-source.svg` and retain `icon.png` and `icon.ico` in `src-tauri/icons`.

## For Dad

1. Install the Windows setup program once, then open **Soumissions et factures** from the Start menu or desktop shortcut.
2. Choose **Soumission** or **Facture**, enter the customer and work details, and review the page on the right.
3. The form saves automatically; **Enregistrer le brouillon** saves immediately. **Documents récents** reopens earlier work.
4. Choose **Créer le PDF** to save a customer copy in `Documents\Entreprise\À classer`. **Imprimer** first explains that it will save a PDF, then opens Windows printing. The PDF name uses the customer's name and the invoice number when applicable. If a PDF with the same name exists, the app keeps it and tells you the new copy's name.

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
- Exported PDFs go to `Documents\Entreprise\À classer` and are never overwritten by a later export. A later sorting agent may organize these files, but is not part of this release.
- The app checks for updates only when the user chooses the update action. Signed updates use a `latest.json` file and the matching NSIS installer from the public GitHub Releases repository. The signing **private** key stays outside this repository at `%USERPROFILE%\.tauri\invoice-company-app.key`; back it up securely before distributing the app. Losing it prevents updates to an installed version that trusts this key.
- Increasing the version in both `package.json` and `src-tauri/tauri.conf.json`, building with the same key, and publishing the installer, `.sig`, and generated `latest.json` are necessary for each update. See `docs/tauri-windows-delivery.md` for the delivery details.

The first installation and updates should be exercised on Dad's actual PC before relying on them for business records. Keep an independent copy of the app's data folder and exported PDFs as part of the normal computer backup.
