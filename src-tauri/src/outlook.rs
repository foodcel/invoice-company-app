//! Personal Outlook public-client OAuth and at-most-once Graph submission.
//! No credentials, authorization URLs, or provider response bodies cross the IPC boundary.
use base64::{
    engine::general_purpose::{STANDARD, URL_SAFE_NO_PAD},
    Engine,
};
use chrono::Utc;
use fs2::FileExt;
use reqwest::{Client, Url};
use serde::{Deserialize, Serialize};
use serde_json::json;
use sha2::{Digest, Sha256};
use std::{
    collections::{BTreeMap, HashSet},
    fs::{self, OpenOptions},
    io::Read,
    path::{Path, PathBuf},
    sync::{Mutex, MutexGuard, OnceLock},
    time::Duration,
};
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::{TcpListener, TcpStream},
    sync::watch,
};
use uuid::Uuid;

const AUTHORIZE: &str = "https://login.microsoftonline.com/consumers/oauth2/v2.0/authorize";
const TOKEN: &str = "https://login.microsoftonline.com/consumers/oauth2/v2.0/token";
const ME: &str = "https://graph.microsoft.com/v1.0/me?$select=id,mail,userPrincipalName";
const SEND: &str = "https://graph.microsoft.com/v1.0/me/sendMail";
const SCOPES: &str = "Mail.Send User.Read offline_access";
const LOGIN_SECONDS: u64 = 300;
const MAX_PDF: usize = 3_000_000; // Strictly less than 3 MB, including at the boundary.
const MAX_WIRE: usize = 4_000_000; // Base64 plus the entire message must also fit.
const MAX_RECIPIENTS: usize = 100;
const MAX_BODY: usize = 100_000;
const MAX_SUBJECT: usize = 998;
const MAX_PRIVATE: usize = 512_000;
const MAX_JOURNAL: usize = 16_000_000;
const MAX_ATTEMPTS: usize = 20_000;
const AMBIGUOUS: &str = "Résultat d’envoi incertain. Vérifiez les éléments envoyés dans Outlook avant de décider d’un nouvel envoi. Cette tentative ne sera pas renvoyée automatiquement.";

static DIRECTORY: OnceLock<PathBuf> = OnceLock::new();
static STATE: Mutex<State> = Mutex::new(State {
    generation: 0,
    pending: None,
    error: None,
});
// Serializes refresh and sending in this process, never held by sync settings commands.
static SEND_LOCK: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

struct State {
    generation: u64,
    pending: Option<Pending>,
    error: Option<String>,
}
struct Pending {
    id: Uuid,
    cancel: watch::Sender<bool>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MailSettings {
    pub client_id: String,
    pub accountant_email: String,
    pub signature: String,
    pub connected: bool,
    pub sender_email: Option<String>,
    pub auth_pending: bool,
    pub auth_error: Option<String>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SendRequest {
    pub attempt_id: String,
    pub to: Vec<String>,
    pub cc: Vec<String>,
    pub subject: String,
    pub body: String,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SendReceipt {
    pub sender_email: String,
    pub accepted_at: String,
    pub attempt_id: String,
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct StoredSettings {
    client_id: String,
    accountant_email: String,
    signature: String,
}

impl Default for StoredSettings {
    fn default() -> Self {
        Self {
            client_id: String::new(),
            accountant_email: String::new(),
            signature: "Ébénisterie de l’Hermitage inc.\n(819) 428-7690 · Ripon, Québec".into(),
        }
    }
}

// Deliberately not Debug and never part of a public return value.
#[derive(Serialize, Deserialize)]
struct Credentials {
    client_id: String,
    subject: String,
    sender_email: String,
    access_token: String,
    refresh_token: String,
    expires_at: i64,
    scope: String,
}

#[derive(Deserialize)]
struct TokenResponse {
    access_token: String,
    #[serde(default)]
    refresh_token: String,
    token_type: String,
    expires_in: u64,
    scope: Option<String>,
}

#[derive(Deserialize)]
struct Identity {
    id: String,
    mail: Option<String>,
    #[serde(rename = "userPrincipalName")]
    user_principal_name: Option<String>,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
enum AttemptStatus {
    Transmitting,
    Accepted,
    Rejected,
    Ambiguous,
}

#[derive(Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct AttemptRecord {
    fingerprint: String,
    status: AttemptStatus,
    receipt: Option<SendReceipt>,
    created_at: String,
}

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Journal {
    version: u32,
    attempts: BTreeMap<String, AttemptRecord>,
}
impl Default for Journal {
    fn default() -> Self {
        Self {
            version: 1,
            attempts: BTreeMap::new(),
        }
    }
}

pub fn configure(directory: PathBuf) {
    // The caller supplies a dedicated Outlook directory inside the application's private data.
    let _ = DIRECTORY.set(directory);
}

fn state() -> Result<MutexGuard<'static, State>, String> {
    STATE
        .lock()
        .map_err(|_| "Connexion Outlook indisponible.".into())
}
fn path(name: &str) -> Result<PathBuf, String> {
    let directory = DIRECTORY.get().ok_or("Outlook n’est pas initialisé.")?;
    fs::create_dir_all(directory).map_err(|_| "Création du dossier Outlook impossible.")?;
    Ok(directory.join(name))
}

fn read_bounded(path: &Path, limit: usize) -> Result<Option<Vec<u8>>, String> {
    let file = match fs::File::open(path) {
        Ok(file) => file,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(_) => return Err("Lecture des données Outlook impossible.".into()),
    };
    let mut bytes = Vec::new();
    file.take(limit as u64 + 1)
        .read_to_end(&mut bytes)
        .map_err(|_| "Lecture des données Outlook impossible.")?;
    if bytes.len() > limit {
        return Err("Données Outlook trop volumineuses.".into());
    }
    Ok(Some(bytes))
}

fn write_json<T: Serialize>(name: &str, value: &T) -> Result<(), String> {
    let bytes = serde_json::to_vec(value).map_err(|_| "Données Outlook invalides.")?;
    crate::atomic_replace(&path(name)?, &bytes)
        .map_err(|_| "Enregistrement des données Outlook impossible.".into())
}

fn guid(value: &str) -> Result<String, String> {
    if value.len() != 36 {
        return Err(
            "L’identifiant client Outlook doit être le GUID de votre application Microsoft.".into(),
        );
    }
    let parsed = Uuid::parse_str(value).map_err(|_| "Identifiant client Outlook invalide.")?;
    if parsed.is_nil()
        || parsed.is_max()
        || !parsed.hyphenated().to_string().eq_ignore_ascii_case(value)
    {
        return Err("Identifiant client Outlook invalide.".into());
    }
    Ok(parsed.hyphenated().to_string())
}

fn registration() -> Result<StoredSettings, String> {
    if let Some(bytes) = read_bounded(&path("settings.json")?, 32_000)? {
        let mut settings: StoredSettings =
            serde_json::from_slice(&bytes).map_err(|_| "Réglages Outlook illisibles.")?;
        if !settings.client_id.is_empty() {
            settings.client_id = guid(&settings.client_id)?;
        }
        validate_preferences(&settings.accountant_email, &settings.signature)?;
        return Ok(settings);
    }
    // Public registration ID only; never a borrowed or invented application ID.
    let configured = std::env::var("HERMITAGE_OUTLOOK_CLIENT_ID")
        .ok()
        .or_else(|| std::env::var("OUTLOOK_CLIENT_ID").ok())
        .or_else(|| option_env!("HERMITAGE_OUTLOOK_CLIENT_ID").map(str::to_owned))
        .or_else(|| option_env!("OUTLOOK_CLIENT_ID").map(str::to_owned))
        // Owner-created public registration; supplied during setup on 2026-09-30.
        .or_else(|| Some("d563fb98-c2e8-4d5a-a35f-4c9630949ddc".to_owned()));
    let client_id = match configured {
        Some(id) if !id.trim().is_empty() => guid(id.trim())?,
        _ => String::new(),
    };
    Ok(StoredSettings {
        client_id,
        ..Default::default()
    })
}

fn validate_preferences(email: &str, signature: &str) -> Result<(), String> {
    if !email.is_empty() {
        validate_email(email)?;
    }
    if signature.len() > 16_000
        || signature
            .chars()
            .any(|c| c.is_control() && !matches!(c, '\n' | '\r' | '\t'))
    {
        return Err("Signature trop longue ou invalide.".into());
    }
    Ok(())
}

fn settings_locked(state: &State) -> Result<MailSettings, String> {
    let settings = registration()?;
    let credentials = read_credentials();
    let credential_error = credentials.as_ref().err().cloned();
    let credentials = credentials
        .ok()
        .flatten()
        .filter(|c| c.client_id == settings.client_id);
    Ok(MailSettings {
        client_id: settings.client_id,
        accountant_email: settings.accountant_email,
        signature: settings.signature,
        connected: credentials.is_some(),
        sender_email: credentials.map(|c| c.sender_email),
        auth_pending: state.pending.is_some(),
        auth_error: state.error.clone().or(credential_error),
    })
}

pub fn settings() -> Result<MailSettings, String> {
    let state = state()?;
    settings_locked(&state)
}

fn cancel_locked(state: &mut State) {
    state.generation = state.generation.wrapping_add(1);
    if let Some(pending) = state.pending.take() {
        let _ = pending.cancel.send(true);
    }
    state.error = None;
}

fn remove_credentials() -> Result<(), String> {
    match fs::remove_file(path("tokens.dpapi")?) {
        Ok(()) => Ok(()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(_) => Err("Suppression de la connexion Outlook impossible.".into()),
    }
}

pub fn save_settings(
    client_id: String,
    accountant_email: String,
    signature: String,
) -> Result<MailSettings, String> {
    let client_id = if client_id.trim().is_empty() {
        String::new()
    } else {
        guid(client_id.trim())?
    };
    let accountant_email = accountant_email.trim().to_owned();
    validate_preferences(&accountant_email, &signature)?;
    let mut state = state()?;
    // A bad optional environment ID must not prevent the owner correcting it through settings.
    let previous = registration();
    if previous.as_ref().map(|p| p.client_id.as_str()).ok() != Some(client_id.as_str()) {
        cancel_locked(&mut state);
        // Remove credentials first: any subsequent write failure remains safely disconnected.
        remove_credentials()?;
    }
    write_json(
        "settings.json",
        &StoredSettings {
            client_id,
            accountant_email,
            signature,
        },
    )?;
    settings_locked(&state)
}

pub fn cancel_login() -> Result<MailSettings, String> {
    let mut state = state()?;
    cancel_locked(&mut state);
    settings_locked(&state)
}

pub async fn disconnect() -> Result<MailSettings, String> {
    let mut state = state()?;
    cancel_locked(&mut state);
    remove_credentials()?;
    // Local deletion only. The user's browser/Microsoft sessions are not revoked.
    settings_locked(&state)
}

#[cfg(windows)]
fn protect(bytes: &[u8], decrypt: bool) -> Result<Vec<u8>, String> {
    use windows_sys::Win32::{
        Foundation::LocalFree,
        Security::Cryptography::{
            CryptProtectData, CryptUnprotectData, CRYPTPROTECT_UI_FORBIDDEN, CRYPT_INTEGER_BLOB,
        },
    };
    if bytes.is_empty() || bytes.len() > MAX_PRIVATE {
        return Err("Identifiants Outlook invalides.".into());
    }
    let input = CRYPT_INTEGER_BLOB {
        cbData: bytes.len() as u32,
        pbData: bytes.as_ptr() as *mut u8,
    };
    let entropy_bytes = b"invoice-company-app/outlook/v1";
    let entropy = CRYPT_INTEGER_BLOB {
        cbData: entropy_bytes.len() as u32,
        pbData: entropy_bytes.as_ptr() as *mut u8,
    };
    let mut output = CRYPT_INTEGER_BLOB {
        cbData: 0,
        pbData: std::ptr::null_mut(),
    };
    // Current Windows user, never CRYPTPROTECT_LOCAL_MACHINE. The entropy is namespace binding,
    // not a secret. Both the primary file and atomic-replace temporary files contain ciphertext.
    let ok = unsafe {
        if decrypt {
            CryptUnprotectData(
                &input,
                std::ptr::null_mut(),
                &entropy,
                std::ptr::null(),
                std::ptr::null(),
                CRYPTPROTECT_UI_FORBIDDEN,
                &mut output,
            )
        } else {
            CryptProtectData(
                &input,
                std::ptr::null(),
                &entropy,
                std::ptr::null(),
                std::ptr::null(),
                CRYPTPROTECT_UI_FORBIDDEN,
                &mut output,
            )
        }
    };
    if ok == 0 {
        return Err("Windows ne peut pas protéger ou ouvrir la connexion Outlook.".into());
    }
    let valid =
        !output.pbData.is_null() && output.cbData > 0 && output.cbData as usize <= MAX_PRIVATE;
    let result = if valid {
        Ok(unsafe { std::slice::from_raw_parts(output.pbData, output.cbData as usize).to_vec() })
    } else {
        Err("Identifiants Outlook protégés invalides.".into())
    };
    unsafe {
        LocalFree(output.pbData as *mut _);
    }
    result
}

#[cfg(not(windows))]
fn protect(_: &[u8], _: bool) -> Result<Vec<u8>, String> {
    Err("La connexion Outlook protégée exige Windows.".into())
}

fn read_credentials() -> Result<Option<Credentials>, String> {
    let Some(bytes) = read_bounded(&path("tokens.dpapi")?, MAX_PRIVATE)? else {
        return Ok(None);
    };
    let credentials: Credentials = serde_json::from_slice(&protect(&bytes, true)?)
        .map_err(|_| "Connexion Outlook enregistrée illisible.")?;
    guid(&credentials.client_id)?;
    validate_email(&credentials.sender_email)?;
    validate_scopes(&credentials.scope)?;
    if credentials.subject.is_empty()
        || !valid_token(&credentials.access_token)
        || !valid_token(&credentials.refresh_token)
    {
        return Err("Connexion Outlook enregistrée invalide.".into());
    }
    Ok(Some(credentials))
}

fn save_credentials(credentials: &Credentials) -> Result<(), String> {
    let bytes = serde_json::to_vec(credentials).map_err(|_| "Identifiants Outlook invalides.")?;
    let protected = protect(&bytes, false)?;
    crate::atomic_replace(&path("tokens.dpapi")?, &protected)
        .map_err(|_| "Enregistrement de la connexion Outlook impossible.".into())
}

fn client() -> Result<Client, String> {
    Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .retry(reqwest::retry::never())
        .connect_timeout(Duration::from_secs(10))
        .timeout(Duration::from_secs(45))
        .user_agent("invoice-company-app/outlook")
        .build()
        .map_err(|_| "Service Outlook indisponible.".into())
}

async fn response_json<T: serde::de::DeserializeOwned>(
    mut response: reqwest::Response,
) -> Result<T, String> {
    let status = response.status();
    if !status.is_success() {
        // Provider text can echo credentials or message contents. Do not forward it or log it.
        return Err(format!("Microsoft a refusé la demande (HTTP {}). Vérifiez l’inscription ou reconnectez Outlook.", status.as_u16()));
    }
    let mut bytes = Vec::new();
    while let Some(chunk) = response
        .chunk()
        .await
        .map_err(|_| "Réponse Microsoft interrompue.")?
    {
        if bytes.len() + chunk.len() > MAX_PRIVATE {
            return Err("Réponse Microsoft trop volumineuse.".into());
        }
        bytes.extend_from_slice(&chunk);
    }
    serde_json::from_slice(&bytes).map_err(|_| "Réponse Microsoft invalide.".into())
}

fn validate_scopes(scope: &str) -> Result<(), String> {
    if scope.len() > 4096 {
        return Err("Autorisations Outlook invalides.".into());
    }
    let mut send = false;
    let mut user = false;
    for scope in scope.split_ascii_whitespace() {
        let scope = scope.to_ascii_lowercase();
        let name = scope
            .strip_prefix("https://graph.microsoft.com/")
            .unwrap_or(&scope);
        match name {
            "mail.send" => send = true,
            "user.read" => user = true,
            "offline_access" | "openid" | "profile" | "email" => {},
            _ => return Err("Autorisations Outlook inattendues. Reconnectez Outlook avec Mail.Send et User.Read.".into()),
        }
    }
    if !send || !user {
        return Err("Les autorisations Mail.Send et User.Read sont nécessaires.".into());
    }
    // offline_access is explicitly REQUESTED; its grant is evidenced by a refresh token.
    // Microsoft does not always echo it in the access-token scope string.
    Ok(())
}

fn valid_token(token: &str) -> bool {
    !token.is_empty() && token.len() <= 128_000 && !token.chars().any(char::is_control)
}

fn apply_tokens(
    tokens: TokenResponse,
    client_id: String,
    previous: Option<&Credentials>,
) -> Result<Credentials, String> {
    if !tokens.token_type.eq_ignore_ascii_case("Bearer")
        || !valid_token(&tokens.access_token)
        || tokens.expires_in == 0
        || tokens.expires_in > 86_400
    {
        return Err("Jeton Outlook invalide.".into());
    }
    let scope = tokens
        .scope
        .or_else(|| previous.map(|p| p.scope.clone()))
        .ok_or("Autorisations Microsoft absentes.")?;
    validate_scopes(&scope)?;
    let refresh_token = if tokens.refresh_token.is_empty() {
        previous
            .map(|p| p.refresh_token.clone())
            .unwrap_or_default()
    } else {
        tokens.refresh_token
    };
    if !valid_token(&refresh_token) {
        return Err(
            "Microsoft n’a pas accordé l’accès hors connexion. Reconnectez Outlook.".into(),
        );
    }
    Ok(Credentials {
        client_id,
        subject: previous.map(|p| p.subject.clone()).unwrap_or_default(),
        sender_email: previous.map(|p| p.sender_email.clone()).unwrap_or_default(),
        access_token: tokens.access_token,
        refresh_token,
        expires_at: Utc::now().timestamp() + tokens.expires_in as i64,
        scope,
    })
}

async fn identity(client: &Client, credentials: &mut Credentials) -> Result<(), String> {
    let response = client
        .get(ME)
        .bearer_auth(&credentials.access_token)
        .send()
        .await
        .map_err(|_| "Lecture du compte Outlook impossible.")?;
    let me: Identity = response_json(response).await?;
    if me.id.is_empty() || me.id.len() > 512 {
        return Err("Identité Microsoft invalide.".into());
    }
    if !credentials.subject.is_empty() && credentials.subject != me.id {
        return Err("Le compte Microsoft a changé. Reconnectez Outlook.".into());
    }
    let sender = me
        .mail
        .filter(|email| validate_email(email).is_ok())
        .or_else(|| {
            me.user_principal_name
                .filter(|email| validate_email(email).is_ok())
        })
        .ok_or("Ce compte Microsoft ne fournit pas d’adresse Outlook utilisable.")?;
    credentials.subject = me.id;
    credentials.sender_email = sender;
    Ok(())
}

fn random_secret() -> String {
    let mut bytes = [0u8; 32];
    bytes[..16].copy_from_slice(Uuid::new_v4().as_bytes());
    bytes[16..].copy_from_slice(Uuid::new_v4().as_bytes());
    URL_SAFE_NO_PAD.encode(bytes)
}
fn challenge(verifier: &str) -> String {
    URL_SAFE_NO_PAD.encode(Sha256::digest(verifier.as_bytes()))
}

fn authorization_url(
    client_id: &str,
    redirect: &str,
    state: &str,
    verifier: &str,
) -> Result<Url, String> {
    let mut url = Url::parse(AUTHORIZE).map_err(|_| "Adresse Microsoft invalide.")?;
    url.query_pairs_mut().extend_pairs([
        ("client_id", client_id),
        ("response_type", "code"),
        ("redirect_uri", redirect),
        ("response_mode", "query"),
        ("scope", SCOPES),
        ("state", state),
        ("code_challenge", &challenge(verifier)),
        ("code_challenge_method", "S256"),
        ("prompt", "select_account"),
    ]);
    Ok(url)
}

#[cfg(windows)]
fn open_browser(url: &Url) -> Result<(), String> {
    use windows_sys::Win32::UI::{Shell::ShellExecuteW, WindowsAndMessaging::SW_SHOWNORMAL};
    let verb: Vec<u16> = "open\0".encode_utf16().collect();
    let target: Vec<u16> = url.as_str().encode_utf16().chain(Some(0)).collect();
    let result = unsafe {
        ShellExecuteW(
            std::ptr::null_mut(),
            verb.as_ptr(),
            target.as_ptr(),
            std::ptr::null(),
            std::ptr::null(),
            SW_SHOWNORMAL,
        )
    };
    if result as isize <= 32 {
        return Err("Impossible d’ouvrir le navigateur pour Outlook.".into());
    }
    Ok(())
}
#[cfg(not(windows))]
fn open_browser(_: &Url) -> Result<(), String> {
    Err("La connexion Outlook exige Windows.".into())
}

async fn cancelled(cancel: &mut watch::Receiver<bool>) {
    loop {
        if *cancel.borrow() {
            return;
        }
        if cancel.changed().await.is_err() {
            return;
        }
    }
}

async fn bounded_login<F, T>(
    cancel: &mut watch::Receiver<bool>,
    duration: Duration,
    future: F,
) -> Result<T, String>
where
    F: std::future::Future<Output = Result<T, String>>,
{
    tokio::select! {
        biased;
        _ = cancelled(cancel) => Err("Connexion Outlook annulée.".into()),
        result = tokio::time::timeout(duration, future) => result.map_err(|_| "Le délai de connexion Outlook a expiré. Réessayez la connexion.")?,
    }
}

pub async fn start_login() -> Result<MailSettings, String> {
    let client_id = {
        let state = state()?;
        if state.pending.is_some() {
            return settings_locked(&state);
        }
        let id = registration()?.client_id;
        if id.is_empty() {
            return Err("Enregistrez d’abord l’identifiant client de votre application Microsoft dans les réglages Outlook.".into());
        }
        id
    };
    // Register http://localhost as a Mobile/Desktop redirect; Microsoft ignores its ephemeral port.
    // The socket itself is explicitly IPv4 loopback, never all interfaces.
    let listener = TcpListener::bind((std::net::Ipv4Addr::LOCALHOST, 0))
        .await
        .map_err(|_| "Ouverture du retour local Outlook impossible.")?;
    let port = listener
        .local_addr()
        .map_err(|_| "Adresse de retour Outlook indisponible.")?
        .port();
    let redirect = format!("http://localhost:{port}/");
    let secret_state = random_secret();
    let verifier = random_secret();
    let url = authorization_url(&client_id, &redirect, &secret_state, &verifier)?;
    let id = Uuid::new_v4();
    let (cancel, mut receiver) = watch::channel(false);
    let generation = {
        let mut state = state()?;
        if state.pending.is_some() {
            return settings_locked(&state);
        }
        if registration()?.client_id != client_id {
            return Err("L’inscription Outlook a changé. Relancez la connexion.".into());
        }
        state.generation = state.generation.wrapping_add(1);
        state.error = None;
        state.pending = Some(Pending { id, cancel });
        state.generation
    };
    if let Err(error) = open_browser(&url) {
        let mut state = state()?;
        if state.pending.as_ref().is_some_and(|p| p.id == id) {
            state.pending = None;
            state.error = Some(error.clone());
        }
        return Err(error);
    }
    // Return authPending immediately; settings() polls completion. Cancellation also covers token
    // exchange and /me, so a late callback or response cannot resurrect disconnected credentials.
    tokio::spawn(async move {
        let result = bounded_login(&mut receiver, Duration::from_secs(LOGIN_SECONDS), async {
            let code = callback(listener, port, &secret_state).await?;
            let client = client()?;
            let response = client
                .post(TOKEN)
                .form(&[
                    ("client_id", client_id.as_str()),
                    ("grant_type", "authorization_code"),
                    ("code", code.as_str()),
                    ("redirect_uri", redirect.as_str()),
                    ("code_verifier", verifier.as_str()),
                    ("scope", SCOPES),
                ])
                .send()
                .await
                .map_err(|_| "Échange de connexion Outlook interrompu. Relancez la connexion.")?;
            let tokens: TokenResponse = response_json(response).await?;
            let mut credentials = apply_tokens(tokens, client_id.clone(), None)?;
            identity(&client, &mut credentials).await?;
            Ok(credentials)
        })
        .await;
        if let Ok(mut state) = state() {
            if state.generation != generation || !state.pending.as_ref().is_some_and(|p| p.id == id)
            {
                return;
            }
            let result = result.and_then(|credentials| {
                if registration()?.client_id != credentials.client_id {
                    return Err("L’inscription Outlook a changé.".into());
                }
                save_credentials(&credentials)
            });
            state.pending = None;
            state.error = result.err();
        }
    });
    settings()
}

fn same_state(actual: &str, expected: &str) -> bool {
    if actual.len() != expected.len() {
        return false;
    }
    actual
        .bytes()
        .zip(expected.bytes())
        .fold(0u8, |difference, (a, b)| difference | (a ^ b))
        == 0
}

fn decode_query(value: &str) -> Result<String, String> {
    let bytes = value.as_bytes();
    let mut decoded = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        match bytes[i] {
            b'%' => {
                let pair = bytes.get(i + 1..i + 3).ok_or("Retour Outlook invalide.")?;
                let digit = |b: u8| match b {
                    b'0'..=b'9' => Some(b - b'0'),
                    b'a'..=b'f' => Some(b - b'a' + 10),
                    b'A'..=b'F' => Some(b - b'A' + 10),
                    _ => None,
                };
                decoded.push(
                    digit(pair[0]).ok_or("Retour Outlook invalide.")? * 16
                        + digit(pair[1]).ok_or("Retour Outlook invalide.")?,
                );
                i += 3;
            }
            b'+' => {
                decoded.push(b' ');
                i += 1;
            }
            b => {
                decoded.push(b);
                i += 1;
            }
        }
    }
    let value = String::from_utf8(decoded).map_err(|_| "Retour Outlook invalide.")?;
    if value.chars().any(char::is_control) {
        return Err("Retour Outlook invalide.".into());
    }
    Ok(value)
}

#[derive(Debug, PartialEq, Eq)]
enum Callback {
    Code(String),
    Denied,
}

fn parse_callback(target: &str, expected_state: &str) -> Result<Callback, String> {
    if target.len() > 12_000 || target.contains('#') {
        return Err("Retour Outlook invalide.".into());
    }
    let (route, query) = target.split_once('?').ok_or("Retour Outlook invalide.")?;
    if route != "/" {
        return Err("Retour Outlook invalide.".into());
    }
    let mut parameters = BTreeMap::new();
    for pair in query.split('&') {
        if parameters.len() >= 24 {
            return Err("Retour Outlook invalide.".into());
        }
        let (key, value) = pair.split_once('=').ok_or("Retour Outlook invalide.")?;
        let key = decode_query(key)?;
        let value = decode_query(value)?;
        if parameters.insert(key, value).is_some() {
            return Err("Paramètre de retour Outlook dupliqué.".into());
        }
    }
    if !parameters
        .get("state")
        .is_some_and(|state| same_state(state, expected_state))
    {
        return Err("État de connexion Outlook invalide.".into());
    }
    match (parameters.get("code"), parameters.get("error")) {
        (Some(code), None) if !code.is_empty() && code.len() <= 8192 => {
            Ok(Callback::Code(code.clone()))
        }
        (None, Some(error)) if !error.is_empty() => Ok(Callback::Denied),
        _ => Err("Retour Outlook invalide.".into()),
    }
}

async fn read_callback(
    stream: &mut TcpStream,
    port: u16,
    expected_state: &str,
) -> Result<Callback, String> {
    let mut bytes = Vec::new();
    let mut buffer = [0u8; 1024];
    loop {
        let count = stream
            .read(&mut buffer)
            .await
            .map_err(|_| "Retour Outlook interrompu.")?;
        if count == 0 {
            return Err("Retour Outlook incomplet.".into());
        }
        bytes.extend_from_slice(&buffer[..count]);
        if bytes.len() > 16_384 {
            return Err("Retour Outlook trop volumineux.".into());
        }
        if bytes.windows(4).any(|w| w == b"\r\n\r\n") {
            break;
        }
    }
    let text = std::str::from_utf8(&bytes).map_err(|_| "Retour Outlook invalide.")?;
    let mut lines = text.split("\r\n");
    let request = lines.next().ok_or("Retour Outlook invalide.")?;
    let parts: Vec<_> = request.split(' ').collect();
    if parts.len() != 3 || parts[0] != "GET" || !matches!(parts[2], "HTTP/1.1" | "HTTP/1.0") {
        return Err("Retour Outlook invalide.".into());
    }
    let mut host = None;
    for line in lines.take_while(|line| !line.is_empty()) {
        let (key, value) = line.split_once(':').ok_or("Retour Outlook invalide.")?;
        if key.eq_ignore_ascii_case("host") {
            if host.replace(value.trim()).is_some() {
                return Err("Retour Outlook invalide.".into());
            }
        }
        if key.eq_ignore_ascii_case("transfer-encoding")
            || (key.eq_ignore_ascii_case("content-length") && value.trim() != "0")
        {
            return Err("Retour Outlook invalide.".into());
        }
    }
    if host != Some(format!("localhost:{port}").as_str()) {
        return Err("Hôte de retour Outlook invalide.".into());
    }
    parse_callback(parts[1], expected_state)
}

async fn callback(
    listener: TcpListener,
    port: u16,
    expected_state: &str,
) -> Result<String, String> {
    loop {
        let (mut stream, peer) = listener
            .accept()
            .await
            .map_err(|_| "Retour Outlook indisponible.")?;
        if !peer.ip().is_loopback() {
            continue;
        }
        let result = tokio::time::timeout(
            Duration::from_secs(3),
            read_callback(&mut stream, port, expected_state),
        )
        .await;
        let valid = matches!(&result, Ok(Ok(_)));
        let (status, body) = if valid {
            (
                "200 OK",
                "Retour Outlook reçu. Vous pouvez revenir à l’application.",
            )
        } else {
            ("400 Bad Request", "Retour de connexion invalide.")
        };
        let response = format!("HTTP/1.1 {status}\r\nContent-Type: text/plain; charset=utf-8\r\nContent-Length: {}\r\nCache-Control: no-store\r\nReferrer-Policy: no-referrer\r\nContent-Security-Policy: default-src 'none'; frame-ancestors 'none'\r\nX-Content-Type-Options: nosniff\r\nConnection: close\r\n\r\n{body}", body.len());
        let _ = tokio::time::timeout(
            Duration::from_secs(2),
            stream.write_all(response.as_bytes()),
        )
        .await;
        match result {
            Ok(Ok(Callback::Code(code))) => return Ok(code),
            Ok(Ok(Callback::Denied)) => {
                return Err("La connexion ou les autorisations Outlook ont été refusées.".into())
            }
            _ => continue, // Bad state, favicon, or unsolicited local request cannot finish login.
        }
    }
}

async fn ready_credentials(client: &Client) -> Result<(Credentials, u64), String> {
    let (mut credentials, generation) = {
        let state = state()?;
        if state.pending.is_some() {
            return Err("Terminez la connexion Outlook avant l’envoi.".into());
        }
        let credentials = read_credentials()?.ok_or("Connectez Outlook avant l’envoi.")?;
        if credentials.client_id != registration()?.client_id {
            return Err("L’inscription Outlook a changé. Reconnectez Outlook.".into());
        }
        (credentials, state.generation)
    };
    if credentials.expires_at <= Utc::now().timestamp() + 120 {
        let response = client
            .post(TOKEN)
            .form(&[
                ("client_id", credentials.client_id.as_str()),
                ("grant_type", "refresh_token"),
                ("refresh_token", credentials.refresh_token.as_str()),
                ("scope", SCOPES),
            ])
            .send()
            .await
            .map_err(|_| "Actualisation Outlook interrompue. Aucun message n’a été envoyé.")?;
        let tokens: TokenResponse = response_json(response).await?;
        credentials = apply_tokens(tokens, credentials.client_id.clone(), Some(&credentials))?;
        identity(client, &mut credentials).await?;
        let mut state = state()?;
        if state.generation != generation || registration()?.client_id != credentials.client_id {
            return Err("La connexion Outlook a changé. Aucun message n’a été envoyé.".into());
        }
        save_credentials(&credentials)?;
        state.error = None;
    }
    Ok((credentials, generation))
}

fn validate_email(email: &str) -> Result<(), String> {
    let invalid = || {
        "Adresse courriel invalide. Utilisez une adresse seule, sans nom ni séparateur.".to_owned()
    };
    if email.len() > 254
        || !email.is_ascii()
        || email
            .bytes()
            .any(|b| b.is_ascii_whitespace() || b.is_ascii_control())
    {
        return Err(invalid());
    }
    let (local, domain) = email.split_once('@').ok_or_else(invalid)?;
    if local.is_empty()
        || local.len() > 64
        || local.starts_with('.')
        || local.ends_with('.')
        || local.contains("..")
        || !local
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b".!#$%&'*+-/=?^_`{|}~".contains(&b))
    {
        return Err(invalid());
    }
    if domain.len() > 253 || !domain.contains('.') {
        return Err(invalid());
    }
    for label in domain.split('.') {
        if label.is_empty()
            || label.len() > 63
            || label.starts_with('-')
            || label.ends_with('-')
            || !label
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || b == b'-')
        {
            return Err(invalid());
        }
    }
    let tld = domain.rsplit('.').next().unwrap_or_default();
    if tld.len() < 2 || !tld.bytes().any(|b| b.is_ascii_alphabetic()) {
        return Err(invalid());
    }
    Ok(())
}

fn validate_request(request: &mut SendRequest, filename: &str, pdf: &[u8]) -> Result<(), String> {
    request.attempt_id =
        guid(&request.attempt_id).map_err(|_| "Identifiant de tentative invalide.")?;
    if request.to.is_empty() || request.to.len() + request.cc.len() > MAX_RECIPIENTS {
        return Err(
            "Ajoutez au moins un destinataire, avec un maximum de 100 adresses au total.".into(),
        );
    }
    let mut seen = HashSet::new();
    for address in request.to.iter_mut().chain(request.cc.iter_mut()) {
        *address = address.trim().to_owned();
        validate_email(address)?;
        if !seen.insert(address.to_ascii_lowercase()) {
            return Err("Une adresse est présente plusieurs fois dans À ou CC.".into());
        }
    }
    if request.subject.trim().is_empty()
        || request.subject.len() > MAX_SUBJECT
        || request.subject.chars().any(char::is_control)
    {
        return Err("Objet vide, trop long ou invalide.".into());
    }
    if request.body.trim().is_empty()
        || request.body.len() > MAX_BODY
        || request
            .body
            .chars()
            .any(|c| c.is_control() && !matches!(c, '\n' | '\r' | '\t'))
    {
        return Err("Message vide, trop long ou invalide.".into());
    }
    if filename.is_empty()
        || filename.len() > 180
        || filename
            .chars()
            .any(|c| c.is_control() || "<>:\"/\\|?*".contains(c))
        || filename.ends_with('.')
        || filename.ends_with(' ')
        || !filename.to_ascii_lowercase().ends_with(".pdf")
    {
        return Err("Nom de fichier PDF invalide.".into());
    }
    if pdf.len() >= MAX_PDF {
        return Err("Le PDF doit faire moins de 3 Mo pour être joint à ce courriel.".into());
    }
    if pdf.len() < 12
        || !pdf.starts_with(b"%PDF-")
        || !pdf[pdf.len().saturating_sub(1024)..]
            .windows(5)
            .any(|w| w == b"%%EOF")
    {
        return Err("La pièce jointe n’est pas un PDF complet.".into());
    }
    Ok(())
}

fn payload(request: &SendRequest, filename: &str, pdf: &[u8]) -> Result<Vec<u8>, String> {
    let recipients = |list: &[String]| {
        list.iter()
            .map(|email| json!({"emailAddress": {"address": email}}))
            .collect::<Vec<_>>()
    };
    let value = json!({
        "message": {
            "subject": request.subject,
            "body": {"contentType": "Text", "content": request.body},
            "toRecipients": recipients(&request.to), "ccRecipients": recipients(&request.cc),
            "attachments": [{"@odata.type": "#microsoft.graph.fileAttachment", "name": filename,
                "contentType": "application/pdf", "contentBytes": STANDARD.encode(pdf)}]
        }, "saveToSentItems": true
    });
    // No client-controlled from/sender, HTML, attachment paths, or arbitrary-file reads.
    let bytes = serde_json::to_vec(&value).map_err(|_| "Message Outlook invalide.")?;
    if bytes.len() >= MAX_WIRE {
        return Err(
            "Le courriel et son PDF dépassent la taille autorisée. Réduisez le PDF ou le texte."
                .into(),
        );
    }
    Ok(bytes)
}

fn fingerprint(request: &SendRequest, filename: &str, pdf: &[u8]) -> Result<String, String> {
    let mut hasher = Sha256::new();
    let request = serde_json::to_vec(request).map_err(|_| "Message Outlook invalide.")?;
    for bytes in [request.as_slice(), filename.as_bytes(), pdf] {
        hasher.update((bytes.len() as u64).to_be_bytes());
        hasher.update(bytes);
    }
    Ok(format!("{:x}", hasher.finalize()))
}

// Lock a stable, separate file: locking the journal inode would be invalidated by atomic replace.
fn with_journal<T>(
    operation: impl FnOnce(&mut Journal) -> Result<(T, bool), String>,
) -> Result<T, String> {
    with_journal_files(&path("attempts.lock")?, &path("attempts.json")?, operation)
}

fn with_journal_files<T>(
    lock_path: &Path,
    journal_path: &Path,
    operation: impl FnOnce(&mut Journal) -> Result<(T, bool), String>,
) -> Result<T, String> {
    let file = OpenOptions::new()
        .create(true)
        .truncate(false)
        .read(true)
        .write(true)
        .open(lock_path)
        .map_err(|_| "Verrouillage du journal Outlook impossible.")?;
    file.try_lock_exclusive().map_err(|_| {
        "Le journal Outlook est utilisé par une autre instance. Aucun nouvel envoi n’a été soumis."
    })?;
    // RAII file close releases the OS lock on every success/error path.
    let mut journal = match read_bounded(journal_path, MAX_JOURNAL)? {
        Some(bytes) => serde_json::from_slice::<Journal>(&bytes)
            .map_err(|_| "Journal Outlook illisible. Envoi bloqué pour éviter un doublon.")?,
        None => Journal::default(),
    };
    if journal.version != 1 || journal.attempts.len() > MAX_ATTEMPTS {
        return Err("Version ou taille du journal Outlook invalide. Envoi bloqué.".into());
    }
    let (value, changed) = operation(&mut journal)?;
    if changed {
        let bytes = serde_json::to_vec(&journal).map_err(|_| "Journal Outlook invalide.")?;
        if bytes.len() > MAX_JOURNAL {
            return Err("Le journal Outlook est plein. Envoi bloqué.".into());
        }
        crate::atomic_replace(journal_path, &bytes).map_err(|_| "Enregistrement du journal Outlook impossible. Aucun renvoi automatique ne sera effectué.".to_owned())?;
    }
    Ok(value)
}

fn duplicate(
    journal: &Journal,
    attempt_id: &str,
    fingerprint: &str,
) -> Result<Option<SendReceipt>, String> {
    let Some(record) = journal.attempts.get(attempt_id) else {
        return Ok(None);
    };
    if record.fingerprint != fingerprint {
        return Err(
            "Cet identifiant de tentative appartient à un autre message ou PDF. Envoi bloqué."
                .into(),
        );
    }
    match record.status {
        AttemptStatus::Accepted => {
            let receipt = record.receipt.as_ref().ok_or("Reçu Outlook absent. Envoi bloqué pour éviter un doublon.")?;
            if receipt.attempt_id != attempt_id || validate_email(&receipt.sender_email).is_err()
                || chrono::DateTime::parse_from_rfc3339(&receipt.accepted_at).is_err() {
                return Err("Reçu Outlook invalide. Envoi bloqué pour éviter un doublon.".into());
            }
            Ok(Some(receipt.clone()))
        },
        AttemptStatus::Rejected => Err("Microsoft a refusé cette tentative. Corrigez le problème et confirmez une nouvelle tentative avec un nouvel identifiant.".into()),
        AttemptStatus::Transmitting | AttemptStatus::Ambiguous => Err(AMBIGUOUS.into()),
    }
}

fn reserve(
    journal: &mut Journal,
    attempt_id: &str,
    fingerprint: &str,
) -> Result<Option<SendReceipt>, String> {
    if let Some(receipt) = duplicate(journal, attempt_id, fingerprint)? {
        return Ok(Some(receipt));
    }
    if journal.attempts.len() >= MAX_ATTEMPTS {
        return Err(
            "Le journal Outlook est plein. Envoi bloqué pour préserver la détection des doublons."
                .into(),
        );
    }
    journal.attempts.insert(
        attempt_id.to_owned(),
        AttemptRecord {
            fingerprint: fingerprint.into(),
            status: AttemptStatus::Transmitting,
            receipt: None,
            created_at: Utc::now().to_rfc3339(),
        },
    );
    Ok(None)
}

fn finish_attempt(
    attempt_id: &str,
    fingerprint: &str,
    status: AttemptStatus,
    receipt: Option<SendReceipt>,
) -> Result<(), String> {
    with_journal(|journal| {
        let record = journal
            .attempts
            .get_mut(attempt_id)
            .ok_or("Tentative Outlook absente. Aucun renvoi automatique.")?;
        if record.fingerprint != fingerprint || record.status != AttemptStatus::Transmitting {
            return Err("État de tentative Outlook incohérent. Aucun renvoi automatique.".into());
        }
        record.status = status;
        record.receipt = receipt;
        Ok(((), true))
    })
}

fn submission_status(status: u16) -> AttemptStatus {
    match status {
        202 => AttemptStatus::Accepted,
        // Explicit client failures are rejections; timeout and unknown/server outcomes are ambiguous.
        400..=499 if status != 408 => AttemptStatus::Rejected,
        _ => AttemptStatus::Ambiguous,
    }
}

pub async fn send(
    mut request: SendRequest,
    filename: String,
    pdf: Vec<u8>,
) -> Result<SendReceipt, String> {
    validate_request(&mut request, &filename, &pdf)?;
    let body = payload(&request, &filename, &pdf)?;
    let fingerprint = fingerprint(&request, &filename, &pdf)?;
    let _send = SEND_LOCK.lock().await;
    // Accepted replay is useful even after disconnect. Never prune journal IDs on disconnect.
    if let Some(receipt) = with_journal(|journal| {
        Ok((
            duplicate(journal, &request.attempt_id, &fingerprint)?,
            false,
        ))
    })? {
        return Ok(receipt);
    }
    let client = client()?;
    let (credentials, generation) = ready_credentials(&client).await?;
    {
        let state = state()?;
        if state.generation != generation
            || state.pending.is_some()
            || registration()?.client_id != credentials.client_id
        {
            return Err("La connexion Outlook a changé. Aucun message n’a été envoyé.".into());
        }
        let replay = with_journal(|journal| {
            let receipt = reserve(journal, &request.attempt_id, &fingerprint)?;
            let changed = receipt.is_none();
            Ok((receipt, changed))
        })?;
        if let Some(receipt) = replay {
            return Ok(receipt);
        }
    }
    // The durable Transmitting marker precedes the ONLY sendMail request. A crash, dropped future,
    // timeout, or journal update failure leaves that marker blocking all subsequent submissions.
    let response = client
        .post(SEND)
        .bearer_auth(&credentials.access_token)
        .header(reqwest::header::CONTENT_TYPE, "application/json")
        .header("client-request-id", &request.attempt_id)
        .header("return-client-request-id", "true")
        .body(body)
        .send()
        .await;
    let response = match response {
        Ok(response) => response,
        Err(_) => {
            let _ = finish_attempt(
                &request.attempt_id,
                &fingerprint,
                AttemptStatus::Ambiguous,
                None,
            );
            return Err(AMBIGUOUS.into());
        }
    };
    let status_code = response.status().as_u16();
    let status = submission_status(status_code);
    match status {
        AttemptStatus::Accepted => {
            // 202 means accepted for processing, not delivered. No response body is needed.
            let receipt = SendReceipt {
                sender_email: credentials.sender_email,
                accepted_at: Utc::now().to_rfc3339(),
                attempt_id: request.attempt_id,
            };
            if finish_attempt(
                &receipt.attempt_id,
                &fingerprint,
                AttemptStatus::Accepted,
                Some(receipt.clone()),
            )
            .is_err()
            {
                return Err("Microsoft a accepté le courriel, mais son reçu local n’a pas pu être enregistré. Vérifiez Outlook; ne renvoyez pas cette tentative.".into());
            }
            Ok(receipt)
        }
        AttemptStatus::Rejected => {
            let _ = finish_attempt(
                &request.attempt_id,
                &fingerprint,
                AttemptStatus::Rejected,
                None,
            );
            Err(format!("Microsoft a refusé l’envoi (HTTP {status_code}). Le PDF reste enregistré. Aucun renvoi automatique. Vérifiez les autorisations ou reconnectez Outlook avant de confirmer une nouvelle tentative."))
        }
        _ => {
            let _ = finish_attempt(
                &request.attempt_id,
                &fingerprint,
                AttemptStatus::Ambiguous,
                None,
            );
            Err(AMBIGUOUS.into())
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn request() -> SendRequest {
        SendRequest {
            attempt_id: Uuid::new_v4().to_string(),
            to: vec!["client@example.com".into()],
            cc: vec!["accountant@example.com".into()],
            subject: "Facture 123".into(),
            body: "Bonjour,\nVoici votre facture.\nMerci.".into(),
        }
    }
    fn pdf() -> Vec<u8> {
        b"%PDF-1.7\nfixture\n%%EOF\n".to_vec()
    }

    #[test]
    fn pkce_matches_rfc7636_vector_and_random_values_are_independent() {
        assert_eq!(
            challenge("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk"),
            "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM"
        );
        let state = random_secret();
        let verifier = random_secret();
        assert_eq!(state.len(), 43);
        assert_eq!(verifier.len(), 43);
        assert_ne!(state, verifier);
        assert_eq!(URL_SAFE_NO_PAD.decode(verifier).unwrap().len(), 32);
    }

    #[test]
    fn authorization_is_consumers_public_pkce_and_exact_scopes() {
        let id = Uuid::new_v4().to_string();
        let url =
            authorization_url(&id, "http://localhost:12345/", "randomstate", "verifier").unwrap();
        assert_eq!(url.path(), "/consumers/oauth2/v2.0/authorize");
        let pairs: BTreeMap<_, _> = url.query_pairs().into_owned().collect();
        assert_eq!(pairs["client_id"], id);
        assert_eq!(pairs["scope"], SCOPES);
        assert_eq!(pairs["code_challenge_method"], "S256");
        assert!(!pairs.contains_key("client_secret"));
    }

    #[test]
    fn callback_decodes_code_and_checks_state_before_denial() {
        assert_eq!(
            parse_callback("/?state=safe&code=a%2Bb%2Fc", "safe").unwrap(),
            Callback::Code("a+b/c".into())
        );
        assert_eq!(
            parse_callback("/?state=safe&error=access_denied", "safe").unwrap(),
            Callback::Denied
        );
        assert!(parse_callback("/?state=wrong&error=access_denied", "safe").is_err());
        assert!(parse_callback("/?state=wrong&code=valid", "safe").is_err());
        assert!(parse_callback("/?code=valid", "safe").is_err());
    }

    #[test]
    fn callback_rejects_parameter_smuggling_and_invalid_encoding() {
        for target in [
            "/?state=safe&state=safe&code=c",
            "/?state=safe&%73tate=safe&code=c",
            "/?state=safe&code=c&error=e",
            "/?state=safe&code=",
            "/?state=safe&code=%GG",
            "/?state=safe&code=%",
            "/?state=safe&code=%FF",
            "/?state=safe&code=%00",
            "https://elsewhere/?state=safe&code=c",
            "/favicon.ico?state=safe&code=c",
            "/?state=safe&code=c#fragment",
        ] {
            assert!(parse_callback(target, "safe").is_err(), "{target}");
        }
    }

    #[test]
    fn scopes_require_both_graph_permissions_without_unexpected_grants() {
        for scope in ["Mail.Send User.Read", SCOPES, "https://graph.microsoft.com/Mail.Send https://graph.microsoft.com/User.Read offline_access"] { assert!(validate_scopes(scope).is_ok()); }
        for scope in [
            "",
            "Mail.Send",
            "User.Read offline_access",
            "Mail.Read User.Read",
            "Mail.Send User.Read Mail.ReadWrite",
            "https://other.example/Mail.Send User.Read",
        ] {
            assert!(validate_scopes(scope).is_err());
        }
    }

    #[test]
    fn refresh_keeps_missing_refresh_token_and_scope_but_validates_rotation() {
        let prior = Credentials {
            client_id: Uuid::new_v4().to_string(),
            subject: "me".into(),
            sender_email: "me@example.com".into(),
            access_token: "old".into(),
            refresh_token: "refresh".into(),
            expires_at: 0,
            scope: "Mail.Send User.Read".into(),
        };
        let tokens = TokenResponse {
            access_token: "new".into(),
            refresh_token: String::new(),
            token_type: "Bearer".into(),
            expires_in: 3600,
            scope: None,
        };
        let updated = apply_tokens(tokens, prior.client_id.clone(), Some(&prior)).unwrap();
        assert_eq!(updated.refresh_token, "refresh");
        assert_eq!(updated.scope, prior.scope);
        assert_eq!(updated.subject, "me");
        let tokens = TokenResponse {
            access_token: "new".into(),
            refresh_token: "rotated".into(),
            token_type: "Bearer".into(),
            expires_in: 3600,
            scope: Some(SCOPES.into()),
        };
        assert_eq!(
            apply_tokens(tokens, prior.client_id.clone(), Some(&prior))
                .unwrap()
                .refresh_token,
            "rotated"
        );
        let tokens = TokenResponse {
            access_token: "new".into(),
            refresh_token: String::new(),
            token_type: "Bearer".into(),
            expires_in: 3600,
            scope: Some(SCOPES.into()),
        };
        assert!(apply_tokens(tokens, prior.client_id, None).is_err());
    }

    #[tokio::test]
    async fn cancellation_interrupts_wait_and_observes_already_cancelled() {
        let (sender, mut receiver) = watch::channel(false);
        let waiting = bounded_login(
            &mut receiver,
            Duration::from_secs(1),
            std::future::pending::<Result<(), String>>(),
        );
        let cancel = async {
            tokio::task::yield_now().await;
            sender.send(true).unwrap();
        };
        let (result, ()) = tokio::join!(waiting, cancel);
        assert!(result.unwrap_err().contains("annulée"));
        assert!(
            bounded_login(&mut receiver, Duration::from_secs(1), async { Ok(()) })
                .await
                .unwrap_err()
                .contains("annulée")
        );
    }

    #[tokio::test]
    async fn bounded_login_expires_and_closed_channel_cancels() {
        let (sender, mut receiver) = watch::channel(false);
        assert!(bounded_login(
            &mut receiver,
            Duration::from_millis(1),
            std::future::pending::<Result<(), String>>()
        )
        .await
        .unwrap_err()
        .contains("expiré"));
        drop(sender);
        assert!(bounded_login(
            &mut receiver,
            Duration::from_secs(1),
            std::future::pending::<Result<(), String>>()
        )
        .await
        .unwrap_err()
        .contains("annulée"));
    }

    #[test]
    fn cancelling_invalidates_pending_generation() {
        let (sender, receiver) = watch::channel(false);
        let mut state = State {
            generation: 4,
            pending: Some(Pending {
                id: Uuid::new_v4(),
                cancel: sender,
            }),
            error: Some("old".into()),
        };
        cancel_locked(&mut state);
        assert_eq!(state.generation, 5);
        assert!(state.pending.is_none());
        assert!(state.error.is_none());
        assert!(*receiver.borrow());
    }

    #[tokio::test]
    async fn loopback_bad_state_does_not_consume_valid_callback_and_socket_closes() {
        let listener = TcpListener::bind((std::net::Ipv4Addr::LOCALHOST, 0))
            .await
            .unwrap();
        let port = listener.local_addr().unwrap().port();
        let server = callback(listener, port, "safe");
        let browser = async {
            for state in ["wrong", "safe"] {
                let mut stream = TcpStream::connect((std::net::Ipv4Addr::LOCALHOST, port))
                    .await
                    .unwrap();
                stream.write_all(format!("GET /?state={state}&code=abc HTTP/1.1\r\nHost: localhost:{port}\r\n\r\n").as_bytes()).await.unwrap();
                let mut response = Vec::new();
                stream.read_to_end(&mut response).await.unwrap();
                assert!(response.starts_with(if state == "safe" {
                    b"HTTP/1.1 200"
                } else {
                    b"HTTP/1.1 400"
                }));
                assert!(!String::from_utf8(response).unwrap().contains("abc"));
            }
        };
        let (code, ()) = tokio::time::timeout(Duration::from_secs(5), async {
            tokio::join!(server, browser)
        })
        .await
        .unwrap();
        assert_eq!(code.unwrap(), "abc");
        assert!(TcpStream::connect((std::net::Ipv4Addr::LOCALHOST, port))
            .await
            .is_err());
    }

    #[tokio::test]
    async fn cancel_drops_listener_and_releases_port() {
        let listener = TcpListener::bind((std::net::Ipv4Addr::LOCALHOST, 0))
            .await
            .unwrap();
        let port = listener.local_addr().unwrap().port();
        let (sender, mut receiver) = watch::channel(false);
        sender.send(true).unwrap();
        assert!(bounded_login(
            &mut receiver,
            Duration::from_secs(1),
            callback(listener, port, "safe")
        )
        .await
        .is_err());
        assert!(TcpStream::connect((std::net::Ipv4Addr::LOCALHOST, port))
            .await
            .is_err());
    }

    #[test]
    fn recipients_validate_syntax_and_injection() {
        for email in [
            "alice@example.com",
            "first.last+invoice@sub.example.ca",
            "a'b@example.com",
        ] {
            assert!(validate_email(email).is_ok(), "{email}");
        }
        for email in [
            "",
            "Name <alice@example.com>",
            "a@example.com;b@example.com",
            "a@example.com\r\nBcc:x@example.com",
            ".a@example.com",
            "a..b@example.com",
            "a@-example.com",
            "a@example..com",
            "a@@example.com",
            "a@localhost",
            "é@example.com",
            "a @example.com",
        ] {
            assert!(validate_email(email).is_err(), "{email}");
        }
    }

    #[test]
    fn request_validates_recipient_count_duplicates_subject_body_and_filename() {
        let mut valid = request();
        valid.to[0] = " client@example.com ".into();
        validate_request(&mut valid, "facture.pdf", &pdf()).unwrap();
        assert_eq!(valid.to[0], "client@example.com");
        let mut duplicate = request();
        duplicate.cc[0] = "CLIENT@example.com".into();
        assert!(validate_request(&mut duplicate, "facture.pdf", &pdf()).is_err());
        let mut empty = request();
        empty.to.clear();
        assert!(validate_request(&mut empty, "facture.pdf", &pdf()).is_err());
        let mut many = request();
        many.to = (0..MAX_RECIPIENTS)
            .map(|i| format!("a{i}@example.com"))
            .collect();
        assert!(validate_request(&mut many, "facture.pdf", &pdf()).is_err());
        for filename in [
            "../facture.pdf",
            "C:\\facture.pdf",
            "facture.txt",
            "facture.pdf\n",
            "facture.pdf ",
        ] {
            assert!(validate_request(&mut request(), filename, &pdf()).is_err());
        }
        let mut bad = request();
        bad.subject = "Bad\r\nSubject".into();
        assert!(validate_request(&mut bad, "facture.pdf", &pdf()).is_err());
        bad = request();
        bad.body = "x".repeat(MAX_BODY + 1);
        assert!(validate_request(&mut bad, "facture.pdf", &pdf()).is_err());
    }

    #[test]
    fn pdf_and_encoded_payload_limits_are_both_enforced() {
        let mut large = vec![b' '; MAX_PDF];
        large[..8].copy_from_slice(b"%PDF-1.7");
        let end = large.len();
        large[end - 5..].copy_from_slice(b"%%EOF");
        assert!(validate_request(&mut request(), "facture.pdf", &large).is_err());
        large.remove(8);
        validate_request(&mut request(), "facture.pdf", &large).unwrap();
        assert!(payload(&request(), "facture.pdf", &large).is_err());
        assert!(validate_request(&mut request(), "facture.pdf", b"not a pdf").is_err());
        assert!(
            validate_request(&mut request(), "facture.pdf", b"%PDF-1.7 missing trailer").is_err()
        );
    }

    #[test]
    fn payload_is_text_pdf_me_only_and_contains_no_secrets_or_file_paths() {
        let bytes = payload(&request(), "facture.pdf", &pdf()).unwrap();
        let value: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
        assert_eq!(value["message"]["body"]["contentType"], "Text");
        assert!(value["message"].get("from").is_none());
        assert!(value["message"].get("sender").is_none());
        assert_eq!(value["saveToSentItems"], true);
        assert_eq!(
            STANDARD
                .decode(
                    value["message"]["attachments"][0]["contentBytes"]
                        .as_str()
                        .unwrap()
                )
                .unwrap(),
            pdf()
        );
        assert_eq!(SEND, "https://graph.microsoft.com/v1.0/me/sendMail");
        assert!(serde_json::from_value::<SendRequest>(json!({"attemptId": Uuid::new_v4().to_string(), "to": ["a@example.com"], "cc": [], "subject": "s", "body": "b", "from": "forged@example.com"})).is_err());
    }

    #[test]
    fn journal_dedupes_pending_accepted_and_changed_payload_after_reload() {
        let request = request();
        let hash = fingerprint(&request, "facture.pdf", &pdf()).unwrap();
        let mut journal = Journal::default();
        assert!(reserve(&mut journal, &request.attempt_id, &hash)
            .unwrap()
            .is_none());
        let persisted = serde_json::to_vec(&journal).unwrap();
        let mut journal: Journal = serde_json::from_slice(&persisted).unwrap();
        assert!(reserve(&mut journal, &request.attempt_id, &hash)
            .unwrap_err()
            .contains("incertain"));
        assert!(reserve(&mut journal, &request.attempt_id, "changed")
            .unwrap_err()
            .contains("autre message"));
        let receipt = SendReceipt {
            sender_email: "me@example.com".into(),
            accepted_at: "2026-09-30T00:00:00Z".into(),
            attempt_id: request.attempt_id.clone(),
        };
        let record = journal.attempts.get_mut(&request.attempt_id).unwrap();
        record.status = AttemptStatus::Accepted;
        record.receipt = Some(receipt.clone());
        let journal: Journal =
            serde_json::from_slice(&serde_json::to_vec(&journal).unwrap()).unwrap();
        assert_eq!(
            duplicate(&journal, &request.attempt_id, &hash).unwrap(),
            Some(receipt)
        );
        assert_eq!(journal.attempts.len(), 1);
    }

    #[test]
    fn uncertain_and_rejected_attempts_never_become_reservable() {
        for status in [
            AttemptStatus::Transmitting,
            AttemptStatus::Ambiguous,
            AttemptStatus::Rejected,
        ] {
            let mut journal = Journal::default();
            journal.attempts.insert(
                "id".into(),
                AttemptRecord {
                    fingerprint: "hash".into(),
                    status,
                    receipt: None,
                    created_at: String::new(),
                },
            );
            assert!(reserve(&mut journal, "id", "hash").is_err());
            assert_eq!(journal.attempts.len(), 1);
        }
        assert_eq!(submission_status(202), AttemptStatus::Accepted);
        for code in [400, 401, 403, 413, 429] {
            assert_eq!(submission_status(code), AttemptStatus::Rejected);
        }
        for code in [200, 204, 302, 408, 500, 503, 504] {
            assert_eq!(submission_status(code), AttemptStatus::Ambiguous);
        }
    }

    #[test]
    fn journal_on_disk_survives_reopen_and_never_resubmits_reserved_id() {
        let directory = tempfile::tempdir().unwrap();
        let lock_path = directory.path().join("attempts.lock");
        let journal_path = directory.path().join("attempts.json");
        with_journal_files(&lock_path, &journal_path, |journal| {
            assert!(reserve(journal, "id", "hash")?.is_none());
            Ok(((), true))
        })
        .unwrap();
        assert!(journal_path.exists());
        let failure = with_journal_files(&lock_path, &journal_path, |journal| {
            reserve(journal, "id", "hash").map(|receipt| (receipt, false))
        })
        .unwrap_err();
        assert!(failure.contains("incertain"));
        let receipt = SendReceipt {
            sender_email: "me@example.com".into(),
            accepted_at: "2026-09-30T00:00:00Z".into(),
            attempt_id: "id".into(),
        };
        with_journal_files(&lock_path, &journal_path, |journal| {
            let record = journal.attempts.get_mut("id").unwrap();
            record.status = AttemptStatus::Accepted;
            record.receipt = Some(receipt.clone());
            Ok(((), true))
        })
        .unwrap();
        let replay = with_journal_files(&lock_path, &journal_path, |journal| {
            Ok((duplicate(journal, "id", "hash")?, false))
        })
        .unwrap();
        assert_eq!(replay, Some(receipt));
    }

    #[test]
    fn corrupt_or_unknown_journal_blocks_before_reservation() {
        let directory = tempfile::tempdir().unwrap();
        let lock_path = directory.path().join("attempts.lock");
        let journal_path = directory.path().join("attempts.json");
        for bytes in [
            b"broken".as_slice(),
            b"{\"version\":2,\"attempts\":{}}".as_slice(),
        ] {
            fs::write(&journal_path, bytes).unwrap();
            let mut reached = false;
            assert!(with_journal_files(&lock_path, &journal_path, |_| {
                reached = true;
                Ok(((), true))
            })
            .is_err());
            assert!(!reached);
            assert_eq!(fs::read(&journal_path).unwrap(), bytes);
        }
    }

    #[test]
    fn concurrent_journal_lock_blocks_and_releases_on_drop() {
        let directory = tempfile::tempdir().unwrap();
        let lock_path = directory.path().join("attempts.lock");
        let journal_path = directory.path().join("attempts.json");
        let lock = OpenOptions::new()
            .create(true)
            .truncate(false)
            .write(true)
            .read(true)
            .open(&lock_path)
            .unwrap();
        lock.try_lock_exclusive().unwrap();
        let mut reached = false;
        assert!(with_journal_files(&lock_path, &journal_path, |_| {
            reached = true;
            Ok(((), true))
        })
        .is_err());
        assert!(!reached);
        drop(lock);
        with_journal_files(&lock_path, &journal_path, |_| Ok(((), false))).unwrap();
    }

    #[test]
    fn fingerprint_covers_attachment_name_bytes_and_message() {
        let request = request();
        let hash = fingerprint(&request, "facture.pdf", &pdf()).unwrap();
        assert_ne!(hash, fingerprint(&request, "autre.pdf", &pdf()).unwrap());
        assert_ne!(
            hash,
            fingerprint(&request, "facture.pdf", b"different").unwrap()
        );
        let mut changed = request.clone();
        changed.body.push('!');
        assert_ne!(hash, fingerprint(&changed, "facture.pdf", &pdf()).unwrap());
    }

    #[test]
    fn registration_requires_real_guid_and_settings_do_not_serialize_credentials() {
        for id in [
            "",
            "invented",
            "00000000-0000-0000-0000-000000000000",
            "{12345678-1234-1234-1234-123456789abc}",
        ] {
            assert!(guid(id).is_err());
        }
        let id = Uuid::new_v4().to_string();
        assert_eq!(guid(&id.to_uppercase()).unwrap(), id);
        let settings = MailSettings {
            client_id: id,
            accountant_email: String::new(),
            signature: String::new(),
            connected: true,
            sender_email: Some("me@example.com".into()),
            auth_pending: false,
            auth_error: None,
        };
        let value = serde_json::to_value(settings).unwrap();
        assert_eq!(value.as_object().unwrap().len(), 7);
        assert!(value.get("clientId").is_some());
        assert!(value.get("senderEmail").is_some());
        assert!(value.get("accessToken").is_none());
        assert!(value.get("refreshToken").is_none());
    }

    #[cfg(windows)]
    #[test]
    fn dpapi_roundtrip_is_ciphertext_and_rejects_tampering() {
        let plaintext = b"outlook test-only fake credentials";
        let protected = protect(plaintext, false).unwrap();
        assert!(!protected.windows(plaintext.len()).any(|w| w == plaintext));
        assert_eq!(protect(&protected, true).unwrap(), plaintext);
        let mut tampered = protected;
        let end = tampered.len() - 1;
        tampered[end] ^= 1;
        assert!(protect(&tampered, true).is_err());
    }
}
