use serde::{Deserialize, Serialize};
use regex::Regex;
use crate::{Draft, AppResult};

pub const RULE: &str = "qc-on-2026-10-01";
#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all="camelCase", deny_unknown_fields)]
pub struct Rate { pub code: String, pub rate_millionths: u32 }
#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all="camelCase")]
pub struct TaxAmount {pub code:String,pub rate_millionths:u32,pub cents:u64}
#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all="camelCase")]
pub struct Totals {pub subtotal_cents:u64,pub lines:Vec<TaxAmount>,pub total_cents:u64,pub paid_cents:u64,pub balance_cents:u64}
#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all="camelCase", deny_unknown_fields)]
pub struct Tax {
    pub schema_version: u32, pub rule_version: String,
    pub fulfillment: String, pub selection: String,
    pub province: Option<String>, pub basis: String, pub status: String, pub rates: Vec<Rate>,
}
pub fn fresh() -> Tax {
    Tax {schema_version:1,rule_version:RULE.into(),fulfillment:"installation".into(),selection:"auto".into(),province:None,basis:"address".into(),status:"unresolved".into(),rates:vec![]}
}
/// Migrate only an editable draft copy, including the editor copy of an issued invoice.
/// Callers must never apply this to saved versions, export snapshots or pending PDFs.
pub fn migrate_editable(draft: &mut Draft) -> bool {
    if draft.tax.as_ref().is_some_and(|tax| tax.selection != "legacy") {
        return false;
    }
    let mut tax = draft.tax.clone().unwrap_or_else(fresh);
    tax.selection = "auto".into();
    draft.tax = Some(tax);
    draft.tax = Some(resolve(draft));
    true
}
fn matches(pattern:&str, text:&str) -> bool { Regex::new(pattern).unwrap().is_match(text) }
pub fn province(address:&str) -> Option<&'static str> {
    let text=address.trim().to_uppercase().replace(['É','È','Ê','Ë'],"E").replace(['À','Â','Ä'],"A").replace('Î',"I").replace('Ô',"O").replace('Û',"U").replace('Ç',"C");
    if matches(r"\b(?:USA|US|UNITED STATES|ETATS[- ]UNIS|CALIFORNIA|CALIFORNIE)\b",&text) { return Some("outside"); }
    let text=Regex::new(r"\b(?:RUE|STREET|ST|AVENUE|AVE|CHEMIN|ROAD|RD|BOULEVARD|BLVD)\s+(?:ONTARIO|QUEBEC)\b").unwrap().replace_all(&text,"STREET").to_string();
    let clues=Regex::new(r"\b(QUEBEC|QC|ONTARIO|ON)\b").unwrap();
    let mut qc=false;let mut on=false;
    for clue in clues.captures_iter(&text) { if matches!(clue.get(1).unwrap().as_str(),"QC"|"QUEBEC") {qc=true;}else{on=true;} }
    if qc && on {return None;}
    let text=Regex::new(r"[,\s]+CANADA\s*$").unwrap().replace(&text,"").trim().to_string();
    if matches(r"\b(?:BC|BRITISH COLUMBIA|COLOMBIE[- ]BRITANNIQUE|AB|ALBERTA|MB|MANITOBA|SK|SASKATCHEWAN|NB|NEW BRUNSWICK|NOUVEAU[- ]BRUNSWICK|NS|NOVA SCOTIA|NOUVELLE[- ]ECOSSE|PE|PEI|PRINCE EDWARD ISLAND|NL|NEWFOUNDLAND|TERRE[- ]NEUVE|NT|NWT|NUNAVUT|NU|YUKON|YT)\b(?:\W+[A-Z]\d[A-Z]\s*\d[A-Z]\d)?[\s,)]*$",&text) {return Some("outside");}
    let re=Regex::new(r"(?:^|[\s,(])(QUEBEC|QC|ONTARIO|ON)[\s,)]*(?:[A-Z]\d[A-Z]\s*\d[A-Z]\d)?\s*$").unwrap();
    re.captures(&text).map(|c|if matches!(c.get(1).unwrap().as_str(),"QC"|"QUEBEC"){"QC"}else{"ON"})
}
pub fn resolve(draft:&Draft) -> Tax {
    let mut result=draft.tax.clone().unwrap_or_else(||{let mut t=fresh();t.selection="legacy".into();t});
    result.schema_version=1;result.rule_version=RULE.into();
    let (location,basis)=match result.selection.as_str() {
        "QC" => (Some("QC"),"manual"), "ON" => (Some("ON"),"manual"),
        "legacy" => (Some("QC"),"legacy"),
        _ if result.fulfillment=="pickup" => (Some("QC"),"shop"),
        _ if !draft.ship_to.trim().is_empty() => (province(&draft.ship_to),"shipTo"),
        _ => (province(&draft.address),"address"),
    };
    result.basis=basis.into();result.status=match location {Some("outside")=>"unsupported",Some(_)=>"resolved",None=>"unresolved"}.into();
    result.province=location.filter(|p|*p!="outside").map(str::to_string);
    result.rates=match location {
        Some("QC")=>vec![Rate{code:"GST".into(),rate_millionths:50000},Rate{code:"QST".into(),rate_millionths:99750}],
        Some("ON")=>vec![Rate{code:"HST".into(),rate_millionths:130000}],_=>vec![],
    };result
}
pub fn validate(draft:&Draft) -> AppResult<()> {
    let Some(tax)=&draft.tax else {return Ok(());};
    if !matches!(tax.fulfillment.as_str(),"installation"|"delivery"|"pickup") || !matches!(tax.selection.as_str(),"auto"|"QC"|"ON"|"legacy") || tax != &resolve(draft) {
        return Err("Choix ou instantané des taxes invalide. Vérifier les taxes du document.".into());
    }Ok(())
}
pub fn validate_export(draft:&Draft) -> AppResult<()> {
    // Export validates the editable view; historical resolve/totals retain legacy QC.
    let mut editable = draft.clone();
    migrate_editable(&mut editable);
    validate(&editable)?;let tax=resolve(&editable);
    if tax.status!="resolved" {return Err("Confirmer les taxes Québec/Ontario avant de créer le PDF. Pour un autre territoire, préparer une facture personnalisée séparément.".into());}
    let subtotal:f64=draft.items.iter().map(|item|crate::parse_nonnegative(&item.quantity).unwrap_or(0.0)*crate::parse_nonnegative(&item.price).unwrap_or(0.0)).sum();
    let cents=((subtotal+f64::EPSILON)*100.0).round();
    if !cents.is_finite() || cents>9_007_199_254_740_991.0 {return Err("Montant trop élevé pour le document.".into());}
    let base=cents as u128;let total=base+tax.rates.iter().map(|r|(base*u128::from(r.rate_millionths)+500_000)/1_000_000).sum::<u128>();
    if total>9_007_199_254_740_991 {return Err("Montant trop élevé pour le document.".into());}
    Ok(())
}
pub fn totals(draft:&Draft)->Option<Totals> {
    let tax=resolve(draft);if tax.status!="resolved"{return None;}
    let subtotal:f64=draft.items.iter().map(|item|crate::parse_nonnegative(&item.quantity).unwrap_or(0.0)*crate::parse_nonnegative(&item.price).unwrap_or(0.0)).sum();
    let cents=((subtotal+f64::EPSILON)*100.0).round();if !cents.is_finite()||cents>9_007_199_254_740_991.0{return None;}
    let subtotal_cents=cents as u64;
    let lines:Vec<TaxAmount>=tax.rates.iter().map(|rate|TaxAmount{code:rate.code.clone(),rate_millionths:rate.rate_millionths,cents:((u128::from(subtotal_cents)*u128::from(rate.rate_millionths)+500_000)/1_000_000) as u64}).collect();
    let total_cents=subtotal_cents+lines.iter().map(|line|line.cents).sum::<u64>();if total_cents>9_007_199_254_740_991{return None;}
    let round=|value:&str|((crate::parse_nonnegative(value).unwrap_or(0.0)+f64::EPSILON)*100.0).round() as u64;
    let paid_cents=draft.payments.as_ref().map_or_else(||round(&draft.deposit),|rows|rows.iter().map(|row|round(&row.amount)).sum());
    Some(Totals{subtotal_cents,lines,total_cents,paid_cents,balance_cents:total_cents.saturating_sub(paid_cents)})
}
