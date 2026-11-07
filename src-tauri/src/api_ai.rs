//! Direct API-key calls: OpenAI (Responses API) and Anthropic (Messages API).
//! Keys come from the Windows credential vault; no login, no token refresh.
use reqwest::{Client, Url};
use serde_json::{json, Value};
use std::{sync::Mutex, time::Duration};

const OPENAI_BASE: &str = "https://api.openai.com/v1";
const CLAUDE_URL: &str = "https://api.anthropic.com/v1/messages";
const CLAUDE_MODEL: &str = "claude-sonnet-5-5";
const OPENAI_PREFERRED: [&str; 6] = ["gpt-6-luna", "gpt-6.1-sol", "gpt-5.5-mini", "gpt-5-mini", "gpt-4.1-mini", "gpt-4o-mini"];
const RESPONSE_LIMIT: usize = 4 * 1024 * 1024;
static OPENAI_MODEL: Mutex<Option<String>> = Mutex::new(None);

/// Call after the OpenAI key changes so the model is looked up again for the new key.
pub fn forget_openai_model() { if let Ok(mut model) = OPENAI_MODEL.lock() { *model = None; } }

fn client() -> Result<Client, String> {
    Client::builder().redirect(reqwest::redirect::Policy::none())
        .connect_timeout(Duration::from_secs(10)).timeout(Duration::from_secs(120))
        .user_agent("invoice-company-app/api-key").build()
        .map_err(|_| "Connexion au service IA indisponible.".into())
}

fn identifier(value: Option<&str>) -> Option<String> {
    value.filter(|s| !s.is_empty() && s.len() <= 120 && s.chars().all(|c| c.is_ascii_alphanumeric() || "_.:-".contains(c))).map(str::to_owned)
}

/// Plain-French explanation of an HTTP failure. Response bodies are never echoed.
fn http_message(service: &str, status: u16, body: &[u8]) -> String {
    let value: Value = serde_json::from_slice(body).unwrap_or(Value::Null);
    let code = identifier(value["error"]["code"].as_str()).or_else(|| identifier(value["error"]["type"].as_str()));
    let explanation = match status {
        401 => format!("{service} a refusé la clé API. Vérifiez-la dans les réglages IA."),
        403 => format!("Cette clé API n’a pas accès à ce service {service}."),
        402 => format!("Le crédit du compte {service} est épuisé."),
        429 if code.as_deref() == Some("insufficient_quota") => format!("Le crédit du compte {service} est épuisé."),
        429 => format!("Limite d’utilisation de {service} atteinte. Réessayez dans un instant."),
        400 | 404 | 422 => format!("{service} a rejeté la demande."),
        500..=599 => format!("{service} est temporairement indisponible. Réessayez."),
        _ => format!("{service} a refusé la demande."),
    };
    match code { Some(code) => format!("{explanation} (HTTP {status} ; {code})"), None => format!("{explanation} (HTTP {status})") }
}

async fn read_body(mut response: reqwest::Response, service: &str) -> Result<Vec<u8>, String> {
    let status = response.status().as_u16();
    let ok = response.status().is_success();
    let mut bytes = Vec::new();
    while let Some(chunk) = response.chunk().await.map_err(|_| format!("Réponse {service} interrompue."))? {
        if bytes.len() + chunk.len() > RESPONSE_LIMIT {
            if ok { return Err(format!("Réponse {service} trop volumineuse.")); }
            bytes.clear(); break;
        }
        bytes.extend_from_slice(&chunk);
    }
    if !ok { return Err(http_message(service, status, &bytes)); }
    Ok(bytes)
}

/// Drops schema keywords the providers' structured-output modes reject (the
/// callers validate lengths themselves) and, for Claude, rewrites ["x","null"]
/// into anyOf.
fn clean_schema(schema: &Value, any_of_nullable: bool) -> Value {
    match schema {
        Value::Object(map) => {
            let mut out = serde_json::Map::new();
            for (key, value) in map {
                if matches!(key.as_str(), "maxLength" | "minLength" | "maxItems" | "minItems" | "minimum" | "maximum" | "pattern" | "format") { continue; }
                out.insert(key.clone(), clean_schema(value, any_of_nullable));
            }
            if any_of_nullable {
                if let Some(Value::Array(types)) = out.get("type").cloned() {
                    if types.len() == 2 && types.iter().any(|t| t == "null") {
                        let other = types.iter().find(|t| *t != "null").cloned().unwrap_or(json!("string"));
                        out.remove("type");
                        out.insert("anyOf".into(), json!([{"type": other}, {"type": "null"}]));
                    }
                }
            }
            Value::Object(out)
        }
        Value::Array(items) => Value::Array(items.iter().map(|v| clean_schema(v, any_of_nullable)).collect()),
        other => other.clone(),
    }
}

fn parse_json_text(text: &str, service: &str) -> Result<Value, String> {
    if text.len() > 256_000 { return Err(format!("Réponse {service} trop longue.")); }
    serde_json::from_str(text.trim()).map_err(|_| format!("{service} n’a pas renvoyé le format attendu."))
}

// ---- OpenAI ----

fn pick_openai_model(ids: &[&str]) -> Option<String> {
    if let Some(found) = OPENAI_PREFERRED.iter().find(|m| ids.contains(m)) { return Some((*found).to_owned()); }
    let mut fallback: Vec<&str> = ids.iter().copied().filter(|id| id.starts_with("gpt-")
        && !["audio", "realtime", "image", "transcribe", "tts", "search", "codex", "instruct", "embedding", "moderation", "preview", "chat-latest"].iter().any(|bad| id.contains(bad))).collect();
    fallback.sort_unstable();
    fallback.first().map(|s| (*s).to_owned())
}

async fn openai_model(cli: &Client, key: &str) -> Result<String, String> {
    if let Some(model) = OPENAI_MODEL.lock().ok().and_then(|m| m.clone()) { return Ok(model); }
    let response = cli.get(format!("{OPENAI_BASE}/models")).bearer_auth(key).send().await
        .map_err(|_| "OpenAI est injoignable. Vérifiez la connexion internet.")?;
    let body: Value = serde_json::from_slice(&read_body(response, "OpenAI").await?).map_err(|_| "Liste de modèles OpenAI invalide.")?;
    let ids: Vec<&str> = body["data"].as_array().map(|a| a.iter().filter_map(|m| m["id"].as_str()).collect()).unwrap_or_default();
    let model = pick_openai_model(&ids).ok_or("Cette clé OpenAI n’a accès à aucun modèle de texte compatible.")?;
    if let Ok(mut cached) = OPENAI_MODEL.lock() { *cached = Some(model.clone()); }
    Ok(model)
}

fn openai_body(model: &str, instructions: &str, input: &str, schema_name: &str, schema: &Value) -> Value {
    json!({"model": model, "store": false, "instructions": instructions, "input": input,
        "text": {"format": {"type": "json_schema", "name": schema_name, "strict": true, "schema": clean_schema(schema, false)}}})
}

fn openai_result(bytes: &[u8]) -> Result<Value, String> {
    let value: Value = serde_json::from_slice(bytes).map_err(|_| "Réponse OpenAI invalide.")?;
    if value["status"] != "completed" { return Err("OpenAI n’a pas terminé la demande. Aucun résultat n’a été appliqué.".into()); }
    let mut texts = Vec::new();
    for item in value["output"].as_array().ok_or("Réponse OpenAI sans texte.")? {
        match item["type"].as_str() {
            Some("reasoning") => {},
            Some("message") => for part in item["content"].as_array().ok_or("Message OpenAI invalide.")? {
                match part["type"].as_str() {
                    Some("output_text") => texts.push(part["text"].as_str().ok_or("Texte OpenAI invalide.")?),
                    Some("refusal") => return Err("OpenAI a refusé cette demande.".into()),
                    _ => return Err("Réponse OpenAI non textuelle.".into()),
                }
            },
            _ => return Err("Réponse OpenAI inattendue.".into()),
        }
    }
    if texts.len() != 1 { return Err("Réponse OpenAI inattendue.".into()); }
    parse_json_text(texts[0], "OpenAI")
}

pub async fn openai_json(key: &str, instructions: &str, input: &str, schema_name: &str, schema: &Value) -> Result<Value, String> {
    let cli = client()?;
    let model = openai_model(&cli, key).await?;
    let body = openai_body(&model, instructions, input, schema_name, schema);
    let response = cli.post(format!("{OPENAI_BASE}/responses")).bearer_auth(key).json(&body).send().await
        .map_err(|_| "OpenAI est injoignable. Vérifiez la connexion internet.")?;
    openai_result(&read_body(response, "OpenAI").await?)
}

// ---- Claude ----

fn claude_body(instructions: &str, input: &str, schema: &Value, max_tokens: u32) -> Value {
    json!({"model": CLAUDE_MODEL, "max_tokens": max_tokens.max(8000), "system": instructions,
        "messages": [{"role": "user", "content": input}],
        "output_config": {"effort": "low", "format": {"type": "json_schema", "schema": clean_schema(schema, true)}}})
}

fn claude_result(bytes: &[u8]) -> Result<Value, String> {
    let value: Value = serde_json::from_slice(bytes).map_err(|_| "Réponse Claude invalide.")?;
    match value["stop_reason"].as_str() {
        Some("end_turn") => {},
        Some("refusal") => return Err("Claude a refusé cette demande.".into()),
        Some("max_tokens") => return Err("La réponse de Claude a été coupée. Réduisez le texte et réessayez.".into()),
        _ => return Err("Claude n’a pas terminé la demande. Aucun résultat n’a été appliqué.".into()),
    }
    let mut texts = Vec::new();
    for block in value["content"].as_array().ok_or("Réponse Claude sans texte.")? {
        match block["type"].as_str() {
            Some("text") => texts.push(block["text"].as_str().ok_or("Texte Claude invalide.")?),
            Some("thinking" | "redacted_thinking") => {},
            _ => return Err("Réponse Claude inattendue.".into()),
        }
    }
    if texts.len() != 1 { return Err("Réponse Claude inattendue.".into()); }
    parse_json_text(texts[0], "Claude")
}

pub async fn claude_json(key: &str, instructions: &str, input: &str, schema: &Value, max_tokens: u32) -> Result<Value, String> {
    let cli = client()?;
    let url = Url::parse(CLAUDE_URL).map_err(|_| "Adresse Claude invalide.")?;
    let response = cli.post(url).header("x-api-key", key).header("anthropic-version", "2023-06-01")
        .json(&claude_body(instructions, input, schema, max_tokens)).send().await
        .map_err(|_| "Claude est injoignable. Vérifiez la connexion internet.")?;
    claude_result(&read_body(response, "Claude").await?)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn schema_cleaning_drops_limits_and_rewrites_nullable_for_claude_only() {
        let schema = json!({"type":"object","properties":{"text":{"type":"string","maxLength":50000},"note":{"type":["string","null"]}},"required":["text","note"],"additionalProperties":false});
        let openai = clean_schema(&schema, false);
        assert!(openai["properties"]["text"].get("maxLength").is_none());
        assert_eq!(openai["properties"]["note"]["type"], json!(["string","null"]));
        let claude = clean_schema(&schema, true);
        assert_eq!(claude["properties"]["note"]["anyOf"], json!([{"type":"string"},{"type":"null"}]));
        assert!(claude["properties"]["note"].get("type").is_none());
        assert_eq!(claude["additionalProperties"], false);
    }

    #[test]
    fn openai_model_prefers_known_models_and_skips_non_text_models() {
        assert_eq!(pick_openai_model(&["gpt-4o-mini", "gpt-6-luna", "whisper-1"]).as_deref(), Some("gpt-6-luna"));
        assert_eq!(pick_openai_model(&["whisper-1", "gpt-image-2", "gpt-realtime", "text-embedding-3-small"]), None);
        assert_eq!(pick_openai_model(&["gpt-image-2", "gpt-7-mini"]).as_deref(), Some("gpt-7-mini"));
    }

    #[test]
    fn openai_request_is_stateless_strict_json() {
        let schema = json!({"type":"object","properties":{"text":{"type":"string"}},"required":["text"],"additionalProperties":false});
        let body = openai_body("m", "Instr", "Source", "rewritten_line", &schema);
        assert_eq!(body["store"], false);
        assert_eq!(body["text"]["format"]["strict"], true);
        assert_eq!(body["input"], "Source");
        assert!(body.get("max_output_tokens").is_none() && body.get("stream").is_none());
    }

    #[test]
    fn openai_results_need_completed_single_text_and_reject_refusals() {
        let ok = json!({"status":"completed","output":[{"type":"reasoning"},{"type":"message","content":[{"type":"output_text","text":"{\"text\":\"Escalier\"}"}]}]});
        assert_eq!(openai_result(ok.to_string().as_bytes()).unwrap()["text"], "Escalier");
        let mut incomplete = ok.clone(); incomplete["status"] = json!("incomplete");
        assert!(openai_result(incomplete.to_string().as_bytes()).is_err());
        let refusal = json!({"status":"completed","output":[{"type":"message","content":[{"type":"refusal","refusal":"no"}]}]});
        assert!(openai_result(refusal.to_string().as_bytes()).is_err());
        let tool = json!({"status":"completed","output":[{"type":"function_call"}]});
        assert!(openai_result(tool.to_string().as_bytes()).is_err());
        let bad = json!({"status":"completed","output":[{"type":"message","content":[{"type":"output_text","text":"pas du JSON"}]}]});
        assert!(openai_result(bad.to_string().as_bytes()).is_err());
    }

    #[test]
    fn claude_request_uses_structured_output_without_forced_tools_or_sampling() {
        let schema = json!({"type":"object","properties":{"text":{"type":"string"}},"required":["text"],"additionalProperties":false});
        let body = claude_body("Instr", "Source", &schema, 4096);
        assert_eq!(body["model"], "claude-sonnet-5-5");
        assert_eq!(body["max_tokens"], 8000);
        assert_eq!(body["output_config"]["format"]["type"], "json_schema");
        for field in ["tools", "tool_choice", "temperature", "top_p", "top_k", "thinking"] { assert!(body.get(field).is_none(), "{field}"); }
    }

    #[test]
    fn claude_results_need_end_turn_single_text_and_reject_refusals_and_cutoffs() {
        let ok = json!({"stop_reason":"end_turn","content":[{"type":"thinking","thinking":""},{"type":"text","text":"{\"text\":\"Escalier\"}"}]});
        assert_eq!(claude_result(ok.to_string().as_bytes()).unwrap()["text"], "Escalier");
        for reason in ["refusal", "max_tokens", "tool_use", "pause_turn"] {
            let mut bad = ok.clone(); bad["stop_reason"] = json!(reason);
            assert!(claude_result(bad.to_string().as_bytes()).is_err(), "{reason}");
        }
        let tool = json!({"stop_reason":"end_turn","content":[{"type":"tool_use"}]});
        assert!(claude_result(tool.to_string().as_bytes()).is_err());
    }

    #[test]
    fn http_errors_are_plain_french_and_never_echo_bodies() {
        let quota = http_message("OpenAI", 429, br#"{"error":{"code":"insufficient_quota","message":"sk-private text"}}"#);
        assert!(quota.contains("crédit") && quota.contains("insufficient_quota") && !quota.contains("sk-private"));
        assert!(http_message("Claude", 401, b"sk-ant-private").contains("clé API"));
        assert!(!http_message("Claude", 401, b"sk-ant-private").contains("sk-ant-private"));
        assert!(http_message("Claude", 529, b"").contains("temporairement"));
    }
}
