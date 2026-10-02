use super::*;
use tempfile::TempDir;
fn setup()->(TempDir,Repository){let root=tempfile::tempdir().unwrap();let repo=Repository::new(root.path().join("appdata"),root.path().join("Documents"));(root,repo)}
fn ready(repo:&Repository)->Draft{let mut d=repo.new_draft(Kind::Facture).unwrap().current;d.project="Taxes test".into();d.client="Client test".into();d.address="Montréal QC".into();d.ship_to="Ottawa ON".into();d.items[0].description="Installation".into();d.items[0].price="100".into();d.tax=Some(taxes::resolve(&d));d}
#[test]
fn tax_snapshot_survives_save_restart_and_export_history(){let(root,repo)=setup();let d=ready(&repo);let saved=repo.save_draft(d.clone()).unwrap().current;assert_eq!(saved.tax.as_ref().unwrap().province.as_deref(),Some("ON"));let restarted=Repository::new(root.path().join("appdata"),root.path().join("Documents"));assert_eq!(restarted.load_state().unwrap().current.tax,saved.tax);let result=repo.export_pdf(d,b"%PDF-1.4\n1 0 obj <<>> endobj\n%%EOF\n".to_vec(),saved.invoice_number,"fr".into()).unwrap();assert_eq!(result.snapshot.tax,saved.tax);let state=repo.load_state().unwrap();assert_eq!(state.records.iter().find(|r|r.id==saved.id).unwrap().exports[0].snapshot.as_ref().unwrap().tax,saved.tax);}
#[test]
fn tax_precedence_pickup_and_manual_override_validate(){let(_root,repo)=setup();let mut d=ready(&repo);d.ship_to="Ripon QC".into();d.address="Ottawa ON".into();d.tax=Some(taxes::resolve(&d));assert_eq!(d.tax.as_ref().unwrap().province.as_deref(),Some("QC"));d.tax.as_mut().unwrap().fulfillment="pickup".into();d.ship_to="Vancouver BC".into();d.tax=Some(taxes::resolve(&d));assert_eq!(d.tax.as_ref().unwrap().basis,"shop");d.tax.as_mut().unwrap().selection="ON".into();d.tax=Some(taxes::resolve(&d));assert_eq!(d.tax.as_ref().unwrap().basis,"manual");assert!(validate_export_draft(&d).is_ok());}
#[test]
fn malformed_rates_unresolved_stale_and_legacy_exports_are_rejected(){let(_root,repo)=setup();let mut d=ready(&repo);d.tax.as_mut().unwrap().rates[0].rate_millionths=0;assert!(repo.save_draft(d.clone()).is_err());d.tax=Some(taxes::resolve(&d));d.ship_to="Toronto California USA".into();assert!(repo.save_draft(d.clone()).is_err());d.tax=Some(taxes::resolve(&d));assert!(repo.save_draft(d.clone()).is_ok());assert!(validate_export_draft(&d).is_err());d.tax=None;assert_eq!(taxes::resolve(&d).province.as_deref(),Some("QC"));assert!(validate_export_draft(&d).is_err());d.ship_to="Ripon QC".into();assert!(validate_export_draft(&d).is_ok());}
#[test]
fn province_parser_distinguishes_streets_and_foreign_locations(){for(text,expected)in[("Ottawa ON K1A 0B1",Some("ON")),("Ripon (Qc) J0V 1V0",Some("QC")),("123 rue Ontario, Montréal QC",Some("QC")),("123 rue Ontario",None),("Ontario California USA",Some("outside")),("Vancouver BC",Some("outside")),("Ottawa ON, Quebec",None)]{assert_eq!(taxes::province(text),expected,"{text}");}}

#[test]
fn active_editable_load_migrates_only_response_and_save_persists_after_restart() {
    for selection in [None, Some("legacy")] {
        let (root, repo) = setup();
        let mut draft = ready(&repo);
        draft.tax = selection.map(|value| {
            let mut tax = taxes::fresh();
            tax.selection = value.into();
            tax
        });
        if draft.tax.is_some() { draft.tax = Some(taxes::resolve(&draft)); }
        let original = draft.clone();
        let mut store = repo.load().unwrap();
        let index = store.index(&draft.id).unwrap();
        store.records[index].draft = draft.clone();
        let mut inactive = draft.clone();
        inactive.id = Uuid::new_v4().to_string();
        store.records.push(Record {
            id: inactive.id.clone(), draft: inactive.clone(), updated_at: Utc::now().to_rfc3339(),
            exports: vec![], saved_versions: vec![], sent_at: None,
        });
        store.versions.insert(draft.id.clone(), vec![draft.clone()]);
        repo.commit(&mut store).unwrap();
        let bytes_before = fs::read(repo.primary()).unwrap();
        let loaded = repo.load_state().unwrap();
        assert_eq!(loaded.current.tax.as_ref().unwrap().selection, "auto");
        assert_eq!(loaded.current.tax.as_ref().unwrap().province.as_deref(), Some("ON"));
        assert_eq!(loaded.records.iter().find(|r| r.id == draft.id).unwrap().draft, original);
        assert_eq!(loaded.records.iter().find(|r| r.id == inactive.id).unwrap().draft, inactive);
        assert_eq!(fs::read(repo.primary()).unwrap(), bytes_before);
        // Native save also handles a stale old client sending missing/legacy tax directly.
        repo.save_draft(original.clone()).unwrap();
        let restarted = Repository::new(root.path().join("appdata"), root.path().join("Documents"));
        let persisted = restarted.load().unwrap();
        assert_eq!(persisted.records[persisted.index(&original.id).unwrap()].draft.tax.as_ref().unwrap().selection, "auto");
        assert_eq!(persisted.records[persisted.index(&inactive.id).unwrap()].draft, inactive);
        assert_eq!(persisted.versions[&original.id], vec![original]);
        assert!(taxes::validate_export(&restarted.load_state().unwrap().current).is_ok());
        // Opening another record migrates its editor response, not its stored history.
        let opened = restarted.open_draft(&inactive.id).unwrap();
        assert_eq!(opened.current.tax.as_ref().unwrap().selection, "auto");
        assert_eq!(restarted.load().unwrap().records.iter().find(|r| r.id == inactive.id).unwrap().draft, inactive);
    }
}

#[test]
fn issued_editable_migration_preserves_archival_snapshots_totals_and_pdf_bytes() {
    for selection in [None, Some("legacy")] {
        let (root, repo) = setup();
        let mut draft = ready(&repo);
        draft.ship_to = "Ripon QC".into();
        draft.tax = Some(taxes::resolve(&draft));
        let pdf = b"%PDF-1.4\n1 0 obj << /Legacy /Exact >> endobj\n%%EOF\n";
        let exported = repo.export_pdf(draft.clone(), pdf.to_vec(), draft.invoice_number, "fr".into()).unwrap();
        let mut historical = exported.snapshot;
        historical.tax = selection.map(|value| {
            let mut tax = taxes::fresh(); tax.selection = value.into(); tax
        });
        if historical.tax.is_some() { historical.tax = Some(taxes::resolve(&historical)); }
        let mut editable = historical.clone();
        editable.ship_to = "Ottawa ON".into();
        let mut store = repo.load().unwrap();
        let index = store.index(&editable.id).unwrap();
        store.records[index].draft = editable.clone();
        store.records[index].exports[0].snapshot = Some(historical.clone());
        store.records[index].exports[0].tax_totals = taxes::totals(&historical);
        store.records[index].saved_versions.push(SavedVersion {
            version_id: format!("history:{}", Uuid::new_v4()), saved_at: Utc::now().to_rfc3339(), snapshot: historical.clone(),
        });
        store.versions.insert(editable.id.clone(), vec![historical.clone()]);
        repo.commit(&mut store).unwrap();
        let versions_before = serde_json::to_value(repo.load_document_versions(&editable.id).unwrap()).unwrap();
        let archive_before = serde_json::to_value(&repo.load().unwrap().records[index].exports).unwrap();
        let current = repo.load_state().unwrap().current;
        assert_eq!(current.issued_number, historical.issued_number);
        assert_eq!(current.tax.as_ref().unwrap().selection, "auto");
        assert_eq!(current.tax.as_ref().unwrap().province.as_deref(), Some("ON"));
        assert!(validate_export_draft(&current).is_ok());
        repo.save_draft(editable).unwrap();
        let restarted = Repository::new(root.path().join("appdata"), root.path().join("Documents"));
        let persisted = restarted.load().unwrap();
        let record = &persisted.records[index];
        assert_eq!(record.draft.tax.as_ref().unwrap().selection, "auto");
        assert_eq!(record.draft.issued_number, historical.issued_number);
        assert_eq!(record.saved_versions[0].snapshot, historical);
        assert_eq!(serde_json::to_value(&record.exports).unwrap(), archive_before);
        assert_eq!(record.exports[0].snapshot.as_ref().unwrap(), &historical);
        assert_eq!(persisted.versions[&historical.id][0], historical);
        assert_eq!(fs::read(&exported.path).unwrap(), pdf);
        // Historical copies remain exact even when an editable restoration is selected.
        let restored = restarted.restore_document_version(&historical.id, &record.saved_versions[0].version_id).unwrap();
        assert_eq!(restored.current.tax.as_ref().unwrap().selection, "auto");
        let after_restore = restarted.load().unwrap();
        assert_eq!(after_restore.records[index].saved_versions[0].snapshot, historical);
        assert_eq!(serde_json::to_value(&after_restore.records[index].exports).unwrap(), archive_before);
        assert_eq!(fs::read(&exported.path).unwrap(), pdf);
        assert!(versions_before.as_array().unwrap().len() >= 2);
    }
}

#[test]
fn migration_preserves_explicit_choices_and_export_requires_a_resolved_province() {
    let (_root, repo) = setup();
    for selection in ["QC", "ON"] {
        let mut draft = ready(&repo);
        draft.tax.as_mut().unwrap().selection = selection.into();
        draft.tax = Some(taxes::resolve(&draft));
        let original = draft.tax.clone();
        assert!(!taxes::migrate_editable(&mut draft));
        assert_eq!(repo.save_draft(draft).unwrap().current.tax, original);
    }
    for location in ["", "123 rue Ontario", "Vancouver BC", "Ontario California USA"] {
        let mut draft = ready(&repo);
        draft.address = location.into(); draft.ship_to = String::new(); draft.tax = None;
        let saved = repo.save_draft(draft).unwrap().current;
        assert_eq!(saved.tax.as_ref().unwrap().selection, "auto");
        assert!(taxes::validate_export(&saved).is_err());
    }
    let mut pickup = ready(&repo);
    pickup.tax.as_mut().unwrap().selection = "legacy".into();
    pickup.tax.as_mut().unwrap().fulfillment = "pickup".into();
    pickup.ship_to = "Vancouver BC".into();
    assert!(taxes::migrate_editable(&mut pickup));
    assert_eq!(pickup.tax.as_ref().unwrap().basis, "shop");
    assert_eq!(pickup.tax.as_ref().unwrap().province.as_deref(), Some("QC"));
    assert!(taxes::validate_export(&pickup).is_ok());
}

#[test]
fn optional_page_break_before_is_backward_compatible_and_persists() {
    let legacy = serde_json::json!({"description":"Installation", "quantity":"1", "price":"100"});
    let item: Item = serde_json::from_value(legacy.clone()).unwrap();
    assert_eq!(item.page_break_before, None);
    assert_eq!(serde_json::to_value(&item).unwrap(), legacy);
    for flag in [false, true] {
        let mut value = legacy.clone(); value["pageBreakBefore"] = flag.into();
        let item: Item = serde_json::from_value(value.clone()).unwrap();
        assert_eq!(item.page_break_before, Some(flag));
        assert_eq!(serde_json::to_value(item).unwrap(), value);
    }
    let (root, repo) = setup();
    let mut draft = ready(&repo); draft.items[0].page_break_before = Some(true);
    let saved = repo.save_draft(draft).unwrap().current;
    let restarted = Repository::new(root.path().join("appdata"), root.path().join("Documents"));
    assert_eq!(restarted.load_state().unwrap().current.items, saved.items);
}

#[test]
fn legacy_pending_pdf_retry_finishes_once_without_migrating_its_snapshot() {
    let (_root, repo) = setup();
    let mut draft = ready(&repo);
    draft.ship_to = "Ripon QC".into();
    draft.tax.as_mut().unwrap().selection = "legacy".into();
    draft.tax = Some(taxes::resolve(&draft));
    let mut store = repo.load().unwrap();
    let index = store.index(&draft.id).unwrap();
    store.records[index].draft = draft.clone();
    let number = draft.invoice_number;
    let filename = base_filename(&draft, number, "fr").unwrap();
    let pdf = b"%PDF-1.4\n1 0 obj << /Pending /Exact >> endobj\n%%EOF\n";
    store.pending_export = Some(PendingExport {
        id: draft.id.clone(), filename: filename.clone(), invoice_number: number,
        snapshot: draft.clone(), language: "fr".into(),
        pdf_sha256: format!("{:x}", Sha256::digest(pdf)), exported_at: Utc::now().to_rfc3339(),
    });
    repo.commit(&mut store).unwrap();
    let output = repo.selected_output_dir(&store, Kind::Facture).unwrap();
    fs::create_dir_all(&output).unwrap();
    fs::write(output.join(&filename), pdf).unwrap();
    let resumed = repo.export_pdf(draft.clone(), pdf.to_vec(), number, "fr".into()).unwrap();
    assert_eq!(resumed.filename, filename);
    let persisted = repo.load().unwrap();
    let record = &persisted.records[index];
    assert_eq!(record.exports.len(), 1);
    assert_eq!(record.exports[0].snapshot.as_ref().unwrap().tax, draft.tax);
    assert_eq!(fs::read(&resumed.path).unwrap(), pdf);
    assert_eq!(persisted.next_invoice_number, number.unwrap() + 1);
    assert!(persisted.pending_export.is_none());
}
