use chrono::{Duration, Local, NaiveDate, Utc};
use fs2::FileExt;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    collections::{HashMap, HashSet},
    fs::{self, OpenOptions},
    io::Write,
    path::{Path, PathBuf},
    sync::Mutex,
};
use tauri::Manager;
use uuid::Uuid;

mod ai;
mod business_ai;
mod subscription_ai;
mod local_asr;
mod outlook;
mod taxes;
#[cfg(test)]
mod tax_tests;

type AppResult<T> = Result<T, String>;
const FIRST_INVOICE_NUMBER: u64 = 2060;
const MAX_INVOICE_NUMBER: u64 = 9_007_199_254_740_990;
const MAX_PDF_BYTES: usize = 25 * 1024 * 1024;
const MAX_RECORDS: usize = 10_000;
const MAX_SAVED_VERSIONS: usize = 1_000;
const MAX_NOTE_ENTRIES: usize = 500;
const MAX_NOTES_BYTES: usize = 50_000;

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum Kind {
    Soumission,
    Facture,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
pub struct Item {
    pub description: String,
    pub quantity: String,
    pub price: String,
    #[serde(default, rename = "pageBreakBefore", skip_serializing_if = "Option::is_none")]
    pub page_break_before: Option<bool>,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
pub struct Payment {
    pub amount: String,
    pub date: String,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct EnglishCopy {
    pub source_project: String,
    pub source_notes: String,
    pub source_descriptions: Vec<String>,
    pub project: String,
    pub notes: String,
    pub descriptions: Vec<String>,
    pub reviewed: bool,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Draft {
    pub id: String,
    pub kind: Kind,
    pub date: String,
    pub valid_until: String,
    pub due_date: String,
    pub client: String,
    pub ship_to: String,
    pub address: String,
    pub contact: String,
    pub email: String,
    pub project: String,
    pub notes: String,
    pub deposit: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub note_entries: Option<Vec<String>>,
    #[serde(default)]
    pub payments: Option<Vec<Payment>>,
    pub items: Vec<Item>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tax: Option<taxes::Tax>,
    #[serde(default)]
    pub english_copy: Option<EnglishCopy>,
    #[serde(default)]
    pub invoice_number: Option<u64>,
    #[serde(default)]
    pub manual_invoice_number: Option<u64>,
    #[serde(default)]
    pub issued_number: Option<u64>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportEntry {
    pub path: String,
    pub filename: String,
    pub exported_at: String,
    pub language: String,
    pub invoice_number: Option<u64>,
    #[serde(default)]
    pub pdf_sha256: Option<String>,
    #[serde(default)]
    pub snapshot: Option<Draft>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tax_totals: Option<taxes::Totals>,
    #[serde(default)]
    pub sent_receipts: Vec<outlook::SendReceipt>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SavedVersion {
    pub version_id: String,
    pub saved_at: String,
    pub snapshot: Draft,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DocumentVersion {
    pub id: String,
    #[serde(rename = "type")]
    pub version_type: String,
    pub created_at: Option<String>,
    pub draft: Option<Draft>,
    pub path: Option<String>,
    pub filename: Option<String>,
    pub language: Option<String>,
    pub restorable: bool,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ArchivedPdf {
    pub path: String,
    pub filename: String,
    pub pdf_bytes: Vec<u8>,
    pub integrity_verified: bool,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Record {
    pub id: String,
    pub draft: Draft,
    pub updated_at: String,
    pub exports: Vec<ExportEntry>,
    #[serde(default)]
    pub saved_versions: Vec<SavedVersion>,
    // Derived from associated archive receipts, never trusted from a cached JSON field.
    #[serde(skip_deserializing)]
    pub sent_at: Option<String>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StateResponse {
    pub current: Draft,
    pub current_pdf_path: Option<String>,
    pub records: Vec<Record>,
    pub next_invoice_number: u64,
    pub pdf_directory: String,
    pub using_default_directory: bool,
    pub invoice_pdf_directory: String,
    pub quote_pdf_directory: String,
    pub using_default_invoice_directory: bool,
    pub using_default_quote_directory: bool,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AiSettings {
    provider: String,
    chatgpt_configured: bool,
    business_configured: bool,
    auth_pending: bool,
    auth_error: Option<String>,
}

fn default_ai_provider() -> String { "chatgpt".into() }

fn ai_settings(provider: String) -> AppResult<AiSettings> {
    Ok(AiSettings {
        provider,
        chatgpt_configured: subscription_ai::has_connection()?,
        business_configured: ai::has_key("business")?,
        auth_pending: subscription_ai::pending(),
        auth_error: subscription_ai::login_error().or_else(subscription_ai::credential_error),
    })
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportResponse {
    pub path: String,
    pub filename: String,
    pub name_collision: bool,
    pub invoice_number: Option<u64>,
    pub snapshot: Draft,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct PendingExport {
    id: String,
    filename: String,
    invoice_number: Option<u64>,
    snapshot: Draft,
    language: String,
    pdf_sha256: String,
    exported_at: String,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct Store {
    schema_version: u32,
    generation: u64,
    current_id: String,
    next_invoice_number: u64,
    // An explicit reset may place the cursor below historical issued invoices.
    #[serde(default)]
    invoice_sequence_reset: bool,
    #[serde(default = "default_ai_provider")]
    ai_provider: String,
    #[serde(skip)]
    ai_provider_migrated: bool,
    #[serde(skip)]
    note_entries_migrated: bool,
    #[serde(default)]
    pdf_directory: Option<String>,
    #[serde(default)]
    invoice_pdf_directory: Option<String>,
    #[serde(default)]
    quote_pdf_directory: Option<String>,
    #[serde(default)]
    separate_pdf_directories: bool,
    records: Vec<Record>,
    versions: HashMap<String, Vec<Draft>>,
    pending_export: Option<PendingExport>,
}

fn blank_draft(kind: Kind) -> Draft {
    let today = Local::now().date_naive();
    Draft {
        id: Uuid::new_v4().to_string(),
        kind,
        date: today.format("%Y-%m-%d").to_string(),
        valid_until: (today + Duration::days(30)).format("%Y-%m-%d").to_string(),
        due_date: String::new(),
        client: String::new(),
        ship_to: String::new(),
        address: String::new(),
        contact: String::new(),
        email: String::new(),
        project: String::new(),
        notes: String::new(),
        deposit: String::new(),
        note_entries: Some(vec![]),
        payments: Some(vec![Payment { amount: String::new(), date: String::new() }]),
        items: vec![Item {
            description: String::new(),
            quantity: "1".into(),
            price: String::new(),
            page_break_before: None,
        }],
        english_copy: None,
        tax: Some(taxes::fresh()),
        invoice_number: (kind == Kind::Facture).then_some(FIRST_INVOICE_NUMBER),
        manual_invoice_number: None,
        issued_number: None,
    }
}

impl Store {
    fn fresh() -> Self {
        let draft = blank_draft(Kind::Soumission);
        Self {
            schema_version: 1,
            generation: 0,
            current_id: draft.id.clone(),
            next_invoice_number: FIRST_INVOICE_NUMBER,
            invoice_sequence_reset: false,
            ai_provider: default_ai_provider(),
            ai_provider_migrated: false,
            note_entries_migrated: false,
            pdf_directory: None,
            invoice_pdf_directory: None,
            quote_pdf_directory: None,
            separate_pdf_directories: true,
            records: vec![Record {
                id: draft.id.clone(),
                draft,
                updated_at: Utc::now().to_rfc3339(),
                exports: vec![],
                saved_versions: vec![],
                sent_at: None,
            }],
            versions: HashMap::new(),
            pending_export: None,
        }
    }

    fn index(&self, id: &str) -> AppResult<usize> {
        self.records
            .iter()
            .position(|record| record.id == id)
            .ok_or_else(|| "Document introuvable. Rechargez les documents récents.".to_string())
    }

    fn refresh_numbers(&mut self) {
        for record in &mut self.records {
            let draft = &mut record.draft;
            draft.invoice_number = if draft.kind == Kind::Facture {
                Some(draft.issued_number.or(draft.manual_invoice_number).unwrap_or(self.next_invoice_number))
            } else {
                None
            };
        }
    }

    fn response(&self, default_output_dir: &Path) -> AppResult<StateResponse> {
        let mut records = self.records.clone();
        for record in &mut records {
            record.sent_at = record.exports.iter().flat_map(|export| &export.sent_receipts)
                .max_by_key(|receipt| chrono::DateTime::parse_from_rfc3339(&receipt.accepted_at).ok())
                .map(|receipt| receipt.accepted_at.clone());
        }
        records.sort_by(|a, b| b.updated_at.cmp(&a.updated_at));
        let mut current = records
            .iter()
            .find(|record| record.id == self.current_id)
            .ok_or_else(|| "Le document courant est introuvable.".to_string())?
            .draft
            .clone();
        // Only the editor's active copy migrates. Library/history entries stay exact.
        taxes::migrate_editable(&mut current);
        let path_for = |kind| self.configured_directory(kind).cloned().unwrap_or_else(|| {
            if self.separate_pdf_directories {
                default_output_dir.parent().unwrap_or(default_output_dir)
                    .join(if kind == Kind::Facture { "Factures" } else { "Soumissions" })
                    .to_string_lossy().into_owned()
            } else { default_output_dir.to_string_lossy().into_owned() }
        });
        let pdf_directory = path_for(current.kind);
        let using_default_directory = self.configured_directory(current.kind).is_none();
        Ok(StateResponse {
            current_pdf_path: records.iter().find(|record| record.id == self.current_id)
                .and_then(|record| record.exports.last()).map(|export| export.path.clone()),
            current,
            records,
            next_invoice_number: self.next_invoice_number,
            pdf_directory,
            using_default_directory,
            invoice_pdf_directory: path_for(Kind::Facture),
            quote_pdf_directory: path_for(Kind::Soumission),
            using_default_invoice_directory: self.configured_directory(Kind::Facture).is_none(),
            using_default_quote_directory: self.configured_directory(Kind::Soumission).is_none(),
        })
    }

    fn configured_directory(&self, kind: Kind) -> Option<&String> {
        if !self.separate_pdf_directories { return self.pdf_directory.as_ref(); }
        match kind { Kind::Facture => self.invoice_pdf_directory.as_ref(), Kind::Soumission => self.quote_pdf_directory.as_ref() }
    }
}

struct Repository {
    data_dir: PathBuf,
    documents_dir: PathBuf,
}

impl Repository {
    fn new(data_dir: PathBuf, documents_dir: PathBuf) -> Self {
        Self {
            data_dir,
            documents_dir,
        }
    }

    fn primary(&self) -> PathBuf {
        self.data_dir.join("state.json")
    }
    fn backup(&self) -> PathBuf {
        self.data_dir.join("recovery").join("state.backup.json")
    }
    fn output_dir(&self) -> PathBuf {
        self.documents_dir.join("Entreprise").join("À classer")
    }

    fn selected_output_dir(&self, store: &Store, kind: Kind) -> AppResult<PathBuf> {
        if let Some(path) = store.configured_directory(kind) {
            let dir = PathBuf::from(path);
            if !dir.is_dir() {
                return Err(format!("Le dossier des PDF n'est plus disponible : {path}. Choisissez un autre dossier."));
            }
            Ok(dir)
        } else {
            Ok(if store.separate_pdf_directories {
                self.documents_dir.join("Entreprise").join(if kind == Kind::Facture { "Factures" } else { "Soumissions" })
            } else { self.output_dir() })
        }
    }

    fn load(&self) -> AppResult<Store> {
        let primary = read_store(&self.primary());
        let backup = read_store(&self.backup());
        let chosen = match (&primary, &backup) {
            (Ok(Some(a)), Ok(Some(b))) => if a.generation >= b.generation { a.clone() } else { b.clone() },
            (Ok(Some(a)), _) => a.clone(),
            (_, Ok(Some(b))) => b.clone(),
            (Ok(None), Ok(None)) => { let mut fresh = Store::fresh(); self.commit(&mut fresh)?; return Ok(fresh); }
            _ => return Err(format!("Données locales illisibles. Copie principale : {}. Copie de récupération : {}. Aucun fichier n'a été remplacé.", issue(&primary), issue(&backup))),
        };
        let bytes = serde_json::to_vec_pretty(&chosen)
            .map_err(|e| format!("Impossible de préparer la récupération : {e}"))?;
        if !matches!(&primary, Ok(Some(s)) if s.generation == chosen.generation && !s.ai_provider_migrated && !s.note_entries_migrated) {
            let _ = atomic_replace(&self.primary(), &bytes);
        }
        if !matches!(&backup, Ok(Some(s)) if s.generation == chosen.generation && !s.ai_provider_migrated && !s.note_entries_migrated) {
            let _ = atomic_replace(&self.backup(), &bytes);
        }
        Ok(chosen)
    }

    fn commit(&self, store: &mut Store) -> AppResult<()> {
        store.refresh_numbers();
        store.generation = store
            .generation
            .checked_add(1)
            .ok_or("Compteur de sauvegarde saturé.")?;
        validate_store(store)?;
        let bytes = serde_json::to_vec_pretty(store)
            .map_err(|e| format!("Impossible de préparer la sauvegarde : {e}"))?;
        atomic_replace(&self.backup(), &bytes)
            .map_err(|e| format!("Copie de récupération non enregistrée : {e}"))?;
        atomic_replace(&self.primary(), &bytes).map_err(|e| format!("La copie de récupération est enregistrée, mais le fichier principal n'a pas pu être mis à jour : {e}"))?;
        Ok(())
    }

    fn reconcile_pending(&self, store: &mut Store) -> AppResult<()> {
        if let Some(pending) = store.pending_export.clone() {
            let output_dir = match self.selected_output_dir(store, pending.snapshot.kind) {
                Ok(path) => path,
                Err(_) => return Ok(()), // Keep an unfinished export until its chosen folder is available again.
            };
            let path = output_dir.join(&pending.filename);
            if file_matches_hash(&path, &pending.pdf_sha256) {
                self.finalize_pending(store)?;
            } else {
                store.pending_export = None;
                self.commit(store)?;
            }
        }
        Ok(())
    }

    fn load_state(&self) -> AppResult<StateResponse> {
        let mut store = self.load()?;
        self.reconcile_pending(&mut store)?;
        store.response(&self.output_dir())
    }

    fn save_draft(&self, draft: Draft) -> AppResult<StateResponse> {
        let mut store = self.load()?;
        self.reconcile_pending(&mut store)?;
        update_draft(&mut store, draft)?;
        self.commit(&mut store)?;
        store.response(&self.output_dir())
    }

    fn new_draft(&self, kind: Kind) -> AppResult<StateResponse> {
        let mut store = self.load()?;
        self.reconcile_pending(&mut store)?;
        if store.records.len() >= MAX_RECORDS {
            return Err(
                "Trop de documents enregistrés; archivez les anciens avant d'en créer un autre."
                    .into(),
            );
        }
        if kind == Kind::Facture && store.next_invoice_number > MAX_INVOICE_NUMBER {
            return Err("La plage de numéros de facture est épuisée.".into());
        }
        let mut draft = blank_draft(kind);
        if kind == Kind::Facture {
            draft.invoice_number = Some(store.next_invoice_number);
        }
        store.current_id = draft.id.clone();
        store.records.push(Record {
            id: draft.id.clone(),
            draft,
            updated_at: Utc::now().to_rfc3339(),
            exports: vec![],
            saved_versions: vec![],
            sent_at: None,
        });
        self.commit(&mut store)?;
        store.response(&self.output_dir())
    }

    fn open_draft(&self, id: &str) -> AppResult<StateResponse> {
        let mut store = self.load()?;
        self.reconcile_pending(&mut store)?;
        store.index(id)?;
        store.current_id = id.to_string();
        self.commit(&mut store)?;
        store.response(&self.output_dir())
    }

    fn create_quote_from_invoice(&self, id: &str) -> AppResult<StateResponse> {
        let mut store = self.load()?;
        if store.pending_export.is_some() {
            return Err("Terminez le PDF en attente avant de créer la soumission.".into());
        }
        if store.current_id != id {
            return Err("Le document a changé. Rouvrez la facture avant de créer la soumission.".into());
        }
        let source = &store.records[store.index(id)?].draft;
        if source.kind != Kind::Facture || source.issued_number.is_none() {
            return Err("Choisissez une facture émise pour créer sa soumission.".into());
        }
        if store.records.len() >= MAX_RECORDS {
            return Err("Trop de documents enregistrés pour créer une soumission.".into());
        }
        let mut draft = source.clone();
        draft.id = Uuid::new_v4().to_string();
        draft.kind = Kind::Soumission;
        draft.invoice_number = None;
        draft.manual_invoice_number = None;
        draft.issued_number = None;
        draft.english_copy = None;
        if draft.valid_until.trim().is_empty() && valid_date(&draft.date) {
            let date = NaiveDate::parse_from_str(&draft.date, "%Y-%m-%d")
                .map_err(|_| "Date du document invalide.".to_string())?;
            draft.valid_until = (date + Duration::days(30)).format("%Y-%m-%d").to_string();
        }
        taxes::migrate_editable(&mut draft);
        validate_draft(&draft)?;
        store.current_id = draft.id.clone();
        store.records.push(Record {
            id: draft.id.clone(), draft, updated_at: Utc::now().to_rfc3339(),
            exports: vec![], saved_versions: vec![], sent_at: None,
        });
        self.commit(&mut store)?;
        store.response(&self.output_dir())
    }

    fn restore_previous(&self, id: &str) -> AppResult<StateResponse> {
        let mut store = self.load()?;
        self.reconcile_pending(&mut store)?;
        let index = store.index(id)?;
        let versions = store
            .versions
            .get_mut(id)
            .ok_or("Aucune version précédente pour ce document.")?;
        let mut previous = versions
            .pop()
            .ok_or("Aucune version précédente pour ce document.")?;
        let current = store.records[index].draft.clone();
        preserve_restored_current(&mut store.records[index], &current)?;
        previous.issued_number = current.issued_number;
        if current.issued_number.is_some() {
            previous.kind = Kind::Facture;
        }
        if current.issued_number.is_some() {
            previous.manual_invoice_number = current.manual_invoice_number;
        }
        previous.invoice_number = if previous.kind == Kind::Facture {
            current.issued_number.or(previous.manual_invoice_number).or(Some(store.next_invoice_number))
        } else { None };
        validate_draft(&previous)?;
        store.records[index].draft = previous;
        store.records[index].updated_at = Utc::now().to_rfc3339();
        versions.insert(0, current);
        if versions.len() > 4 {
            versions.pop();
        }
        store.current_id = id.to_string();
        self.commit(&mut store)?;
        store.response(&self.output_dir())
    }

    fn set_next_invoice_number(&self, number: u64, allow_reuse: bool) -> AppResult<StateResponse> {
        let mut store = self.load()?;
        self.reconcile_pending(&mut store)?;
        if number == 0 {
            return Err("Le prochain numéro de facture doit être positif.".into());
        }
        if store.pending_export.is_some() {
            return Err(
                "Terminez ou réessayez l'export en cours avant de changer le prochain numéro."
                    .into(),
            );
        }
        if number == u64::MAX {
            return Err("Numéro trop grand pour permettre la facture suivante.".into());
        }
        if number > MAX_INVOICE_NUMBER {
            return Err(
                "Numéro trop grand pour être affiché sans erreur dans l'application.".into(),
            );
        }
        let reused = store.records.iter().any(|record| record.draft.issued_number == Some(number));
        if (number < store.next_invoice_number || reused) && !allow_reuse {
            return Err(format!("Le numéro {number} a déjà été utilisé ou précède le prochain numéro automatique ({}). Confirmez le nouveau point de départ dans l'application.", store.next_invoice_number));
        }
        let index = store.index(&store.current_id)?;
        if store.records[index].draft.kind == Kind::Facture && store.records[index].draft.issued_number.is_some() {
            if store.records.len() >= MAX_RECORDS {
                return Err("Trop de documents enregistrés pour créer une nouvelle facture.".into());
            }
            let mut draft = blank_draft(Kind::Facture);
            draft.invoice_number = Some(number);
            store.current_id = draft.id.clone();
            store.records.push(Record {
                id: draft.id.clone(), draft,
                updated_at: Utc::now().to_rfc3339(), exports: vec![], saved_versions: vec![], sent_at: None,
            });
        }
        store.next_invoice_number = number;
        store.invoice_sequence_reset = true;
        // Issued invoices stay immutable; unissued invoices follow the chosen cursor.
        for record in &mut store.records {
            if record.draft.issued_number.is_none() { record.draft.manual_invoice_number = None; }
        }
        let current = store.index(&store.current_id)?;
        if store.records[current].draft.kind == Kind::Facture {
            store.records[current].draft.manual_invoice_number = reused.then_some(number);
        }
        store.records[current].updated_at = Utc::now().to_rfc3339();
        self.commit(&mut store)?;
        store.response(&self.output_dir())
    }

    fn set_output_directory(&self, path: Option<String>, kind: Kind) -> AppResult<StateResponse> {
        let mut store = self.load()?;
        self.reconcile_pending(&mut store)?;
        if store.pending_export.is_some() {
            return Err("Un PDF en attente doit être terminé dans son dossier actuel avant de changer de dossier.".into());
        }
        if let Some(selected) = &path {
            let directory = Path::new(selected);
            if selected.len() > 4096 || selected.contains('\0') || !directory.is_absolute() || !directory.is_dir() {
                return Err("Choisissez un dossier existant et accessible sur cet ordinateur.".into());
            }
            let probe = directory.join(format!(".invoice-app-write-check-{}.tmp", Uuid::new_v4()));
            let check = OpenOptions::new().write(true).create_new(true).open(&probe)
                .map_err(|e| format!("Ce dossier n'accepte pas les PDF : {e}"))?;
            drop(check);
            fs::remove_file(&probe)
                .map_err(|e| format!("Le test du dossier n'a pas pu être nettoyé : {e}"))?;
        }
        if !store.separate_pdf_directories {
            let legacy = store.pdf_directory.clone().unwrap_or_else(|| self.output_dir().to_string_lossy().into_owned());
            store.invoice_pdf_directory = Some(legacy.clone());
            store.quote_pdf_directory = Some(legacy);
            store.separate_pdf_directories = true;
        }
        match kind { Kind::Facture => store.invoice_pdf_directory = path, Kind::Soumission => store.quote_pdf_directory = path }
        self.commit(&mut store)?;
        store.response(&self.output_dir())
    }

    fn delete_draft(&self, id: &str, expected_draft: Draft) -> AppResult<StateResponse> {
        let mut store = self.load()?;
        // Do not reconcile or discard a possibly completed export during deletion.
        if store.pending_export.is_some() {
            return Err("Un PDF doit être finalisé avant de supprimer un brouillon. Rechargez les documents.".into());
        }
        let index = store.index(id)?;
        let record = &store.records[index];
        let issued_history = record.saved_versions.iter().any(|version| version.snapshot.issued_number.is_some())
            || store.versions.get(id).is_some_and(|versions| versions.iter().any(|draft| draft.issued_number.is_some()));
        if !record.exports.is_empty() || record.draft.issued_number.is_some() || issued_history {
            return Err("Ce document est émis ou possède un PDF. Il ne peut pas être supprimé.".into());
        }
        if expected_draft.id != id || expected_draft != record.draft {
            return Err("Le brouillon a changé. Vérifiez-le à nouveau avant de confirmer sa suppression.".into());
        }
        let kind = record.draft.kind;
        let was_current = store.current_id == id;
        store.records.remove(index);
        store.versions.remove(id);
        if was_current {
            let draft = blank_draft(kind);
            store.current_id = draft.id.clone();
            store.records.push(Record {
                id: draft.id.clone(), draft, updated_at: Utc::now().to_rfc3339(),
                exports: vec![], saved_versions: vec![], sent_at: None,
            });
        }
        self.commit(&mut store)?;
        store.response(&self.output_dir())
    }

    fn load_document_versions(&self, id: &str) -> AppResult<Vec<DocumentVersion>> {
        let store = self.load()?;
        let record = &store.records[store.index(id)?];
        let mut versions: Vec<DocumentVersion> = record.exports.iter().map(|export| DocumentVersion {
            id: export_version_id(&export.path), version_type: "export".into(),
            created_at: Some(export.exported_at.clone()), draft: export.snapshot.clone(),
            path: Some(export.path.clone()), filename: Some(export.filename.clone()),
            language: Some(export.language.clone()), restorable: export.snapshot.is_some(),
        }).chain(record.saved_versions.iter().map(|version| DocumentVersion {
            id: version.version_id.clone(), version_type: "recovery".into(),
            created_at: Some(version.saved_at.clone()), draft: Some(version.snapshot.clone()),
            path: None, filename: None, language: None, restorable: true,
        })).collect();
        versions.sort_by(|a, b| b.created_at.cmp(&a.created_at).then_with(|| a.id.cmp(&b.id)));
        // Legacy edit recovery has no timestamp. IDs bind selection to exact content, not a moving index.
        if let Some(recovery) = store.versions.get(id) {
            for draft in recovery.iter().rev() {
                versions.push(DocumentVersion {
                    id: recovery_version_id(draft)?, version_type: "recovery".into(),
                    created_at: None, draft: Some(draft.clone()), path: None, filename: None,
                    language: None, restorable: true,
                });
            }
        }
        let mut seen = HashSet::new();
        versions.retain(|version| seen.insert(version.id.clone()));
        Ok(versions)
    }

    fn restore_document_version(&self, id: &str, version_id: &str) -> AppResult<StateResponse> {
        let mut store = self.load()?;
        if store.pending_export.is_some() {
            return Err("Terminez l'export en attente avant de restaurer une version.".into());
        }
        let index = store.index(id)?;
        let record = &store.records[index];
        let mut selected = if let Some(export) = record.exports.iter()
            .find(|export| export_version_id(&export.path) == version_id) {
            export.snapshot.clone().ok_or("Cette ancienne copie PDF ne contient pas de brouillon restaurable.")?
        } else if let Some(version) = record.saved_versions.iter().find(|version| version.version_id == version_id) {
            version.snapshot.clone()
        } else {
            store.versions.get(id).into_iter().flatten()
                .find(|draft| recovery_version_id(draft).is_ok_and(|key| key == version_id))
                .cloned().ok_or("Version introuvable ou périmée. Rechargez les versions précédentes.")?
        };
        let current = store.records[index].draft.clone();
        // Historical fields are exact; issuance and reuse acknowledgement remain backend-owned.
        let selected_recovery = version_id.starts_with("recovery:")
            && !store.records[index].saved_versions.iter().any(|version| version.version_id == version_id);
        if selected_recovery {
            if store.records[index].saved_versions.len() + 2 > MAX_SAVED_VERSIONS {
                return Err("L'historique des restaurations est plein. Aucune version n'a été supprimée.".into());
            }
            // Promote the selected ring entry so later autosaves cannot evict the chosen version.
            store.records[index].saved_versions.push(SavedVersion {
                version_id: version_id.to_owned(), saved_at: Utc::now().to_rfc3339(), snapshot: selected.clone(),
            });
        }
        selected.issued_number = current.issued_number;
        if current.issued_number.is_some() {
            selected.kind = Kind::Facture;
            selected.manual_invoice_number = current.manual_invoice_number;
        } else {
            selected.manual_invoice_number = None;
        }
        selected.invoice_number = if selected.kind == Kind::Facture {
            current.issued_number.or(Some(store.next_invoice_number))
        } else { None };
        validate_draft(&selected)?;
        preserve_restored_current(&mut store.records[index], &current)?;
        push_version(store.versions.entry(id.to_owned()).or_default(), current);
        store.records[index].draft = selected;
        store.records[index].updated_at = Utc::now().to_rfc3339();
        store.current_id = id.to_owned();
        self.commit(&mut store)?;
        store.response(&self.output_dir())
    }

    fn read_document_pdf(&self, id: &str, path: &str) -> AppResult<ArchivedPdf> {
        use std::io::Read;
        let store = self.load()?;
        let export = store.records[store.index(id)?].exports.iter()
            .find(|export| export.path == path)
            .ok_or("Ce PDF n'est pas enregistré pour ce document.")?;
        let mut file = fs::File::open(&export.path).map_err(|_| "Le PDF archivé ne peut pas être ouvert.")?;
        let metadata = file.metadata().map_err(|_| "Le PDF archivé ne peut pas être vérifié.")?;
        if !metadata.is_file() || metadata.len() > MAX_PDF_BYTES as u64 {
            return Err("Le PDF archivé n'est pas un fichier ou dépasse la taille permise.".into());
        }
        let mut bytes = Vec::new();
        (&mut file).take(MAX_PDF_BYTES as u64 + 1).read_to_end(&mut bytes)
            .map_err(|_| "Le PDF archivé ne peut pas être lu.")?;
        validate_pdf(&bytes)?;
        if export.pdf_sha256.as_ref().is_some_and(|hash| *hash != format!("{:x}", Sha256::digest(&bytes))) {
            return Err("Le PDF a été modifié depuis son enregistrement.".into());
        }
        Ok(ArchivedPdf { path: export.path.clone(), filename: export.filename.clone(),
            pdf_bytes: bytes, integrity_verified: export.pdf_sha256.is_some() })
    }

    fn record_sent_receipt(&self, id: &str, path: &str, hash: &str, receipt: outlook::SendReceipt) -> AppResult<()> {
        validate_sent_receipt(&receipt)?;
        let mut store = self.load()?;
        let index = store.index(id)?;
        let export = store.records[index].exports.iter_mut()
            .find(|export| export.path == path && export.pdf_sha256.as_deref() == Some(hash))
            .ok_or("Le PDF accepté ne correspond plus à son archive enregistrée.")?;
        if let Some(existing) = export.sent_receipts.iter().find(|entry| entry.attempt_id == receipt.attempt_id) {
            if existing != &receipt { return Err("Reçu Outlook incohérent pour cette tentative.".into()); }
            return Ok(());
        }
        export.sent_receipts.push(receipt);
        self.commit(&mut store)
    }

    fn confirm_invoice_number_reuse(&self, id: &str, expected_number: u64) -> AppResult<StateResponse> {
        let mut store = self.load()?;
        self.reconcile_pending(&mut store)?;
        if store.pending_export.is_some() { return Err("Terminez l'export en attente avant de confirmer le numéro.".into()); }
        let index = store.index(id)?;
        let draft = &store.records[index].draft;
        if draft.kind != Kind::Facture || draft.issued_number.is_some()
            || draft.invoice_number != Some(expected_number) {
            return Err("Le numéro du document a changé. Ouvrez à nouveau la facture.".into());
        }
        store.records[index].draft.manual_invoice_number = Some(expected_number);
        self.commit(&mut store)?;
        store.response(&self.output_dir())
    }

    fn export_pdf(
        &self,
        mut draft: Draft,
        pdf_bytes: Vec<u8>,
        expected_invoice_number: Option<u64>,
        language: String,
    ) -> AppResult<ExportResponse> {
        migrate_draft_notes(&mut draft);
        let original_editable = draft.clone();
        taxes::migrate_editable(&mut draft);
        if language != "fr" && language != "en" {
            return Err("Langue invalide : utilisez fr ou en.".into());
        }
        validate_pdf(&pdf_bytes)?;
        validate_export_draft(&draft)?;
        if language == "en" {
            validate_english_copy(&draft)?;
        }
        let mut store = self.load()?;
        let output_dir = self.selected_output_dir(&store, draft.kind)?;
        let index = store.index(&draft.id)?;
        let issued = store.records[index].draft.issued_number;
        if issued.is_some() && draft.kind != Kind::Facture {
            return Err("Une facture déjà émise ne peut pas devenir une soumission.".into());
        }
        let number = if draft.kind == Kind::Facture {
            Some(issued.or(store.records[index].draft.manual_invoice_number).unwrap_or(store.next_invoice_number))
        } else {
            None
        };
        if issued.is_none() && number.is_some_and(|n| n > MAX_INVOICE_NUMBER) {
            return Err("La plage de numéros de facture est épuisée.".into());
        }
        if issued.is_none() && number.is_some_and(|n| store.records.iter().any(|r| r.draft.issued_number == Some(n)))
            && store.records[index].draft.manual_invoice_number != number {
            return Err("Ce numéro de facture existe déjà. Confirmez sa réutilisation avant de créer le PDF.".into());
        }
        if expected_invoice_number != number {
            return Err(format!(
                "Numéro de facture périmé. Rechargez le document; numéro actuel : {}.",
                number.map_or_else(|| "aucun".into(), |n| n.to_string())
            ));
        }

        // A prior write may have finished before the state commit. Complete it first.
        if let Some(pending) = store.pending_export.clone() {
            let path = self.selected_output_dir(&store, pending.snapshot.kind)?.join(&pending.filename);
            if file_matches_hash(&path, &pending.pdf_sha256) {
                self.finalize_pending(&mut store)?;
                if pending.id == draft.id
                    && (pending.snapshot == draft || pending.snapshot == original_editable)
                    && pending.language == language
                {
                    let snapshot = store.records[store.index(&pending.id)?].draft.clone();
                    return Ok(ExportResponse {
                        path: path.to_string_lossy().into_owned(),
                        name_collision: pending.filename
                            != base_filename(&draft, pending.invoice_number, &language)?,
                        filename: pending.filename,
                        invoice_number: pending.invoice_number,
                        snapshot,
                    });
                }
            } else {
                store.pending_export = None;
            }
        }

        let current_number = if draft.kind == Kind::Facture {
            let index = store.index(&draft.id)?;
            Some(
                store.records[index]
                    .draft
                    .issued_number
                    .or(store.records[index].draft.manual_invoice_number)
                    .unwrap_or(store.next_invoice_number),
            )
        } else {
            None
        };
        if expected_invoice_number != current_number {
            return Err(format!(
                "Numéro de facture périmé. Rechargez le document; numéro actuel : {}.",
                current_number.map_or_else(|| "aucun".into(), |n| n.to_string())
            ));
        }

        update_draft(&mut store, draft)?;
        let index = store.index(&store.current_id)?;
        let snapshot = store.records[index].draft.clone();
        let number = snapshot
            .invoice_number;
        let base_name = base_filename(&snapshot, number, &language)?;
        let filename = available_filename(&output_dir, &base_name)?;
        store.pending_export = Some(PendingExport {
            id: snapshot.id.clone(),
            filename: filename.clone(),
            invoice_number: number,
            snapshot: snapshot.clone(),
            language: language.clone(),
            pdf_sha256: format!("{:x}", Sha256::digest(&pdf_bytes)),
            exported_at: Utc::now().to_rfc3339(),
        });
        self.commit(&mut store)?;
        if store.configured_directory(snapshot.kind).is_none() {
            fs::create_dir_all(&output_dir)
                .map_err(|e| format!("Impossible de créer le dossier de sortie : {e}"))?;
        }
        let temp = output_dir.join(format!(".{}.tmp", Uuid::new_v4()));
        write_new_file(&temp, &pdf_bytes).map_err(|e| format!("PDF non enregistré : {e}"))?;
        let result = (|| -> AppResult<PathBuf> {
            for _ in 0..1000 {
                let pending = store
                    .pending_export
                    .as_ref()
                    .ok_or("Export en attente introuvable.")?;
                let final_path = output_dir.join(&pending.filename);
                if final_path.exists() {
                    let next_name = available_filename(
                        &output_dir,
                        &base_filename(&snapshot, number, &language)?,
                    )?;
                    store.pending_export.as_mut().unwrap().filename = next_name;
                    self.commit(&mut store)?;
                    continue;
                }
                match atomic_move_new(&temp, &final_path) {
                    Ok(()) => return Ok(final_path),
                    Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => {
                        let next_name = available_filename(
                            &output_dir,
                            &base_filename(&snapshot, number, &language)?,
                        )?;
                        store.pending_export.as_mut().unwrap().filename = next_name;
                        self.commit(&mut store)?;
                    }
                    Err(e) => return Err(format!("PDF non enregistré : {e}")),
                }
            }
            Err("Trop de fichiers portent déjà ce nom.".into())
        })();
        if result.is_err() {
            let _ = fs::remove_file(&temp);
        }
        let path = result?;
        self.finalize_pending(&mut store)?;
        let issued_snapshot = store.records[store.index(&snapshot.id)?].draft.clone();
        Ok(ExportResponse {
            path: path.to_string_lossy().into_owned(),
            filename: path.file_name().unwrap().to_string_lossy().into_owned(),
            name_collision: path.file_name().unwrap().to_string_lossy() != base_name,
            invoice_number: number,
            snapshot: issued_snapshot,
        })
    }

    fn email_attachment(&self, draft_id: &str, requested_path: &str) -> AppResult<(String, Vec<u8>)> {
        let store = self.load()?;
        let record = &store.records[store.index(draft_id)?];
        let export = record.exports.iter().find(|export| export.path == requested_path)
            .ok_or("Cette pièce jointe ne correspond pas à un PDF enregistré pour ce document.")?;
        let expected_hash = export.pdf_sha256.as_deref()
            .ok_or("Créez une nouvelle copie du PDF avant de l’envoyer.")?;
        let metadata = fs::metadata(&export.path).map_err(|_| "Le PDF enregistré est introuvable.")?;
        if !metadata.is_file() || metadata.len() >= 3_000_000 {
            return Err("Le PDF dépasse la limite d’envoi de 3 Mo ou n’est pas un fichier.".into());
        }
        use std::io::Read;
        let mut bytes = Vec::new();
        fs::File::open(&export.path).map_err(|_| "Le PDF ne peut pas être ouvert.")?
            .take(3_000_001).read_to_end(&mut bytes).map_err(|_| "Le PDF ne peut pas être lu.")?;
        if bytes.len() >= 3_000_000 || format!("{:x}", Sha256::digest(&bytes)) != expected_hash {
            return Err("Le PDF a été modifié depuis son enregistrement. Créez une nouvelle copie avant l’envoi.".into());
        }
        validate_pdf(&bytes)?;
        Ok((export.filename.clone(), bytes))
    }

    fn finalize_pending(&self, store: &mut Store) -> AppResult<()> {
        let pending = store
            .pending_export
            .clone()
            .ok_or("Aucun export à terminer.")?;
        let path = self.selected_output_dir(store, pending.snapshot.kind)?.join(&pending.filename);
        if !file_matches_hash(&path, &pending.pdf_sha256) {
            return Err(
                "Le PDF en attente est absent ou modifié; le numéro n'a pas été émis.".into(),
            );
        }
        let index = store.index(&pending.id)?;
        if let Some(number) = pending.invoice_number {
            if let Some(issued) = store.records[index].draft.issued_number {
                if issued != number {
                    return Err("Conflit de numéro sur la facture déjà émise.".into());
                }
            } else {
                if number != store.records[index].draft.manual_invoice_number.unwrap_or(store.next_invoice_number) {
                    return Err("Le numéro de cette facture a changé pendant l'export.".into());
                }
                store.records[index].draft.issued_number = Some(number);
                store.next_invoice_number = store.next_invoice_number.max(number
                    .checked_add(1)
                    .ok_or("Plus de numéro de facture disponible.")?);
            }
            store.records[index].draft.invoice_number = Some(number);
        }
        if !store.records[index]
            .exports
            .iter()
            .any(|entry| entry.path == path.to_string_lossy())
        {
            let mut archived_snapshot = pending.snapshot;
            archived_snapshot.issued_number = pending.invoice_number;
            archived_snapshot.invoice_number = pending.invoice_number;
            store.records[index].exports.push(ExportEntry {
                path: path.to_string_lossy().into_owned(),
                filename: pending.filename,
                exported_at: pending.exported_at,
                language: pending.language,
                invoice_number: pending.invoice_number,
                pdf_sha256: Some(pending.pdf_sha256),
                tax_totals: taxes::totals(&archived_snapshot),
                snapshot: Some(archived_snapshot),
                sent_receipts: vec![],
            });
        }
        store.records[index].updated_at = Utc::now().to_rfc3339();
        store.pending_export = None;
        self.commit(store)
    }
}

fn export_version_id(path: &str) -> String {
    format!("export:{:x}", Sha256::digest(path.as_bytes()))
}

fn recovery_version_id(draft: &Draft) -> AppResult<String> {
    let bytes = serde_json::to_vec(draft).map_err(|_| "Version de brouillon illisible.")?;
    Ok(format!("recovery:{:x}", Sha256::digest(&bytes)))
}

fn matches_recovery_version_id(draft: &Draft, id: &str) -> bool {
    if recovery_version_id(draft).is_ok_and(|current| current == id) { return true; }
    // Pre-noteEntries IDs hash the original scalar draft. Accept that exact
    // identity only for lossless single-entry or empty-note migration, never arbitrary rows.
    let empty_migration = draft.notes.is_empty()
        && draft.note_entries.as_ref().is_some_and(Vec::is_empty);
    if empty_migration || draft.note_entries.as_deref() == Some(std::slice::from_ref(&draft.notes)) {
        let mut legacy = draft.clone();
        legacy.note_entries = None;
        return recovery_version_id(&legacy).is_ok_and(|previous| previous == id);
    }
    false
}

fn preserve_restored_current(record: &mut Record, current: &Draft) -> AppResult<()> {
    if record.saved_versions.len() >= MAX_SAVED_VERSIONS {
        return Err("L'historique des restaurations est plein. Aucune version n'a été supprimée.".into());
    }
    record.saved_versions.push(SavedVersion {
        version_id: format!("history:{}", Uuid::new_v4()),
        saved_at: Utc::now().to_rfc3339(), snapshot: current.clone(),
    });
    Ok(())
}

fn validate_sent_receipt(receipt: &outlook::SendReceipt) -> AppResult<()> {
    if Uuid::parse_str(&receipt.attempt_id).is_err()
        || chrono::DateTime::parse_from_rfc3339(&receipt.accepted_at).is_err()
        || receipt.sender_email.len() > 254 || !receipt.sender_email.contains('@')
        || receipt.sender_email.chars().any(|c| c.is_control() || c.is_whitespace()) {
        return Err("Reçu Outlook enregistré invalide.".into());
    }
    Ok(())
}

fn update_draft(store: &mut Store, mut incoming: Draft) -> AppResult<()> {
    migrate_draft_payments(&mut incoming);
    migrate_draft_notes(&mut incoming);
    taxes::migrate_editable(&mut incoming);
    let index = store.index(&incoming.id)?;
    let old = store.records[index].draft.clone();
    if old.issued_number.is_some() && incoming.kind != Kind::Facture {
        return Err("Une facture émise doit rester une facture.".into());
    }
    if old.kind != Kind::Soumission && incoming.kind == Kind::Soumission
        && incoming.valid_until.trim().is_empty() && valid_date(&incoming.date)
    {
        let document_date = NaiveDate::parse_from_str(&incoming.date, "%Y-%m-%d")
            .map_err(|_| "Date du document invalide.".to_string())?;
        incoming.valid_until = (document_date + Duration::days(30)).format("%Y-%m-%d").to_string();
    }
    incoming.issued_number = old.issued_number;
    incoming.manual_invoice_number = if incoming.kind == Kind::Facture { old.manual_invoice_number } else { None };
    incoming.invoice_number = if incoming.kind == Kind::Facture {
        Some(old.issued_number.or(old.manual_invoice_number).unwrap_or(store.next_invoice_number))
    } else {
        None
    };
    validate_draft(&incoming)?;
    if incoming != old {
        push_version(store.versions.entry(incoming.id.clone()).or_default(), old);
        store.records[index].draft = incoming;
        store.records[index].updated_at = Utc::now().to_rfc3339();
    }
    store.current_id = store.records[index].id.clone();
    Ok(())
}

fn push_version(versions: &mut Vec<Draft>, draft: Draft) {
    if versions.last() != Some(&draft) {
        versions.push(draft);
    }
    if versions.len() > 4 {
        versions.remove(0);
    }
}

fn valid_date(value: &str) -> bool {
    NaiveDate::parse_from_str(value, "%Y-%m-%d")
        .map(|date| date.format("%Y-%m-%d").to_string() == value)
        .unwrap_or(false)
}

fn validate_draft(draft: &Draft) -> AppResult<()> {
    taxes::validate(draft)?;
    Uuid::parse_str(&draft.id).map_err(|_| "Identifiant de document invalide.".to_string())?;
    if draft.manual_invoice_number.is_some_and(|n| n == 0 || n > MAX_INVOICE_NUMBER)
        || (draft.kind == Kind::Soumission && draft.manual_invoice_number.is_some())
        || (draft.issued_number.is_some() && draft.manual_invoice_number.is_some() && draft.manual_invoice_number != draft.issued_number)
    {
        return Err("Numéro manuel de facture invalide.".into());
    }
    for (label, value, limit) in [
        ("client", &draft.client, 500),
        ("adresse", &draft.address, 2000),
        ("livraison", &draft.ship_to, 2000),
        ("contact", &draft.contact, 500),
        ("courriel", &draft.email, 500),
        ("projet", &draft.project, 500),
        ("notes", &draft.notes, MAX_NOTES_BYTES),
        ("dépôt", &draft.deposit, 100),
    ] {
        if value.len() > limit
            || value
                .chars()
                .any(|ch| ch == '\0' || (ch.is_control() && ch != '\n' && ch != '\r' && ch != '\t'))
        {
            return Err(format!(
                "Champ {label} trop long ou contenant un caractère invalide."
            ));
        }
    }
    if let Some(entries) = &draft.note_entries {
        if entries.len() > MAX_NOTE_ENTRIES {
            return Err("Maximum de 500 notes par document.".into());
        }
        if entries.iter().any(|entry| entry.len() > MAX_NOTES_BYTES
            || entry.chars().any(|ch| ch.is_control() && !matches!(ch, '\n' | '\r' | '\t'))) {
            return Err("Une note est trop longue ou contient un caractère invalide.".into());
        }
        if notes_mirror(entries) != draft.notes {
            return Err("Le texte des notes ne correspond pas à leurs entrées. Aucune note n'a été remplacée.".into());
        }
    }
    for (label, value) in [
        ("date", &draft.date),
        ("validUntil", &draft.valid_until),
        ("dueDate", &draft.due_date),
    ] {
        if !value.is_empty() && !valid_date(value) {
            return Err(format!("{label} doit être une date YYYY-MM-DD valide."));
        }
    }
    if draft.items.is_empty() || draft.items.len() > 500 {
        return Err("Le document doit avoir entre 1 et 500 lignes.".into());
    }
    for item in &draft.items {
        if item.description.len() > 20_000 || item.quantity.len() > 100 || item.price.len() > 100 {
            return Err("Une ligne de travail est trop longue.".into());
        }
        if [&item.description, &item.quantity, &item.price]
            .iter()
            .any(|text| {
                text.chars().any(|ch| {
                    ch == '\0' || (ch.is_control() && ch != '\n' && ch != '\r' && ch != '\t')
                })
            })
        {
            return Err("Une ligne contient un caractère invalide.".into());
        }
    }
    if let Some(payments) = &draft.payments {
        if payments.len() > 500 {
            return Err("Maximum de 500 paiements par document.".into());
        }
        for payment in payments {
            if payment.amount.len() > 100 || payment.amount.chars().any(|ch| ch.is_control()) {
                return Err("Montant de paiement trop long ou invalide.".into());
            }
            if !payment.date.is_empty() && !valid_date(&payment.date) {
                return Err("Date de paiement invalide.".into());
            }
        }
    }
    if let Some(copy) = &draft.english_copy {
        if copy.source_project.len() > 500
            || copy.project.len() > 500
            || copy.source_notes.len() > 50_000
            || copy.notes.len() > 50_000
            || copy.source_descriptions.len() > 500
            || copy.descriptions.len() > 500
            || copy.source_descriptions.iter().any(|text| text.len() > 20_000)
            || copy.descriptions.iter().any(|text| text.len() > 20_000)
            || [&copy.source_project, &copy.project, &copy.source_notes, &copy.notes]
                .into_iter()
                .chain(copy.source_descriptions.iter())
                .chain(copy.descriptions.iter())
                .any(|text| text.chars().any(|ch| ch == '\0' || (ch.is_control() && ch != '\n' && ch != '\r' && ch != '\t')))
        {
            return Err("Copie anglaise trop longue ou contenant un caractère invalide.".into());
        }
    }
    Ok(())
}

fn validate_english_copy(draft: &Draft) -> AppResult<()> {
    let copy = draft.english_copy.as_ref().ok_or("Créez et vérifiez la copie anglaise avant l'export.")?;
    if !copy.reviewed {
        return Err("Vérifiez et acceptez la copie anglaise avant l'export.".into());
    }
    if copy.source_project != draft.project
        || copy.source_notes != draft.notes
        || copy.source_descriptions != draft.items.iter().map(|item| item.description.clone()).collect::<Vec<_>>()
    {
        return Err("La version française a changé. Vérifiez à nouveau la copie anglaise.".into());
    }
    if copy.descriptions.len() != draft.items.len()
        || copy.descriptions.iter().any(|text| text.trim().is_empty())
    {
        return Err("Une description manque dans la copie anglaise.".into());
    }
    if !draft.project.trim().is_empty() && copy.project.trim().is_empty() {
        return Err("Le nom du projet manque dans la copie anglaise.".into());
    }
    if !draft.notes.trim().is_empty() && copy.notes.trim().is_empty() {
        return Err("La note manque dans la copie anglaise.".into());
    }
    Ok(())
}

fn parse_nonnegative(value: &str) -> Option<f64> {
    let value = value.trim();
    if value.is_empty()
        || value.matches([',', '.']).count() > 1
        || !value
            .chars()
            .all(|c| c.is_ascii_digit() || c == ',' || c == '.')
    {
        return None;
    }
    let number: f64 = value.replace(',', ".").parse().ok()?;
    (number.is_finite() && number >= 0.0 && number <= 1_000_000_000.0).then_some(number)
}

fn validate_export_draft(draft: &Draft) -> AppResult<()> {
    validate_draft(draft)?;
    taxes::validate_export(draft)?;
    if !valid_date(&draft.date) {
        return Err("La date du document est requise.".into());
    }
    if draft.kind == Kind::Soumission && !valid_date(&draft.valid_until) {
        return Err("La date de validité de la soumission est requise.".into());
    }
    if draft.project.trim().is_empty() {
        return Err("Le nom du projet est requis.".into());
    }
    if draft.client.trim().is_empty() {
        return Err("Le nom du client est requis.".into());
    }
    if draft.address.trim().is_empty() {
        return Err("L'adresse de facturation est requise.".into());
    }
    for (index, item) in draft.items.iter().enumerate() {
        if item.description.trim().is_empty() {
            return Err(format!("Description requise à la ligne {}.", index + 1));
        }
        if !matches!(parse_nonnegative(&item.quantity), Some(n) if n > 0.0) {
            return Err(format!("Quantité invalide à la ligne {}.", index + 1));
        }
        if parse_nonnegative(&item.price).is_none() {
            return Err(format!("Prix invalide à la ligne {}.", index + 1));
        }
    }
    if let Some(payments) = &draft.payments {
        for (index, payment) in payments.iter().enumerate() {
            if (payment.amount.trim().is_empty() && !payment.date.is_empty())
                || (!payment.amount.trim().is_empty() && parse_nonnegative(&payment.amount).is_none())
            {
                return Err(format!("Montant du paiement {} invalide.", index + 1));
            }
        }
    } else if !draft.deposit.trim().is_empty() && parse_nonnegative(&draft.deposit).is_none() {
        return Err("Dépôt invalide.".into());
    }
    Ok(())
}

fn validate_pdf(bytes: &[u8]) -> AppResult<()> {
    if bytes.len() < 16
        || bytes.len() > MAX_PDF_BYTES
        || !bytes.starts_with(b"%PDF-")
        || !bytes.trim_ascii_end().ends_with(b"%%EOF")
    {
        return Err("PDF invalide ou trop volumineux (maximum 25 Mo).".into());
    }
    Ok(())
}

fn safe_client_name(client: &str) -> String {
    let mut result = String::new();
    for ch in client.trim().chars().take(100) {
        if ch.is_alphanumeric() {
            result.push(ch);
        } else if (ch.is_whitespace() || ch == '-' || ch == '_') && !result.ends_with('_') {
            result.push('_');
        }
    }
    let trimmed = result.trim_matches('_');
    if trimmed.is_empty() {
        "Client".into()
    } else {
        trimmed.chars().take(70).collect()
    }
}

fn base_filename(draft: &Draft, number: Option<u64>, language: &str) -> AppResult<String> {
    if !valid_date(&draft.date) {
        return Err("Date invalide pour le nom du PDF.".into());
    }
    let prefix = match draft.kind {
        Kind::Facture => format!("Facture_{}_", number.ok_or("Numéro de facture manquant.")?),
        Kind::Soumission => "Soumission_".into(),
    };
    let suffix = if language == "en" { "_EN" } else { "" };
    Ok(format!(
        "{prefix}{}_{}{}.pdf",
        draft.date,
        safe_client_name(&draft.client),
        suffix
    ))
}

fn available_filename(dir: &Path, base: &str) -> AppResult<String> {
    let stem = base.strip_suffix(".pdf").ok_or("Nom PDF invalide.")?;
    for n in 1..=1000 {
        let filename = if n == 1 {
            base.to_string()
        } else {
            format!("{stem}_{n}.pdf")
        };
        if !dir.join(&filename).exists() {
            return Ok(filename);
        }
    }
    Err("Trop de fichiers portent déjà ce nom.".into())
}

fn validate_store(store: &Store) -> AppResult<()> {
    if store.schema_version != 1 {
        return Err("Version de données inconnue; aucune donnée n'a été écrasée.".into());
    }
    if !matches!(store.ai_provider.as_str(), "chatgpt" | "business") {
        return Err("Service IA inconnu; les données locales n'ont pas été écrasées.".into());
    }
    if store.next_invoice_number == 0
        || store.next_invoice_number > MAX_INVOICE_NUMBER + 1
        || store.records.is_empty()
        || store.records.len() > MAX_RECORDS
    {
        return Err("État des documents invalide.".into());
    }
    for path in [&store.pdf_directory, &store.invoice_pdf_directory, &store.quote_pdf_directory].into_iter().flatten() {
        if path.len() > 4096 || path.contains('\0') || !Path::new(path).is_absolute() {
            return Err("Dossier PDF personnalisé invalide.".into());
        }
    }
    let mut ids = HashSet::new();
    let mut issued: HashMap<u64, (usize, usize)> = HashMap::new();
    for record in &store.records {
        validate_draft(&record.draft)?;
        if record.id != record.draft.id || !ids.insert(record.id.clone()) {
            return Err("Identifiants de document dupliqués ou incohérents.".into());
        }
        if record.saved_versions.len() > MAX_SAVED_VERSIONS {
            return Err("Historique des restaurations trop grand.".into());
        }
        let mut version_ids = HashSet::new();
        for version in &record.saved_versions {
            if !version_ids.insert(&version.version_id)
                || !(version.version_id.strip_prefix("history:").is_some_and(|id| Uuid::parse_str(id).is_ok())
                    || matches_recovery_version_id(&version.snapshot, &version.version_id))
                || chrono::DateTime::parse_from_rfc3339(&version.saved_at).is_err()
                || version.snapshot.id != record.id {
                return Err("Version restaurable invalide.".into());
            }
            validate_draft(&version.snapshot)?;
        }
        for export in &record.exports {
            if let Some(totals) = &export.tax_totals {
                if export.snapshot.as_ref().and_then(taxes::totals).as_ref() != Some(totals) {
                    return Err("Montants archivés des taxes incohérents.".into());
                }
            }
            if let Some(snapshot) = &export.snapshot {
                validate_draft(snapshot)?;
                if snapshot.id != record.id || snapshot.invoice_number != export.invoice_number
                    || snapshot.issued_number != export.invoice_number
                    || (snapshot.kind == Kind::Facture) != export.invoice_number.is_some() {
                    return Err("Brouillon de version PDF incohérent.".into());
                }
            }
            let mut attempts = HashSet::new();
            for receipt in &export.sent_receipts {
                validate_sent_receipt(receipt)?;
                if !attempts.insert(&receipt.attempt_id) {
                    return Err("Reçu Outlook dupliqué.".into());
                }
            }
        }
        if let Some(number) = record.draft.issued_number {
            if record.draft.kind != Kind::Facture
                || record.draft.invoice_number != Some(number)
            {
                return Err("Numéros de facture émis incohérents.".into());
            }
            let count = issued.entry(number).or_insert((0, 0));
            count.0 += 1;
            if record.draft.manual_invoice_number == Some(number) { count.1 += 1; }
        } else if record.draft.invoice_number
            != (record.draft.kind == Kind::Facture).then_some(record.draft.manual_invoice_number.unwrap_or(store.next_invoice_number))
        {
            return Err("Numéro proposé incohérent.".into());
        }
    }
    if !ids.contains(&store.current_id) || issued.iter().any(|(n, (total, manual))| (!store.invoice_sequence_reset && *n >= store.next_invoice_number) || *manual < total.saturating_sub(1)) {
        return Err("Document courant ou prochain numéro invalide.".into());
    }
    if store.versions.iter().any(|(id, list)| {
        !ids.contains(id)
            || list.len() > 4
            || list
                .iter()
                .any(|draft| &draft.id != id || validate_draft(draft).is_err())
    }) {
        return Err("Versions de récupération invalides.".into());
    }
    if let Some(pending) = &store.pending_export {
        validate_draft(&pending.snapshot)?;
        if !ids.contains(&pending.id)
            || pending.snapshot.id != pending.id
            || pending.filename.contains(['/', '\\'])
            || pending.filename.starts_with('.')
            || !pending.filename.ends_with(".pdf")
            || pending.pdf_sha256.len() != 64
        {
            return Err("Export en attente invalide.".into());
        }
        let record = store
            .records
            .iter()
            .find(|record| record.id == pending.id)
            .unwrap();
        let expected = if record.draft.kind == Kind::Facture {
            Some(
                record
                    .draft
                    .issued_number
                    .or(record.draft.manual_invoice_number)
                    .unwrap_or(store.next_invoice_number),
            )
        } else {
            None
        };
        if pending.invoice_number != expected
            || pending.snapshot.kind != record.draft.kind
            || (pending.language != "fr" && pending.language != "en")
        {
            return Err("Numéro d'export en attente incohérent.".into());
        }
    }
    Ok(())
}

fn read_store(path: &Path) -> AppResult<Option<Store>> {
    let bytes = match fs::read(path) {
        Ok(bytes) => bytes,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(error.to_string()),
    };
    let mut store: Store = serde_json::from_slice(&bytes).map_err(|e| e.to_string())?;
    if matches!(store.ai_provider.as_str(), "openai" | "zai") { store.ai_provider = default_ai_provider(); store.ai_provider_migrated = true; }
    for record in &mut store.records {
        migrate_draft_payments(&mut record.draft);
        store.note_entries_migrated |= migrate_draft_notes(&mut record.draft);
        for version in &mut record.saved_versions {
            migrate_draft_payments(&mut version.snapshot);
            store.note_entries_migrated |= migrate_draft_notes(&mut version.snapshot);
        }
        for export in &mut record.exports {
            if let Some(snapshot) = &mut export.snapshot {
                migrate_draft_payments(snapshot);
                store.note_entries_migrated |= migrate_draft_notes(snapshot);
            }
        }
    }
    for versions in store.versions.values_mut() {
        for draft in versions {
            migrate_draft_payments(draft);
            store.note_entries_migrated |= migrate_draft_notes(draft);
        }
    }
    if let Some(pending) = &mut store.pending_export {
        migrate_draft_payments(&mut pending.snapshot);
        store.note_entries_migrated |= migrate_draft_notes(&mut pending.snapshot);
    }
    validate_store(&store)?;
    Ok(Some(store))
}

fn migrate_draft_payments(draft: &mut Draft) {
    if draft.payments.is_none() {
        draft.payments = Some(vec![Payment { amount: draft.deposit.clone(), date: String::new() }]);
    }
}

fn notes_mirror(entries: &[String]) -> String {
    entries.iter().filter(|entry| !entry.is_empty()).map(String::as_str).collect::<Vec<_>>().join("\n\n")
}

fn migrate_draft_notes(draft: &mut Draft) -> bool {
    if draft.note_entries.is_some() { return false; }
    // Paragraphs and blank lines belong to this one historical note.
    draft.note_entries = Some(if draft.notes.is_empty() { vec![] } else { vec![draft.notes.clone()] });
    true
}

fn issue(result: &AppResult<Option<Store>>) -> String {
    match result {
        Ok(None) => "absente".into(),
        Ok(Some(_)) => "valide".into(),
        Err(e) => e.clone(),
    }
}

fn write_new_file(path: &Path, bytes: &[u8]) -> std::io::Result<()> {
    let mut file = OpenOptions::new().write(true).create_new(true).open(path)?;
    if let Err(error) = file.write_all(bytes).and_then(|_| file.sync_all()) {
        drop(file);
        let _ = fs::remove_file(path);
        return Err(error);
    }
    Ok(())
}

fn atomic_replace(path: &Path, bytes: &[u8]) -> std::io::Result<()> {
    fs::create_dir_all(path.parent().unwrap())?;
    let temp = path.with_file_name(format!(
        ".{}.{}.tmp",
        path.file_name().unwrap().to_string_lossy(),
        Uuid::new_v4()
    ));
    write_new_file(&temp, bytes)?;
    let result = move_replace(&temp, path);
    if result.is_err() {
        let _ = fs::remove_file(&temp);
    }
    result
}

fn file_matches_hash(path: &Path, hash: &str) -> bool {
    fs::read(path).ok().is_some_and(|bytes| {
        validate_pdf(&bytes).is_ok() && format!("{:x}", Sha256::digest(bytes)) == hash
    })
}

#[cfg(windows)]
fn windows_move(source: &Path, target: &Path, replace: bool) -> std::io::Result<()> {
    use std::os::windows::ffi::OsStrExt;
    use windows_sys::Win32::Storage::FileSystem::{
        MoveFileExW, MOVEFILE_REPLACE_EXISTING, MOVEFILE_WRITE_THROUGH,
    };
    let source: Vec<u16> = source.as_os_str().encode_wide().chain(Some(0)).collect();
    let target: Vec<u16> = target.as_os_str().encode_wide().chain(Some(0)).collect();
    let flags = MOVEFILE_WRITE_THROUGH
        | if replace {
            MOVEFILE_REPLACE_EXISTING
        } else {
            0
        };
    let ok = unsafe { MoveFileExW(source.as_ptr(), target.as_ptr(), flags) };
    if ok == 0 {
        Err(std::io::Error::last_os_error())
    } else {
        Ok(())
    }
}

fn move_replace(source: &Path, target: &Path) -> std::io::Result<()> {
    #[cfg(windows)]
    {
        windows_move(source, target, true)
    }
    #[cfg(not(windows))]
    {
        fs::rename(source, target)
    }
}

fn atomic_move_new(source: &Path, target: &Path) -> std::io::Result<()> {
    #[cfg(windows)]
    {
        windows_move(source, target, false)
    }
    #[cfg(not(windows))]
    {
        fs::hard_link(source, target)?;
        fs::remove_file(source)
    }
}

fn with_repo<T>(
    app: tauri::AppHandle,
    lock: tauri::State<'_, Mutex<()>>,
    f: impl FnOnce(&Repository) -> AppResult<T>,
) -> AppResult<T> {
    let _guard = lock
        .lock()
        .map_err(|_| "Verrou de stockage indisponible.".to_string())?;
    let data = app
        .path()
        .app_local_data_dir()
        .map_err(|e| format!("Dossier de données introuvable : {e}"))?;
    let documents = app
        .path()
        .document_dir()
        .map_err(|e| format!("Dossier Documents introuvable : {e}"))?;
    fs::create_dir_all(&data).map_err(|e| format!("Dossier de données inaccessible : {e}"))?;
    let process_lock = OpenOptions::new()
        .create(true)
        .read(true)
        .write(true)
        .open(data.join("state.lock"))
        .map_err(|e| format!("Verrou de stockage inaccessible : {e}"))?;
    process_lock
        .lock_exclusive()
        .map_err(|e| format!("Un autre processus utilise les documents : {e}"))?;
    f(&Repository::new(data, documents))
}

#[tauri::command]
fn load_state(
    app: tauri::AppHandle,
    lock: tauri::State<'_, Mutex<()>>,
) -> AppResult<StateResponse> {
    with_repo(app, lock, |repo| repo.load_state())
}

#[tauri::command]
fn save_draft(
    app: tauri::AppHandle,
    lock: tauri::State<'_, Mutex<()>>,
    draft: Draft,
) -> AppResult<StateResponse> {
    with_repo(app, lock, |repo| repo.save_draft(draft))
}

#[tauri::command]
fn new_draft(
    app: tauri::AppHandle,
    lock: tauri::State<'_, Mutex<()>>,
    kind: Kind,
) -> AppResult<StateResponse> {
    with_repo(app, lock, |repo| repo.new_draft(kind))
}

#[tauri::command]
fn open_draft(
    app: tauri::AppHandle,
    lock: tauri::State<'_, Mutex<()>>,
    id: String,
) -> AppResult<StateResponse> {
    with_repo(app, lock, |repo| repo.open_draft(&id))
}

#[tauri::command]
fn create_quote_from_invoice(
    app: tauri::AppHandle,
    lock: tauri::State<'_, Mutex<()>>,
    id: String,
) -> AppResult<StateResponse> {
    with_repo(app, lock, |repo| repo.create_quote_from_invoice(&id))
}

#[tauri::command]
fn delete_draft(
    app: tauri::AppHandle,
    lock: tauri::State<'_, Mutex<()>>,
    id: String,
    expected_draft: Draft,
) -> AppResult<StateResponse> {
    with_repo(app, lock, |repo| repo.delete_draft(&id, expected_draft))
}

#[tauri::command]
fn restore_previous(
    app: tauri::AppHandle,
    lock: tauri::State<'_, Mutex<()>>,
    id: String,
) -> AppResult<StateResponse> {
    with_repo(app, lock, |repo| repo.restore_previous(&id))
}

#[tauri::command]
fn set_next_invoice_number(
    app: tauri::AppHandle,
    lock: tauri::State<'_, Mutex<()>>,
    number: u64,
    allow_reuse: bool,
) -> AppResult<StateResponse> {
    with_repo(app, lock, |repo| repo.set_next_invoice_number(number, allow_reuse))
}

#[tauri::command]
fn set_output_directory(
    app: tauri::AppHandle,
    lock: tauri::State<'_, Mutex<()>>,
    path: Option<String>,
    kind: Kind,
) -> AppResult<StateResponse> {
    with_repo(app, lock, |repo| repo.set_output_directory(path, kind))
}

#[tauri::command]
fn get_ai_settings(
    app: tauri::AppHandle,
    lock: tauri::State<'_, Mutex<()>>,
) -> AppResult<AiSettings> {
    let provider = with_repo(app, lock, |repo| Ok(repo.load()?.ai_provider))?;
    ai_settings(provider)
}

#[tauri::command]
fn set_ai_provider(
    app: tauri::AppHandle,
    lock: tauri::State<'_, Mutex<()>>,
    provider: String,
) -> AppResult<AiSettings> {
    if !matches!(provider.as_str(), "chatgpt" | "business") { return Err("Service IA invalide.".into()); }
    let selected = with_repo(app, lock, |repo| {
        let mut store = repo.load()?;
        store.ai_provider = provider;
        repo.commit(&mut store)?;
        Ok(store.ai_provider)
    })?;
    ai_settings(selected)
}

#[tauri::command]
fn set_ai_key(
    app: tauri::AppHandle,
    lock: tauri::State<'_, Mutex<()>>,
    provider: String,
    key: Option<String>,
) -> AppResult<AiSettings> {
    if provider != "business" { return Err("Les clés API ne sont pas acceptées dans cette application.".into()); }
    ai::set_key(&provider, key.as_deref())?;
    let selected = with_repo(app, lock, |repo| Ok(repo.load()?.ai_provider))?;
    ai_settings(selected)
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ChatgptStart { settings: AiSettings, attempt_id: String }

#[tauri::command]
async fn start_chatgpt_login(app: tauri::AppHandle, lock: tauri::State<'_, Mutex<()>>) -> AppResult<ChatgptStart> {
    let provider = with_repo(app, lock, |repo| Ok(repo.load()?.ai_provider))?;
    let attempt_id = subscription_ai::start().await?;
    Ok(ChatgptStart { settings: ai_settings(provider)?, attempt_id })
}

#[tauri::command]
fn open_chatgpt_login(attempt: String) -> AppResult<()> { subscription_ai::open_login_url(&attempt) }

#[tauri::command]
fn cancel_chatgpt_login(app: tauri::AppHandle, lock: tauri::State<'_, Mutex<()>>) -> AppResult<AiSettings> {
    subscription_ai::cancel()?;
    get_ai_settings(app, lock)
}

#[tauri::command]
async fn disconnect_chatgpt(app: tauri::AppHandle, lock: tauri::State<'_, Mutex<()>>) -> AppResult<AiSettings> {
    let warning = subscription_ai::disconnect().await?;
    subscription_ai::set_login_message(warning);
    get_ai_settings(app, lock)
}

#[tauri::command]
async fn ai_translate_english(
    app: tauri::AppHandle,
    lock: tauri::State<'_, Mutex<()>>,
    mut draft: Draft,
) -> AppResult<ai::TranslatedText> {
    migrate_draft_notes(&mut draft);
    validate_draft(&draft)?;
    let provider = with_repo(app, lock, |repo| {
        let store = repo.load()?;
        let index = store.index(&draft.id)?;
        if store.records[index].draft != draft {
            return Err("Le brouillon a changé. Enregistrez-le et réessayez la traduction.".into());
        }
        Ok(store.ai_provider)
    })?;
    ai::translate(&provider, &draft.project, &draft.notes,
        &draft.items.iter().map(|item| item.description.clone()).collect::<Vec<_>>()).await
}

/// User-triggered provider check: only synthetic example data, never a draft.
#[tauri::command]
async fn test_ai_connection(
    app: tauri::AppHandle,
    lock: tauri::State<'_, Mutex<()>>,
) -> AppResult<String> {
    let provider = with_repo(app, lock, |repo| Ok(repo.load()?.ai_provider))?;
    let rewritten = ai::rewrite_line(&provider, "Fabrication d’un escalier en chêne, installation comprise.", "prose", 0).await?;
    let translated = ai::translate(&provider, "Escalier", "", &[rewritten]).await?;
    let extracted = ai::extract_document(&provider, "Le nom du client est Client Démonstration. Le projet est Escalier.").await?;
    if extracted.client.as_deref().unwrap_or("").is_empty() { return Err("Le test de remplissage n’a pas reconnu le client.".into()); }
    Ok(format!("Connexion vérifiée : rédaction, traduction et remplissage. Exemple anglais : {}", translated.descriptions[0]))
}

#[tauri::command]
fn start_local_asr(app: tauri::AppHandle, asr: tauri::State<'_, local_asr::LocalAsr>) -> AppResult<String> {
    asr.start(&app)
}

#[tauri::command]
async fn ai_proofread_text(
    app: tauri::AppHandle,
    lock: tauri::State<'_, Mutex<()>>,
    source: String,
    field: Option<String>,
) -> AppResult<String> {
    let provider = with_repo(app, lock, |repo| Ok(repo.load()?.ai_provider))?;
    ai::proofread_text(&provider, &source, field.as_deref().unwrap_or("prose")).await
}

#[tauri::command]
async fn ai_rewrite_line(
    app: tauri::AppHandle,
    lock: tauri::State<'_, Mutex<()>>,
    source: String,
    style: String,
    variation: u32,
) -> AppResult<String> {
    let provider = with_repo(app, lock, |repo| Ok(repo.load()?.ai_provider))?;
    ai::rewrite_line(&provider, &source, &style, variation).await
}

#[tauri::command]
async fn ai_extract_document(
    app: tauri::AppHandle,
    lock: tauri::State<'_, Mutex<()>>,
    transcript: String,
) -> AppResult<ai::VoiceUpdate> {
    let provider = with_repo(app, lock, |repo| Ok(repo.load()?.ai_provider))?;
    ai::extract_document(&provider, &transcript).await
}

#[tauri::command]
fn export_pdf(
    app: tauri::AppHandle,
    lock: tauri::State<'_, Mutex<()>>,
    draft: Draft,
    pdf_bytes: Vec<u8>,
    expected_invoice_number: Option<u64>,
    language: String,
) -> AppResult<ExportResponse> {
    with_repo(app, lock, |repo| {
        repo.export_pdf(draft, pdf_bytes, expected_invoice_number, language)
    })
}

#[tauri::command]
fn get_mail_settings() -> AppResult<outlook::MailSettings> { outlook::settings() }

#[tauri::command]
fn preview_pdf_filename(app: tauri::AppHandle, lock: tauri::State<'_, Mutex<()>>,
    draft_id: String, language: String) -> AppResult<String> {
    if language != "fr" && language != "en" { return Err("Langue du PDF invalide.".into()); }
    with_repo(app, lock, |repo| {
        let store = repo.load()?;
        let draft = &store.records[store.index(&draft_id)?].draft;
        let number = if draft.kind == Kind::Facture {
            Some(draft.issued_number.or(draft.manual_invoice_number).unwrap_or(store.next_invoice_number))
        } else { None };
        let base = base_filename(draft, number, &language)?;
        available_filename(&repo.selected_output_dir(&store, draft.kind)?, &base)
    })
}

#[tauri::command]
fn load_document_versions(app: tauri::AppHandle, lock: tauri::State<'_, Mutex<()>>,
    id: String) -> AppResult<Vec<DocumentVersion>> {
    with_repo(app, lock, |repo| repo.load_document_versions(&id))
}

#[tauri::command]
fn restore_document_version(app: tauri::AppHandle, lock: tauri::State<'_, Mutex<()>>,
    id: String, version_id: String) -> AppResult<StateResponse> {
    with_repo(app, lock, |repo| repo.restore_document_version(&id, &version_id))
}

#[tauri::command]
fn read_document_pdf(app: tauri::AppHandle, lock: tauri::State<'_, Mutex<()>>,
    id: String, path: String) -> AppResult<Vec<u8>> {
    with_repo(app, lock, |repo| repo.read_document_pdf(&id, &path).map(|pdf| pdf.pdf_bytes))
}

#[tauri::command]
fn confirm_invoice_number_reuse(app: tauri::AppHandle, lock: tauri::State<'_, Mutex<()>>,
    draft_id: String, expected_number: u64) -> AppResult<StateResponse> {
    with_repo(app, lock, |repo| repo.confirm_invoice_number_reuse(&draft_id, expected_number))
}

#[tauri::command]
fn save_mail_settings(client_id: String, accountant_email: String, signature: String) -> AppResult<outlook::MailSettings> {
    outlook::save_settings(client_id, accountant_email, signature)
}

#[tauri::command]
async fn start_outlook_login() -> AppResult<outlook::MailSettings> { outlook::start_login().await }

#[tauri::command]
fn cancel_outlook_login() -> AppResult<outlook::MailSettings> { outlook::cancel_login() }

#[tauri::command]
async fn disconnect_outlook() -> AppResult<outlook::MailSettings> { outlook::disconnect().await }

#[tauri::command]
async fn send_outlook_mail(app: tauri::AppHandle, lock: tauri::State<'_, Mutex<()>>,
    draft_id: String, path: String, request: outlook::SendRequest) -> AppResult<outlook::SendReceipt> {
    let (filename, bytes) = with_repo(app.clone(), lock.clone(), |repo| repo.email_attachment(&draft_id, &path))?;
    let hash = format!("{:x}", Sha256::digest(&bytes));
    let receipt = outlook::send(request, filename, bytes).await?;
    with_repo(app, lock, |repo| repo.record_sent_receipt(&draft_id, &path, &hash, receipt.clone()))
        .map_err(|_| "Microsoft a accepté le courriel, mais son statut n'a pas pu être associé au document. Vérifiez Outlook avant tout nouvel envoi.".to_owned())?;
    Ok(receipt)
}

#[tauri::command]
async fn ai_rewrite_email(app: tauri::AppHandle, lock: tauri::State<'_, Mutex<()>>,
    subject: String, body: String, language: String) -> AppResult<ai::EmailText> {
    let provider = with_repo(app, lock, |repo| Ok(repo.load()?.ai_provider))?;
    ai::rewrite_email(&provider, &subject, &body, &language).await
}

pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _, _| { if let Some(window) = app.get_webview_window("main") { let _ = window.show(); let _ = window.set_focus(); } }))
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .setup(|app| {
            business_ai::configure(app.path().resource_dir()?.join("resources/codex/codex.exe"));
            let auth_directory = app.path().app_local_data_dir()?.join("subscription-auth");
            fs::create_dir_all(&auth_directory)?;
            subscription_ai::configure(auth_directory);
            let mail_directory = app.path().app_local_data_dir()?.join("outlook");
            fs::create_dir_all(&mail_directory)?;
            outlook::configure(mail_directory);
            Ok(())
        })
        .manage(Mutex::new(()))
        .manage(local_asr::LocalAsr::default())
        .invoke_handler(tauri::generate_handler![
            load_state,
            save_draft,
            new_draft,
            open_draft,
            create_quote_from_invoice,
            delete_draft,
            restore_previous,
            load_document_versions,
            restore_document_version,
            read_document_pdf,
            set_next_invoice_number,
            set_output_directory,
            confirm_invoice_number_reuse,
            get_ai_settings,
            set_ai_provider,
            set_ai_key,
            start_chatgpt_login,
            open_chatgpt_login,
            cancel_chatgpt_login,
            disconnect_chatgpt,
            test_ai_connection,
            ai_translate_english,
            start_local_asr,
            ai_rewrite_line,
            ai_proofread_text,
            ai_extract_document,
            export_pdf,
            get_mail_settings,
            preview_pdf_filename,
            save_mail_settings,
            start_outlook_login,
            cancel_outlook_login,
            disconnect_outlook,
            send_outlook_mail,
            ai_rewrite_email
        ])
        .build(tauri::generate_context!())
        .expect("Unable to build the local invoice app")
        .run(|app, event| {
            if let tauri::RunEvent::Exit = event {
                app.state::<local_asr::LocalAsr>().stop();
            }
        });
}

#[cfg(test)]
#[path = "selected_versions_tests.rs"]
mod selected_versions_tests;

#[cfg(test)]
mod client_notes_tests;

#[cfg(test)]
mod draft_deletion_tests;

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    const PDF: &[u8] = b"%PDF-1.4\n1 0 obj <<>> endobj\n%%EOF\n";

    fn setup() -> (TempDir, Repository) {
        let root = tempfile::tempdir().unwrap();
        let repo = Repository::new(root.path().join("appdata"), root.path().join("Documents"));
        (root, repo)
    }

    fn ready_invoice(repo: &Repository) -> Draft {
        let mut draft = repo.new_draft(Kind::Facture).unwrap().current;
    draft.tax.as_mut().unwrap().selection = "QC".into();
    draft.tax = Some(taxes::resolve(&draft));
        draft.project = "Projet de test".into();
        draft.client = "Peter".into();
        draft.address = "68 chemin des guides".into();
        draft.items[0].description = "Travail".into();
        draft.items[0].price = "100,00".into();
        draft
    }

    #[test]
    fn separate_saved_drafts_survive_new_documents_and_restart_without_export() {
        let (root, repo) = setup();
        let mut quote = repo.new_draft(Kind::Soumission).unwrap().current;
        quote.project = "Cuisine à reprendre".into();
        quote.notes = "Notes conservées sans PDF".into();
        quote.note_entries = Some(vec![quote.notes.clone()]);
        let quote_id = quote.id.clone();
        let saved = repo.save_draft(quote).unwrap();
        assert_eq!(saved.current.id, quote_id);
        let mut invoice = repo.new_draft(Kind::Facture).unwrap().current;
        invoice.project = "Escalier à reprendre".into();
        invoice.client = "Client de test".into();
        let invoice_id = invoice.id.clone();
        repo.save_draft(invoice).unwrap();
        let records_before = repo.load_state().unwrap().records.len();
        drop(repo);
        let reopened = Repository::new(root.path().join("appdata"), root.path().join("Documents"));
        let state = reopened.load_state().unwrap();
        assert_eq!(state.records.len(), records_before);
        assert_eq!(state.next_invoice_number, 2060);
        assert!(state.records.iter().all(|record| record.exports.is_empty()));
        let resumed_quote = reopened.open_draft(&quote_id).unwrap().current;
        assert_eq!(resumed_quote.project, "Cuisine à reprendre");
        assert_eq!(resumed_quote.notes, "Notes conservées sans PDF");
        assert!(resumed_quote.issued_number.is_none());
        let resumed_invoice = reopened.open_draft(&invoice_id).unwrap().current;
        assert_eq!(resumed_invoice.project, "Escalier à reprendre");
        assert_eq!(resumed_invoice.client, "Client de test");
        assert!(resumed_invoice.issued_number.is_none());
    }

    #[test]
    fn project_is_required_for_output_but_incomplete_drafts_can_be_saved() {
        let (_temp, repo) = setup();
        let mut draft = ready_invoice(&repo);
        draft.project.clear();
        let saved = repo.save_draft(draft).unwrap().current;
        assert!(saved.project.is_empty());
        assert!(validate_export_draft(&saved).unwrap_err().contains("nom du projet"));
        let mut complete = saved;
        complete.project = "Escalier en chêne rouge".into();
        assert!(validate_export_draft(&complete).is_ok());
    }

    #[test]
    fn email_attachment_is_registered_hashed_and_bound_to_document() {
        let (_temp, repo) = setup();
        let draft = ready_invoice(&repo);
        let id = draft.id.clone();
        let exported = repo.export_pdf(draft, PDF.to_vec(), Some(2060), "fr".into()).unwrap();
        let (filename, bytes) = repo.email_attachment(&id, &exported.path).unwrap();
        assert_eq!(filename, exported.filename);
        assert_eq!(bytes, PDF);
        let another = repo.new_draft(Kind::Soumission).unwrap().current;
        assert!(repo.email_attachment(&another.id, &exported.path).is_err());
        assert!(repo.email_attachment(&id, "C:/Windows/win.ini").is_err());
        fs::write(&exported.path, b"%PDF-1.4\nchanged\n%%EOF\n").unwrap();
        assert!(repo.email_attachment(&id, &exported.path).is_err());
        // Hashing the bytes actually read catches a changed PDF rather than trusting its header.
        fs::write(&exported.path, PDF).unwrap();
        assert!(repo.email_attachment(&id, &exported.path).is_ok());
        let mut store = repo.load().unwrap();
        let index = store.index(&id).unwrap();
        store.records[index].exports[0].pdf_sha256 = None;
        repo.commit(&mut store).unwrap();
        assert!(repo.email_attachment(&id, &exported.path).is_err());
    }

    #[test]
    fn legacy_metered_selection_migrates_without_losing_drafts() {
        for provider in ["openai", "zai"] {
            let (_temp, repo) = setup();
            let mut store = Store::fresh();
            repo.commit(&mut store).unwrap();
            store.ai_provider = provider.into();
            let client = store.records[0].draft.client.clone();
            let id = store.records[0].draft.id.clone();
            let bytes = serde_json::to_vec_pretty(&store).unwrap();
            fs::write(repo.primary(), &bytes).unwrap();
            fs::write(repo.backup(), &bytes).unwrap();
            let loaded = repo.load().unwrap();
            assert_eq!(loaded.ai_provider, "chatgpt");
            assert_eq!(loaded.records[0].draft.id, id);
            assert_eq!(loaded.records[0].draft.client, client);
            for path in [repo.primary(), repo.backup()] {
                let persisted: Store = serde_json::from_slice(&fs::read(path).unwrap()).unwrap();
                assert_eq!(persisted.ai_provider, "chatgpt");
            }
            store.ai_provider = provider.into();
            assert!(validate_store(&store).is_err());
        }
    }

    #[test]
    fn first_run_save_and_backup_recover_last_good_state() {
        let (_temp, repo) = setup();
        let state = repo.load_state().unwrap();
        assert_eq!(state.next_invoice_number, 2060);
        assert_eq!(state.current.kind, Kind::Soumission);
        assert!(state.current.client.is_empty());
        let mut draft = state.current;
        draft.client = "Client enregistré".into();
        let saved = repo.save_draft(draft.clone()).unwrap();
        assert_eq!(saved.current.client, draft.client);
        assert!(repo.primary().exists() && repo.backup().exists());
        fs::write(repo.primary(), b"{corrupt").unwrap();
        assert_eq!(repo.load_state().unwrap().current.client, draft.client);
        assert!(read_store(&repo.primary()).unwrap().is_some());
        fs::write(repo.primary(), b"{bad").unwrap();
        fs::write(repo.backup(), b"{bad").unwrap();
        assert!(repo
            .load_state()
            .unwrap_err()
            .contains("Aucun fichier n'a été remplacé"));
        assert_eq!(fs::read(repo.primary()).unwrap(), b"{bad");
    }

    #[test]
    fn invoice_number_is_fixed_only_after_successful_pdf_and_reused() {
        let (_temp, repo) = setup();
        let draft = ready_invoice(&repo);
        for _ in 0..3 {
            assert_eq!(
                repo.save_draft(draft.clone()).unwrap().next_invoice_number,
                2060
            );
        }
        assert!(repo
            .export_pdf(draft.clone(), PDF.to_vec(), Some(2059), "fr".into())
            .is_err());
        assert!(repo
            .export_pdf(draft.clone(), b"bad".to_vec(), Some(2060), "fr".into())
            .is_err());
        assert_eq!(repo.load_state().unwrap().next_invoice_number, 2060);
        let first = repo
            .export_pdf(draft.clone(), PDF.to_vec(), Some(2060), "fr".into())
            .unwrap();
        assert_eq!(first.invoice_number, Some(2060));
        assert!(!first.name_collision);
        assert_eq!(first.snapshot.issued_number, Some(2060));
        assert_eq!(repo.load_state().unwrap().next_invoice_number, 2061);
        fs::write(repo.primary(), b"{corrupt").unwrap();
        let recovered = repo.load_state().unwrap();
        assert_eq!(recovered.current.issued_number, Some(2060));
        assert_eq!(recovered.next_invoice_number, 2061);
        let repeat = repo
            .export_pdf(first.snapshot, PDF.to_vec(), Some(2060), "fr".into())
            .unwrap();
        assert_eq!(repeat.invoice_number, Some(2060));
        assert_ne!(repeat.path, first.path);
        assert!(repeat.filename.ends_with("_2.pdf"));
        assert!(repeat.name_collision);
        assert_eq!(
            repo.new_draft(Kind::Facture)
                .unwrap()
                .current
                .invoice_number,
            Some(2061)
        );
        assert_eq!(repo.load_state().unwrap().next_invoice_number, 2061);
    }

    #[test]
    fn reviewed_english_copy_survives_reopen_and_shares_one_invoice_number() {
        let (_temp, repo) = setup();
        let mut draft = ready_invoice(&repo);
        draft.project = "Escalier".into();
        draft.notes = "Installation incluse".into();
        draft.note_entries = Some(vec![draft.notes.clone()]);
        draft.payments = Some(vec![Payment { amount: "40,25".into(), date: "2026-09-18".into() }, Payment { amount: "15,50".into(), date: "2026-09-25".into() }]);
        draft.english_copy = Some(EnglishCopy {
            source_project: draft.project.clone(),
            source_notes: draft.notes.clone(),
            source_descriptions: vec![draft.items[0].description.clone()],
            project: "Staircase".into(),
            notes: "Installation included".into(),
            descriptions: vec!["Work".into()],
            reviewed: true,
        });
        repo.save_draft(draft.clone()).unwrap();
        let reopened = repo.load_state().unwrap().current;
        assert_eq!(reopened.items[0].description, "Travail");
        assert_eq!(reopened.english_copy.as_ref().unwrap().descriptions[0], "Work");
        let en = repo.export_pdf(reopened, PDF.to_vec(), Some(2060), "en".into()).unwrap();
        assert!(en.filename.contains("_EN.pdf"));
        assert_eq!(en.snapshot.items[0].description, "Travail");
        assert_eq!(en.snapshot.issued_number, Some(2060));
        assert_eq!(en.snapshot.payments.as_ref().unwrap().len(), 2);
        assert_eq!(repo.load_state().unwrap().next_invoice_number, 2061);
        let fr = repo.export_pdf(en.snapshot, PDF.to_vec(), Some(2060), "fr".into()).unwrap();
        assert_eq!(fr.invoice_number, Some(2060));
        assert_eq!(repo.load_state().unwrap().next_invoice_number, 2061);
        assert!(repo.backup().exists());
    }

    #[test]
    fn legacy_deposit_migration_preserves_undated_amount_and_dated_rows_after_restore() {
        let (_temp, repo) = setup();
        let draft = ready_invoice(&repo);
        repo.save_draft(draft.clone()).unwrap();
        let mut store = repo.load().unwrap();
        let index = store.index(&draft.id).unwrap();
        store.records[index].draft.deposit = "75,00".into();
        let mut value = serde_json::to_value(&store).unwrap();
        for record in value["records"].as_array_mut().unwrap() {
            record["draft"].as_object_mut().unwrap().remove("payments");
        }
        for versions in value["versions"].as_object_mut().unwrap().values_mut() {
            for version in versions.as_array_mut().unwrap() { version.as_object_mut().unwrap().remove("payments"); }
        }
        let bytes = serde_json::to_vec_pretty(&value).unwrap();
        fs::write(repo.primary(), &bytes).unwrap();
        fs::write(repo.backup(), &bytes).unwrap();
        let loaded = repo.load_state().unwrap();
        assert_eq!(loaded.next_invoice_number, 2060);
        assert_eq!(loaded.current.payments.as_ref().unwrap(), &vec![Payment { amount: "75,00".into(), date: String::new() }]);
        assert_eq!(fs::read(repo.primary()).unwrap(), bytes);
        let mut edited = loaded.current;
        edited.payments = Some(vec![Payment { amount: "40".into(), date: "2026-09-18".into() }, Payment { amount: "35".into(), date: "2026-09-25".into() }]);
        repo.save_draft(edited.clone()).unwrap();
        assert_eq!(repo.open_draft(&draft.id).unwrap().current.payments, edited.payments);
        fs::write(repo.primary(), b"{corrupt").unwrap();
        assert_eq!(repo.load_state().unwrap().current.payments, edited.payments);
        let restored = repo.restore_previous(&draft.id).unwrap().current;
        assert_eq!(restored.payments.unwrap()[0].amount, "75,00");
        assert_eq!(repo.load_state().unwrap().next_invoice_number, 2060);
    }

    #[test]
    fn cleared_payments_are_not_recreated_from_legacy_deposit() {
        let (_temp, repo) = setup();
        let mut draft = ready_invoice(&repo);
        draft.deposit = "75,00".into();
        draft.payments = Some(vec![]);
        repo.save_draft(draft.clone()).unwrap();
        assert!(repo.load_state().unwrap().current.payments.unwrap().is_empty());
        assert!(repo.export_pdf(draft, PDF.to_vec(), Some(2060), "fr".into()).is_ok());
    }

    #[test]
    fn invalid_payment_export_never_issues_an_invoice_number() {
        let (_temp, repo) = setup();
        let mut draft = ready_invoice(&repo);
        for amount in ["-1", "abc", "1000000001", ""] {
            draft.payments = Some(vec![Payment { amount: amount.into(), date: "2026-09-18".into() }]);
            repo.save_draft(draft.clone()).unwrap();
            assert!(repo.export_pdf(draft.clone(), PDF.to_vec(), Some(2060), "fr".into()).is_err());
            assert_eq!(repo.load_state().unwrap().next_invoice_number, 2060);
        }
        draft.payments = Some(vec![Payment { amount: "10".into(), date: "2026-02-30".into() }]);
        assert!(repo.save_draft(draft).is_err());
        assert_eq!(repo.load_state().unwrap().next_invoice_number, 2060);
    }

    #[test]
    fn english_export_requires_current_review_and_keeps_unissued_number_on_failure() {
        let (_temp, repo) = setup();
        let mut draft = ready_invoice(&repo);
        assert!(repo.export_pdf(draft.clone(), PDF.to_vec(), Some(2060), "en".into()).is_err());
        draft.english_copy = Some(EnglishCopy {
            source_project: draft.project.clone(), source_notes: draft.notes.clone(),
            source_descriptions: vec![draft.items[0].description.clone()],
            project: String::new(), notes: String::new(), descriptions: vec!["Work".into()],
            reviewed: false,
        });
        assert!(repo.export_pdf(draft.clone(), PDF.to_vec(), Some(2060), "en".into()).is_err());
        draft.english_copy.as_mut().unwrap().reviewed = true;
        draft.items[0].description = "Travail modifié".into();
        assert!(repo.export_pdf(draft, PDF.to_vec(), Some(2060), "en".into()).is_err());
        assert_eq!(repo.load_state().unwrap().next_invoice_number, 2060);
    }

    #[test]
    fn older_number_resets_cursor_and_preserves_issued_documents() {
        let (_temp, repo) = setup();
        assert!(repo.set_next_invoice_number(0, false).is_err());
        assert_eq!(
            repo.set_next_invoice_number(3000, false)
                .unwrap()
                .next_invoice_number,
            3000
        );
        let draft = ready_invoice(&repo);
        assert_eq!(draft.invoice_number, Some(3000));
        let original = repo.export_pdf(draft, PDF.to_vec(), Some(3000), "fr".into())
            .unwrap();
        assert!(repo.set_next_invoice_number(3000, false).is_err());
        assert!(repo.set_next_invoice_number(2999, false).is_err());
        assert_eq!(
            repo.set_next_invoice_number(4000, false)
                .unwrap()
                .next_invoice_number,
            4000
        );
        assert_eq!(repo.load_state().unwrap().next_invoice_number, 4000);
        assert_eq!(
            repo.new_draft(Kind::Facture)
                .unwrap()
                .current
                .invoice_number,
            Some(4000)
        );
        let selected = repo.set_next_invoice_number(3000, true).unwrap();
        assert_eq!(selected.current.invoice_number, Some(3000));
        assert_eq!(selected.current.manual_invoice_number, Some(3000));
        assert_eq!(selected.next_invoice_number, 3000);
        let mut corrected = selected.current;
        corrected.project = "Correction".into();
        corrected.client = "Peter".into();
        corrected.address = "68 chemin des guides".into();
        corrected.tax.as_mut().unwrap().selection = "QC".into();
        corrected.tax = Some(taxes::resolve(&corrected));
        corrected.items[0].description = "Correction".into();
        corrected.items[0].price = "100".into();
        repo.save_draft(corrected.clone()).unwrap();
        assert_eq!(repo.load_state().unwrap().current.invoice_number, Some(3000));
        let exported = repo.export_pdf(corrected, PDF.to_vec(), Some(3000), "fr".into()).unwrap();
        assert!(exported.name_collision);
        assert_ne!(original.path, exported.path);
        assert!(Path::new(&original.path).exists());
        assert!(Path::new(&exported.path).exists());
        assert_eq!(exported.invoice_number, Some(3000));
        assert_eq!(repo.load_state().unwrap().next_invoice_number, 3001);
        assert_eq!(repo.new_draft(Kind::Facture).unwrap().current.invoice_number, Some(3001));
        let unused = repo.set_next_invoice_number(2999, true).unwrap();
        assert_eq!(unused.current.invoice_number, Some(2999));
        assert_eq!(unused.next_invoice_number, 2999);
        let gap = repo.set_next_invoice_number(3500, true).unwrap();
        assert_eq!(gap.current.invoice_number, Some(3500));
        assert_eq!(gap.next_invoice_number, 3500);
        let mut quote = gap.current;
        quote.kind = Kind::Soumission;
        let quote = repo.save_draft(quote).unwrap().current;
        assert_eq!(quote.manual_invoice_number, None);
        assert_eq!(quote.invoice_number, None);
        let mut invoice_again = quote;
        invoice_again.kind = Kind::Facture;
        assert_eq!(repo.save_draft(invoice_again).unwrap().current.invoice_number, Some(3500));
    }

    #[test]
    fn type_switch_defaults_missing_quote_validity_and_preserves_custom_date() {
        let (_temp, repo) = setup();
        let mut draft = repo.load_state().unwrap().current;
        draft.kind = Kind::Facture;
        draft.date = "2026-12-20".into();
        draft.valid_until.clear();
        draft.due_date.clear();
        draft.project = "Projet conservé".into();
        let invoice = repo.save_draft(draft).unwrap();
        let cursor = invoice.next_invoice_number;
        let mut quote = invoice.current;
        quote.kind = Kind::Soumission;
        let quote = repo.save_draft(quote).unwrap();
        assert_eq!(quote.current.valid_until, "2027-01-19");
        assert_eq!(quote.current.due_date, "");
        assert_eq!(quote.current.project, "Projet conservé");
        assert_eq!(quote.current.invoice_number, None);
        assert_eq!(quote.next_invoice_number, cursor);
        assert_eq!(repo.load_state().unwrap().current.valid_until, "2027-01-19");
        let mut invoice = quote.current;
        invoice.kind = Kind::Facture;
        let mut quote = repo.save_draft(invoice).unwrap().current;
        quote.kind = Kind::Soumission;
        quote.valid_until = "2027-02-10".into();
        assert_eq!(repo.save_draft(quote).unwrap().current.valid_until, "2027-02-10");
    }

    #[test]
    fn issued_invoice_quote_copy_preserves_original_history_pdf_and_cursor() {
        let (_temp, repo) = setup();
        let mut draft = ready_invoice(&repo);
        draft.date = "2026-12-20".into();
        draft.valid_until.clear();
        draft.note_entries = Some(vec!["Note conservée".into()]);
        draft.notes = "Note conservée".into();
        draft.payments = Some(vec![Payment {amount:"25".into(),date:"2026-12-20".into()}]);
        let exported = repo.export_pdf(draft, PDF.to_vec(), Some(2060), "fr".into()).unwrap();
        let before = repo.load().unwrap();
        let quote = repo.create_quote_from_invoice(&exported.snapshot.id).unwrap();
        assert_eq!(quote.current.kind, Kind::Soumission);
        assert_ne!(quote.current.id, exported.snapshot.id);
        assert_eq!(quote.current.valid_until, "2027-01-19");
        assert_eq!(quote.current.invoice_number, None);
        assert_eq!(quote.current.issued_number, None);
        assert_eq!(quote.current.manual_invoice_number, None);
        assert_eq!(quote.next_invoice_number, before.next_invoice_number);
        let mut expected = exported.snapshot.clone();
        expected.id = quote.current.id.clone(); expected.kind = Kind::Soumission;
        expected.valid_until = "2027-01-19".into(); expected.invoice_number = None;
        expected.manual_invoice_number = None; expected.issued_number = None; expected.english_copy = None;
        assert_eq!(quote.current, expected);
        let after = repo.load().unwrap();
        assert_eq!(serde_json::to_value(&after.records[..before.records.len()]).unwrap(),serde_json::to_value(&before.records).unwrap());
        assert_eq!(after.versions,before.versions);
        assert!(after.records.last().unwrap().exports.is_empty());
        assert_eq!(fs::read(exported.path).unwrap(), PDF);
        assert_eq!(repo.load_state().unwrap().current, quote.current);
        repo.open_draft(&exported.snapshot.id).unwrap();
        let mut custom = exported.snapshot.clone(); custom.valid_until = "2027-02-10".into();
        repo.save_draft(custom).unwrap();
        assert_eq!(repo.create_quote_from_invoice(&exported.snapshot.id).unwrap().current.valid_until,"2027-02-10");
    }

    #[test]
    fn quote_copy_rejects_unissued_and_stale_sources_without_writing() {
        let (_temp, repo) = setup();
        let draft = repo.save_draft(ready_invoice(&repo)).unwrap().current;
        let before = fs::read(repo.primary()).unwrap();
        assert!(repo.create_quote_from_invoice(&draft.id).is_err());
        assert_eq!(fs::read(repo.primary()).unwrap(),before);
        let issued = repo.export_pdf(draft, PDF.to_vec(), Some(2060), "fr".into()).unwrap();
        repo.new_draft(Kind::Soumission).unwrap();
        let before = fs::read(repo.primary()).unwrap();
        assert!(repo.create_quote_from_invoice(&issued.snapshot.id).is_err());
        assert_eq!(fs::read(repo.primary()).unwrap(),before);
    }

    #[test]
    fn type_switch_keeps_unissued_content_and_blocks_issued_invoice_change() {
        let (_temp, repo) = setup();
        let mut draft = repo.load_state().unwrap().current;
        draft.project = "Armoire".into();
        draft.client = "Peter".into();
        draft.address = "Adresse".into();
        draft.tax.as_mut().unwrap().selection = "QC".into();
        draft.tax = Some(taxes::resolve(&draft));
        draft.items[0].description = "Travail".into();
        draft.items[0].price = "100".into();
        draft.kind = Kind::Facture;
        let invoice = repo.save_draft(draft).unwrap().current;
        assert_eq!(invoice.invoice_number, Some(2060));
        assert_eq!(invoice.project, "Armoire");

        let mut back_to_quote = invoice;
        back_to_quote.kind = Kind::Soumission;
        let quote = repo.save_draft(back_to_quote).unwrap().current;
        assert_eq!(quote.invoice_number, None);
        assert_eq!(quote.client, "Peter");
        assert_eq!(quote.items[0].description, "Travail");

        let mut invoice_again = quote;
        invoice_again.kind = Kind::Facture;
        let invoice_again = repo.save_draft(invoice_again).unwrap().current;
        let issued = repo
            .export_pdf(invoice_again, PDF.to_vec(), Some(2060), "fr".into())
            .unwrap();
        let mut invalid_change = issued.snapshot;
        invalid_change.kind = Kind::Soumission;
        assert!(repo.save_draft(invalid_change).is_err());
    }

    #[test]
    fn dad_cursor_reset_survives_restart_type_switches_and_warns_on_each_reused_number() {
        let (_root, repo) = setup();
        let mut originals = Vec::new();
        for number in 2060..=2062 {
            let draft = ready_invoice(&repo);
            let exported = repo.export_pdf(draft, PDF.to_vec(), Some(number), "fr".into()).unwrap();
            originals.push(exported);
        }
        assert_eq!(repo.load_state().unwrap().next_invoice_number, 2063);
        let original_bytes: Vec<_> = originals.iter().map(|e| fs::read(&e.path).unwrap()).collect();
        let draft = repo.set_next_invoice_number(2060, true).unwrap().current;
        assert_eq!(draft.invoice_number, Some(2060));
        assert_eq!(repo.load_state().unwrap().next_invoice_number, 2060);
        let mut quote = draft;
        quote.kind = Kind::Soumission;
        let mut invoice = repo.save_draft(quote).unwrap().current;
        invoice.kind = Kind::Facture;
        invoice.project = "Correction".into();
        invoice.client = "Peter".into(); invoice.address = "Adresse".into();
        invoice.tax.as_mut().unwrap().selection = "QC".into();
        invoice.tax = Some(taxes::resolve(&invoice));
        invoice.items[0].description = "Correction".into(); invoice.items[0].price = "100".into();
        let invoice = repo.save_draft(invoice).unwrap().current;
        assert_eq!(invoice.invoice_number, Some(2060));
        assert_eq!(invoice.manual_invoice_number, None);
        let before = repo.load().unwrap();
        assert!(repo.export_pdf(invoice.clone(), PDF.to_vec(), Some(2060), "fr".into()).is_err());
        assert_eq!(repo.load().unwrap().generation, before.generation);
        assert!(repo.load().unwrap().pending_export.is_none());
        assert!(repo.confirm_invoice_number_reuse(&invoice.id, 2061).is_err());
        let confirmed = repo.confirm_invoice_number_reuse(&invoice.id, 2060).unwrap().current;
        let correction = repo.export_pdf(confirmed, PDF.to_vec(), Some(2060), "fr".into()).unwrap();
        assert_eq!(repo.load_state().unwrap().next_invoice_number, 2061);
        repo.export_pdf(correction.snapshot, PDF.to_vec(), Some(2060), "fr".into()).unwrap();
        assert_eq!(repo.load_state().unwrap().next_invoice_number, 2061);
        let next = ready_invoice(&repo);
        assert_eq!(next.invoice_number, Some(2061));
        assert!(repo.export_pdf(next.clone(), PDF.to_vec(), Some(2061), "fr".into()).is_err());
        repo.save_draft(next.clone()).unwrap();
        let next = repo.confirm_invoice_number_reuse(&next.id, 2061).unwrap().current;
        repo.export_pdf(next, PDF.to_vec(), Some(2061), "fr".into()).unwrap();
        assert_eq!(repo.load_state().unwrap().next_invoice_number, 2062);
        for (original, bytes) in originals.iter().zip(original_bytes) {
            assert_eq!(fs::read(&original.path).unwrap(), bytes);
            let saved = repo.open_draft(&original.snapshot.id).unwrap();
            assert_eq!(saved.current.issued_number, original.invoice_number);
        }
    }

    #[test]
    fn pdf_destinations_are_independent_by_kind_and_legacy_shared_path_is_preserved() {
        let (root, repo) = setup();
        let invoices = root.path().join("Factures choisies");
        let quotes = root.path().join("Soumissions choisies");
        fs::create_dir(&invoices).unwrap(); fs::create_dir(&quotes).unwrap();
        repo.set_output_directory(Some(invoices.to_string_lossy().into_owned()), Kind::Facture).unwrap();
        repo.set_output_directory(Some(quotes.to_string_lossy().into_owned()), Kind::Soumission).unwrap();
        let invoice = ready_invoice(&repo);
        let archived = repo.export_pdf(invoice, PDF.to_vec(), Some(2060), "fr".into()).unwrap();
        assert!(Path::new(&archived.path).starts_with(&invoices));
        let mut quote = repo.new_draft(Kind::Soumission).unwrap().current;
        quote.project = "Travail".into();
        quote.client = "Peter".into(); quote.address = "Adresse".into();
        quote.tax.as_mut().unwrap().selection = "QC".into();
        quote.tax = Some(taxes::resolve(&quote));
        quote.items[0].description = "Travail".into(); quote.items[0].price = "100".into();
        let archived_quote = repo.export_pdf(quote, PDF.to_vec(), None, "fr".into()).unwrap();
        assert!(Path::new(&archived_quote.path).starts_with(&quotes));
        assert_eq!(repo.email_attachment(&archived.snapshot.id, &archived.path).unwrap().1, PDF);
        assert_eq!(repo.email_attachment(&archived_quote.snapshot.id, &archived_quote.path).unwrap().1, PDF);
        let state = repo.load_state().unwrap();
        assert_eq!(state.invoice_pdf_directory, invoices.to_string_lossy());
        assert_eq!(state.quote_pdf_directory, quotes.to_string_lossy());
        repo.set_output_directory(None, Kind::Facture).unwrap();
        assert_eq!(repo.load_state().unwrap().quote_pdf_directory, quotes.to_string_lossy());
        let mut legacy = repo.load().unwrap();
        legacy.separate_pdf_directories = false;
        legacy.pdf_directory = Some(quotes.to_string_lossy().into_owned());
        repo.commit(&mut legacy).unwrap();
        let preserved = repo.set_output_directory(Some(invoices.to_string_lossy().into_owned()), Kind::Facture).unwrap();
        assert_eq!(preserved.quote_pdf_directory, quotes.to_string_lossy());
        assert_eq!(preserved.invoice_pdf_directory, invoices.to_string_lossy());
        assert!(Path::new(&archived.path).exists()); assert!(Path::new(&archived_quote.path).exists());
    }

    #[test]
    fn filenames_stay_inside_intake_and_invalid_inputs_are_rejected() {
        let (_temp, repo) = setup();
        let mut draft = ready_invoice(&repo);
        draft.client = "../CON:<A/B>".into();
        let exported = repo
            .export_pdf(draft.clone(), PDF.to_vec(), Some(2060), "fr".into())
            .unwrap();
        assert!(Path::new(&exported.path).starts_with(repo.selected_output_dir(&repo.load().unwrap(), Kind::Facture).unwrap()));
        assert!(!exported.filename.contains(['/', '\\', ':', '<', '>']));
        assert!(exported.filename.starts_with("Facture_2060_"));
        let mut quote = repo.new_draft(Kind::Soumission).unwrap().current;
        quote.project = "Travail".into();
        quote.client = "Peter".into();
        quote.address = "Adresse".into();
        quote.tax.as_mut().unwrap().selection = "QC".into();
        quote.tax = Some(taxes::resolve(&quote));
        quote.items[0].description = "Travail".into();
        quote.items[0].price = "0".into();
        let one = repo
            .export_pdf(quote.clone(), PDF.to_vec(), None, "fr".into())
            .unwrap();
        let two = repo
            .export_pdf(quote.clone(), PDF.to_vec(), None, "fr".into())
            .unwrap();
        assert_ne!(one.filename, two.filename);
        assert!(two.name_collision);
        assert!(!one.filename.contains("2060"));
        quote.date = "2026-02-30".into();
        assert!(repo.save_draft(quote.clone()).is_err());
        quote.date = "2026-09-28".into();
        quote.items[0].quantity = "0".into();
        assert!(repo
            .export_pdf(quote, PDF.to_vec(), None, "fr".into())
            .is_err());
        assert!(Path::new(&one.path).exists());
    }

    #[test]
    fn version_restore_keeps_issued_number_and_can_reach_older_versions() {
        let (_temp, repo) = setup();
        let mut draft = ready_invoice(&repo);
        draft.client = "A".into();
        repo.save_draft(draft.clone()).unwrap();
        draft.client = "B".into();
        repo.save_draft(draft.clone()).unwrap();
        draft.client = "C".into();
        repo.export_pdf(draft.clone(), PDF.to_vec(), Some(2060), "fr".into())
            .unwrap();
        let once = repo.restore_previous(&draft.id).unwrap();
        assert_eq!(once.current.client, "B");
        assert_eq!(once.current.issued_number, Some(2060));
        let twice = repo.restore_previous(&draft.id).unwrap();
        assert_eq!(twice.current.client, "A");
        assert_eq!(twice.current.issued_number, Some(2060));
        assert_eq!(twice.next_invoice_number, 2061);
    }

    #[test]
    fn interrupted_pdf_write_is_finalized_once_after_restart() {
        let (_temp, repo) = setup();
        let draft = ready_invoice(&repo);
        repo.save_draft(draft.clone()).unwrap();
        let mut store = repo.load().unwrap();
        let snapshot = store.records[store.index(&draft.id).unwrap()].draft.clone();
        let filename = base_filename(&snapshot, Some(2060), "fr").unwrap();
        store.pending_export = Some(PendingExport {
            id: draft.id.clone(),
            filename: filename.clone(),
            invoice_number: Some(2060),
            snapshot: snapshot.clone(),
            language: "fr".into(),
            pdf_sha256: format!("{:x}", Sha256::digest(PDF)),
            exported_at: Utc::now().to_rfc3339(),
        });
        repo.commit(&mut store).unwrap();
        let output = repo.selected_output_dir(&store, Kind::Facture).unwrap();
        fs::create_dir_all(&output).unwrap();
        fs::write(output.join(&filename), PDF).unwrap();
        let resumed = repo
            .export_pdf(snapshot, PDF.to_vec(), Some(2060), "fr".into())
            .unwrap();
        assert_eq!(resumed.filename, filename);
        assert_eq!(resumed.snapshot.issued_number, Some(2060));
        let final_state = repo.load().unwrap();
        assert_eq!(final_state.next_invoice_number, 2061);
        assert_eq!(
            final_state.records[final_state.index(&draft.id).unwrap()]
                .exports
                .len(),
            1
        );
    }

    #[test]
    fn failed_output_path_does_not_issue_a_number() {
        let (_temp, repo) = setup();
        let draft = ready_invoice(&repo);
        fs::create_dir_all(&repo.documents_dir).unwrap();
        let blocker = repo.documents_dir.join("Entreprise");
        fs::write(&blocker, b"blocks output directory").unwrap();
        let error = repo
            .export_pdf(draft.clone(), PDF.to_vec(), Some(2060), "fr".into())
            .unwrap_err();
        assert!(error.contains("dossier de sortie"));
        let state = repo.load_state().unwrap();
        assert_eq!(state.next_invoice_number, 2060);
        assert_eq!(state.current.issued_number, None);
        fs::remove_file(blocker).unwrap();
        let result = repo
            .export_pdf(draft, PDF.to_vec(), Some(2060), "fr".into())
            .unwrap();
        assert_eq!(result.snapshot.issued_number, Some(2060));
    }

    #[test]
    fn load_reconciles_completed_pdf_after_restart() {
        let (_temp, repo) = setup();
        let draft = ready_invoice(&repo);
        repo.save_draft(draft.clone()).unwrap();
        let mut store = repo.load().unwrap();
        let snapshot = store.records[store.index(&draft.id).unwrap()].draft.clone();
        let filename = base_filename(&snapshot, Some(2060), "fr").unwrap();
        store.pending_export = Some(PendingExport {
            id: draft.id.clone(),
            filename: filename.clone(),
            invoice_number: Some(2060),
            snapshot,
            language: "fr".into(),
            pdf_sha256: format!("{:x}", Sha256::digest(PDF)),
            exported_at: Utc::now().to_rfc3339(),
        });
        repo.commit(&mut store).unwrap();
        let output = repo.selected_output_dir(&store, Kind::Facture).unwrap();
        fs::create_dir_all(&output).unwrap();
        fs::write(output.join(filename), PDF).unwrap();
        let recovered = repo.load_state().unwrap();
        assert_eq!(recovered.current.issued_number, Some(2060));
        assert_eq!(recovered.next_invoice_number, 2061);
        assert_eq!(
            recovered
                .records
                .iter()
                .find(|record| record.id == draft.id)
                .unwrap()
                .exports
                .len(),
            1
        );
        assert!(repo.load().unwrap().pending_export.is_none());
    }

    #[test]
    fn chosen_pdf_folder_persists_and_receives_invoice_without_overwriting() {
        let (root, repo) = setup();
        let chosen = root.path().join("Mes PDF");
        fs::create_dir_all(&chosen).unwrap();
        let chosen_text = chosen.to_string_lossy().into_owned();
        let configured = repo.set_output_directory(Some(chosen_text.clone()), Kind::Facture).unwrap();
        assert_eq!(configured.invoice_pdf_directory, chosen_text);
        assert!(!configured.using_default_invoice_directory);
        assert_eq!(repo.load_state().unwrap().invoice_pdf_directory, chosen_text);

        let draft = ready_invoice(&repo);
        let first = repo
            .export_pdf(draft, PDF.to_vec(), Some(2060), "fr".into())
            .unwrap();
        assert!(Path::new(&first.path).starts_with(&chosen));
        assert!(!repo.output_dir().exists());
        let second = repo
            .export_pdf(first.snapshot, PDF.to_vec(), Some(2060), "fr".into())
            .unwrap();
        assert!(Path::new(&second.path).starts_with(&chosen));
        assert_ne!(first.path, second.path);
        assert!(second.name_collision);
        assert_eq!(repo.load_state().unwrap().next_invoice_number, 2061);

        let reset = repo.set_output_directory(None, Kind::Facture).unwrap();
        assert!(reset.using_default_directory);
        assert_eq!(reset.pdf_directory, repo.selected_output_dir(&repo.load().unwrap(), Kind::Facture).unwrap().to_string_lossy());
        assert!(Path::new(&first.path).exists());
    }

    #[test]
    fn unavailable_chosen_folder_blocks_export_and_preserves_number() {
        let (root, repo) = setup();
        let chosen = root.path().join("PDF amovibles");
        fs::create_dir_all(&chosen).unwrap();
        let chosen_text = chosen.to_string_lossy().into_owned();
        repo.set_output_directory(Some(chosen_text.clone()), Kind::Facture).unwrap();
        let draft = ready_invoice(&repo);
        fs::remove_dir(&chosen).unwrap();
        let error = repo
            .export_pdf(draft.clone(), PDF.to_vec(), Some(2060), "fr".into())
            .unwrap_err();
        assert!(error.contains("n'est plus disponible"));
        let state = repo.load_state().unwrap();
        assert_eq!(state.pdf_directory, chosen_text);
        assert_eq!(state.next_invoice_number, 2060);
        assert_eq!(state.current.issued_number, None);

        assert!(repo.set_output_directory(Some("relative-folder".into()), Kind::Facture).is_err());
        let other = root.path().join("Nouveau dossier");
        fs::create_dir_all(&other).unwrap();
        repo.set_output_directory(Some(other.to_string_lossy().into_owned()), Kind::Facture).unwrap();
        let exported = repo
            .export_pdf(draft, PDF.to_vec(), Some(2060), "fr".into())
            .unwrap();
        assert!(Path::new(&exported.path).starts_with(other));
        assert_eq!(exported.snapshot.issued_number, Some(2060));
    }

    #[test]
    fn existing_state_without_folder_setting_uses_original_default() {
        let (_root, repo) = setup();
        let original = repo.load_state().unwrap();
        let mut legacy: serde_json::Value = serde_json::from_slice(&fs::read(repo.primary()).unwrap()).unwrap();
        legacy.as_object_mut().unwrap().remove("pdfDirectory");
        for field in ["invoicePdfDirectory", "quotePdfDirectory", "separatePdfDirectories", "invoiceSequenceReset"] {
            legacy.as_object_mut().unwrap().remove(field);
        }
        let bytes = serde_json::to_vec(&legacy).unwrap();
        fs::write(repo.primary(), &bytes).unwrap();
        fs::write(repo.backup(), &bytes).unwrap();
        let reopened = repo.load_state().unwrap();
        assert_eq!(reopened.current.id, original.current.id);
        assert_eq!(reopened.next_invoice_number, original.next_invoice_number);
        assert!(reopened.using_default_directory);
        assert_eq!(reopened.pdf_directory, repo.output_dir().to_string_lossy());
    }
}
