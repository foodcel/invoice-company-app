// One provider job at a time, with independent stable-row ownership.
export function createImprovementQueue({isCurrent,run,onResult,onStatus=()=>{},timeoutMs=60000}) {
  const jobs=[];let running=false,epoch=0;const watchers=new Set();
  const announce=()=>{onStatus();for(const notify of watchers)notify();};
  const state=documentId=>jobs.filter(j=>j.documentId===documentId&&j.epoch===epoch);
  const active=documentId=>state(documentId).filter(j=>['waiting','running'].includes(j.status));
  async function pump() {
    if(running)return;running=true;
    try {
      let job;
      while((job=jobs.find(j=>j.status==='waiting'))) {
        if(job.epoch!==epoch||!isCurrent(job)){job.status='stale';announce();continue;}
        job.status='running';announce();let timer;
        try {
          const text=await Promise.race([run(job),new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error('Amélioration trop longue. Réessayez cette ligne.')),timeoutMs);})]);
          if(job.status!=='running'||job.epoch!==epoch||!isCurrent(job)){job.status='stale';continue;}
          if(typeof text!=='string'||!text.trim())throw new Error('Aucune amélioration reçue.');
          job.result=text.trim();await onResult(job);job.status='done';
        }catch(error){job.status=job.status==='running'&&job.epoch===epoch&&isCurrent(job)?'error':'stale';job.error=String(error?.message||error);}
        finally{clearTimeout(timer);announce();}
      }
    }finally{running=false;announce();}
  }
  function enqueue({documentId,key,source}) {
    if(!source.trim())return false;
    if(active(documentId).some(j=>j.key===key&&j.source===source))return false;
    // A new click retries a failed row, without retaining an old error barrier.
    for(const previous of state(documentId).filter(j=>j.key===key&&j.status==='error'))previous.status='stale';
    jobs.push({documentId,key,source,epoch,status:'waiting',result:null,error:''});announce();void pump();return true;
  }
  function snapshot(documentId) {
    const current=state(documentId);return {jobs:current,pending:active(documentId).length,errors:current.filter(j=>j.status==='error'&&isCurrent(j)),done:current.filter(j=>j.status==='done')};
  }
  async function drain(documentId) {
    while(active(documentId).length)await new Promise(resolve=>{const done=()=>{watchers.delete(done);resolve();};watchers.add(done);});
    const failures=snapshot(documentId).errors;if(failures.length)throw new Error('Une amélioration IA a échoué. Recliquez sur les étoiles de la ligne pour réessayer.');
  }
  function cancel(documentId) {
    // Cancellation invalidates ownership, even if a provider reply arrives later.
    for(const job of state(documentId))if(['waiting','running','error'].includes(job.status))job.status='stale';
    announce();
  }
  return {enqueue,snapshot,drain,cancel};
}
