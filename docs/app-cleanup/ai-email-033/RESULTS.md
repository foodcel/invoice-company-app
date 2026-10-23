# 0.1.33 — AI-independent document output

2026-10-22. Send, Create PDF and Print now use current document text without waiting for optional writing corrections. Completed corrections and Undo remain available; canceled/late results cannot overwrite output. Existing document, archive, recipient and Outlook checks remain active.

The exact oversized-response error comes from the bounded JSON reader. The models catalogue now has a separate 4 MiB allowance, while authentication responses retain their 512,000-byte limit. Actual recovery of Dad's ChatGPT connection has not been tested.

## Evidence

- App checks: 175 passed, 0 failed; includes a negative control restoring the former mandatory AI gate.
- Native release tests: 106 passed, 0 failed, 1 ignored (explicit live subscription test).
- Browser: failed, pending and disconnected AI each reach composer, create a real PDF and complete one mocked send. No external emails or provider calls.
- Windows build and silent local installation: exit 0, version 0.1.33.
- Installed app: a real disconnected-AI correction failure no longer blocks composer; original six records, history, selection and invoice counter preserved. Synthetic test draft removed. Two preexisting PDF references point to absent files; no local existing PDF files were available to hash.
- Local installer signature verified against updater key; corrupted digest rejected.

Native installed testing uses the real immutable Tauri bridge. The complete send flow is covered using simulated mail transport in browser/helper tests; real Outlook delivery and Dad-PC acceptance remain unverified.

## Distribution

Signed installer: `release-output/v0.1.33/Soumissions-et-factures_0.1.33_x64-setup.exe`.
GitHub repository is currently private; anonymous latest release lookup returns 404. Automatic updater delivery is not verified and cannot work through the existing anonymous endpoint while it remains private. No visibility change performed. User choice requested after installer completion.

Claude has not reviewed this.
