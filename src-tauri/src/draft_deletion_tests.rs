use super::*;
use tempfile::TempDir;

const PDF: &[u8] = b"%PDF-1.4\n1 0 obj <<>> endobj\n%%EOF\n";
fn setup() -> (TempDir, Repository) {
    let root = tempfile::tempdir().unwrap();
    let repo = Repository::new(root.path().join("appdata"), root.path().join("Documents"));
    (root, repo)
}
fn ready(repo: &Repository, kind: Kind) -> Draft {
    let mut draft = repo.new_draft(kind).unwrap().current;
    draft.tax.as_mut().unwrap().selection = "QC".into();
    draft.tax = Some(taxes::resolve(&draft));
    draft.project = "Projet synthétique".into(); draft.client = "Client de test".into();
    draft.address = "Adresse de test".into(); draft.items[0].description = "Travail".into();
    draft.items[0].price = "100".into();
    repo.save_draft(draft).unwrap().current
}

#[test]
fn deletion_of_other_draft_persists_without_touching_current_or_cursor() {
    let (_root, repo) = setup();
    let draft = ready(&repo, Kind::Soumission);
    let current = ready(&repo, Kind::Facture);
    let before = repo.load().unwrap();
    assert!(before.versions.contains_key(&draft.id));
    let result = repo.delete_draft(&draft.id, draft.clone()).unwrap();
    assert_eq!(result.current, current);
    assert_eq!(result.next_invoice_number, before.next_invoice_number);
    assert_eq!(result.records.len(), before.records.len() - 1);
    assert!(result.records.iter().all(|r| r.id != draft.id));
    let after = repo.load().unwrap();
    assert!(!after.versions.contains_key(&draft.id));
    assert_eq!(after.current_id, before.current_id);
    assert_eq!(after.invoice_sequence_reset, before.invoice_sequence_reset);
    assert_eq!(after.ai_provider, before.ai_provider);
    for record in before.records.iter().filter(|r| r.id != draft.id) {
        assert_eq!(serde_json::to_value(record).unwrap(), serde_json::to_value(after.records.iter().find(|r| r.id == record.id).unwrap()).unwrap());
    }
    let restarted = Repository::new(repo.data_dir.clone(), repo.documents_dir.clone());
    assert!(restarted.load_state().unwrap().records.iter().all(|r| r.id != draft.id));
}

#[test]
fn current_and_sole_draft_deletions_create_blank_same_type_without_advancing_cursor() {
    for kind in [Kind::Soumission, Kind::Facture] {
        let (_root, repo) = setup();
        let draft = ready(&repo, kind);
        let mut store = repo.load().unwrap();
        store.records.retain(|r| r.id == draft.id); store.versions.retain(|id, _| id == &draft.id);
        repo.commit(&mut store).unwrap();
        let result = repo.delete_draft(&draft.id, draft.clone()).unwrap();
        assert_eq!(result.records.len(), 1); assert_ne!(result.current.id, draft.id);
        assert_eq!(result.current.kind, kind); assert!(result.current.project.is_empty());
        assert!(result.current.client.is_empty()); assert!(result.current.issued_number.is_none());
        assert_eq!(result.next_invoice_number, store.next_invoice_number);
        assert_eq!(repo.load_state().unwrap().current.id, result.current.id);
    }
}

#[test]
fn pdf_documents_are_protected_and_files_unchanged() {
    for kind in [Kind::Facture, Kind::Soumission] {
        let (_root, repo) = setup(); let draft = ready(&repo, kind);
        let exported = repo.export_pdf(draft.clone(), PDF.to_vec(), draft.invoice_number, "fr".into()).unwrap();
        let confirmed = repo.load_state().unwrap().current;
        let bytes = fs::read(repo.primary()).unwrap(); let backup = fs::read(repo.backup()).unwrap();
        assert!(repo.delete_draft(&draft.id, confirmed).unwrap_err().contains("PDF"));
        assert_eq!(fs::read(repo.primary()).unwrap(), bytes); assert_eq!(fs::read(repo.backup()).unwrap(), backup);
        assert_eq!(fs::read(exported.path).unwrap(), PDF);
    }
}

#[test]
fn stale_and_missing_targets_fail_without_a_commit() {
    let (_root, repo) = setup(); let original = ready(&repo, Kind::Soumission);
    let mut changed = original.clone(); changed.project = "Modification après confirmation".into();
    repo.save_draft(changed).unwrap();
    let bytes = fs::read(repo.primary()).unwrap();
    assert!(repo.delete_draft(&original.id, original.clone()).unwrap_err().contains("changé"));
    assert_eq!(fs::read(repo.primary()).unwrap(), bytes);
    assert!(repo.delete_draft(&Uuid::new_v4().to_string(), original).is_err());
    assert_eq!(fs::read(repo.primary()).unwrap(), bytes);
}

#[test]
fn unresolved_export_cannot_be_discarded_even_if_a_file_has_finished_writing() {
    let (_root, repo) = setup(); let draft = ready(&repo, Kind::Soumission);
    let mut store = repo.load().unwrap();
    let filename = "pending.pdf".to_string();
    let directory = repo.selected_output_dir(&store, draft.kind).unwrap();
    fs::create_dir_all(&directory).unwrap(); fs::write(directory.join(&filename), PDF).unwrap();
    store.pending_export = Some(PendingExport {id:draft.id.clone(),filename:filename.clone(),invoice_number:None,snapshot:draft.clone(),language:"fr".into(),pdf_sha256:format!("{:x}", Sha256::digest(PDF)),exported_at:Utc::now().to_rfc3339()});
    repo.commit(&mut store).unwrap(); let bytes = fs::read(repo.primary()).unwrap();
    assert!(repo.delete_draft(&draft.id, draft.clone()).unwrap_err().contains("finalisé"));
    assert_eq!(fs::read(repo.primary()).unwrap(), bytes);
    assert_eq!(fs::read(directory.join(filename)).unwrap(), PDF);
    assert!(repo.load().unwrap().pending_export.is_some());
}
