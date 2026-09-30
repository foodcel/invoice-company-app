# Outlook setup (one time for the app owner)

Dad's account is Outlook.com / Hotmail / Live. This app uses Microsoft Graph with a delegated personal-account login. It never asks Dad for an application secret, Microsoft password in an app field, or an AI API key.

0. If Entra reports **AADSTS16000 / AADSTS50020**, **live.com**, and tenant **Microsoft Services**, your personal Microsoft account has no linked developer directory. Follow Microsoft's documented fix: open https://azure.microsoft.com/free/ and create an Azure account. That provisions your own tenant, with you as its administrator. Complete identity/terms/payment verification yourself; no paid Azure compute resources are needed by this app. Dad does not need this developer signup and keeps his MSN mailbox. After signup, select your own directory in Entra, not Microsoft Services.
1. Open https://entra.microsoft.com/, select **Entra ID → App registrations → New registration**.
2. Name: **Hermitage Invoice App**. Supported accounts: **Personal Microsoft accounts only**.
3. Register. Copy the **Application (client) ID** from Overview. This GUID is public, not a secret.
4. **Authentication → Add a platform → Mobile and desktop applications**. Register **http://localhost** for the system-browser return. The native listener uses a temporary local port; Microsoft ignores the port for this localhost desktop redirect.
5. **API permissions → Add a permission → Microsoft Graph → Delegated permissions**. Add **User.Read** and **Mail.Send**. The app also requests **offline_access** to keep Dad signed in. Do not use application permissions or a client secret.
6. The owner registered public client ID `d563fb98-c2e8-4d5a-a35f-4c9630949ddc` on 2026-09-30; this is the default for this app. Dad only needs **Connecter Outlook**. To change registration, edit the GUID in **Courriel Outlook → Configuration avancée · Propriétaire**, then save. Builds may override the default with `HERMITAGE_OUTLOOK_CLIENT_ID`.
7. Click **Connecter Outlook** and finish Microsoft sign-in and consent in the browser. Return to the app; it updates the connected sender.
8. Save the accountant's email in the same settings window. The company signature is already filled in with the approved mockup: **Ébénisterie de l’Hermitage inc.**, then **(819) 428-7690 · Ripon, Québec**. It remains editable. The accountant defaults to CC on invoices and is not added to quotes unless Dad chooses it. CC remains editable per email.

Microsoft's registration guide lists an Azure account with active subscription, a tenant, and application-registration permissions as prerequisites. If the portal blocks registration, report the exact page; a mail app cannot legitimately invent a registration or borrow another application's identity.

Changing accounts uses Microsoft's account picker. Disconnect clears this app's local credentials, rather than claiming to sign the user out of every Microsoft service.

## Sending

Client email is optional for Save/Print, required for Send. Dad reviews To, CC, subject, message, signature and PDF, then clicks Send. The app archives the PDF in the selected output folder before submission, preserving prior copies and the issued invoice number. A sending failure leaves the saved PDF available. Outlook acceptance is shown separately from confirmed delivery. If a network interruption makes submission uncertain, check Outlook Sent Items before composing another send to avoid duplicates.

## Official references

- Registration: https://learn.microsoft.com/en-us/entra/identity-platform/quickstart-register-app
- Personal-account portal error and developer tenant setup: https://learn.microsoft.com/en-us/troubleshoot/entra/entra-id/app-integration/error-code-AADSTS50020-user-account-identity-provider-does-not-exist
- OAuth code/PKCE: https://learn.microsoft.com/en-us/entra/identity-platform/v2-oauth2-auth-code-flow
- Desktop redirect rules: https://learn.microsoft.com/en-us/entra/identity-platform/reply-url
- Send with file attachment / Mail.Send personal-account permission: https://learn.microsoft.com/en-us/graph/api/user-sendmail?view=graph-rest-1.0
