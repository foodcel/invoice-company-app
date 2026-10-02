// Keep correction provenance separate from ordinary edits. No whole-draft restore.
const tokens = text => String(text).match(/[\p{L}\p{N}]+|\s+|[^\p{L}\p{N}\s]/gu) || [];
export function textEdits(before, after) {
  const a=tokens(before), b=tokens(after), n=a.length, m=b.length;
  let v=new Map([[1,0]]), trace=[], steps;
  outer: for(let d=0;d<=n+m;d++) {
    trace.push(new Map(v));
    for(let k=-d;k<=d;k+=2) {
      let x=k===-d || (k!==d && (v.get(k-1)??-1)<(v.get(k+1)??-1)) ? v.get(k+1)??0 : (v.get(k-1)??0)+1;
      let y=x-k;
      while(x<n&&y<m&&a[x]===b[y]){x++;y++;}
      v.set(k,x);
      if(x>=n&&y>=m) {
        steps=[];
        for(let depth=trace.length-1;depth>=0;depth--) {
          const previous=trace[depth], diagonal=x-y;
          const previousK=diagonal===-depth || (diagonal!==depth&&(previous.get(diagonal-1)??-1)<(previous.get(diagonal+1)??-1)) ? diagonal+1 : diagonal-1;
          const px=previous.get(previousK)??0, py=px-previousK;
          while(x>px&&y>py){steps.push(['same',a[x-1]]);x--;y--;}
          if(depth>0){if(x===px){steps.push(['add',b[y-1]]);y--;}else{steps.push(['remove',a[x-1]]);x--;}}
        }
        steps.reverse();break outer;
      }
    }
  }
  const edits=[];let position=0,pending;
  for(const [kind,text]of steps) {
    if(kind==='same'){if(pending){edits.push(pending);pending=null;}position+=text.length;}
    else {pending ||= {start:position,end:position,before:'',after:''};
      if(kind==='remove'){pending.before+=text;position+=text.length;pending.end=position;}else pending.after+=text;}
  }
  if(pending)edits.push(pending);
  return edits;
}
function ownership(before,after){let offset=0;return textEdits(before,after).map(e=>{const p={start:e.start+offset,before:e.before,after:e.after};offset+=e.after.length-e.before.length;return p;});}
function reverseOwned(text,patches) {
  for(const patch of [...patches].sort((a,b)=>b.start-a.start)) {
    if(text.slice(patch.start,patch.start+patch.after.length)===patch.after)
      text=text.slice(0,patch.start)+patch.before+text.slice(patch.start+patch.after.length);
  }
  return text;
}
function rebaseOwned(patches,edits) {
  return patches.flatMap(p=>{
    let shift=0;const end=p.start+p.after.length;
    for(const e of edits) {
      const insertion=e.start===e.end;
      const overlaps=insertion ? e.start>p.start&&e.start<end : e.start<end&&e.end>p.start;
      if(overlaps || (!p.after.length&&e.start<=p.start&&e.end>p.start))return [];
      if(e.end<=p.start)shift+=e.after.length-e.before.length;
    }
    return [{...p,start:p.start+shift}];
  });
}
export function createAutomaticCorrections({getDocumentId,getFields,write,proofread,onChange=()=>{},onStatus=()=>{},timeoutMs=45000}) {
  const documents=new Map();let generation=0;
  const entries=()=>{
    const id=getDocumentId();let fields=documents.get(id);if(!fields){fields=new Map();documents.set(id,fields);}return fields;
  };
  function observe(key,text) {
    const fields=entries();let entry=fields.get(key);
    if(!entry){entry={text,patches:[],revision:0,checked:null,pending:null,error:''};fields.set(key,entry);}
    else if(entry.text!==text){entry.patches=rebaseOwned(entry.patches,textEdits(entry.text,text));entry.text=text;entry.revision++;entry.checked=null;entry.error='';}
    return entry;
  }
  function reconcile(){const fields=getFields();for(const f of fields)observe(f.key,f.text);return fields;}
  function snapshot(){const fields=reconcile(),map=entries();return {pending:fields.filter(f=>map.get(f.key)?.pending).length,errors:fields.filter(f=>map.get(f.key)?.error).length,undoable:fields.some(f=>map.get(f.key)?.patches.length)};}
  const announce=()=>onStatus(snapshot());
  async function schedule(key) {
    const fields=reconcile(),field=fields.find(f=>f.key===key);if(!field)return;
    const entry=observe(key,field.text);
    if(!field.text.trim()){entry.checked=field.text;entry.error='';return;}
    if(entry.checked===field.text)return;
    if(entry.pending?.source===field.text)return entry.pending.promise;
    const source=field.text,revision=entry.revision,docId=getDocumentId(),epoch=generation;
    let timer;const pending={source,promise:null};entry.pending=pending;entry.error='';
    pending.promise=(async()=>{
      // Yield before provider invocation so pending ownership is established.
      await Promise.resolve();
      try {
        const corrected=await Promise.race([proofread(source),new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error('La correction prend trop de temps. Réessayez.')),timeoutMs);})]);
        const live=getDocumentId()===docId&&getFields().find(f=>f.key===key);
        if(epoch!==generation||!live||live.text!==source||entry.revision!==revision)return;
        if(typeof corrected!=='string'||!corrected.trim())throw new Error('La correction reçue est vide.');
        const numbers=t=>(t.match(/\d+(?:[.,]\d+)?/g)||[]).join('|');
        if(numbers(source)!==numbers(corrected))throw new Error('La correction a modifié un nombre; le texte original est conservé.');
        if(corrected!==source) {
          const manual=reverseOwned(source,entry.patches);
          entry.patches=ownership(manual,corrected);entry.text=corrected;
          write(key,corrected);onChange();
        }
        entry.checked=corrected;entry.error='';
      } catch(error) {
        if(epoch===generation&&getDocumentId()===docId&&getFields().some(f=>f.key===key&&f.text===source)&&entry.revision===revision)
          entry.error=String(error?.message||error);
      } finally {clearTimeout(timer);if(entry.pending===pending)entry.pending=null;announce();}
    })();
    announce();return pending.promise;
  }
  async function ensureAll() {
    const docId=getDocumentId();
    for(let attempt=0;attempt<8;attempt++) {
      const fields=reconcile();
      // Serial requests bound provider work and keep failures actionable.
      for(const field of fields) {
        if(getDocumentId()!==docId)throw new Error('Le document a changé. Réessayez sur le document ouvert.');
        await schedule(field.key);
        const entry=entries().get(field.key);
        if(entry?.error)throw new Error(`Correction indisponible : ${entry.error}`);
      }
      if(getDocumentId()!==docId)throw new Error('Le document a changé.');
      const latest=reconcile();
      if(latest.every(f=>!f.text.trim()||entries().get(f.key)?.checked===f.text))return true;
    }
    throw new Error('Le texte change encore. Terminez la saisie avant de continuer.');
  }
  function undoAll() {
    generation++;let count=0;
    for(const field of reconcile()) {
      const entry=entries().get(field.key);const text=reverseOwned(field.text,entry.patches);
      if(text!==field.text){write(field.key,text);count++;}
      entry.text=text;entry.patches=[];entry.checked=text;entry.error='';entry.revision++;entry.pending=null;
    }
    if(count)onChange();announce();return count;
  }
  function applyImprovement(key,source,text) {
    const field=reconcile().find(f=>f.key===key);if(!field||field.text!==source)return false;
    if(typeof text!=='string'||!text.trim())throw new Error('Aucune amélioration reçue.');
    const numbers=t=>(t.match(/\d+(?:[.,]\d+)?/g)||[]).join('|');
    if(numbers(source)!==numbers(text))throw new Error('L’amélioration a modifié un nombre; le texte original est conservé.');
    const entry=observe(key,source),manual=reverseOwned(source,entry.patches);
    entry.patches=ownership(manual,text);entry.text=text;entry.revision++;entry.checked=text;entry.error='';
    write(key,text);onChange();announce();return true;
  }
  function supersede(key){const field=reconcile().find(f=>f.key===key);if(!field)return;const entry=observe(key,field.text);entry.revision++;entry.pending=null;entry.error='';announce();}
  return {observe,schedule,ensureAll,undoAll,snapshot,reconcile,applyImprovement,supersede};
}
