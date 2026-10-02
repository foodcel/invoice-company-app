import {createPdf} from './pdf.js';
import {releaseAfterMotion} from './interactions.js';

const cache=new Map();let observer,queue=[],running=0;
const escape=value=>String(value).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'})[c]);
export const draftPreview=draft=>`<div class="library-draft-preview" data-library-draft="${escape(JSON.stringify(draft))}" aria-busy="true"><span class="library-preview-loading">Chargement de l’aperçu…</span></div>`;

function paint(entry,host) {
 if(!host.isConnected)return;
 if(entry.error) {host.textContent='Aperçu indisponible.';host.setAttribute('aria-busy','false');return;}
 if(!entry.result)return;
 const images=entry.result.pages.map((page,index)=>{const img=document.createElement('img');img.src=page.url;img.width=page.width;img.height=page.height;img.alt=`Page ${index+1} sur ${entry.result.pageCount}, format Lettre`;return img;});
 host.replaceChildren(...images);host.dataset.pageCount=String(entry.result.pageCount);host.setAttribute('aria-busy','false');
 const button=host.closest('.library-paper');
 if(button) {
  const note=button.nextElementSibling?.classList.contains('library-preview-count')?button.nextElementSibling:document.createElement('small');
  note.className='library-preview-count';note.textContent=entry.result.pageCount>1?`Page 1 sur ${entry.result.pageCount} — cliquez pour voir toutes les pages.`:'';note.hidden=entry.result.pageCount===1;button.after(note);
 }
}
function pump() {
 while(running<2&&queue.length) {
  const entry=queue.shift();if(cache.get(entry.key)!==entry)continue;
  running++;
  (async()=>{
   try {
    const bytes=await createPdf(entry.draft,{preview:true,invoiceNumber:entry.draft.issuedNumber??entry.draft.invoiceNumber});
    if(cache.get(entry.key)!==entry)return;
    const {renderSavedPdf}=await import('./saved-pdf-preview.js');
    const result=await renderSavedPdf(bytes,()=>cache.get(entry.key)===entry,{firstPageOnly:!entry.full});
    if(cache.get(entry.key)!==entry){result.dispose();return;}entry.result=result;
   }catch(error){if(cache.get(entry.key)===entry)entry.error=error.message;}
   finally {for(const host of entry.hosts)paint(entry,host);running--;pump();}
  })();
 }
}
export function hydrateLibraryPreviews(root) {
 observer?.disconnect();for(const entry of cache.values())entry.hosts.clear();
 const entries=new Map();
 for(const host of root.querySelectorAll('[data-library-draft]')) {
  const full=Boolean(host.closest('.library-full-paper,.history-paper'));
  host.classList.toggle('library-draft-pages',full);
  const raw=host.getAttribute('data-library-draft'),key=`${full}:${raw}`;
  let entry=cache.get(key);if(!entry){entry={key,full,draft:JSON.parse(raw),hosts:new Set()};cache.set(key,entry);}
  entry.hosts.add(host);entries.set(host,entry);paint(entry,host);
 }
 for(const [key,entry] of cache)if(!entry.hosts.size){cache.delete(key);if(entry.result)releaseAfterMotion(entry.result.dispose);}
 queue=queue.filter(entry=>cache.get(entry.key)===entry);
 observer=new IntersectionObserver(changes=>{
  for(const change of changes.filter(c=>c.isIntersecting).sort((a,b)=>Number(Boolean(a.target.closest('.library-thumbnail')))-Number(Boolean(b.target.closest('.library-thumbnail'))))) {
   const entry=entries.get(change.target);if(!entry||entry.requested)continue;entry.requested=true;queue.push(entry);
  }pump();
 });
 for(const host of entries.keys())observer.observe(host);
}
