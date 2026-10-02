import { getDocument, GlobalWorkerOptions } from 'pdfjs-dist/build/pdf.mjs';
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';

GlobalWorkerOptions.workerSrc = workerUrl;
const assets = Object.fromEntries(Object.entries(import.meta.glob([
  '../node_modules/pdfjs-dist/standard_fonts/*.{pfb,ttf}',
  '../node_modules/pdfjs-dist/cmaps/*.bcmap',
  '../node_modules/pdfjs-dist/wasm/*.wasm'
], {eager:true,query:'?url',import:'default'})).map(([path,url])=>[path.split('/').at(-1),url]));

class BundledDataFactory {
  async fetch({filename}) {
    if (!assets[filename]) throw new Error('Ressource PDF indisponible : '+filename);
    const response = await fetch(assets[filename]);
    if (!response.ok) throw new Error('Impossible de charger une ressource PDF.');
    return new Uint8Array(await response.arrayBuffer());
  }
}

// Render the archive itself, including its saved language and pagination. No
// browser PDF viewer, remote service, executable PDF actions or draft replacement.
export async function renderSavedPdf(bytes, isCurrent = () => true, { print = false, firstPageOnly = false } = {}) {
  const pages = [];
  const dispose = () => { for (const page of pages) URL.revokeObjectURL(page.url); };
  const task = getDocument({data:bytes.slice(),useWorkerFetch:false,BinaryDataFactory:BundledDataFactory,
    useSystemFonts:false,isEvalSupported:false,enableXfa:false});
  try {
    const pdf = await task.promise;
    for (let index=1; index<=(firstPageOnly?Math.min(1,pdf.numPages):pdf.numPages); index++) {
      if (!isCurrent()) throw new Error('Aperçu remplacé.');
      const page = await pdf.getPage(index);
      const base = page.getViewport({scale:1});
      const viewport = page.getViewport({scale:print ? 300/72 : Math.min(1200/base.width,1800/base.height)});
      const canvas = document.createElement('canvas');
      canvas.width=Math.ceil(viewport.width); canvas.height=Math.ceil(viewport.height);
      await page.render({canvasContext:canvas.getContext('2d'),viewport,background:'#ffffff'}).promise;
      const blob = await new Promise(resolve=>canvas.toBlob(resolve,'image/png'));
      if (!blob) throw new Error('Impossible de générer l’aperçu du PDF.');
      pages.push({url:URL.createObjectURL(blob),width:canvas.width,height:canvas.height});
      canvas.width=0; canvas.height=0; page.cleanup();
    }
    if (!isCurrent()) throw new Error('Aperçu remplacé.');
    return {pages,pageCount:pdf.numPages,dispose};
  } catch (error) { dispose(); throw error; }
  finally { await task.destroy(); }
}
