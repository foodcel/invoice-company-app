import { createPdf } from './pdf.js';
import { renderSavedPdf } from './saved-pdf-preview.js';

let revision = 0, timer, current, key = '', completedKey = '', pending = false, lastPages = null;
export function updatePdfPreview(draft, options, incomplete = false) {
  const host = document.querySelector('[data-live-pdf]');
  if (!host) return;
  const next = JSON.stringify([draft, options, incomplete]);
  if (next === completedKey && lastPages) { key = next; revision++; clearTimeout(timer); pending = false; paint(host, lastPages, incomplete); return; }
  if (next === key && pending) return;
  key = next;
  pending = true;
  const token = ++revision;
  clearTimeout(timer);
  host.setAttribute('aria-busy', 'true');
  const status = document.querySelector('[data-page-status]');
  if (status) status.textContent = 'Mise à jour de l’aperçu…';
  timer = setTimeout(async () => {
    try {
      const bytes = await createPdf(draft, {...options, preview: true});
      if (token !== revision) return;
      const rendered = await renderSavedPdf(bytes, () => token === revision);
      if (token !== revision) { rendered.dispose(); return; }
      const target = document.querySelector('[data-live-pdf]');
      if (!target) { rendered.dispose(); return; }
      const previous = current;
      current = rendered; lastPages = rendered.pages; completedKey = next; pending = false;
      paint(target, lastPages, incomplete);
      previous?.dispose();
    } catch (error) {
      if (token !== revision) return;
      lastPages = null; completedKey = ''; pending = false;
      const target = document.querySelector('[data-live-pdf]');
      if (target) { target.replaceChildren(); target.setAttribute('aria-busy', 'false'); }
      const status = document.querySelector('[data-page-status]');
      if (status) { status.textContent = `Aperçu indisponible : ${error.message}`; status.hidden = false; }
    }
  }, 180);
}
function paint(host, pages, incomplete) {
  if (host.dataset.pagesKey !== pages.map(p => p.url).join('|')) {
    host.replaceChildren(...pages.map((page, index) => {
      const image = document.createElement('img');
      image.src = page.url; image.className = 'letter-pdf-page';
      image.alt = `Aperçu du document, page ${index + 1} sur ${pages.length}, format Lettre`;
      image.width = page.width; image.height = page.height;
      return image;
    }));
    host.dataset.pagesKey = pages.map(p => p.url).join('|');
  }
  host.setAttribute('aria-busy', 'false');
  const status = document.querySelector('[data-page-status]');
  if (status) {
    status.textContent = (pages.length > 1
      ? `Le contenu ne tient pas sur une seule page. ${pages.length} pages Lettre seront imprimées, sans couper le contenu.`
      : '1 page Lettre (8,5 × 11 po).') + (incomplete ? ' Aperçu provisoire : champs à compléter ou taxes à confirmer.' : '');
    status.classList.toggle('multiple-pages', pages.length > 1);
    status.hidden = pages.length === 1;
  }
}

// Printing uses in-memory document bytes; it neither exports nor archives them.
export async function printPdf(bytes) {
  const rendered = await renderSavedPdf(bytes, () => true, {print: true});
  document.getElementById('print-document')?.remove();
  const layer = document.createElement('div'); layer.id = 'print-document';
  for (const page of rendered.pages) {
    const image = document.createElement('img'); image.src = page.url;
    image.alt = ''; layer.append(image);
  }
  document.body.append(layer);
  const cleanup = () => { layer.remove(); rendered.dispose(); };
  try {
    await Promise.all([...layer.children].map(image => image.decode()));
    window.addEventListener('afterprint', cleanup, {once: true});
    window.print();
  } catch (error) { window.removeEventListener('afterprint', cleanup); cleanup(); throw error; }
}
