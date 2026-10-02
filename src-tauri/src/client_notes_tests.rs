use super::*;
use tempfile::TempDir;

const PDF: &[u8] = b"%PDF-1.4\n1 0 obj <<>> endobj\n%%EOF\n";

fn setup() -> (TempDir, Repository) {
    let root = tempfile::tempdir().unwrap();
    let repo = Repository::new(root.path().join("appdata"), root.path().join("Documents"));
    (root, repo)
}

fn set_notes(draft: &mut Draft, entries: &[&str]) {
    let entries: Vec<String> = entries.iter().map(|entry| (*entry).into()).collect();
    draft.notes = notes_mirror(&entries);
    draft.note_entries = Some(entries);
}

fn ready_quote(repo: &Repository) -> Draft {
    let mut draft = repo.new_draft(Kind::Soumission).unwrap().current;
    draft.tax.as_mut().unwrap().selection = "QC".into();
    draft.tax = Some(taxes::resolve(&draft));
    draft.project = "Projet synthétique".into();
    draft.client = "Client de test".into();
    draft.address = "Adresse de test".into();
    draft.items[0].description = "Travail de test".into();
    draft.items[0].price = "100".into();
    draft
}

#[test]
fn missing_or_null_legacy_notes_migrate_to_one_exact_entry_without_splitting() {
    for notes in ["", "  ", "\r\n\tPremière note\n\nDeuxième paragraphe\n  "] {
        for null in [false, true] {
            let mut value = serde_json::to_value(blank_draft(Kind::Soumission)).unwrap();
            value["notes"] = notes.into();
            value.as_object_mut().unwrap().remove("noteEntries");
            if null { value["noteEntries"] = serde_json::Value::Null; }
            let mut draft: Draft = serde_json::from_value(value).unwrap();
            assert!(draft.note_entries.is_none());
            assert!(migrate_draft_notes(&mut draft));
            assert_eq!(draft.note_entries, Some(if notes.is_empty() { vec![] } else { vec![notes.to_owned()] }));
            assert_eq!(draft.notes, notes);
            assert!(!migrate_draft_notes(&mut draft));
            validate_draft(&draft).unwrap();
        }
    }
}

#[test]
fn fresh_draft_has_no_notes_and_explicit_removal_never_resurrects_notes() {
    let (_temp, repo) = setup();
    let mut draft = repo.load_state().unwrap().current;
    assert_eq!(draft.note_entries, Some(vec![]));
    set_notes(&mut draft, &["Première\nligne", "Deuxième"]);
    let saved = repo.save_draft(draft).unwrap().current;
    let mut cleared = saved.clone();
    set_notes(&mut cleared, &[]);
    repo.save_draft(cleared).unwrap();
    let reopened = repo.load_state().unwrap().current;
    assert_eq!(reopened.note_entries, Some(vec![]));
    assert_eq!(reopened.notes, "");
    let restored = repo.restore_previous(&saved.id).unwrap().current;
    assert_eq!(restored.note_entries, saved.note_entries);
    assert_eq!(restored.notes, "Première\nligne\n\nDeuxième");
}

#[test]
fn empty_legacy_notes_keep_their_original_recovery_identity() {
    let mut legacy = blank_draft(Kind::Soumission);
    legacy.note_entries = None;
    let old_id = recovery_version_id(&legacy).unwrap();
    assert!(migrate_draft_notes(&mut legacy));
    assert_eq!(legacy.note_entries, Some(vec![]));
    assert!(matches_recovery_version_id(&legacy, &old_id));
    assert!(!matches_recovery_version_id(&legacy, "recovery:unknown"));
    legacy.note_entries = Some(vec![String::new(), String::new()]);
    assert!(!matches_recovery_version_id(&legacy, &old_id));
    legacy.note_entries = Some(vec!["New text".into()]);
    legacy.notes = "New text".into();
    assert!(!matches_recovery_version_id(&legacy, &old_id));
}

#[test]
fn multiline_order_and_exact_whitespace_match_the_mirror_without_empty_placeholder_separators() {
    let mut draft = blank_draft(Kind::Soumission);
    set_notes(&mut draft, &["  Première\n\nSuite  ", "", "Deuxième\r\nligne", "\t "]);
    assert_eq!(draft.notes, "  Première\n\nSuite  \n\nDeuxième\r\nligne\n\n\t ");
    validate_draft(&draft).unwrap();
    draft.note_entries.as_mut().unwrap().swap(0, 2);
    assert!(validate_draft(&draft).is_err());
    draft.notes = notes_mirror(draft.note_entries.as_ref().unwrap());
    validate_draft(&draft).unwrap();
}

#[test]
fn malformed_types_controls_counts_and_utf8_aggregate_bounds_are_rejected() {
    let mut draft = blank_draft(Kind::Soumission);
    let mut value = serde_json::to_value(&draft).unwrap();
    for malformed in [serde_json::json!("text"), serde_json::json!([17]), serde_json::json!([null])] {
        value["noteEntries"] = malformed;
        assert!(serde_json::from_value::<Draft>(value.clone()).is_err());
    }
    for control in ["\0", "\u{b}", "\u{1f}", "\u{7f}", "\u{85}", "\u{9f}"] {
        set_notes(&mut draft, &[control]);
        assert!(validate_draft(&draft).is_err());
    }
    set_notes(&mut draft, &["\n\r\t"]);
    validate_draft(&draft).unwrap();
    draft.note_entries = Some(vec![String::new(); MAX_NOTE_ENTRIES]);
    draft.notes.clear();
    validate_draft(&draft).unwrap();
    draft.note_entries.as_mut().unwrap().push(String::new());
    assert!(validate_draft(&draft).is_err());
    let exactly = "é".repeat(MAX_NOTES_BYTES / 2);
    set_notes(&mut draft, &[&exactly]);
    validate_draft(&draft).unwrap();
    set_notes(&mut draft, &[&(exactly + "é")]);
    assert!(validate_draft(&draft).is_err());
    set_notes(&mut draft, &[&"a".repeat(25_000), &"b".repeat(25_000)]);
    assert_eq!(draft.notes.len(), 50_002);
    assert!(validate_draft(&draft).is_err());
}

#[test]
fn mismatched_saves_and_exports_leave_both_durable_copies_and_invoice_cursor_unchanged() {
    let (_temp, repo) = setup();
    let mut draft = ready_quote(&repo);
    set_notes(&mut draft, &["Texte à conserver", "Seconde note"]);
    let saved = repo.save_draft(draft).unwrap();
    let primary = fs::read(repo.primary()).unwrap();
    let backup = fs::read(repo.backup()).unwrap();
    for entries in [vec![], vec!["Texte différent".into()]] {
        let mut bad = saved.current.clone();
        bad.note_entries = Some(entries);
        assert!(repo.save_draft(bad.clone()).is_err());
        assert!(repo.export_pdf(bad, PDF.to_vec(), None, "fr".into()).is_err());
        assert_eq!(fs::read(repo.primary()).unwrap(), primary);
        assert_eq!(fs::read(repo.backup()).unwrap(), backup);
    }
    let reopened = repo.load_state().unwrap();
    assert_eq!(reopened.current, saved.current);
    assert_eq!(reopened.next_invoice_number, saved.next_invoice_number);
    assert!(reopened.records.iter().all(|record| record.exports.is_empty()));
}

#[test]
fn invalid_persisted_notes_including_pending_snapshots_fail_closed_without_rewriting_files() {
    let (_temp, repo) = setup();
    repo.load_state().unwrap();
    let mut store = repo.load().unwrap();
    let draft = store.records[0].draft.clone();
    let mut pending = draft.clone();
    pending.note_entries = Some(vec!["Incohérent".into()]);
    store.pending_export = Some(PendingExport {
        id: draft.id.clone(), filename: "fixture.pdf".into(), invoice_number: None,
        snapshot: pending, language: "fr".into(), pdf_sha256: format!("{:x}", Sha256::digest(PDF)),
        exported_at: Utc::now().to_rfc3339(),
    });
    let bytes = serde_json::to_vec_pretty(&store).unwrap();
    fs::write(repo.primary(), &bytes).unwrap();
    fs::write(repo.backup(), &bytes).unwrap();
    assert!(repo.load().is_err());
    assert_eq!(fs::read(repo.primary()).unwrap(), bytes);
    assert_eq!(fs::read(repo.backup()).unwrap(), bytes);
    store.pending_export = None;
    store.records[0].draft.note_entries = Some(vec!["Incohérent".into()]);
    let bytes = serde_json::to_vec_pretty(&store).unwrap();
    fs::write(repo.primary(), &bytes).unwrap();
    fs::write(repo.backup(), &bytes).unwrap();
    assert!(repo.load().is_err());
    assert_eq!(fs::read(repo.primary()).unwrap(), bytes);
    assert_eq!(fs::read(repo.backup()).unwrap(), bytes);
}

#[test]
fn migration_rewrites_all_snapshot_surfaces_preserving_generation_and_legacy_promoted_ids() {
    let (_temp, repo) = setup();
    let mut store = Store::fresh();
    let mut legacy = store.records[0].draft.clone();
    legacy.notes = "  Historique\n\nSecond paragraphe\r\n".into();
    legacy.note_entries = None;
    let legacy_id = recovery_version_id(&legacy).unwrap();
    store.records[0].draft = legacy.clone();
    store.records[0].saved_versions.push(SavedVersion {
        version_id: legacy_id.clone(), saved_at: Utc::now().to_rfc3339(), snapshot: legacy.clone(),
    });
    store.versions.insert(legacy.id.clone(), vec![legacy.clone()]);
    store.records[0].exports.push(ExportEntry {
        tax_totals: None,
        path: repo.documents_dir.join("legacy.pdf").to_string_lossy().into_owned(), filename: "legacy.pdf".into(),
        exported_at: Utc::now().to_rfc3339(), language: "fr".into(), invoice_number: None,
        pdf_sha256: None, snapshot: Some(legacy.clone()), sent_receipts: vec![],
    });
    let mut view_only = store.records[0].exports[0].clone();
    view_only.path = repo.documents_dir.join("view-only.pdf").to_string_lossy().into_owned();
    view_only.snapshot = None;
    store.records[0].exports.push(view_only);
    store.pending_export = Some(PendingExport {
        id: legacy.id.clone(), filename: "pending.pdf".into(), invoice_number: None,
        snapshot: legacy.clone(), language: "fr".into(), pdf_sha256: format!("{:x}", Sha256::digest(PDF)),
        exported_at: Utc::now().to_rfc3339(),
    });
    repo.commit(&mut store).unwrap();
    let generation = store.generation;
    let migrated = repo.load().unwrap();
    assert_eq!(migrated.generation, generation);
    let expected = Some(vec![legacy.notes.clone()]);
    assert_eq!(migrated.records[0].draft.note_entries, expected);
    assert_eq!(migrated.records[0].saved_versions[0].snapshot.note_entries, expected);
    assert_eq!(migrated.records[0].saved_versions[0].version_id, legacy_id);
    assert_eq!(migrated.records[0].exports[0].snapshot.as_ref().unwrap().note_entries, expected);
    assert!(migrated.records[0].exports[1].snapshot.is_none());
    assert_eq!(migrated.versions[&legacy.id][0].note_entries, expected);
    assert_eq!(migrated.pending_export.as_ref().unwrap().snapshot.note_entries, expected);
    let durable_primary = fs::read(repo.primary()).unwrap();
    assert_eq!(durable_primary, fs::read(repo.backup()).unwrap());
    let durable: Store = serde_json::from_slice(&durable_primary).unwrap();
    assert_eq!(durable.records[0].draft.note_entries, expected);
    assert_eq!(durable.records[0].saved_versions[0].snapshot.note_entries, expected);
    assert_eq!(durable.records[0].exports[0].snapshot.as_ref().unwrap().note_entries, expected);
    assert_eq!(durable.versions[&legacy.id][0].note_entries, expected);
    assert_eq!(durable.pending_export.as_ref().unwrap().snapshot.note_entries, expected);
    assert!(!read_store(&repo.primary()).unwrap().unwrap().note_entries_migrated);
    let mut migrated = migrated;
    migrated.pending_export = None;
    repo.commit(&mut migrated).unwrap();
    let restored = repo.restore_document_version(&legacy.id, &legacy_id).unwrap().current;
    assert_eq!(restored.notes, legacy.notes);
    assert_eq!(restored.note_entries, expected);
    let mut forged = restored;
    set_notes(&mut forged, &["  Historique", "Second paragraphe\r\n"]);
    assert!(!matches_recovery_version_id(&forged, &legacy_id));
}

#[test]
fn multiple_notes_survive_restart_backup_pdf_snapshot_and_selected_restore_with_displaced_history() {
    let (_temp, repo) = setup();
    let mut original = ready_quote(&repo);
    set_notes(&mut original, &["  Note A\n\nParagraphe  ", "Note B\nLigne", ""]);
    let original = repo.save_draft(original).unwrap().current;
    let export = repo.export_pdf(original.clone(), PDF.to_vec(), None, "fr".into()).unwrap();
    assert_eq!(export.snapshot.note_entries, original.note_entries);
    let mut edited = export.snapshot.clone();
    set_notes(&mut edited, &["Note B\nLigne", "Nouvelle note\r\nSuite"]);
    let edited = repo.save_draft(edited).unwrap().current;
    let reopened = Repository::new(repo.data_dir.clone(), repo.documents_dir.clone());
    assert_eq!(reopened.load_state().unwrap().current, edited);
    fs::write(repo.primary(), b"{invalid").unwrap();
    assert_eq!(reopened.load_state().unwrap().current, edited);
    let version_id = export_version_id(&export.path);
    let restored = reopened.restore_document_version(&edited.id, &version_id).unwrap();
    assert_eq!(restored.current, original);
    let record = restored.records.iter().find(|record| record.id == edited.id).unwrap();
    assert_eq!(record.saved_versions.last().unwrap().snapshot, edited);
    assert_eq!(record.exports[0].snapshot.as_ref(), Some(&original));
    assert_eq!(fs::read(&export.path).unwrap(), PDF);
    assert_eq!(reopened.load_state().unwrap().current, original);
    let history_id = record.saved_versions.last().unwrap().version_id.clone();
    assert_eq!(reopened.restore_document_version(&edited.id, &history_id).unwrap().current, edited);
}

#[test]
fn legacy_save_and_export_inputs_normalize_exact_text_before_persisting_snapshots() {
    let (_temp, repo) = setup();
    let mut draft = ready_quote(&repo);
    draft.notes = "  Legacy\n\nTexte exact\r\n".into();
    draft.note_entries = None;
    let saved = repo.save_draft(draft.clone()).unwrap().current;
    assert_eq!(saved.note_entries, Some(vec![draft.notes.clone()]));
    let exported = repo.export_pdf(draft, PDF.to_vec(), None, "fr".into()).unwrap();
    assert_eq!(exported.snapshot, saved);
    assert_eq!(repo.load_state().unwrap().current, saved);
}

#[test]
fn note_edits_stale_english_by_exact_mirror_without_overwriting_translated_or_french_text() {
    let (_temp, repo) = setup();
    let mut draft = ready_quote(&repo);
    set_notes(&mut draft, &["Première", "Deuxième\nligne"]);
    draft.english_copy = Some(EnglishCopy {
        source_project: draft.project.clone(), source_notes: draft.notes.clone(),
        source_descriptions: draft.items.iter().map(|item| item.description.clone()).collect(),
        project: "Synthetic project".into(), notes: "First\n\nSecond line".into(),
        descriptions: vec!["Test work".into()], reviewed: true,
    });
    validate_english_copy(&draft).unwrap();
    let translation = draft.english_copy.clone();
    set_notes(&mut draft, &["Première", "", "Deuxième\nligne"]);
    validate_english_copy(&draft).unwrap();
    set_notes(&mut draft, &["Deuxième\nligne", "Première"]);
    assert!(validate_english_copy(&draft).is_err());
    let saved = repo.save_draft(draft).unwrap().current;
    assert_eq!(saved.english_copy, translation);
    assert_eq!(saved.notes, "Deuxième\nligne\n\nPremière");
    assert!(repo.export_pdf(saved.clone(), PDF.to_vec(), None, "en".into()).is_err());
    assert_eq!(repo.load_state().unwrap().current, saved);
}
