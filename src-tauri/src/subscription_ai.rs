//! OpenAI's documented public-client ChatGPT plan flow. No API keys or borrowed sessions.
use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
use chrono::Utc;
use jsonwebtoken::{decode, decode_header, jwk::JwkSet, Algorithm, DecodingKey, Validation};
use reqwest::{Client, Url};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{collections::HashMap, path::PathBuf, sync::{Mutex, OnceLock}, time::Duration};
use tokio::{io::{AsyncReadExt, AsyncWriteExt}, net::TcpListener, task::JoinHandle};
use uuid::Uuid;

const ISSUER: &str = "https://auth.openai.com";
const AUTHORIZE: &str = "https://auth.openai.com/api/accounts/authorize";
const TOKEN: &str = "https://auth.openai.com/api/accounts/oauth/token";
const RESOURCE: &str = "https://api.openai.com/v1";
const APP_NAME: &str = "Soumissions et factures";
const SCOPE: &str = "openid profile email offline_access resource.invoke chatgpt.tokens.use.direct";
static DIRECTORY: OnceLock<PathBuf> = OnceLock::new();
static CREDENTIAL_LOCK: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());
static LOGIN: Mutex<LoginState> = Mutex::new(LoginState { generation: 0, task: None, error: None, url: None, attempt_id: None });
static SESSION: OnceLock<tokio::sync::watch::Sender<u64>> = OnceLock::new();
fn sessions() -> &'static tokio::sync::watch::Sender<u64> { SESSION.get_or_init(|| tokio::sync::watch::channel(0).0) }

struct LoginState { generation: u64, task: Option<JoinHandle<()>>, error: Option<String>, url: Option<String>, attempt_id: Option<String> }
#[derive(Serialize, Deserialize)]
struct Registration { client_id: String, subject: Option<String> }
fn read_registration() -> Result<Option<Registration>, String> {
    match std::fs::read(path("registration.json")?) {
        Ok(bytes) => {
            let value: Registration = serde_json::from_slice(&bytes).map_err(|_| "Inscription ChatGPT illisible.")?;
            if !value.client_id.starts_with("oaiapp_") { return Err("Inscription ChatGPT invalide.".into()); }
            Ok(Some(value))
        },
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(_) => Err("Lecture de l’inscription ChatGPT impossible.".into()),
    }
}
fn save_registration(client_id: &str, subject: Option<String>) -> Result<(), String> {
    let data = serde_json::to_vec(&Registration { client_id: client_id.into(), subject }).map_err(|_| "Inscription invalide.")?;
    crate::atomic_replace(&path("registration.json")?, &data).map_err(|_| "Inscription ChatGPT non enregistrée.".into())
}

#[derive(Clone, Serialize, Deserialize)]
struct Credentials {
    client_id: String, host_id: String, subject: String,
    access_token: String, refresh_token: String, id_token: String,
    expires_at: i64, scopes: Vec<String>,
}
#[derive(Deserialize)]
struct Tokens { access_token: String, #[serde(default)] refresh_token: String,
    #[serde(default)] id_token: String, token_type: String, expires_in: u64, scope: Option<String> }
#[derive(Deserialize)]
struct Identity { sub: String, nonce: Option<String>, exp: u64, iat: u64 }
struct Attempt { state: String, nonce: String, verifier: String, redirect: String,
    client_id: Option<String>, previous_subject: Option<String>, host_id: String }

pub fn configure(directory: PathBuf) { let _ = DIRECTORY.set(directory); }
fn path(name: &str) -> Result<PathBuf, String> {
    Ok(DIRECTORY.get().ok_or("Connexion ChatGPT non initialisée.")?.join(name))
}
fn client() -> Result<Client, String> {
    Client::builder().redirect(reqwest::redirect::Policy::none())
        .connect_timeout(Duration::from_secs(10)).timeout(Duration::from_secs(90))
        .user_agent("invoice-company-app/subscription").build()
        .map_err(|_| "Connexion ChatGPT indisponible.".into())
}
async fn json_response(mut response: reqwest::Response) -> Result<Value, String> {
    if !response.status().is_success() { return Err(http_error(response).await); }
    let mut bytes = Vec::new();
    while let Some(chunk) = response.chunk().await.map_err(|_| "Réponse ChatGPT interrompue.")? {
        if bytes.len() + chunk.len() > 512_000 { return Err("Réponse ChatGPT trop volumineuse.".into()); }
        bytes.extend_from_slice(&chunk);
    }
    serde_json::from_slice(&bytes).map_err(|_| "Réponse ChatGPT invalide.".into())
}

fn diagnostic_identifier(value: Option<&str>) -> Option<String> {
    value.filter(|s| !s.is_empty() && s.len() <= 160 && s.chars().all(|c| c.is_ascii_alphanumeric() || "_.:/-[]".contains(c)))
        .map(str::to_owned)
}
fn provider_error(status: u16, bytes: &[u8], request_id: Option<&str>) -> String {
    let value: Value = serde_json::from_slice(bytes).unwrap_or(Value::Null);
    // Never display arbitrary response bodies: they may echo source text or credentials.
    let code = diagnostic_identifier(value["error"]["code"].as_str());
    let parameter = diagnostic_identifier(value["error"]["param"].as_str());
    let mut details = vec![format!("HTTP {status}")];
    if let Some(code) = &code { details.push(format!("code : {code}")); }
    if let Some(param) = parameter { details.push(format!("champ : {param}")); }
    if let Some(id) = diagnostic_identifier(request_id) { details.push(format!("référence : {id}")); }
    let explanation = match code.as_deref() {
        Some("subscription_sharing_unsupported_capability") => "Une option de la demande n’est pas prise en charge par l’abonnement.",
        Some("subscription_sharing_user_not_eligible") => "L’utilisation de l’abonnement n’est pas autorisée pour ce compte ou cet espace.",
        Some("subscription_sharing_usage_limit_exceeded") => "La limite d’utilisation de l’abonnement pour cette connexion est atteinte.",
        _ if status == 400 => "Le service a rejeté le format de la demande. Ce message ne signifie pas que votre abonnement est refusé.",
        _ => "Le service a refusé la demande.",
    };
    format!("{explanation} ({}). Aucun autre service n’a été utilisé.", details.join(" ; "))
}
async fn http_error(mut response: reqwest::Response) -> String {
    let status = response.status().as_u16();
    let request_id = response.headers().get("x-request-id").and_then(|s| s.to_str().ok()).map(str::to_owned);
    let mut bytes = Vec::new();
    while let Ok(Some(chunk)) = response.chunk().await {
        if bytes.len() + chunk.len() > 16_384 { bytes.clear(); break; }
        bytes.extend_from_slice(&chunk);
    }
    provider_error(status, &bytes, request_id.as_deref())
}

#[cfg(windows)]
fn protect(bytes: &[u8], decrypt: bool) -> Result<Vec<u8>, String> {
    use windows_sys::Win32::{Foundation::LocalFree, Security::Cryptography::{CryptProtectData, CryptUnprotectData, CRYPT_INTEGER_BLOB, CRYPTPROTECT_UI_FORBIDDEN}};
    if bytes.is_empty() || bytes.len() > 512_000 { return Err("Identifiants ChatGPT invalides.".into()); }
    let input = CRYPT_INTEGER_BLOB { cbData: bytes.len() as u32, pbData: bytes.as_ptr() as *mut u8 };
    let mut output = CRYPT_INTEGER_BLOB { cbData: 0, pbData: std::ptr::null_mut() };
    // DPAPI binds the credential to the current Windows user; no plaintext is written.
    let ok = unsafe { if decrypt {
        CryptUnprotectData(&input, std::ptr::null_mut(), std::ptr::null(), std::ptr::null(), std::ptr::null(), CRYPTPROTECT_UI_FORBIDDEN, &mut output)
    } else {
        CryptProtectData(&input, std::ptr::null(), std::ptr::null(), std::ptr::null(), std::ptr::null(), CRYPTPROTECT_UI_FORBIDDEN, &mut output)
    }};
    if ok == 0 { return Err("Windows ne peut pas protéger ou ouvrir la connexion ChatGPT.".into()); }
    let result = unsafe { std::slice::from_raw_parts(output.pbData, output.cbData as usize).to_vec() };
    unsafe { LocalFree(output.pbData as *mut _); }
    Ok(result)
}
#[cfg(not(windows))]
fn protect(_: &[u8], _: bool) -> Result<Vec<u8>, String> { Err("Cette connexion exige Windows.".into()) }

fn read_credentials() -> Result<Option<Credentials>, String> {
    if DIRECTORY.get().is_none() { return Ok(None); }
    let bytes = match std::fs::read(path("chatgpt.dpapi")?) {
        Ok(bytes) => bytes,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(_) => return Err("Lecture de la connexion ChatGPT impossible.".into()),
    };
    serde_json::from_slice(&protect(&bytes, true)?).map(Some)
        .map_err(|_| "Connexion ChatGPT enregistrée illisible.".into())
}
fn save_credentials(credentials: &Credentials) -> Result<(), String> {
    save_registration(&credentials.client_id, Some(credentials.subject.clone()))?;
    let bytes = serde_json::to_vec(credentials).map_err(|_| "Connexion ChatGPT invalide.")?;
    crate::atomic_replace(&path("chatgpt.dpapi")?, &protect(&bytes, false)?)
        .map_err(|_| "Enregistrement de la connexion ChatGPT impossible.".into())
}
pub fn has_connection() -> Result<bool, String> {
    Ok(read_credentials().unwrap_or(None).is_some_and(|c| !c.access_token.is_empty() && !c.refresh_token.is_empty() && c.scopes.iter().any(|s| s == "chatgpt.tokens.use.direct")))
}
pub fn credential_error() -> Option<String> { read_credentials().err() }
pub fn pending() -> bool { LOGIN.lock().map(|s| s.task.as_ref().is_some_and(|t| !t.is_finished())).unwrap_or(false) }
pub fn login_error() -> Option<String> { LOGIN.lock().ok().and_then(|s| s.error.clone()) }
pub fn set_login_message(message: Option<String>) { if let Ok(mut login) = LOGIN.lock() { login.error = message; } }
pub fn open_login_url(attempt: &str) -> Result<(), String> {
    let url = { let login = LOGIN.lock().map_err(|_| "Connexion ChatGPT occupée.")?;
        if login.attempt_id.as_deref() != Some(attempt) || !login.task.as_ref().is_some_and(|t| !t.is_finished()) { return Err("Cette connexion ChatGPT n’est plus active.".into()); }
        login.url.clone().ok_or("Connexion ChatGPT indisponible.")? };
    #[cfg(windows)]
    {
        use windows_sys::Win32::UI::{Shell::ShellExecuteW, WindowsAndMessaging::SW_SHOWNORMAL};
        let verb: Vec<u16> = "open\0".encode_utf16().collect();
        let target: Vec<u16> = url.encode_utf16().chain(Some(0)).collect();
        let result = unsafe { ShellExecuteW(std::ptr::null_mut(), verb.as_ptr(), target.as_ptr(), std::ptr::null(), std::ptr::null(), SW_SHOWNORMAL) };
        if result as isize <= 32 { return Err("Impossible d’ouvrir le navigateur pour la connexion ChatGPT.".into()); }
        Ok(())
    }
    #[cfg(not(windows))]
    { Err("Cette connexion exige Windows.".into()) }
}
pub fn cancel() -> Result<(), String> {
    let mut login = LOGIN.lock().map_err(|_| "Connexion ChatGPT occupée.")?;
    login.generation += 1;
    if let Some(task) = login.task.take() { task.abort(); }
    login.error = None; login.url = None; login.attempt_id = None;
    Ok(())
}
fn random() -> String { format!("{}{}", Uuid::new_v4().simple(), Uuid::new_v4().simple()) }
fn host_id() -> Result<String, String> {
    let host_path = path("host-id")?;
    match std::fs::read_to_string(&host_path) {
        Ok(value) if Uuid::parse_str(value.trim_start_matches("urn:uuid:")).is_ok() => Ok(value),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            let value = format!("urn:uuid:{}", Uuid::new_v4());
            crate::atomic_replace(&host_path, value.as_bytes()).map_err(|_| "Création de l’identité locale impossible.")?;
            Ok(value)
        }
        _ => Err("Identité locale ChatGPT invalide.".into()),
    }
}
pub async fn start() -> Result<String, String> {
    if pending() { return Err("Une connexion ChatGPT est déjà en cours. Annulez-la pour recommencer.".into()); }
    let listener = TcpListener::bind("127.0.0.1:0").await.map_err(|_| "Impossible d’ouvrir le retour de connexion local.")?;
    let previous = read_credentials().unwrap_or(None);
    let registration = read_registration().unwrap_or(None);
    let attempt = Attempt { state: random(), nonce: random(), verifier: random(),
        redirect: format!("http://127.0.0.1:{}/auth/callback", listener.local_addr().map_err(|_| "Retour local indisponible.")?.port()),
        client_id: previous.as_ref().map(|c| c.client_id.clone()).or_else(|| registration.as_ref().map(|r| r.client_id.clone())),
        previous_subject: previous.as_ref().map(|c| c.subject.clone()).or_else(|| registration.and_then(|r| r.subject)), host_id: host_id()? };
    let mut url = Url::parse(AUTHORIZE).unwrap();
    {
        let mut query = url.query_pairs_mut();
        query.append_pair("client_id", attempt.client_id.as_deref().unwrap_or("dynamic_agent_client"))
            .append_pair("ext_agent_host_id", &attempt.host_id).append_pair("response_type", "code")
            .append_pair("redirect_uri", &attempt.redirect).append_pair("scope", SCOPE).append_pair("resource", RESOURCE)
            .append_pair("state", &attempt.state).append_pair("nonce", &attempt.nonce)
            .append_pair("code_challenge_method", "S256")
            .append_pair("code_challenge", &URL_SAFE_NO_PAD.encode(Sha256::digest(attempt.verifier.as_bytes())));
        if attempt.client_id.is_none() { query.append_pair("agent_name_hint", APP_NAME); }
        if let Some(c) = &previous { if !c.id_token.is_empty() { query.append_pair("id_token_hint", &c.id_token); } }
    }
    let url = url.to_string();
    let mut login = LOGIN.lock().map_err(|_| "Connexion ChatGPT occupée.")?;
    if login.task.as_ref().is_some_and(|t| !t.is_finished()) { return Err("Connexion déjà en cours.".into()); }
    login.generation += 1;
    let generation = login.generation;
    let attempt_id = random();
    login.error = None; login.url = Some(url); login.attempt_id = Some(attempt_id.clone());
    login.task = Some(tokio::spawn(async move {
        let outcome = tokio::time::timeout(Duration::from_secs(600), handle_login(listener, attempt)).await
            .unwrap_or_else(|_| Err("Connexion expirée. Recommencez le login ChatGPT.".into()));
        let _credential_guard = CREDENTIAL_LOCK.lock().await;
        if let Ok(mut state) = LOGIN.lock() {
            if state.generation == generation {
                state.error = match outcome { Ok(credentials) => { sessions().send_modify(|n| *n += 1); save_credentials(&credentials).err() }, Err(error) => Some(error) };
                state.task = None; state.url = None; state.attempt_id = None;
            }
        }
    }));
    Ok(attempt_id)
}

fn callback_values(target: &str, attempt: &Attempt) -> Result<(String, String), String> {
    let url = Url::parse(&format!("http://127.0.0.1{target}")).map_err(|_| "Retour de connexion invalide.")?;
    if url.path() != "/auth/callback" { return Err("Chemin de retour invalide.".into()); }
    let mut query = HashMap::new();
    for (key, value) in url.query_pairs() { if query.insert(key.into_owned(), value.into_owned()).is_some() { return Err("Paramètre de retour dupliqué.".into()); } }
    if query.get("state") != Some(&attempt.state) { return Err("Retour de connexion non reconnu.".into()); }
    if query.contains_key("error") { return Err("ChatGPT a refusé la connexion. Vérifiez l’espace sélectionné et l’accès autorisé à cette application.".into()); }
    let issued = query.get("client_id").cloned().or_else(|| attempt.client_id.clone()).ok_or("ChatGPT n’a pas enregistré cette application.")?;
    if !issued.starts_with("oaiapp_") || attempt.client_id.as_ref().is_some_and(|id| id != &issued) { return Err("Identité de l’application ChatGPT invalide.".into()); }
    let code = query.get("code").filter(|s| !s.is_empty()).cloned().ok_or("Code de connexion manquant.")?;
    Ok((code, issued))
}
async fn handle_login(listener: TcpListener, attempt: Attempt) -> Result<Credentials, String> {
    for _ in 0..200 {
        let (mut socket, _) = listener.accept().await.map_err(|_| "Retour local interrompu.")?;
        let mut bytes = Vec::new();
        let request = tokio::time::timeout(Duration::from_secs(3), async {
            let mut part = [0u8; 2048];
            while bytes.len() <= 16_000 {
                let read = socket.read(&mut part).await.map_err(|_| "Retour local illisible.")?;
                if read == 0 { break; } bytes.extend_from_slice(&part[..read]);
                if bytes.windows(4).any(|w| w == b"\r\n\r\n") { return Ok::<_, String>(()); }
            }
            Err("Retour local trop long.".into())
        }).await;
        if !matches!(request, Ok(Ok(()))) { continue; }
        let header = String::from_utf8_lossy(&bytes);
        let mut line = header.lines().next().unwrap_or("").split_whitespace();
        if line.next() != Some("GET") { continue; }
        let target = line.next().unwrap_or("");
        if !target.starts_with("/auth/callback?") { let _ = socket.write_all(b"HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\nConnection: close\r\n\r\n").await; continue; }
        // A request with incorrect state cannot consume a legitimate pending attempt.
        let parsed = callback_values(target, &attempt);
        let good_state = Url::parse(&format!("http://127.0.0.1{target}")).ok()
            .is_some_and(|u| u.query_pairs().any(|(k,v)| k == "state" && v == attempt.state));
        if !good_state { let _ = socket.write_all(b"HTTP/1.1 400 Bad Request\r\nContent-Length: 0\r\nConnection: close\r\n\r\n").await; continue; }
        let reply = b"HTTP/1.1 200 OK\r\nContent-Type: text/plain; charset=utf-8\r\nCache-Control: no-store\r\nContent-Security-Policy: default-src 'none'\r\nConnection: close\r\n\r\nRetour recu. Revenez dans Soumissions et factures pour verifier la connexion.";
        let _ = socket.write_all(reply).await;
        drop(socket);
        let (code, issued) = parsed?;
        save_registration(&issued, attempt.previous_subject.clone())?;
        let cli = client()?;
        let response = cli.post(TOKEN).form(&[("grant_type", "authorization_code"), ("client_id", issued.as_str()),
            ("code", code.as_str()), ("code_verifier", attempt.verifier.as_str()), ("redirect_uri", attempt.redirect.as_str()), ("resource", RESOURCE)])
            .send().await.map_err(|_| "Échange de connexion ChatGPT impossible.")?;
        let tokens: Tokens = serde_json::from_value(json_response(response).await?).map_err(|_| "Identifiants ChatGPT incomplets.")?;
        let identity = verify_identity(&cli, &tokens.id_token, &issued, Some(&attempt.nonce)).await?;
        if attempt.previous_subject.as_ref().is_some_and(|sub| sub != &identity.sub) { return Err("Le compte ne correspond pas à la connexion précédente.".into()); }
        return credentials_from_tokens(tokens, issued, attempt.host_id, identity.sub, None);
    }
    Err("Trop de retours locaux invalides. Recommencez la connexion.".into())
}
async fn verify_identity(client: &Client, token: &str, audience: &str, nonce: Option<&str>) -> Result<Identity, String> {
    let header = decode_header(token).map_err(|_| "Identité ChatGPT invalide.")?;
    if header.alg != Algorithm::RS256 { return Err("Signature ChatGPT non reconnue.".into()); }
    let response = client.get("https://auth.openai.com/.well-known/jwks.json").send().await.map_err(|_| "Vérification de l’identité impossible.")?;
    let keys: JwkSet = serde_json::from_value(json_response(response).await?).map_err(|_| "Clés de signature ChatGPT invalides.")?;
    let key = keys.find(header.kid.as_deref().ok_or("Signature ChatGPT manquante.")?).ok_or("Clé de signature ChatGPT inconnue.")?;
    let mut validation = Validation::new(Algorithm::RS256);
    validation.set_issuer(&[ISSUER]); validation.set_audience(&[audience]); validation.leeway = 5;
    validation.set_required_spec_claims(&["iss", "aud", "exp", "iat", "sub"]);
    let identity = decode::<Identity>(token, &DecodingKey::from_jwk(key).map_err(|_| "Clé ChatGPT invalide.")?, &validation)
        .map_err(|_| "Signature ou validité de la connexion ChatGPT refusée.")?.claims;
    validate_identity_claims(&identity, nonce)?;
    Ok(identity)
}
fn validate_identity_claims(identity: &Identity, nonce: Option<&str>) -> Result<(), String> {
    if identity.sub.is_empty() || identity.iat > (Utc::now().timestamp() + 5) as u64 || identity.exp <= identity.iat
        || nonce.is_some_and(|n| identity.nonce.as_deref() != Some(n)) { return Err("Identité ou nonce ChatGPT non reconnu.".into()); }
    Ok(())
}
fn credentials_from_tokens(tokens: Tokens, client_id: String, host_id: String, subject: String, previous: Option<&Credentials>) -> Result<Credentials, String> {
    let scopes = tokens.scope.map(|s| s.split_whitespace().map(str::to_owned).collect::<Vec<_>>())
        .or_else(|| previous.map(|p| p.scopes.clone())).ok_or("Autorisations d’abonnement manquantes.")?;
    if !scopes.iter().any(|s| s == "chatgpt.tokens.use.direct") || !scopes.iter().any(|s| s == "resource.invoke")
        || tokens.access_token.trim().is_empty() || !tokens.token_type.eq_ignore_ascii_case("bearer")
        || tokens.expires_in == 0 || tokens.expires_in > 86_400 { return Err("ChatGPT n’a pas autorisé l’utilisation de votre abonnement par cette application.".into()); }
    let refresh = if tokens.refresh_token.is_empty() { previous.map(|p| p.refresh_token.clone()).unwrap_or_default() } else { tokens.refresh_token };
    if refresh.is_empty() { return Err("Connexion renouvelable ChatGPT manquante.".into()) }
    Ok(Credentials { client_id, host_id, subject, access_token: tokens.access_token, refresh_token: refresh,
        id_token: if tokens.id_token.is_empty() { previous.map(|p| p.id_token.clone()).unwrap_or_default() } else { tokens.id_token },
        expires_at: Utc::now().timestamp() + tokens.expires_in as i64, scopes })
}
async fn access() -> Result<String, String> {
    let _guard = CREDENTIAL_LOCK.lock().await;
    let old = read_credentials()?.filter(|c| !c.access_token.is_empty()).ok_or("Connectez votre abonnement ChatGPT dans les réglages IA.")?;
    if !old.scopes.iter().any(|s| s == "chatgpt.tokens.use.direct") { return Err("Accès à l’abonnement ChatGPT non autorisé.".into()); }
    if old.expires_at > Utc::now().timestamp() + 60 { return Ok(old.access_token); }
    let cli = client()?;
    let response = cli.post(TOKEN).form(&[("grant_type", "refresh_token"), ("client_id", old.client_id.as_str()),
        ("refresh_token", old.refresh_token.as_str()), ("resource", RESOURCE)])
        .send().await.map_err(|_| "Renouvellement ChatGPT impossible. Reconnectez votre abonnement.")?;
    let tokens: Tokens = serde_json::from_value(json_response(response).await?).map_err(|_| "Renouvellement ChatGPT incomplet.")?;
    if !tokens.id_token.is_empty() {
        let identity = verify_identity(&cli, &tokens.id_token, &old.client_id, None).await?;
        if identity.sub != old.subject { return Err("Le compte ChatGPT a changé; reconnectez-vous.".into()) }
    }
    let renewed = credentials_from_tokens(tokens, old.client_id.clone(), old.host_id.clone(), old.subject.clone(), Some(&old))?;
    save_credentials(&renewed)?;
    Ok(renewed.access_token)
}
pub async fn disconnect() -> Result<Option<String>, String> {
    cancel()?;
    sessions().send_modify(|n| *n += 1);
    let _guard = CREDENTIAL_LOCK.lock().await;
    let mut credentials = match read_credentials() {
        Ok(Some(value)) => value,
        Ok(None) => return Ok(None),
        Err(_) => { std::fs::remove_file(path("chatgpt.dpapi")?).map_err(|_| "Suppression de la connexion endommagée impossible.")?; return Ok(Some("Connexion locale endommagée supprimée. Reconnectez ChatGPT.".into())); }
    };
    let revoked = async {
        let cli = client()?;
        let config = json_response(cli.get("https://auth.openai.com/.well-known/openid-configuration").send().await.map_err(|_| "Connexion impossible.")?).await?;
        let endpoint = Url::parse(config["revocation_endpoint"].as_str().ok_or("Révocation indisponible.")?).map_err(|_| "Révocation invalide.")?;
        if endpoint.scheme() != "https" || endpoint.host_str() != Some("auth.openai.com") { return Err("Révocation invalide.".to_string()); }
        let response = cli.post(endpoint).form(&[("token", credentials.refresh_token.as_str()), ("token_type_hint", "refresh_token"), ("client_id", credentials.client_id.as_str())]).send().await.map_err(|_| "Révocation impossible.")?;
        if response.status().as_u16() != 200 { return Err("Révocation non confirmée.".to_string()); }
        Ok::<_, String>(())
    }.await;
    credentials.access_token.clear(); credentials.refresh_token.clear(); credentials.id_token.clear(); credentials.expires_at = 0;
    save_credentials(&credentials)?;
    Ok(revoked.err().map(|_| "Déconnecté sur ce PC. La révocation distante n’a pas été confirmée; retirez l’accès dans les paramètres ChatGPT.".into()))
}

fn stream_result(bytes: &[u8]) -> Result<Value, String> {
    let text = std::str::from_utf8(bytes).map_err(|_| "Réponse ChatGPT illisible.")?;
    let mut result = None;
    let mut completed_items = std::collections::BTreeMap::new();
    for block in text.replace("\r\n", "\n").split("\n\n") {
        let data = block.lines().filter_map(|line| line.strip_prefix("data:").map(str::trim_start)).collect::<Vec<_>>().join("\n");
        if data.is_empty() || data == "[DONE]" { continue; }
        let event: Value = serde_json::from_str(&data).map_err(|_| "Flux ChatGPT invalide.")?;
        match event["type"].as_str() {
            Some("response.failed" | "response.incomplete" | "error") => return Err("Demande interrompue ou limite de l’abonnement atteinte. Aucun résultat n’a été appliqué.".into()),
            Some("response.output_item.done") => {
                if result.is_some() { return Err("Élément reçu après la fin de la réponse ChatGPT.".into()); }
                let index = event["output_index"].as_u64().filter(|i| *i < 100).ok_or("Indice de réponse ChatGPT invalide.")?;
                let item = event["item"].as_object().ok_or("Élément de réponse ChatGPT invalide.")?;
                if completed_items.insert(index, Value::Object(item.clone())).is_some() { return Err("Élément de réponse ChatGPT dupliqué.".into()); }
            },
            Some("response.completed") if event["response"]["status"] == "completed" => {
                if result.is_some() { return Err("Réponse ChatGPT dupliquée.".into()); }
                let final_output = event["response"]["output"].as_array().ok_or("Réponse ChatGPT sans texte.")?;
                // This route can omit output from its terminal event. Completed
                // items carry the text, but are usable only after response.completed.
                let streamed_output = completed_items.values().cloned().collect::<Vec<_>>();
                let output = if final_output.is_empty() { &streamed_output } else { final_output };
                let mut texts = Vec::new();
                for item in output {
                    match item["type"].as_str() {
                        Some("reasoning") => {},
                        Some("message") if item["role"] == "assistant" => {
                            for part in item["content"].as_array().ok_or("Message ChatGPT invalide.")? {
                                if part["type"] != "output_text" { return Err("Réponse ChatGPT non textuelle.".into()); }
                                texts.push(part["text"].as_str().ok_or("Texte ChatGPT invalide.")?);
                            }
                        },
                        _ => return Err("Action externe ChatGPT refusée.".into()),
                    }
                }
                if texts.len() != 1 || texts[0].len() > 256_000 { return Err("Réponse ChatGPT inattendue.".into()); }
                result = Some(serde_json::from_str(texts[0]).map_err(|_| "Format ChatGPT invalide.")?);
            },
            Some("response.completed") => return Err("Réponse ChatGPT incomplète.".into()),
            _ => {},
        }
    }
    result.ok_or("ChatGPT n’a pas terminé la demande. Aucun résultat n’a été appliqué.".into())
}
pub async fn text_json(instructions: &str, input: &str, schema_name: &str, schema: Value, _max_output_tokens: u32) -> Result<Value, String> {
    // The subscription route rejects max_output_tokens. Output sizes remain
    // bounded by transport limits and the calling document validators.
    guarded_inference(sessions().subscribe(), access(), |token| text_request(token, instructions, input, schema_name, schema)).await
}
async fn guarded_inference<F, R>(mut session: tokio::sync::watch::Receiver<u64>, credential: F, request: impl FnOnce(String) -> R) -> Result<Value, String>
where F: std::future::Future<Output = Result<String, String>>, R: std::future::Future<Output = Result<Value, String>> {
    // Finish an already submitted refresh through atomic persistence. Logout waits
    // on its credential lock and then revokes the latest rotating refresh token.
    let token = credential.await?;
    if session.has_changed().unwrap_or(true) { return Err("Connexion ChatGPT modifiée. La demande a été annulée.".into()); }
    tokio::select! { biased;
        _ = session.changed() => Err("Connexion ChatGPT modifiée. La demande a été annulée.".into()),
        result = request(token) => result
    }
}
fn request_body(model: &str, instructions: &str, input: &str, schema_name: &str, schema: Value) -> Value {
    json!({"model": model, "store": false, "stream": true, "instructions": instructions,
        "input": [{"role":"user","content":input}],
        "text":{"format":{"type":"json_schema","name":schema_name,"strict":true,"schema":schema}}})
}
async fn text_request(token: String, instructions: &str, input: &str, schema_name: &str, schema: Value) -> Result<Value, String> {
    let cli = client()?;
    let catalog = json_response(cli.get(format!("{RESOURCE}/models")).bearer_auth(&token).send().await.map_err(|_| "Catalogue de l’abonnement indisponible.")?).await?;
    let models = catalog["models"].as_array().ok_or("Catalogue d’abonnement ChatGPT invalide.")?;
    let visible = models.iter().filter(|m| m["visibility"] == "list").filter_map(|m| m["slug"].as_str()).collect::<Vec<_>>();
    let model = ["gpt-6-luna", "gpt-6.1-sol"].iter().find(|m| visible.contains(m)).copied()
        .or_else(|| visible.first().copied()).ok_or("Aucun modèle disponible pour cet abonnement.")?;
    let body = request_body(model, instructions, input, schema_name, schema);
    let mut response = cli.post(format!("{RESOURCE}/responses")).bearer_auth(token).json(&body).send().await.map_err(|_| "Demande ChatGPT impossible.")?;
    if !response.status().is_success() { return Err(http_error(response).await); }
    let mut bytes = Vec::new();
    while let Some(chunk) = response.chunk().await.map_err(|_| "Réponse ChatGPT interrompue.")? {
        if bytes.len() + chunk.len() > 2_000_000 { return Err("Réponse ChatGPT trop longue.".into()); } bytes.extend_from_slice(&chunk);
    }
    stream_result(&bytes)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn subscription_body_omits_unsupported_fields_and_keeps_structured_transport() {
        let schema = json!({"type":"object","properties":{"text":{"type":"string"}},"required":["text"],"additionalProperties":false});
        let body = request_body("account-model", "Preserve facts", "Synthetic source", "rewritten_line", schema.clone());
        for field in ["background", "conversation", "max_output_tokens", "max_tool_calls", "metadata", "moderation", "multi_agent", "prompt", "prompt_cache_retention", "safety_identifier", "temperature", "top_logprobs", "top_p", "truncation", "user", "previous_response_id"] {
            assert!(body.get(field).is_none(), "Unsupported subscription field: {field}");
        }
        assert_eq!(body["model"], "account-model");
        assert_eq!(body["store"], false);
        assert_eq!(body["stream"], true);
        assert_eq!(body["instructions"], "Preserve facts");
        assert_eq!(body["input"][0]["content"], "Synthetic source");
        assert_eq!(body["text"]["format"]["schema"], schema);
        assert_eq!(body["text"]["format"]["strict"], true);
    }
    #[test]
    fn http_errors_distinguish_request_format_from_subscription_denial_without_echoing_text() {
        let body = br#"{"error":{"code":"subscription_sharing_unsupported_capability","param":"max_output_tokens","message":"private source must not be echoed"}}"#;
        let error = provider_error(400, body, Some("req_synthetic"));
        assert!(error.contains("max_output_tokens") && error.contains("HTTP 400") && error.contains("req_synthetic"));
        assert!(!error.contains("private source"));
        let denied = provider_error(403, br#"{"error":{"code":"subscription_sharing_user_not_eligible"}}"#, None);
        assert!(denied.contains("pas autorisée") && denied.contains("HTTP 403"));
        let malformed = provider_error(400, b"invalid body sk-private", Some("unsafe\nheader"));
        assert!(malformed.contains("format") && !malformed.contains("sk-private") && !malformed.contains("unsafe"));
        assert!(diagnostic_identifier(Some(&"x".repeat(161))).is_none());
    }
    #[test]
    fn completed_stream_items_supply_text_only_after_a_successful_terminal_event() {
        let item = json!({"type":"response.output_item.done","output_index":0,"item":{"type":"message","role":"assistant","content":[{"type":"output_text","text":"{\"text\":\"Escalier\"}"}]}});
        let done = json!({"type":"response.completed","response":{"status":"completed","output":[]}});
        let prefix = format!("data: {item}\n\n");
        let complete = format!("{prefix}data: {done}\n\n");
        assert_eq!(stream_result(complete.as_bytes()).unwrap()["text"], "Escalier");
        assert!(stream_result(prefix.as_bytes()).is_err());
        assert!(stream_result(format!("{prefix}data: {{\"type\":\"response.failed\"}}\n\n").as_bytes()).is_err());
        assert!(stream_result(format!("{prefix}{prefix}data: {done}\n\n").as_bytes()).is_err());
        let mut tool = item.clone(); tool["item"]["type"] = json!("function_call");
        assert!(stream_result(format!("data: {tool}\n\ndata: {done}\n\n").as_bytes()).is_err());
        assert!(stream_result(format!("{complete}data: {item}\n\n").as_bytes()).is_err());
    }
    #[tokio::test]
    #[ignore = "Explicit local subscription acceptance only; synthetic inputs, no API billing"]
    async fn live_subscription_document_workflows() {
        assert_eq!(std::env::var("INVOICE_SUBSCRIPTION_PROBE").as_deref(), Ok("1"), "Explicit subscription probe opt-in required");
        let directory = PathBuf::from(std::env::var_os("LOCALAPPDATA").expect("Windows user directory"))
            .join("ca.hermitage.invoice-company-app/subscription-auth");
        configure(directory);
        assert!(has_connection().unwrap(), "Sign in privately in the app first");
        let rewritten = crate::ai::rewrite_line("chatgpt", "Escalier en chêne, quatre marches. Installation comprise.", "bullets", 0).await.expect("Completed subscription rewrite");
        assert!(rewritten.contains("chêne") && (rewritten.contains('4') || rewritten.contains("quatre")) && rewritten.to_lowercase().contains("installation"));
        println!("LIVE PASS: completed rewrite, source facts retained");
        let descriptions = vec!["Escalier en chêne, quatre marches. Installation comprise.".into()];
        let translated = crate::ai::translate("chatgpt", "Escalier de démonstration", "", &descriptions).await.expect("Completed subscription translation");
        assert_eq!(translated.descriptions.len(), 1);
        assert!(translated.notes.is_empty());
        assert!(translated.descriptions[0].to_lowercase().contains("oak") && translated.descriptions[0].to_lowercase().contains("installation"));
        println!("LIVE PASS: completed English translation, line count and empty notes retained");
        let update = crate::ai::extract_document("chatgpt", "Le client est Client Démonstration. Le projet est Escalier de démonstration. Un article : escalier en chêne. Quantité deux. Prix unitaire cent dollars.").await.expect("Completed subscription extraction");
        assert_eq!(update.client.as_deref(), Some("Client Démonstration"));
        assert_eq!(update.items.len(), 1);
        assert_eq!(update.items[0].quantity.as_deref(), Some("2"));
        assert_eq!(update.items[0].price.as_deref(), Some("100"));
        assert!(update.date.is_none() && update.address.is_none());
        println!("LIVE PASS: completed form extraction, quantity and price identified, absent facts not invented");
    }
    #[tokio::test]
    async fn logout_finishes_refresh_persistence_but_never_starts_inference() {
        use std::sync::{Arc, atomic::{AtomicBool, Ordering}};
        let (session, receiver) = tokio::sync::watch::channel(0);
        let (submitted, has_submitted) = tokio::sync::oneshot::channel();
        let (release, wait_release) = tokio::sync::oneshot::channel();
        let persisted = Arc::new(AtomicBool::new(false));
        let sent = Arc::new(AtomicBool::new(false));
        let saved = persisted.clone(); let transmitted = sent.clone();
        let work = tokio::spawn(guarded_inference(receiver, async move {
            submitted.send(()).unwrap();
            wait_release.await.unwrap();
            saved.store(true, Ordering::SeqCst);
            Ok("rotated-subscription-token".into())
        }, move |_| async move { transmitted.store(true, Ordering::SeqCst); Ok(json!({"text":"unexpected"})) }));
        has_submitted.await.unwrap();
        session.send(1).unwrap(); // Logout during a submitted rotating refresh.
        release.send(()).unwrap();
        assert!(work.await.unwrap().is_err());
        assert!(persisted.load(Ordering::SeqCst));
        assert!(!sent.load(Ordering::SeqCst));
    }
    #[tokio::test]
    async fn native_login_uses_opaque_attempt_and_wrong_callback_cannot_finish_it() {
        let directory = tempfile::tempdir().unwrap();
        configure(directory.path().to_path_buf());
        let id = start().await.unwrap();
        assert!(!id.contains("http"));
        assert!(pending());
        assert!(open_login_url("not-the-current-attempt").is_err());
        let login_url = LOGIN.lock().unwrap().url.clone().unwrap();
        let url = Url::parse(&login_url).unwrap();
        let query: HashMap<_,_> = url.query_pairs().into_owned().collect();
        assert_eq!(query["client_id"], "dynamic_agent_client");
        assert_eq!(query["code_challenge_method"], "S256");
        let redirect = Url::parse(&query["redirect_uri"]).unwrap();
        let mut socket = tokio::net::TcpStream::connect(("127.0.0.1", redirect.port().unwrap())).await.unwrap();
        socket.write_all(b"GET /auth/callback?state=wrong&code=synthetic&client_id=oaiapp_fake HTTP/1.1\r\nHost: 127.0.0.1\r\n\r\n").await.unwrap();
        let mut reply = Vec::new();
        tokio::time::timeout(Duration::from_secs(3), socket.read_to_end(&mut reply)).await.unwrap().unwrap();
        assert!(reply.starts_with(b"HTTP/1.1 400"));
        assert!(pending());
        assert!(!has_connection().unwrap());
        cancel().unwrap();
        assert!(!pending());
        assert!(open_login_url(&id).is_err());
        // A damaged credential file can be cleared without decrypting it.
        std::fs::write(path("chatgpt.dpapi").unwrap(), b"damaged credential").unwrap();
        assert!(!has_connection().unwrap());
        assert!(credential_error().is_some());
        assert!(disconnect().await.unwrap().is_some());
        assert!(!path("chatgpt.dpapi").unwrap().exists());
    }
    fn attempt() -> Attempt { Attempt { state: "expected".into(), nonce: "nonce".into(), verifier: "verifier".into(), redirect: "http://127.0.0.1:1234/auth/callback".into(), client_id: None, previous_subject: None, host_id: "host".into() } }
    #[test] fn callback_rejects_wrong_state_client_errors_duplicates_and_missing_codes() {
        let a = attempt();
        assert_eq!(callback_values("/auth/callback?state=expected&code=one&client_id=oaiapp_example", &a).unwrap().1, "oaiapp_example");
        for target in ["/auth/callback?state=wrong&code=one&client_id=oaiapp_example", "/auth/callback?state=expected&error=access_denied", "/auth/callback?state=expected&code=one&client_id=dynamic_agent_client", "/auth/callback?state=expected&code=one", "/auth/callback?state=expected&state=expected&code=one&client_id=oaiapp_example", "/auth/callback?state=expected&client_id=oaiapp_example"] { assert!(callback_values(target, &a).is_err()); }
        let mut returning = attempt(); returning.client_id = Some("oaiapp_old".into());
        assert!(callback_values("/auth/callback?state=expected&code=one&client_id=oaiapp_other", &returning).is_err());
        assert!(callback_values("/auth/callback?state=expected&code=one", &returning).is_ok());
    }
    #[test] fn rejects_missing_subscription_grant_and_invalid_nonce() {
        let build = |scope: &str| Tokens { access_token:"synthetic".into(), refresh_token:"synthetic".into(), id_token:"id".into(), token_type:"Bearer".into(), expires_in:3600, scope:Some(scope.into()) };
        assert!(credentials_from_tokens(build("openid profile email"), "oaiapp_test".into(), "host".into(), "subject".into(), None).is_err());
        assert!(credentials_from_tokens(build("chatgpt.tokens.use.direct resource.invoke"), "oaiapp_test".into(), "host".into(), "subject".into(), None).is_ok());
        let identity = Identity { sub:"test".into(), nonce:Some("nonce".into()), iat:1, exp:2 };
        assert!(validate_identity_claims(&identity, Some("wrong")).is_err());
    }
    #[test] fn streams_require_completed_json_and_reject_failure_after_deltas() {
        let completed = json!({"type":"response.completed","response":{"status":"completed","output":[{"type":"message","role":"assistant","content":[{"type":"output_text","text":"{\"text\":\"Escalier\"}"}]}]}});
        let bytes = format!("data: {completed}\n\n");
        assert_eq!(stream_result(bytes.as_bytes()).unwrap()["text"], "Escalier");
        assert!(stream_result(b"data: {\"type\":\"response.output_text.delta\",\"delta\":\"partial\"}\n\n").is_err());
        assert!(stream_result(format!("{bytes}data: {{\"type\":\"response.failed\"}}\n\n").as_bytes()).is_err());
        assert!(stream_result(format!("{bytes}{bytes}").as_bytes()).is_err());
        let mut tool = completed; tool["response"]["output"][0]["type"] = json!("function_call");
        assert!(stream_result(format!("data: {tool}\n\n").as_bytes()).is_err());
    }
    #[cfg(windows)] #[test] fn windows_encrypts_large_tokens_and_rejects_corruption() {
        let plaintext = vec![b'Q'; 16_000];
        let cipher = protect(&plaintext, false).unwrap();
        assert_ne!(cipher, plaintext); assert_eq!(protect(&cipher, true).unwrap(), plaintext);
        let mut corrupt = cipher; corrupt[20] ^= 1; assert!(protect(&corrupt, true).is_err());
    }
}
