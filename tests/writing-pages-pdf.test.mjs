import assert from 'node:assert/strict';
import test, {after} from 'node:test';
import {mkdtemp, readFile, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {PDFDocument, StandardFonts, decodePDFRawStream, PDFName} from 'pdf-lib';
import {createPdf, calculateTotals, descriptionFitsPage, measureDescriptionCapacity} from '../web/pdf.js';
import {sampleDraft} from './fixtures.mjs';

// Inspect saved PDF operators and glyph advances, never renderer cursors or
// its wrapping/planning helpers. Keep artifacts in OS temp, outside leaf scope.
const output = await mkdtemp(join(tmpdir(), 'writing-pages-pdf-'));
after(() => console.log(`WRITING_PDF_SAVED_ARTIFACTS ${output}`));
const decoder = new TextDecoder('windows-1252');
const normalize = text => text.replace(/[\u00a0\u202f]/g, ' ').replace(/[\u2010-\u2015]/g, '-').replace(/\s+/g, ' ').trim();
const currency = (n, language='fr') => normalize(new Intl.NumberFormat(language==='en'?'en-CA':'fr-CA', {style:'currency',currency:'CAD'}).format(n));
const cents = text => Math.round(Number(text.replace(/[^\d.,-]/g,'').replace(/,(?=\d{3}(?:\D|$))/g,'').replace(',','.'))*100);
function streamOf(doc,page) {
  const contents = page.node.Contents();
  assert.ok(contents, 'A saved page must have contents');
  return Array.from({length:contents.size()},(_,i) => Buffer.from(decodePDFRawStream(doc.context.lookup(contents.get(i))).decode()).toString('latin1')).join('\n');
}
async function inspect(bytes) {
  const doc = await PDFDocument.load(bytes);
  const [normal,bold] = await Promise.all([doc.embedFont(StandardFonts.Helvetica),doc.embedFont(StandardFonts.HelveticaBold)]);
  return doc.getPages().map(page => {
    const stream = streamOf(doc,page), rows = [], stack = []; let spacing = 0;
    for (const token of stream.matchAll(/(-?[\d.]+) Tw|\b(q|Q)\b|BT([\s\S]*?)ET/g)) {
      if (token[1] !== undefined) {spacing=Number(token[1]); continue;}
      if (token[2]==='q') {stack.push(spacing); continue;}
      if (token[2]==='Q') {assert.ok(stack.length);spacing=stack.pop();continue;}
      const block=token[3];
      const font=block.match(/\/(Helvetica[^\s]*) ([\d.]+) Tf/);
      const matrix=block.match(/1 0 0 1 ([\d.-]+) ([\d.-]+) Tm/);
      const encoded=block.match(/<([\dA-Fa-f]+)> Tj/);
      assert.ok(font && matrix && encoded,'All saved text operators must be understood');
      const text=decoder.decode(Buffer.from(encoded[1],'hex'));
      const size=Number(font[2]), x=Number(matrix[1]), y=Number(matrix[2]);
      const face=font[1].includes('Bold')?bold:normal;
      const width=Array.from(text).reduce((sum,char)=>sum+face.widthOfTextAtSize(char,size),0)+(text.match(/ /g)||[]).length*spacing;
      rows.push({text,size,x,right:x+width,top:792-y-size,bottom:792-y,spacing});
    }
    assert.ok(rows.length>10,'Empty PDF extraction cannot pass');
    return {rows,size:page.getSize(),stream};
  });
}
async function saved(draft, name, language='fr', preview=false) {
  const file=join(output,`${name}.pdf`);
  await writeFile(file,await createPdf(draft,{invoiceNumber:2060,language,preview}));
  return inspect(await readFile(file));
}
const workRows = page => page.rows.filter(r=>r.x===48 && r.size===10.5);
const amountAt = (page,label) => {
  const row=page.rows.find(r=>r.text===label); assert.ok(row,`Missing ${label}`);
  const amount=page.rows.find(r=>r.x>420 && Math.abs(r.top-row.top)<.001);
  assert.ok(amount,`Missing amount for ${label}`); return amount;
};
function assertBounds(pages) {
  for (const [index,page] of pages.entries()) {
    assert.deepEqual(page.size,{width:612,height:792},'Physical Letter page');
    assert.ok(page.rows.some(r=>r.text===`${index+1} / ${pages.length}`),'Page count footer');
    for (const row of page.rows) {
      const footer=/(?:848045563 RT0001|1212260726 TQ0001|^\d+ \/ \d+$)/.test(row.text);
      assert.ok(row.x>=41 && row.right<=571.001,`Horizontal clipping: ${row.text} at ${row.right}`);
      assert.ok(row.top>=23 && (footer ? row.bottom<=760 : row.bottom<738),`Footer clipping: ${row.text} at ${row.bottom}`);
    }
    for(let a=0;a<page.rows.length;a++)for(let b=a+1;b<page.rows.length;b++) {
      const x=page.rows[a],y=page.rows[b];
      const overlapX=Math.min(x.right,y.right)-Math.max(x.x,y.x);
      const overlapY=Math.min(x.bottom,y.bottom)-Math.max(x.top,y.top);
      assert.ok(overlapX<.5 || overlapY<.5,`Text overlap: ${x.text} / ${y.text}`);
    }
  }
}
function assertWorkSummary(pages, language='fr', kind='facture') {
  const subtotal=language==='en'?'Subtotal for this page':'Sous-total de cette page';
  const overall=language==='en'?'Subtotal':'Sous-total';
  for(const page of pages) {
    const work=workRows(page);
    if(work.length) {
      assert.equal(page.rows.filter(r=>r.text===subtotal).length,0,'Page subtotals are absent on every work page');
      assert.ok(page.rows.some(r=>r.text===(language==='en'?'PROJECT':'PROJET')),'Project repeated');
      assert.ok(page.rows.some(r=>r.text===(language==='en'?'DOCUMENT DATE':'DATE DU DOCUMENT')),'Date repeated');
      assert.ok(page.rows.some(r=>r.text==='Client Démo'),'Client repeated');
      assert.ok(page.rows.some(r=>r.text==="Ébénisterie de l'Hermitage inc."),'Company repeated');
      if(kind==='facture')assert.ok(page.rows.some(r=>r.text===(language==='en'?'Invoice no. 2060':'Facture n° 2060')),'Same invoice identity');
      else assert.ok(!page.rows.some(r=>/2060/.test(r.text)),'Quotes do not acquire an invoice number');
    }
    if(page.rows.some(r=>r.text===overall)) assert.ok(work.length,'Orphan overall summary detected');
  }
  assert.ok(workRows(pages.at(-1)).length,'Final physical page contains work');
  assert.equal(pages.flatMap(p=>p.rows).filter(r=>r.text===overall).length,1,'Overall summary appears exactly once');
  const summed=pages.reduce((sum,p)=>sum+p.rows.filter(r=>r.x>475 && r.size===10 && workRows(p).some(w=>Math.abs(w.top-r.top)<.001)).reduce((n,r)=>n+cents(r.text),0),0);
  assert.equal(summed,cents(amountAt(pages.at(-1),overall).text),'Printed work charges sum to overall subtotal');
}
function rowsDraft(count=15) {
  return {...sampleDraft('facture'),notes:'',deposit:'',payments:[],items:Array.from({length:count},(_,i)=>({
    description:`WORK${String(i+1).padStart(2,'0')} fabrication des caissons.\nPortes et quincaillerie incluses.\nInstallation selon les mesures.`,
    quantity:String(i%3+1),price:`${100+i}.25`,
  }))};
}
function assertTotals(pages,draft,language='fr') {
  const totals=calculateTotals(draft),final=pages.at(-1);
  const labels=language==='en'?['Subtotal','GST (5%)','QST (9.975%)','Total incl. tax','Total received','Balance due']:['Sous-total','TPS (5 %)','TVQ (9,975 %)','Total avec taxes','Total reçu','Balance'];
  for(const [i,value] of [totals.subtotal,totals.tps,totals.tvq,totals.total,totals.deposit,totals.balance].entries()) {
    if(i>=4 && !totals.deposit)continue;
    assert.equal(amountAt(final,labels[i]).text,currency(value,language),'Unchanged document-level calculation');
  }
}

test('fifteen whole three-line descriptions: saved Letter pages, arithmetic, repeated identity, one final summary',async()=>{
  for(const language of ['fr','en'])for(const kind of ['facture','soumission']) {
    const draft=rowsDraft();draft.kind=kind; const pages=await saved(draft,`15x3-${kind}-${language}`,language);
    assert.equal(pages.length,3,'Measured 15x3 fixture uses three physical Letter pages');
    assertBounds(pages); assertWorkSummary(pages,language,kind);assertTotals(pages,draft,language);
    for(const item of draft.items) {
      const marker=item.description.split(' ')[0];
      const owners=pages.filter(p=>workRows(p).some(r=>r.text.startsWith(marker)));
      assert.equal(owners.length,1,'Item occurs once');
      const index=workRows(owners[0]).findIndex(r=>r.text.startsWith(marker));
      assert.equal(workRows(owners[0]).slice(index,index+3).map(r=>r.text).join('\n'),item.description,'Whole row retained on one page');
    }
  }
});

test('six-row RCA boundary and neighboring row counts cannot create a totals-only page',async()=>{
  for(const n of [4,5,6,7,8,9,10,11,12]) {
    const draft=rowsDraft(n); const pages=await saved(draft,`boundary-${n}`);
    assertBounds(pages);assertWorkSummary(pages);assertTotals(pages,draft);
    assert.equal(pages.flatMap(workRows).filter(r=>/^WORK\d+/.test(r.text)).length,n);
    if(n===6)assert.equal(pages.length,2,'Original six-row defect still needs two pages, now both have work');
  }
});

test('description admission matches actual wrapping including final recap, notes, payments and repeated identity',async()=>{
  for(const [notes,payments] of [['',[]],['NOTE01 short.\nNOTE02 short.',[{amount:'12.34',date:'2026-09-18'}]],
    [Array.from({length:48},(_,i)=>`NOTE${i} retained.`).join('\n'),Array.from({length:90},()=>({amount:'1',date:'2026-09-18'}))]]) {
    const draft={...rowsDraft(1),notes,payments};
    const before=structuredClone(draft),capacity=await measureDescriptionCapacity(draft);
    assert.ok(capacity.maxLines>0);assert.equal(capacity.maxLines,Math.floor(capacity.maxHeight/13));
    const fit=Array.from({length:capacity.maxLines},(_,i)=>`CAP${i} short.`).join('\n');
    assert.equal(await descriptionFitsPage(draft,fit),true);
    assert.equal(await descriptionFitsPage(draft,fit+'\nEXTRA short.'),false);
    assert.equal(await descriptionFitsPage(draft,'WIDE '.repeat(capacity.maxLines*30)),false,'Width wrapping counts, not only newlines');
    for(const language of ['fr','en']) {
      draft.items[0].description=fit;
      const pages=await saved(draft,`capacity-${notes.length}-${language}`,language);
      assertBounds(pages);assertWorkSummary(pages,language);assertTotals(pages,draft,language);
      assert.equal(pages.filter(p=>workRows(p).length).length,1,'Accepted one row fits on the final work page');
    }
    draft.items[0].description=before.items[0].description;assert.deepEqual(draft,before,'Measurement/rendering do not mutate input');
  }
  assert.ok((await measureDescriptionCapacity({})).maxLines>0,'Incomplete editable drafts can be measured');
  assert.equal(await descriptionFitsPage({},''),true);
});

test('explicit pageBreakBefore starts a whole uncharged manual continuation on a new physical page',async()=>{
  const draft=rowsDraft(2); draft.items[1].pageBreakBefore=true;draft.items[1].price='0';
  const pages=await saved(draft,'manual-continuation');
  assert.equal(pages.length,2);assertBounds(pages);assertWorkSummary(pages);assertTotals(pages,draft);
  assert.ok(workRows(pages[0])[0].text.startsWith('WORK01'));
  assert.ok(workRows(pages[1])[0].text.startsWith('WORK02'));
  assert.ok(!pages[1].rows.some(r=>r.text==='Sous-total de cette page'));
  const preview=await saved(draft,'manual-continuation-preview','fr',true);assert.equal(preview.length,2);assertWorkSummary(preview);
});

test('legacy huge single description preserves every word and prints quantity/charge once',async()=>{
  const draft=rowsDraft(1);
  draft.items[0]={description:Array.from({length:100},(_,i)=>`STEP${i}: Fabrication et ajustement selon les dimensions confirmées. END${i}.`).join('\n'),quantity:'2',price:'123.45'};
  const pages=await saved(draft,'legacy-huge');assert.ok(pages.length>3);
  assertBounds(pages);assertWorkSummary(pages);assertTotals(pages,draft);
  assert.equal(normalize(pages.flatMap(workRows).map(r=>r.text).join(' ')),normalize(draft.items[0].description));
  assert.equal(pages.flatMap(p=>p.rows.filter(r=>r.x>475 && r.size===10 && r.text==='246,90 $' && workRows(p).some(w=>Math.abs(w.top-r.top)<.001))).length,1,'Work charge once');
  assert.equal(pages.flatMap(p=>p.rows).filter(r=>r.x>=340 && r.x<370 && r.size===10 && r.text==='2').length,1,'Quantity once');
});

test('oversized supporting notes and payment histories retain every fact, above footer, before final work/summary',async()=>{
  for(const language of ['fr','en'])for(const kind of ['facture','soumission']) {
    const draft=rowsDraft(1);draft.kind=kind;
    draft.notes=Array.from({length:70},(_,i)=>`NOTE${String(i).padStart(3,'0')}: A confirmed detail END${i}.`).join('\n');
    draft.payments=Array.from({length:500},(_,i)=>({amount:String(i+1),date:`2026-09-${String(i%28+1).padStart(2,'0')}`}));
    const pages=await saved(draft,`support-${kind}-${language}`,language);assertBounds(pages);assertWorkSummary(pages,language,kind);
    const rows=pages.flatMap(p=>p.rows);
    for(let i=0;i<70;i++)assert.equal(rows.filter(r=>r.text.startsWith(`NOTE${String(i).padStart(3,'0')}:`)).length,1,'Each note once');
    const pairs=[];
    for(const page of pages)for(const row of page.rows.filter(r=>r.x===73 && r.size===10)) {
      const amount=page.rows.find(r=>r.x>200 && Math.abs(r.top-row.top)<.001);assert.ok(amount);pairs.push([row.text,amount.text]);
    }
    assert.deepEqual(pairs,draft.payments.map(p=>[language==='en'?p.date:p.date.split('-').reverse().join('/'),currency(Number(p.amount),language)]),'All 500 date/amount pairs in order');
    assert.ok(workRows(pages.at(-1)).length,'Final page has original work, not just supporting recap');
    assert.equal(amountAt(pages.at(-1),language==='en'?'Subtotal':'Sous-total').text,currency(calculateTotals(draft).subtotal,language));
  }
});

test('notes and both addresses justify wrapped lines, retaining paragraph endings and body sizes',async()=>{
  const paragraph='Adresse confirmée de la résidence du client avec les précisions supplémentaires pour la livraison et le lieu de travail. ';
  const draft=rowsDraft(1);draft.address=paragraph+'Québec (Qc) G1A 0A1';draft.shipTo=paragraph+'Québec (Qc) G1A 0A2';
  draft.tax={selection:'QC',fulfillment:'installation'};draft.notes=paragraph.repeat(2)+'FIN.';
  const pages=await saved(draft,'justified-support');assertBounds(pages);
  const rows=pages.flatMap(p=>p.rows);
  for(const [x,right,size] of [[55,280,10],[324,549,10],[56,275,10]]) {
    const aligned=rows.filter(r=>r.x===x && r.spacing>0);
    assert.ok(aligned.length,`Justified multiline field at ${x}`);
    assert.ok(aligned.every(r=>r.size===size && Math.abs(r.right-right)<.001));
  }
  assert.equal(rows.find(r=>r.text.endsWith('FIN.')).spacing,0,'Paragraph ending is naturally spaced');
  assert.ok(workRows(pages.at(-1)).every(r=>r.size===10.5),'Work font unchanged');
});

test('fractional cent row/page accounting reconciles with the existing document subtotal',async()=>{
  const draft=rowsDraft(15);draft.items.forEach(item=>{item.quantity='1';item.price='0.105';});
  const pages=await saved(draft,'fractional-cents');assertBounds(pages);assertWorkSummary(pages);assertTotals(pages,draft);
  assert.equal(amountAt(pages.at(-1),'Sous-total').text,'1,58 $');
});

test('representative six-row invoice fits one Letter page with exact totals',async()=>{
  // Synthetic public fixture. The original customer invoice remains local.
  const draft={...sampleDraft('facture'),date:'2026-10-01',project:'Projet Démonstration',client:'Client Démonstration',
    address:'100, rue Exemple, Gatineau, Québec J8X 1A1',contact:'819 555 0123',email:'client@example.com',shipTo:'',notes:'',
    tax:{selection:'QC',fulfillment:'installation'},payments:[{date:'',amount:'10000'}],items:[
      {description:'Modules de rangement de démonstration avec portes et tablettes ajustables. Fabrication de 1 élément central et de 4 éléments latéraux, avec 2 tiroirs. Ajustement des charnières et finition selon les choix fictifs du client. Largeur de 84 pouces et profondeur de 24 pouces.',quantity:'2',price:'8900.00'},
      {description:'Meuble de démonstration de 48 pouces avec 6 tiroirs.',quantity:'2',price:'750.00'},
      {description:'Meuble de démonstration de 36 pouces avec 3 tiroirs.',quantity:'2',price:'500.00'},
      {description:'Éléments de rangement fictifs de 12 x 30 x 60 pouces.',quantity:'2',price:'480.00'},
      {description:'Tablettes ajustables de démonstration avec supports en métal.',quantity:'2',price:'1600.00'},
      {description:'Ajout de modules de rangement fictifs avec surface de travail.',quantity:'2',price:'2500.00'},
    ]};
  for(const language of ['fr','en']) {
    const pages=await saved(draft,`synthetic-invoice-${language}`,language);assert.equal(pages.length,1);assertBounds(pages);assertTotals(pages,draft,language);
    assert.equal(normalize(pages.flatMap(workRows).map(r=>r.text).join(' ')),normalize(draft.items.map(i=>i.description).join(' ')),'Every description preserved');
    const overall=language==='en'?'Subtotal':'Sous-total',pageTotal=language==='en'?'Subtotal for this page':'Sous-total de cette page';
    assert.ok(!pages[0].rows.some(r=>r.text===pageTotal));
    assert.equal(amountAt(pages[0],overall).text,currency(29460,language));
    assert.equal(amountAt(pages[0],language==='en'?'Total incl. tax':'Total avec taxes').text,currency(33871.64,language));
    assert.equal(amountAt(pages[0],language==='en'?'Balance due':'Balance').text,currency(23871.64,language));
  }
});

test('legacy identity overflow and summary capacity boundaries preserve data and always end with work',async()=>{
  const large={...rowsDraft(1),project:Array.from({length:40},(_,i)=>`PROJECT${i} retained identity.`).join('\n'),
    client:'Client Démo',address:Array.from({length:70},(_,i)=>`ADDR${i} retained address.`).join('\n'),tax:{selection:'QC',fulfillment:'installation'}};
  const pages=await saved(large,'legacy-identity');assertBounds(pages);assert.ok(workRows(pages.at(-1)).length);
  const text=normalize(pages.flatMap(p=>p.rows).map(r=>r.text).join(' '));
  for(let i=0;i<40;i++)assert.ok(text.includes(`PROJECT${i} retained identity.`));
  for(let i=0;i<70;i++)assert.ok(text.includes(`ADDR${i} retained address.`));
  assertTotals(pages,large);
  for(const n of [9,10,11,12,13,14,15,16,17,18,19,20]) {
    const draft=rowsDraft(1);draft.notes=Array.from({length:n},(_,i)=>`NOTE${i} brief.`).join('\n');
    draft.items[0].description=Array.from({length:60},(_,i)=>`LEGACY${i} retained.`).join('\n');
    const boundary=await saved(draft,`notes-boundary-${n}`);assertBounds(boundary);assertWorkSummary(boundary);assertTotals(boundary,draft);
    assert.equal(normalize(boundary.flatMap(workRows).map(r=>r.text).join(' ')),normalize(draft.items[0].description));
  }
});

test('saved-PDF observers reject injected clipping, overlaps, totals-only pages and overall arithmetic defects',async()=>{
  const draft=rowsDraft(6),pages=await saved(draft,'positive-control');assertBounds(pages);assertWorkSummary(pages);
  const bytes=await readFile(join(output,'positive-control.pdf'));
  const clipped=await PDFDocument.load(bytes);const font=await clipped.embedFont(StandardFonts.Helvetica);
  clipped.getPage(0).drawText('CLIPPED',{x:48,y:35,size:10,font});
  await assert.rejects(async()=>assertBounds(await inspect(await clipped.save())),/Footer clipping/);
  const overlapped=await PDFDocument.load(bytes),overlapFont=await overlapped.embedFont(StandardFonts.Helvetica);
  overlapped.getPage(0).drawText('OVERLAP',{x:48,y:792-workRows(pages[0])[0].bottom,size:10.5,font:overlapFont});
  await assert.rejects(async()=>assertBounds(await inspect(await overlapped.save())),/Text overlap/);
  const orphan=await PDFDocument.load(bytes),last=orphan.getPages().at(-1);
  const brokenStream=streamOf(orphan,last).replace(/BT([\s\S]*?)ET/g,(block)=>/10\.5 Tf/.test(block)&&/1 0 0 1 48 /.test(block)?'':block);
  assert.notEqual(brokenStream,streamOf(orphan,last),'Known work-free final-page defect injected');
  const ref=orphan.context.register(orphan.context.flateStream(brokenStream));last.node.set(PDFName.of('Contents'),orphan.context.obj([ref]));
  await assert.rejects(async()=>assertWorkSummary(await inspect(await orphan.save())),/Orphan overall summary/);
  const wrong=structuredClone(pages);const printed=amountAt(wrong.at(-1),'Sous-total');printed.text='0,00 $';
  assert.throws(()=>assertWorkSummary(wrong),/Printed work charges sum to overall subtotal/);
});
