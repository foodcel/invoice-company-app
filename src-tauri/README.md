# Windows host

`tauri.conf.json` builds the Vite frontend from `app/web` into `app/dist` and bundles an NSIS installer for the current Windows user. The host exposes the seven commands in `app/CONTRACT.md` and registers Tauri's updater plugin.

The updater trusts the public key embedded in `tauri.conf.json` and reads the latest release feed from `foodcel/invoice-company-app` on GitHub. `bundle.createUpdaterArtifacts` produces signed update artifacts during a release build. Provide `TAURI_SIGNING_PRIVATE_KEY` and, if the key is encrypted, `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` in the build process environment. The private key stays outside this repository. The frontend calls the updater and process plugins; the capability grants only check, download-and-install, and restart. Plugin registration alone does not start an update check.

## Local data and recovery

- Editable state: Tauri's app-local data directory, `state.json`.
- Independent recovery copy: `recovery/state.backup.json` in that directory. Each committed state has a generation number. On load, the newest valid copy wins, and the other copy is repaired. If neither copy is readable, the host stops with an error and leaves both files intact.
- Up to four earlier editable versions are kept per document inside the state and recovery copy. `restore_previous` restores the next older version and preserves an issued invoice number.
- A local `state.lock` serializes commands across app processes on one PC. It does not coordinate invoice numbers across multiple computers or protect against loss of the whole disk.
- Customer PDFs go to the Windows Documents location under `Entreprise/À classer/`. A temporary file is synced before it is moved to a new, collision-safe final filename. An export intent is persisted before writing, so an interrupted export can finish without issuing a second number.

The next unissued invoice starts at **2060**. Draft saves and quotes do not issue a number. The first successful invoice PDF fixes its number and advances the proposed next number once. `set_next_invoice_number` changes the future proposal while rejecting numbers already issued or below the highest issued number. The frontend must supply PDF bytes that display the number supplied by the backend; the host verifies PDF framing and size, but does not parse rendered page text.

Run `cargo test --lib` from this directory for persistence, recovery, validation, filename, and numbering tests. `cargo tauri build` from `app/` builds the Vite frontend and Windows NSIS package using the configured Visual Studio MSVC environment.
