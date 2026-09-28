# Technical update error shown to customer

Reproduced in the installed 0.1.0 app before its first GitHub Release was published. The update dialog displayed the English library text “Could not fetch a valid release JSON from the remote.” Severity: low; confidence: high.

Why: `web/app.js:473` concatenates the raw updater exception into a French prefix, and `web/app.js:276` renders that string in the customer dialog. The repository's release feed was unavailable at the time of test, which triggered that path. The root issue for this UI defect is exposing library error text to a French-speaking user. `web/app.js:521` does the same for installation failures.

Show concise French retry guidance for both failures. Preserve the underlying error in the developer console. Verify the dialog remains usable when the feed is unavailable; after publishing `latest.json`, verify an installed current version reports that it is current. The app has no commit history yet, so Git blame cannot date this behavior.
