# Outlook integration interfaces

Selected design: `.pipeline/brainstorm/outlook-email-polished-three/number-one.png` and gallery `index.html` variant 2 (user label 01). Recipient To and CC rows each expose + and remove X, including the first recipient. Subject row ends with Undo then icon-only AI. Sender in header. Company signature, PDF card, 14px footer gap, Cancel/Send bottom.

Backend module owns `src-tauri/src/outlook.rs` only. Main owns lib.rs wrappers. Public module API:

- `configure(PathBuf)` initializes private Outlook data directory.
- `settings() -> Result<MailSettings,String>` exposes camelCase clientId, accountantEmail, signature, connected, senderEmail, authPending, authError. Never expose tokens.
- `save_settings(client_id:String, accountant_email:String, signature:String) -> Result<MailSettings,String>`; client ID public, GUID validated; changing registration disconnects old credentials.
- `start_login() -> async Result<MailSettings,String>`, opens default browser via native ShellExecuteW. Public client OAuth/PKCE with loopback callback, random state, bounded lifetime. Scope Mail.Send User.Read offline_access. Consumers authority personal accounts. No app secret.
- `cancel_login() -> Result<MailSettings,String>`.
- `disconnect() -> async Result<MailSettings,String>` clears local tokens, aborts auth; don't imply revoking all Microsoft sessions.
- `send(request:SendRequest, filename:String, pdf:Vec<u8>) -> async Result<SendReceipt,String>`; request camelCase attemptId, to:Vec<String>, cc:Vec<String>, subject:String, body:String. Validation bounded, no retry send after timeout/transport ambiguity. Persist local attempt journal keyed by ID; duplicate attempt must not submit twice. Response senderEmail, acceptedAt, attemptId. Graph 202 means accepted, not delivered. Backend has no arbitrary-file read; main resolves attachment only from stored export belonging to given draft.

Frontend module owns `web/email-composer.js`, `web/email-composer.css`, `tests/email-check.mjs` only. Export `openEmailComposer(options)` async or sync. Options `{ invoke, draft, language, filename, preparePdf, rewrite, onClose, onSent }`. `preparePdf()` runs existing export, returns `{path,filename,draftId}`; invoked on final Send before native send. `rewrite({body,subject,language})` returns `{body,subject}` with approved subscription route. File preview can be from Blob passed in options if main supports. Settings commands `get_mail_settings`, `save_mail_settings` `{clientId,accountantEmail,signature}`, `start_outlook_login`, `cancel_outlook_login`, `disconnect_outlook`. Final `send_outlook_mail` args `{draftId,path,request}`. Composer controls its overlay and focus trap independently; preserve draft on close, disable duplicate submissions, show PDF saved separately from send errors. Email optional except Send. Validate recipients before PDF creation. No hidden provider call on open.

Main integrates existing export safely without rerendering away composer, adds settings entry topbar, third Send output button, native commands and AI email rewriting. Version local 0.1.15, no push/release.
