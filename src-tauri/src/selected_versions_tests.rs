use super::*;
use tempfile::TempDir;

const PDF_A: &[u8] = b"%PDF-1.4\n1 0 obj << /Version /A >> endobj\n%%EOF\n";
const PDF_B: &[u8] = b"%PDF-1.4\n1 0 obj << /Version /B >> endobj\n%%EOF\n";

fn setup() -> (TempDir, Repository) {
    let root = tempfile::tempdir().unwrap();
    let repo = Repository::new(root.path().join("appdata"), root.path().join("Documents"));
    (root, repo)
}

fn complete_draft(repo: &Repository, kind: Kind) -> Draft {
    let mut draft = repo.new_draft(kind).unwrap().current;
    draft.tax.as_mut().unwrap().selection = "QC".into();
    draft.tax = Some(taxes::resolve(&draft));
    draft.project = "Escalier choisi".into();
    draft.client = "Client original".into();
    draft.address = "Adresse originale".into();
    draft.ship_to = "Livraison originale".into();
    draft.contact = "514-555-0100".into();
    draft.email = "client@example.test".into();
    draft.date = "2026-09-30".into();
    draft.valid_until = "2026-10-30".into();
    draft.due_date = "2026-10-15".into();
    draft.notes = "Note intégrale\nDeuxième ligne".into();
    draft.note_entries = Some(vec![draft.notes.clone()]);
    draft.items = vec![Item { description: "Marche originale".into(), quantity: "2".into(), price: "125.50".into(), page_break_before: None }];
    draft.payments = Some(vec![Payment { amount: "20.00".into(), date: "2026-09-29".into() }]);
    draft.english_copy = Some(EnglishCopy {
        source_project: draft.project.clone(), source_notes: draft.notes.clone(),
        source_descriptions: vec![draft.items[0].description.clone()],
        project: "Selected staircase".into(), notes: "Complete note\nSecond line".into(),
        descriptions: vec!["Original step".into()], reviewed: true,
    });
    repo.save_draft(draft).unwrap().current
}

fn archive(repo: &Repository, draft: Draft, bytes: &[u8]) -> ExportResponse {
    let number = draft.invoice_number;
    repo.export_pdf(draft, bytes.to_vec(), number, "fr".into()).unwrap()
}

#[test]
fn selected_nonlatest_export_restores_full_snapshot_and_retains_every_archive_and_displaced_current_after_reload() {
    let (_root, repo) = setup();
    let invoice_folder = repo.documents_dir.join("custom-invoices");
    let quote_folder = repo.documents_dir.join("custom-quotes");
    fs::create_dir_all(&invoice_folder).unwrap();
    fs::create_dir_all(&quote_folder).unwrap();
    repo.set_output_directory(Some(invoice_folder.to_string_lossy().into_owned()), Kind::Facture).unwrap();
    repo.set_output_directory(Some(quote_folder.to_string_lossy().into_owned()), Kind::Soumission).unwrap();
    let draft = complete_draft(&repo, Kind::Facture);
    let first = archive(&repo, draft, PDF_A);
    let mut current = first.snapshot.clone();
    // Evict the original from the four-entry autosave ring.
    for i in 0..7 {
        current.project = format!("Édition {i}");
        current = repo.save_draft(current).unwrap().current;
    }
    let second = archive(&repo, current, PDF_B);
    let mut displaced = second.snapshot.clone();
    displaced.client = "Dernier client".into();
    displaced.notes = "Dernière note".into();
    displaced.note_entries = Some(vec![displaced.notes.clone()]);
    displaced.payments = Some(vec![Payment { amount: "50".into(), date: String::new() }]);
    let before = repo.save_draft(displaced).unwrap();
    let displaced = before.current.clone();
    let originals = serde_json::to_value(&before.records.iter().find(|r| r.id == displaced.id).unwrap().exports).unwrap();
    let selected = repo.load_document_versions(&displaced.id).unwrap().into_iter()
        .find(|v| v.path.as_deref() == Some(&first.path)).unwrap();
    assert!(selected.restorable);
    assert_eq!(selected.draft.as_ref(), Some(&first.snapshot));
    let restored = repo.restore_document_version(&displaced.id, &selected.id).unwrap();
    assert_eq!(restored.current, first.snapshot);
    assert_eq!(restored.current.issued_number, Some(2060));
    assert_eq!(restored.next_invoice_number, before.next_invoice_number);
    assert_eq!(restored.invoice_pdf_directory, before.invoice_pdf_directory);
    assert_eq!(restored.quote_pdf_directory, before.quote_pdf_directory);
    assert_eq!(restored.current_pdf_path.as_deref(), Some(second.path.as_str()));
    let record = restored.records.iter().find(|r| r.id == restored.current.id).unwrap();
    assert_eq!(record.saved_versions.last().unwrap().snapshot, displaced);
    assert_eq!(serde_json::to_value(&record.exports).unwrap(), originals);
    assert_eq!(fs::read(&first.path).unwrap(), PDF_A);
    assert_eq!(fs::read(&second.path).unwrap(), PDF_B);
    assert_eq!(fs::read_dir(&invoice_folder).unwrap().count(), 2);
    assert!(!repo.data_dir.join("outlook/attempts.json").exists());
    let reopened = Repository::new(repo.data_dir.clone(), repo.documents_dir.clone());
    assert_eq!(reopened.load_state().unwrap().current, first.snapshot);
    let history_id = reopened.load_state().unwrap().records.into_iter().find(|r| r.id == displaced.id)
        .unwrap().saved_versions.last().unwrap().version_id.clone();
    assert!(reopened.load_document_versions(&displaced.id).unwrap().iter().any(|v| v.id == selected.id));
    let recovered_current = reopened.restore_document_version(&displaced.id, &history_id).unwrap();
    assert_eq!(recovered_current.current, displaced);
    let record = recovered_current.records.iter().find(|r| r.id == displaced.id).unwrap();
    assert_eq!(record.saved_versions.len(), 2);
    assert!(record.saved_versions.iter().any(|v| v.version_id == history_id));
    assert_eq!(fs::read(&first.path).unwrap(), PDF_A);
    assert_eq!(fs::read(&second.path).unwrap(), PDF_B);
}

#[test]
fn restore_preissuance_quote_content_keeps_issued_invoice_number_and_other_named_draft() {
    let (_root, repo) = setup();
    let quote = complete_draft(&repo, Kind::Soumission);
    let exported_quote = archive(&repo, quote, PDF_A);
    let mut invoice = exported_quote.snapshot.clone();
    invoice.kind = Kind::Facture;
    invoice.project = "Facture ultérieure".into();
    let invoice = repo.save_draft(invoice).unwrap().current;
    let issued = archive(&repo, invoice, PDF_B);
    let mut other = repo.new_draft(Kind::Soumission).unwrap().current;
    other.project = "Autre brouillon nommé".into();
    other.client = "Autre client".into();
    let other = repo.save_draft(other).unwrap().current;
    let restored = repo.restore_document_version(&issued.snapshot.id, &export_version_id(&exported_quote.path)).unwrap();
    let mut expected = exported_quote.snapshot;
    expected.kind = Kind::Facture;
    expected.invoice_number = Some(2060);
    expected.issued_number = Some(2060);
    assert_eq!(restored.current, expected);
    assert_eq!(restored.next_invoice_number, 2061);
    assert_eq!(restored.records.iter().find(|r| r.id == other.id).unwrap().draft, other);
    assert_eq!(repo.open_draft(&other.id).unwrap().current, other);
    assert_eq!(repo.open_draft(&expected.id).unwrap().current, expected);
    assert_eq!(fs::read(&exported_quote.path).unwrap(), PDF_A);
    assert_eq!(fs::read(&issued.path).unwrap(), PDF_B);
}

#[test]
fn opaque_recovery_selection_survives_reload_and_rejects_evicted_or_cross_document_selection() {
    let (_root, repo) = setup();
    let mut draft = complete_draft(&repo, Kind::Soumission);
    let original = draft.clone();
    draft.project = "Projet plus récent".into();
    let draft = repo.save_draft(draft).unwrap().current;
    let version = repo.load_document_versions(&draft.id).unwrap().into_iter()
        .find(|v| v.draft.as_ref() == Some(&original)).unwrap();
    let other = repo.new_draft(Kind::Soumission).unwrap().current;
    let before = fs::read(repo.primary()).unwrap();
    assert!(repo.restore_document_version(&other.id, &version.id).is_err());
    assert!(repo.restore_document_version(&draft.id, "recovery:unknown").is_err());
    assert_eq!(fs::read(repo.primary()).unwrap(), before);
    assert_eq!(repo.restore_document_version(&draft.id, &version.id).unwrap().current, original);
    let mut current = repo.load_state().unwrap().current;
    let old_key = repo.load_document_versions(&draft.id).unwrap().into_iter()
        .find(|v| v.id.starts_with("recovery:") && v.id != version.id).unwrap().id;
    for i in 0..6 { current.notes = i.to_string(); current.note_entries = Some(vec![current.notes.clone()]); current = repo.save_draft(current).unwrap().current; }
    assert!(repo.restore_document_version(&draft.id, &old_key).is_err());
    assert_eq!(repo.restore_document_version(&draft.id, &version.id).unwrap().current, original);
}

#[test]
fn english_export_and_full_history_survive_restore_and_reload_without_new_pdf() {
    let (_root, repo) = setup();
    let draft = complete_draft(&repo, Kind::Facture);
    let exported = repo.export_pdf(draft.clone(), PDF_A.to_vec(), draft.invoice_number, "en".into()).unwrap();
    let mut changed = exported.snapshot.clone();
    changed.notes = "Contenu modifié".into();
    changed.note_entries = Some(vec![changed.notes.clone()]);
    repo.save_draft(changed).unwrap();
    let selected = repo.load_document_versions(&draft.id).unwrap().into_iter()
        .find(|v| v.path.as_deref() == Some(&exported.path)).unwrap();
    assert_eq!(selected.language.as_deref(), Some("en"));
    assert_eq!(repo.restore_document_version(&draft.id, &selected.id).unwrap().current, exported.snapshot);
    let loaded = repo.load_state().unwrap();
    assert_eq!(loaded.current.english_copy, exported.snapshot.english_copy);
    assert_eq!(loaded.current.issued_number, Some(2060));
    assert_eq!(loaded.next_invoice_number, 2061);
    assert_eq!(loaded.records.iter().find(|r| r.id == draft.id).unwrap().exports.len(), 1);
    assert_eq!(fs::read(&exported.path).unwrap(), PDF_A);
}

#[test]
fn legacy_export_remains_view_only_and_cannot_borrow_current_fields_as_its_snapshot() {
    let (_root, repo) = setup();
    let exported = archive(&repo, complete_draft(&repo, Kind::Facture), PDF_A);
    let mut state = serde_json::to_value(repo.load().unwrap()).unwrap();
    for record in state["records"].as_array_mut().unwrap() {
        record.as_object_mut().unwrap().remove("savedVersions");
        record.as_object_mut().unwrap().remove("sentAt");
        for export in record["exports"].as_array_mut().unwrap() {
            export.as_object_mut().unwrap().remove("snapshot");
            export.as_object_mut().unwrap().remove("taxTotals");
            export.as_object_mut().unwrap().remove("sentReceipts");
            export.as_object_mut().unwrap().remove("pdfSha256");
        }
    }
    let bytes = serde_json::to_vec(&state).unwrap();
    fs::write(repo.primary(), &bytes).unwrap();
    fs::write(repo.backup(), &bytes).unwrap();
    let rows = repo.load_document_versions(&exported.snapshot.id).unwrap();
    let legacy = rows.iter().find(|v| v.version_type == "export").unwrap();
    assert_eq!(legacy.draft, None);
    assert!(!legacy.restorable);
    assert!(repo.restore_document_version(&exported.snapshot.id, &legacy.id).is_err());
    let pdf = repo.read_document_pdf(&exported.snapshot.id, &exported.path).unwrap();
    assert_eq!(pdf.pdf_bytes, PDF_A);
    assert!(!pdf.integrity_verified);
    assert_eq!(fs::read(repo.primary()).unwrap(), bytes);
    assert_eq!(repo.load_state().unwrap().records.iter().find(|r| r.id == exported.snapshot.id).unwrap().sent_at, None);
}

#[test]
fn registered_pdf_read_rejects_other_record_arbitrary_path_missing_file_and_hash_mismatch() {
    let (_root, repo) = setup();
    let exported = archive(&repo, complete_draft(&repo, Kind::Facture), PDF_A);
    let other = repo.new_draft(Kind::Soumission).unwrap().current;
    assert_eq!(repo.read_document_pdf(&exported.snapshot.id, &exported.path).unwrap().pdf_bytes, PDF_A);
    assert!(repo.read_document_pdf(&other.id, &exported.path).is_err());
    assert!(repo.read_document_pdf(&exported.snapshot.id, &repo.primary().to_string_lossy()).is_err());
    fs::write(&exported.path, PDF_B).unwrap();
    assert!(repo.read_document_pdf(&exported.snapshot.id, &exported.path).unwrap_err().contains("modifié"));
    fs::remove_file(&exported.path).unwrap();
    assert!(repo.read_document_pdf(&exported.snapshot.id, &exported.path).is_err());
}

#[test]
fn pending_export_blocks_restoration_without_issuing_or_touching_files() {
    let (_root, repo) = setup();
    let exported = archive(&repo, complete_draft(&repo, Kind::Facture), PDF_A);
    let mut store = repo.load().unwrap();
    store.pending_export = Some(PendingExport {
        id: exported.snapshot.id.clone(), filename: "pending.pdf".into(), invoice_number: Some(2060),
        snapshot: exported.snapshot.clone(), language: "fr".into(),
        pdf_sha256: format!("{:x}", Sha256::digest(PDF_B)), exported_at: Utc::now().to_rfc3339(),
    });
    repo.commit(&mut store).unwrap();
    let before = fs::read(repo.primary()).unwrap();
    assert!(repo.restore_document_version(&exported.snapshot.id, &export_version_id(&exported.path)).unwrap_err().contains("attente"));
    assert_eq!(fs::read(repo.primary()).unwrap(), before);
    assert_eq!(fs::read(&exported.path).unwrap(), PDF_A);
    assert_eq!(repo.load().unwrap().next_invoice_number, 2061);
}

#[test]
fn archive_acceptance_receipt_is_exactly_bound_persisted_deduplicated_and_survives_restore() {
    let (_root, repo) = setup();
    let exported = archive(&repo, complete_draft(&repo, Kind::Facture), PDF_A);
    let receipt = outlook::SendReceipt { attempt_id: Uuid::new_v4().to_string(),
        sender_email: "owner@example.test".into(), accepted_at: "2026-09-30T15:00:00Z".into() };
    let hash = format!("{:x}", Sha256::digest(PDF_A));
    assert!(repo.record_sent_receipt(&exported.snapshot.id, &exported.path, "wrong-hash", receipt.clone()).is_err());
    repo.record_sent_receipt(&exported.snapshot.id, &exported.path, &hash, receipt.clone()).unwrap();
    repo.record_sent_receipt(&exported.snapshot.id, &exported.path, &hash, receipt.clone()).unwrap();
    let mut changed = exported.snapshot.clone();
    changed.notes = "Brouillon après envoi".into();
    changed.note_entries = Some(vec![changed.notes.clone()]);
    repo.save_draft(changed).unwrap();
    repo.restore_document_version(&exported.snapshot.id, &export_version_id(&exported.path)).unwrap();
    let state = repo.load_state().unwrap();
    let record = state.records.iter().find(|r| r.id == exported.snapshot.id).unwrap();
    assert_eq!(record.sent_at, Some(receipt.accepted_at.clone()));
    assert_eq!(record.exports[0].sent_receipts, vec![receipt]);
    assert_eq!(fs::read(&exported.path).unwrap(), PDF_A);
    assert!(!repo.data_dir.join("outlook/attempts.json").exists()); // Pure local receipts; no send transport.
}

#[test]
fn version_json_matches_frontend_contract_and_rejects_corrupt_snapshot_identity() {
    let (_root, repo) = setup();
    let exported = archive(&repo, complete_draft(&repo, Kind::Facture), PDF_A);
    let rows = serde_json::to_value(repo.load_document_versions(&exported.snapshot.id).unwrap()).unwrap();
    let row = rows.as_array().unwrap().iter().find(|r| r["type"] == "export").unwrap();
    for key in ["id", "type", "draft", "createdAt", "filename", "path", "language", "restorable"] {
        assert!(row.get(key).is_some(), "missing {key}");
    }
    assert_eq!(row["restorable"], true);
    assert_eq!(row["draft"]["issuedNumber"], 2060);
    let state = serde_json::to_value(repo.load_state().unwrap()).unwrap();
    assert_eq!(state["currentPdfPath"], exported.path);
    assert!(state["records"].as_array().unwrap().iter().all(|r| r["sentAt"].is_null()));
    let mut store = repo.load().unwrap();
    let index = store.index(&exported.snapshot.id).unwrap();
    store.records[index].exports[0].snapshot.as_mut().unwrap().id = Uuid::new_v4().to_string();
    assert!(validate_store(&store).is_err());
}

#[test]
fn full_history_refuses_restore_without_pruning_or_changing_current_or_pdf() {
    let (_root, repo) = setup();
    let exported = archive(&repo, complete_draft(&repo, Kind::Facture), PDF_A);
    let mut store = repo.load().unwrap();
    let index = store.index(&exported.snapshot.id).unwrap();
    store.records[index].saved_versions = (0..MAX_SAVED_VERSIONS).map(|_| SavedVersion {
        version_id: format!("history:{}", Uuid::new_v4()), saved_at: Utc::now().to_rfc3339(),
        snapshot: exported.snapshot.clone(),
    }).collect();
    repo.commit(&mut store).unwrap();
    let primary = fs::read(repo.primary()).unwrap();
    let backup = fs::read(repo.backup()).unwrap();
    assert!(repo.restore_document_version(&exported.snapshot.id, &export_version_id(&exported.path)).unwrap_err().contains("plein"));
    assert_eq!(fs::read(repo.primary()).unwrap(), primary);
    assert_eq!(fs::read(repo.backup()).unwrap(), backup);
    assert_eq!(repo.load_state().unwrap().current, exported.snapshot);
    assert_eq!(repo.load().unwrap().records[index].saved_versions.len(), MAX_SAVED_VERSIONS);
    assert_eq!(fs::read(&exported.path).unwrap(), PDF_A);
}

#[test]
fn cached_sent_timestamp_cannot_invent_acceptance_and_actual_receipt_order_uses_instants() {
    let (_root, repo) = setup();
    let exported = archive(&repo, complete_draft(&repo, Kind::Facture), PDF_A);
    let mut cached = serde_json::to_value(repo.load().unwrap()).unwrap();
    for record in cached["records"].as_array_mut().unwrap() { record["sentAt"] = "2099-01-01T00:00:00Z".into(); }
    let bytes = serde_json::to_vec(&cached).unwrap();
    fs::write(repo.primary(), &bytes).unwrap();
    fs::write(repo.backup(), &bytes).unwrap();
    assert!(repo.load_state().unwrap().records.iter().all(|r| r.sent_at.is_none()));
    let hash = format!("{:x}", Sha256::digest(PDF_A));
    for accepted_at in ["2026-09-30T16:00:00+02:00", "2026-09-30T15:00:00Z"] {
        repo.record_sent_receipt(&exported.snapshot.id, &exported.path, &hash, outlook::SendReceipt {
            attempt_id: Uuid::new_v4().to_string(), sender_email: "owner@example.test".into(), accepted_at: accepted_at.into(),
        }).unwrap();
    }
    let loaded = repo.load_state().unwrap();
    assert_eq!(loaded.records.iter().find(|r| r.id == exported.snapshot.id).unwrap().sent_at.as_deref(), Some("2026-09-30T15:00:00Z"));
}
