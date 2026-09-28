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

type AppResult<T> = Result<T, String>;
const FIRST_INVOICE_NUMBER: u64 = 2060;
const MAX_INVOICE_NUMBER: u64 = 9_007_199_254_740_990;
const MAX_PDF_BYTES: usize = 25 * 1024 * 1024;
const MAX_RECORDS: usize = 10_000;

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
    pub items: Vec<Item>,
    #[serde(default)]
    pub invoice_number: Option<u64>,
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
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Record {
    pub id: String,
    pub draft: Draft,
    pub updated_at: String,
    pub exports: Vec<ExportEntry>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StateResponse {
    pub current: Draft,
    pub records: Vec<Record>,
    pub next_invoice_number: u64,
    pub pdf_directory: String,
    pub using_default_directory: bool,
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
    #[serde(default)]
    pdf_directory: Option<String>,
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
        items: vec![Item {
            description: String::new(),
            quantity: "1".into(),
            price: String::new(),
        }],
        invoice_number: (kind == Kind::Facture).then_some(FIRST_INVOICE_NUMBER),
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
            pdf_directory: None,
            records: vec![Record {
                id: draft.id.clone(),
                draft,
                updated_at: Utc::now().to_rfc3339(),
                exports: vec![],
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
                Some(draft.issued_number.unwrap_or(self.next_invoice_number))
            } else {
                None
            };
        }
    }

    fn response(&self, default_output_dir: &Path) -> AppResult<StateResponse> {
        let mut records = self.records.clone();
        records.sort_by(|a, b| b.updated_at.cmp(&a.updated_at));
        let current = records
            .iter()
            .find(|record| record.id == self.current_id)
            .ok_or_else(|| "Le document courant est introuvable.".to_string())?
            .draft
            .clone();
        Ok(StateResponse {
            current,
            records,
            next_invoice_number: self.next_invoice_number,
            pdf_directory: self.pdf_directory.clone().unwrap_or_else(|| default_output_dir.to_string_lossy().into_owned()),
            using_default_directory: self.pdf_directory.is_none(),
        })
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

    fn selected_output_dir(&self, store: &Store) -> AppResult<PathBuf> {
        if let Some(path) = &store.pdf_directory {
            let dir = PathBuf::from(path);
            if !dir.is_dir() {
                return Err(format!("Le dossier des PDF n'est plus disponible : {path}. Choisissez un autre dossier."));
            }
            Ok(dir)
        } else {
            Ok(self.output_dir())
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
        if !matches!(&primary, Ok(Some(s)) if s.generation == chosen.generation) {
            let _ = atomic_replace(&self.primary(), &bytes);
        }
        if !matches!(&backup, Ok(Some(s)) if s.generation == chosen.generation) {
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
            let output_dir = match self.selected_output_dir(store) {
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
        previous.issued_number = current.issued_number;
        if current.issued_number.is_some() {
            previous.kind = Kind::Facture;
        }
        previous.invoice_number = current
            .issued_number
            .or((previous.kind == Kind::Facture).then_some(store.next_invoice_number));
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

    fn set_next_invoice_number(&self, number: u64) -> AppResult<StateResponse> {
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
        let highest = store
            .records
            .iter()
            .filter_map(|record| record.draft.issued_number)
            .max()
            .unwrap_or(0);
        if number <= highest {
            return Err(format!("Le numéro {number} est déjà utilisé ou antérieur à la dernière facture émise ({highest})."));
        }
        if number == u64::MAX {
            return Err("Numéro trop grand pour permettre la facture suivante.".into());
        }
        if number > MAX_INVOICE_NUMBER {
            return Err(
                "Numéro trop grand pour être affiché sans erreur dans l'application.".into(),
            );
        }
        store.next_invoice_number = number;
        self.commit(&mut store)?;
        store.response(&self.output_dir())
    }

    fn set_output_directory(&self, path: Option<String>) -> AppResult<StateResponse> {
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
        store.pdf_directory = path;
        self.commit(&mut store)?;
        store.response(&self.output_dir())
    }

    fn export_pdf(
        &self,
        draft: Draft,
        pdf_bytes: Vec<u8>,
        expected_invoice_number: Option<u64>,
        language: String,
    ) -> AppResult<ExportResponse> {
        if language != "fr" && language != "en" {
            return Err("Langue invalide : utilisez fr ou en.".into());
        }
        validate_pdf(&pdf_bytes)?;
        validate_export_draft(&draft)?;
        let mut store = self.load()?;
        let output_dir = self.selected_output_dir(&store)?;
        let index = store.index(&draft.id)?;
        let issued = store.records[index].draft.issued_number;
        if issued.is_some() && draft.kind != Kind::Facture {
            return Err("Une facture déjà émise ne peut pas devenir une soumission.".into());
        }
        let number = if draft.kind == Kind::Facture {
            Some(issued.unwrap_or(store.next_invoice_number))
        } else {
            None
        };
        if issued.is_none() && number.is_some_and(|n| n > MAX_INVOICE_NUMBER) {
            return Err("La plage de numéros de facture est épuisée.".into());
        }
        if expected_invoice_number != number {
            return Err(format!(
                "Numéro de facture périmé. Rechargez le document; numéro actuel : {}.",
                number.map_or_else(|| "aucun".into(), |n| n.to_string())
            ));
        }

        // A prior write may have finished before the state commit. Complete it first.
        if let Some(pending) = store.pending_export.clone() {
            let path = output_dir.join(&pending.filename);
            if file_matches_hash(&path, &pending.pdf_sha256) {
                self.finalize_pending(&mut store)?;
                if pending.id == draft.id
                    && pending.snapshot == draft
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
            .issued_number
            .or((snapshot.kind == Kind::Facture).then_some(store.next_invoice_number));
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
        if store.pdf_directory.is_none() {
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

    fn finalize_pending(&self, store: &mut Store) -> AppResult<()> {
        let pending = store
            .pending_export
            .clone()
            .ok_or("Aucun export à terminer.")?;
        let path = self.selected_output_dir(store)?.join(&pending.filename);
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
                if number != store.next_invoice_number {
                    return Err("Le prochain numéro a changé pendant l'export.".into());
                }
                store.records[index].draft.issued_number = Some(number);
                store.next_invoice_number = number
                    .checked_add(1)
                    .ok_or("Plus de numéro de facture disponible.")?;
            }
            store.records[index].draft.invoice_number = Some(number);
        }
        if !store.records[index]
            .exports
            .iter()
            .any(|entry| entry.path == path.to_string_lossy())
        {
            store.records[index].exports.push(ExportEntry {
                path: path.to_string_lossy().into_owned(),
                filename: pending.filename,
                exported_at: pending.exported_at,
                language: pending.language,
                invoice_number: pending.invoice_number,
            });
        }
        store.records[index].updated_at = Utc::now().to_rfc3339();
        store.pending_export = None;
        self.commit(store)
    }
}

fn update_draft(store: &mut Store, mut incoming: Draft) -> AppResult<()> {
    validate_draft(&incoming)?;
    let index = store.index(&incoming.id)?;
    let old = store.records[index].draft.clone();
    if old.issued_number.is_some() && incoming.kind != Kind::Facture {
        return Err("Une facture émise doit rester une facture.".into());
    }
    incoming.issued_number = old.issued_number;
    incoming.invoice_number = if incoming.kind == Kind::Facture {
        Some(old.issued_number.unwrap_or(store.next_invoice_number))
    } else {
        None
    };
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
    Uuid::parse_str(&draft.id).map_err(|_| "Identifiant de document invalide.".to_string())?;
    for (label, value, limit) in [
        ("client", &draft.client, 500),
        ("adresse", &draft.address, 2000),
        ("livraison", &draft.ship_to, 2000),
        ("contact", &draft.contact, 500),
        ("courriel", &draft.email, 500),
        ("projet", &draft.project, 500),
        ("notes", &draft.notes, 50_000),
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
    if !valid_date(&draft.date) {
        return Err("La date du document est requise.".into());
    }
    if draft.kind == Kind::Soumission && !valid_date(&draft.valid_until) {
        return Err("La date de validité de la soumission est requise.".into());
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
    if !draft.deposit.trim().is_empty() && parse_nonnegative(&draft.deposit).is_none() {
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
    if store.next_invoice_number == 0
        || store.next_invoice_number > MAX_INVOICE_NUMBER + 1
        || store.records.is_empty()
        || store.records.len() > MAX_RECORDS
    {
        return Err("État des documents invalide.".into());
    }
    if let Some(path) = &store.pdf_directory {
        if path.len() > 4096 || path.contains('\0') || !Path::new(path).is_absolute() {
            return Err("Dossier PDF personnalisé invalide.".into());
        }
    }
    let mut ids = HashSet::new();
    let mut issued = HashSet::new();
    for record in &store.records {
        validate_draft(&record.draft)?;
        if record.id != record.draft.id || !ids.insert(record.id.clone()) {
            return Err("Identifiants de document dupliqués ou incohérents.".into());
        }
        if let Some(number) = record.draft.issued_number {
            if record.draft.kind != Kind::Facture
                || !issued.insert(number)
                || record.draft.invoice_number != Some(number)
            {
                return Err("Numéros de facture émis incohérents.".into());
            }
        } else if record.draft.invoice_number
            != (record.draft.kind == Kind::Facture).then_some(store.next_invoice_number)
        {
            return Err("Numéro proposé incohérent.".into());
        }
    }
    if !ids.contains(&store.current_id) || issued.iter().any(|n| *n >= store.next_invoice_number) {
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
    let store: Store = serde_json::from_slice(&bytes).map_err(|e| e.to_string())?;
    validate_store(&store)?;
    Ok(Some(store))
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
) -> AppResult<StateResponse> {
    with_repo(app, lock, |repo| repo.set_next_invoice_number(number))
}

#[tauri::command]
fn set_output_directory(
    app: tauri::AppHandle,
    lock: tauri::State<'_, Mutex<()>>,
    path: Option<String>,
) -> AppResult<StateResponse> {
    with_repo(app, lock, |repo| repo.set_output_directory(path))
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

pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .manage(Mutex::new(()))
        .invoke_handler(tauri::generate_handler![
            load_state,
            save_draft,
            new_draft,
            open_draft,
            restore_previous,
            set_next_invoice_number,
            set_output_directory,
            export_pdf
        ])
        .run(tauri::generate_context!())
        .expect("Unable to start the local invoice app");
}

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
        draft.client = "Peter".into();
        draft.address = "68 chemin des guides".into();
        draft.items[0].description = "Travail".into();
        draft.items[0].price = "100,00".into();
        draft
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
    fn next_number_setting_cannot_reuse_or_go_below_issued_number() {
        let (_temp, repo) = setup();
        assert!(repo.set_next_invoice_number(0).is_err());
        assert_eq!(
            repo.set_next_invoice_number(3000)
                .unwrap()
                .next_invoice_number,
            3000
        );
        let draft = ready_invoice(&repo);
        assert_eq!(draft.invoice_number, Some(3000));
        repo.export_pdf(draft, PDF.to_vec(), Some(3000), "fr".into())
            .unwrap();
        assert!(repo.set_next_invoice_number(3000).is_err());
        assert!(repo.set_next_invoice_number(2999).is_err());
        assert_eq!(
            repo.set_next_invoice_number(4000)
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
    }

    #[test]
    fn type_switch_keeps_unissued_content_and_blocks_issued_invoice_change() {
        let (_temp, repo) = setup();
        let mut draft = repo.load_state().unwrap().current;
        draft.project = "Armoire".into();
        draft.client = "Peter".into();
        draft.address = "Adresse".into();
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
    fn filenames_stay_inside_intake_and_invalid_inputs_are_rejected() {
        let (_temp, repo) = setup();
        let mut draft = ready_invoice(&repo);
        draft.client = "../CON:<A/B>".into();
        let exported = repo
            .export_pdf(draft.clone(), PDF.to_vec(), Some(2060), "fr".into())
            .unwrap();
        assert!(Path::new(&exported.path).starts_with(repo.output_dir()));
        assert!(!exported.filename.contains(['/', '\\', ':', '<', '>']));
        assert!(exported.filename.starts_with("Facture_2060_"));
        let mut quote = repo.new_draft(Kind::Soumission).unwrap().current;
        quote.client = "Peter".into();
        quote.address = "Adresse".into();
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
        assert!(repo.output_dir().join(&one.filename).exists());
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
        fs::create_dir_all(repo.output_dir()).unwrap();
        fs::write(repo.output_dir().join(&filename), PDF).unwrap();
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
        fs::create_dir_all(repo.output_dir()).unwrap();
        fs::write(repo.output_dir().join(filename), PDF).unwrap();
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
        let configured = repo.set_output_directory(Some(chosen_text.clone())).unwrap();
        assert_eq!(configured.pdf_directory, chosen_text);
        assert!(!configured.using_default_directory);
        assert_eq!(repo.load_state().unwrap().pdf_directory, chosen_text);

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

        let reset = repo.set_output_directory(None).unwrap();
        assert!(reset.using_default_directory);
        assert_eq!(reset.pdf_directory, repo.output_dir().to_string_lossy());
        assert!(Path::new(&first.path).exists());
    }

    #[test]
    fn unavailable_chosen_folder_blocks_export_and_preserves_number() {
        let (root, repo) = setup();
        let chosen = root.path().join("PDF amovibles");
        fs::create_dir_all(&chosen).unwrap();
        let chosen_text = chosen.to_string_lossy().into_owned();
        repo.set_output_directory(Some(chosen_text.clone())).unwrap();
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

        assert!(repo.set_output_directory(Some("relative-folder".into())).is_err());
        let other = root.path().join("Nouveau dossier");
        fs::create_dir_all(&other).unwrap();
        repo.set_output_directory(Some(other.to_string_lossy().into_owned())).unwrap();
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
