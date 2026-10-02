import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {canDeleteDraft,libraryDetail,createDocumentLibrary} from '../web/document-library.js';
const draft=(id='draft-a')=>({id,kind:'soumission',project:'Cuisine & rangement',client:'Client <test>',notes:'',noteEntries:[''],items:[{description:'Travail',quantity:'1',price:'100'}],payments:[],issuedNumber:null});
const record=(id='draft-a',exports=[])=>({id,draft:draft(id),exports,updatedAt:'2026-10-01T12:00:00Z',savedVersions:[]});
const button=(name,value)=>({dataset:{libraryAction:value},hasAttribute:a=>a===name,disabled:false});
const action=name=>button('data-library-action',name);
function harness(options={},create=createDocumentLibrary){
 const calls=[],notices=[];let records=options.records||[record()],current=records[0].draft;
 const lib=create({getRecords:()=>records,getState:()=>current,command:async()=>[],flush:options.flush||(async()=>true),render(){},notice:m=>notices.push(m),transition:async(name,args)=>{calls.push([name,args]);if(options.transition)return options.transition(name,args);records=records.filter(r=>r.id!==args.id);if(current.id===args.id){const blank=record('blank');blank.draft.project='';records.push(blank);current=blank.draft;}return true;}});
 return {lib,calls,notices,get records(){return records;},set records(r){records=r;},get current(){return current;}};
}

test('option one exposes separated draft action and protects PDFs, sent archives and issued drafts',()=>{
 assert.equal(canDeleteDraft(record()),true);assert.equal(canDeleteDraft(null),false);
 for(const protectedRecord of [record('quote-pdf',[{path:'archive.pdf'}]),record('sent',[{sentReceipts:[{acceptedAt:'2026-10-01'}]}]),{...record(),draft:{...draft(),issuedNumber:2060}},{...record(),savedVersions:[{snapshot:{issuedNumber:2060}}]}]){
  assert.equal(canDeleteDraft(protectedRecord),false);assert.doesNotMatch(libraryDetail(protectedRecord,()=>''),/request-delete/);assert.match(libraryDetail(protectedRecord,()=>''),/draft-protection/);
 }
 const html=libraryDetail(record(),()=>'<paper>');assert.match(html,/<div class="delete-zone">.*request-delete/);assert.ok(html.indexOf('delete-zone')>html.indexOf('Versions précédentes'));
});

test('named confirmation and Cancel preserve the exact draft; forged confirmation is inert',async()=>{
 const h=harness(),before=structuredClone(h.records);h.lib.open();await h.lib.handleClick(action('confirm-delete'));assert.equal(h.calls.length,0);
 await h.lib.handleClick(action('request-delete'));assert.match(h.lib.html(),/Cuisine &amp; rangement/);assert.match(h.lib.html(),/Client &lt;test&gt;/);assert.match(h.lib.html(),/action est définitive/);assert.equal(h.calls.length,0);
 await h.lib.handleClick(action('cancel-delete'));assert.deepEqual(h.records,before);assert.equal(h.calls.length,0);assert.match(h.lib.html(),/library-panel/);
});

test('confirmation removes only its UUID, retains the library and refreshes results',async()=>{
 const h=harness({records:[record('draft-a'),record('draft-b'),record('protected',[{path:'archive.pdf'}])]});h.lib.open();await h.lib.handleClick(action('request-delete'));await h.lib.handleClick(action('confirm-delete'));
 assert.equal(h.calls.length,1);assert.equal(h.calls[0][0],'delete_draft');assert.equal(h.calls[0][1].id,'draft-a');assert.deepEqual(h.calls[0][1].expectedDraft,draft('draft-a'));assert.equal(h.lib.isOpen,true);assert.match(h.lib.html(),/library-panel/);assert.ok(h.records.some(r=>r.id==='draft-b'));assert.ok(h.records.some(r=>r.id==='protected'));assert.ok(h.records.every(r=>r.id!=='draft-a'));assert.equal(h.current.id,'blank');
});

test('failed save, stale content and newly exported PDF cannot pass the deletion confirmation',async()=>{
 const save=harness({flush:async()=>false});save.lib.open();await save.lib.handleClick(action('request-delete'));await save.lib.handleClick(action('confirm-delete'));assert.equal(save.calls.length,0);assert.match(save.lib.html(),/delete-dialog/);
 const stale=harness();stale.lib.open();await stale.lib.handleClick(action('request-delete'));stale.records=[{...record(),draft:{...draft(),project:'New title'}}];await stale.lib.handleClick(action('confirm-delete'));assert.equal(stale.calls.length,0);assert.match(stale.lib.html(),/New title/);assert.match(stale.notices.at(-1),/changé/);await stale.lib.handleClick(action('confirm-delete'));assert.equal(stale.calls.length,1);assert.equal(stale.calls[0][1].expectedDraft.project,'New title');
 const protectedNow=harness();protectedNow.lib.open();await protectedNow.lib.handleClick(action('request-delete'));protectedNow.records=[record('draft-a',[{path:'new.pdf'}])];await protectedNow.lib.handleClick(action('confirm-delete'));assert.equal(protectedNow.calls.length,0);assert.doesNotMatch(protectedNow.lib.html(),/delete-dialog/);
});

test('pending confirmation suppresses repeated clicks, while native failure keeps the confirmation usable',async()=>{
 let resolve;const blocked=new Promise(r=>resolve=r);const h=harness({flush:()=>blocked});h.lib.open();await h.lib.handleClick(action('request-delete'));const first=h.lib.handleClick(action('confirm-delete'));await h.lib.handleClick(action('confirm-delete'));assert.equal(h.calls.length,0);resolve(true);await first;assert.equal(h.calls.length,1);
 const failed=harness({transition:async()=>false});failed.lib.open();await failed.lib.handleClick(action('request-delete'));await failed.lib.handleClick(action('confirm-delete'));assert.match(failed.lib.html(),/delete-dialog/);assert.match(failed.lib.html(),/aria-busy="false"/);assert.equal(failed.records.length,1);
});

test('isolated mutations are caught for protected documents and destructive cancellation',async()=>{
 const url=new URL('../web/document-library.js',import.meta.url),source=await readFile(url,'utf8');
 const load=async raw=>import('data:text/javascript;base64,'+Buffer.from(raw.replace(/from '([^']+)'/g,(_,path)=>`from '${new URL(path,url).href}'`)).toString('base64'));
 const protection='!record.exports.length';assert.ok(source.includes(protection));const broken=await load(source.replace(protection,'true'));assert.throws(()=>assert.equal(broken.canDeleteDraft(record('pdf',[{path:'saved.pdf'}])),false),assert.AssertionError);
 const cancel="if (data.libraryAction === 'cancel-delete') { deletion = null;";assert.ok(source.includes(cancel));const wrongCancel=await load(source.replace(cancel,"if (data.libraryAction === 'cancel-delete') { await transition('delete_draft', {id:deletion.record.id}); deletion = null;"));const h=harness({},wrongCancel.createDocumentLibrary);h.lib.open();await h.lib.handleClick(action('request-delete'));await h.lib.handleClick(action('cancel-delete'));assert.throws(()=>assert.equal(h.calls.length,0),assert.AssertionError);
});
