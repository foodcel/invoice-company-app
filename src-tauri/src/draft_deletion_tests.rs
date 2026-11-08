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

#[test]
fn issued_document_deletion_trashes_every_pdf_then_removes_it_and_keeps_the_number_cursor() {
    let (_root, repo) = setup();
    let draft = ready(&repo, Kind::Facture);
    let first = repo.export_pdf(draft, PDF.to_vec(), Some(2060), "fr".into()).unwrap();
    let again = repo.export_pdf(first.snapshot.clone(), PDF.to_vec(), Some(2060), "fr".into()).unwrap();
    let other = ready(&repo, Kind::Soumission);
    let issued = repo.load().unwrap().records.iter().find(|r| r.draft.id == first.snapshot.id).unwrap().draft.clone();
    assert!(issued.issued_number.is_some());
    assert!(repo.delete_draft(&issued.id, issued.clone()).is_err(), "plain draft deletion stays protected");
    let cursor = repo.load().unwrap().next_invoice_number;
    let trashed = std::cell::RefCell::new(vec![]);
    // A changed document is never deleted.
    let mut stale = issued.clone(); stale.project = "autre".into();
    assert!(repo.delete_document(&issued.id, stale, &|p: &Path| { trashed.borrow_mut().push(p.to_path_buf()); Ok(()) }).unwrap_err().contains("changé"));
    assert!(trashed.borrow().is_empty());
    let result = repo.delete_document(&issued.id, issued.clone(), &|p: &Path| { trashed.borrow_mut().push(p.to_path_buf()); Ok(()) }).unwrap();
    assert_eq!(trashed.borrow().len(), 2);
    assert!(trashed.borrow().contains(&PathBuf::from(&first.path)) && trashed.borrow().contains(&PathBuf::from(&again.path)));
    assert!(result.records.iter().all(|r| r.draft.id != issued.id));
    assert!(result.records.iter().any(|r| r.draft.id == other.id));
    assert_eq!(result.next_invoice_number, cursor);
    assert!(repo.load().unwrap().versions.get(&issued.id).is_none());
}

#[test]
fn a_pdf_that_cannot_be_trashed_blocks_deletion_and_changes_nothing() {
    let (_root, repo) = setup();
    let draft = ready(&repo, Kind::Facture);
    let exported = repo.export_pdf(draft, PDF.to_vec(), Some(2060), "fr".into()).unwrap();
    let issued = repo.load().unwrap().records.iter().find(|r| r.draft.id == exported.snapshot.id).unwrap().draft.clone();
    let before = repo.load().unwrap().records.len();
    let error = repo.delete_document(&issued.id, issued.clone(), &|_: &Path| Err("locked".into())).unwrap_err();
    assert!(error.contains("Rien n’a été supprimé"));
    assert_eq!(repo.load().unwrap().records.len(), before);
    assert!(Path::new(&exported.path).exists());
}

#[test]
fn a_missing_pdf_file_does_not_block_deleting_the_record() {
    let (_root, repo) = setup();
    let draft = ready(&repo, Kind::Facture);
    let exported = repo.export_pdf(draft, PDF.to_vec(), Some(2060), "fr".into()).unwrap();
    fs::remove_file(&exported.path).unwrap();
    let issued = repo.load().unwrap().records.iter().find(|r| r.draft.id == exported.snapshot.id).unwrap().draft.clone();
    let result = repo.delete_document(&issued.id, issued.clone(), &|_: &Path| Err("must not be called".into())).unwrap();
    assert!(result.records.iter().all(|r| r.draft.id != issued.id));
}

#[test]
#[ignore = "Puts one tiny temporary file in the real Windows Recycle Bin"]
fn recycle_bin_helper_really_moves_a_file() {
    let (root, _repo) = setup();
    let file = root.path().join("recycle-probe.pdf");
    fs::write(&file, PDF).unwrap();
    move_to_recycle_bin(&file).unwrap();
    assert!(!file.exists());
}
