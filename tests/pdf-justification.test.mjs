import assert from 'node:assert/strict';
import test from 'node:test';
import {readFile, writeFile, mkdir, mkdtemp, rm} from 'node:fs/promises';
import {resolve, sep} from 'node:path';
import {pathToFileURL} from 'node:url';
import {PDFDocument, StandardFonts, decodePDFRawStream} from 'pdf-lib';
import {createPdf} from '../web/pdf.js';
import {sampleDraft} from './fixtures.mjs';

// Interpret saved PDF graphics/text state independently of layout cursor values.
async function inspect(bytes) {
  const pdf = await PDFDocument.load(bytes);
  const normal = await pdf.embedFont(StandardFonts.Helvetica);
  const bold = await pdf.embedFont(StandardFonts.HelveticaBold);
  return pdf.getPages().map(page => {
    const contents = page.node.Contents();
    const stream = Array.from({length:contents.size()},(_,i)=>
      Buffer.from(decodePDFRawStream(pdf.context.lookup(contents.get(i))).decode()).toString('latin1')).join('\n');
    const rows = [], stack = []; let spacing = 0;
    for (const match of stream.matchAll(/(-?[\d.]+) Tw|\b(q|Q)\b|BT([\s\S]*?)ET/g)) {
      if (match[1] !== undefined) {spacing = Number(match[1]); continue;}
      if (match[2] === 'q') {stack.push(spacing); continue;}
      if (match[2] === 'Q') {spacing = stack.pop(); continue;}
      const block = match[3];
      const font = block.match(/\/(Helvetica[^\s]*) ([\d.]+) Tf/);
      const matrix = block.match(/1 0 0 1 ([\d.-]+) ([\d.-]+) Tm/);
      const encoded = block.match(/<([\dA-Fa-f]+)> Tj/);
      assert.ok(font && matrix && encoded,'Saved PDF text must be understood');
      const text = new TextDecoder('windows-1252').decode(Buffer.from(encoded[1],'hex'));
      const size = Number(font[2]), x = Number(matrix[1]), y = Number(matrix[2]);
      const face = font[1].includes('Bold') ? bold : normal;
      const width = Array.from(text).reduce((sum,char)=>sum+face.widthOfTextAtSize(char,size),0)
        + (text.match(/ /g)||[]).length * spacing;
      rows.push({text,size,x,top:792-y-size,right:x+width,spacing});
    }
    assert.ok(rows.length>10,'Nonempty saved-PDF extraction required');
    return rows;
  });
}
const paragraph = 'Fabrication de caissons en chêne blanc avec tablettes réglables, portes et charnières à fermeture douce, ajustement selon les mesures confirmées. ';
function draftFor(description) {
  return {...sampleDraft('facture'),notes:'',payments:[],deposit:'',items:[{description,quantity:'2',price:'100'}]};
}
function assertJustified(pages) {
  const rows=pages.flat(), justified=rows.filter(row=>row.spacing!==0);
  assert.ok(justified.length>=5,'At least five wrapped lines must actually be justified');
  for (const row of justified) {
    assert.equal(row.x,48); assert.equal(row.size,10.5);
    assert.ok(Math.abs(row.right-324)<.001,`Description right edge: ${row.right}`);
  }
  for (const row of rows.filter(row=>row.x!==48||row.size!==10.5)) assert.equal(row.spacing,0,'Word spacing must not leak into numeric columns or labels');
}
test('wrapped paragraphs align on both edges; final lines and explicit breaks retain normal spacing',async()=>{
  for(const language of ['fr','en']) {
    const pages=await inspect(await createPdf(draftFor(paragraph.repeat(3)+'FIN.\nLigne courte.\n\n'+paragraph.repeat(2)+'DERNIER.'),{invoiceNumber:2060,language}));
    assertJustified(pages);
    const rows=pages.flat().filter(row=>row.x===48&&row.size===10.5);
    for(const row of rows.filter(row=>row.text.endsWith('FIN.')||row.text.endsWith('DERNIER.')||row.text==='Ligne courte.')) assert.equal(row.spacing,0,'Paragraph ends must not be stretched');
    const short=rows.findIndex(row=>row.text==='Ligne courte.');assert.ok(short>=0);
    assert.equal(rows[short+1].top-rows[short].top,26,'Blank paragraph line survives');
    assert.ok(rows.every(row=>row.right<=324.001));
  }
});
test('a wrapped line ending a physical page stays justified; single-word lines remain unexpanded',async()=>{
  const pages=await inspect(await createPdf(draftFor(paragraph.repeat(100)+'FIN.'),{invoiceNumber:2060}));
  assert.ok(pages.length>1);assertJustified(pages);
  for(const page of pages.slice(0,-1)) {
    const rows=page.filter(row=>row.x===48&&row.size===10.5);
    if(rows.length)assert.notEqual(rows.at(-1).spacing,0,'Physical page break is not a paragraph end');
  }
  const single=await inspect(await createPdf(draftFor('Court\n'+ 'X'.repeat(160)),{invoiceNumber:2060}));
  assert.ok(single.flat().filter(row=>row.x===48&&row.size===10.5).every(row=>row.spacing===0&&row.right<=324.001));
});
test('saved-PDF observer catches a disabled word-spacing defect in an isolated renderer',async()=>{
  await mkdir('tmp',{recursive:true}); const dir=await mkdtemp(resolve('tmp','justify-mutation-'));
  try {
    let source=await readFile(new URL('../web/pdf.js',import.meta.url),'utf8');
    const broken=source.replace('setWordSpacing(extra / gaps)','setWordSpacing(0)');
    assert.notEqual(broken,source,'Defect was injected');source=broken;
    for(const name of ['payments','taxes','phone'])source=source.replace(`'./${name}.js'`,`'../../web/${name}.js'`);
    const file=resolve(dir,'broken.mjs');await writeFile(file,source);
    const mutant=await import(pathToFileURL(file));
    const pages=await inspect(await mutant.createPdf(draftFor(paragraph.repeat(4)),{invoiceNumber:2060}));
    assert.throws(()=>assertJustified(pages),/At least five wrapped lines/);
  } finally {
    assert.ok(resolve(dir).startsWith(resolve('tmp')+sep),'Recursive cleanup stays inside the owned workspace tmp directory');
    await rm(dir,{recursive:true,force:true});
  }
});
