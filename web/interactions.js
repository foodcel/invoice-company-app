const reduced = () => globalThis.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
const panels = root => [...root.querySelectorAll('[role="dialog"], .number-popover')];
const identity = panel => panel.getAttribute('aria-labelledby') || panel.getAttribute('aria-label') || panel.className;
const seen = new WeakSet();
const exitTasks = new Set();
const snapshotSheets = new WeakMap();

export function releaseAfterMotion(dispose) {
  if(typeof document==='undefined') {dispose();return;}
  queueMicrotask(()=>Promise.allSettled([...exitTasks]).then(dispose));
}

export function openPanelMotion(panel) {
  if (!panel || seen.has(panel)) return;
  seen.add(panel);
  if (!reduced()) panel.animate?.([
    { opacity:0, transform:'translateY(7px) scale(.985)' },
    { opacity:1, transform:'translateY(0) scale(1)' }
  ], { duration:180, easing:'cubic-bezier(.2,.8,.2,1)' });
}

// Keep the occupied space until the row has collapsed; never clone editor rows.
export async function collapseRowMotion(row) {
  if (!row?.isConnected || reduced() || !row.animate) return;
  const height = row.getBoundingClientRect().height;
  row.inert = true;
  row.style.overflow = 'hidden';
  try {
    await row.animate([
      {height:height+'px',opacity:1},
      {height:'0px',minHeight:'0px',paddingTop:'0px',paddingBottom:'0px',marginTop:'0px',marginBottom:'0px',opacity:0}
    ], {duration:150,easing:'cubic-bezier(.2,.7,.3,1)',fill:'forwards'}).finished;
  } catch { /* A render or reduced-motion change may finish the removal early. */ }
}

export function installInteractionMotion() {
  const preference=globalThis.matchMedia?.('(prefers-reduced-motion: reduce)');
  preference?.addEventListener('change',event=>{
    if(event.matches){for(const animation of document.getAnimations())animation.cancel();for(const host of document.querySelectorAll('[data-motion-exit]'))host.remove();}
  });
  document.addEventListener('click',event=>{
    const summary=event.target.closest?.('summary'),detail=summary?.parentElement;
    if(detail?.open && detail.closest('.app,.email-overlay'))for(const child of detail.children)if(child!==summary)closePanelMotion(child);
  },true);
  document.addEventListener('toggle',event=>{
    const detail=event.target;
    if(!detail.matches?.('details') || !detail.closest('.app,.email-overlay'))return;
    if(detail.open && detail.dataset.motionOpen!=='true')for(const child of detail.children)if(!child.matches('summary'))openPanelMotion(child);
    detail.dataset.motionOpen=String(detail.open);
  },true);
}

// A noninteractive shadow snapshot lets closing finish while the live controller
// immediately leaves that view. No duplicate selectors, focus targets or handlers.
export function closePanelMotion(panel) {
  if (!panel?.isConnected || reduced() || !panel.animate) return;
  const box = panel.getBoundingClientRect();
  if (!box.width || !box.height) return;
  const host = document.createElement('div');
  host.dataset.motionExit = panel.getAttribute('aria-modal') === 'true' ? 'modal' : 'panel';
  host.inert = true; host.setAttribute('aria-hidden','true');
  host.style.cssText = 'position:fixed;inset:0;pointer-events:none;z-index:10001';
  const shadow = host.attachShadow({mode:'closed'});
  const sheets=[];
  for(const original of document.styleSheets){
    let sheet=snapshotSheets.get(original);
    if(!sheet){sheet=new CSSStyleSheet();const css=[...original.cssRules].map(rule=>rule.cssText).join('\n').replace(/url\(["']?([^"')]+)["']?\)/g,(match,url)=>`url("${new URL(url,original.href||document.baseURI).href}")`);sheet.replaceSync(css);snapshotSheets.set(original,sheet);}
    sheets.push(sheet);
  }
  shadow.adoptedStyleSheets=sheets;
  const context = document.createElement('div');
  context.className = panel.closest('.email-overlay, .app')?.className || 'app v1';
  context.style.cssText = 'position:fixed;inset:0;background:transparent;border:0;border-radius:0;min-height:0;box-shadow:none;overflow:visible;pointer-events:none';
  const style = getComputedStyle(panel);
  context.style.font=style.font;
  for (const property of style) if (property.startsWith('--')) context.style.setProperty(property,style.getPropertyValue(property));
  const copy = panel.cloneNode(true);
  copy.style.cssText += `;position:fixed;margin:0;left:${box.x}px;top:${box.y}px;right:auto;bottom:auto;width:${box.width}px;height:${box.height}px;max-height:none;animation:none;pointer-events:none`;
  context.append(copy); shadow.append(context); document.body.append(host);
  const originalNodes=[panel,...panel.querySelectorAll('*')],copies=[copy,...copy.querySelectorAll('*')];
  for(let index=0;index<originalNodes.length;index++) { copies[index].scrollTop=originalNodes[index].scrollTop;copies[index].scrollLeft=originalNodes[index].scrollLeft;if(originalNodes[index].matches('input,textarea')) copies[index].value=originalNodes[index].value; }
  const animation = copy.animate([{opacity:1,transform:'translateY(0) scale(1)'},{opacity:0,transform:'translateY(5px) scale(.985)'}],{duration:130,easing:'ease-in',fill:'forwards'});
  const finished=animation.finished.catch(()=>{}).finally(()=>{host.remove();exitTasks.delete(finished);});
  exitTasks.add(finished);
}

// App dialogs use delegated events. Retain their shell on status/selection changes
// so async responses do not restart entrance motion or reset internal scrolling.
export function replaceAppMarkup(root, markup) {
  const previous = panels(root);
  const oldKeys = new Map(previous.map(panel => [identity(panel),panel]));
  const rowCounts = new Map(['.line-entry','.payment-entry','.notes-entry','.library-new-actions','.voice-recovery'].map(selector=>[selector,root.querySelectorAll(selector).length]));
  const focus = document.activeElement;
  const focusedKey = previous.find(panel=>panel.contains(focus));
  const focusId = focus?.id;
  const focusData = focus && [...focus.attributes].filter(attribute=>attribute.name.startsWith('data-') || ['name','aria-label'].includes(attribute.name));
  const focusSelection = focus && typeof focus.selectionStart==='number' ? [focus.selectionStart,focus.selectionEnd,focus.selectionDirection] : null;
  const scrollSelectors='.settings-body,.history-body,.library-body,.large-paper-scroll,.version-list,.library-list,.recent-list';
  const scroll = new Map(previous.flatMap(panel=>[...panel.querySelectorAll(scrollSelectors)].map((el,index)=>[identity(panel)+'|'+index,[el.scrollTop,el.scrollLeft]])));
  const disclosures = new Map(previous.map(panel=>[identity(panel),[...panel.querySelectorAll('details')].map(el=>el.open)]));
  // Snapshot before detaching, but only when a panel is truly leaving this view.
  const template = document.createElement('template'); template.innerHTML = markup;
  const nextKeys = new Set(panels(template.content).map(identity));
  for (const panel of previous) if (!nextKeys.has(identity(panel))) closePanelMotion(panel);
  for (const [selector,count] of rowCounts) if(selector==='.library-new-actions')for(const el of [...root.querySelectorAll(selector)].slice(template.content.querySelectorAll(selector).length,count))closePanelMotion(el);
  root.replaceChildren(template.content);
  for (const panel of panels(root)) {
    const old = oldKeys.get(identity(panel));
    if (old && !panel.classList.contains('date-popover')) {
      const fields=[...old.querySelectorAll('input,textarea')].map(el=>({id:el.id,type:el.type,value:el.value,defaultValue:el.defaultValue,checked:el.checked,defaultChecked:el.defaultChecked}));
      for (const attr of [...old.attributes]) if (!panel.hasAttribute(attr.name)) old.removeAttribute(attr.name);
      for (const attr of panel.attributes) old.setAttribute(attr.name,attr.value);
      old.innerHTML = panel.innerHTML;
      panel.replaceWith(old);
      if(old.getAttribute('aria-modal')==='true')old.tabIndex=-1;
      [...old.querySelectorAll('input,textarea')].forEach((el,index)=>{const before=fields[index];if(before && before.id===el.id && before.type===el.type && before.defaultValue===el.defaultValue){el.value=before.value;if(before.defaultChecked===el.defaultChecked)el.checked=before.checked;}});
      [...old.querySelectorAll('details')].forEach((el,index)=>{el.open=disclosures.get(identity(old))?.[index]||false;el.dataset.motionOpen=String(el.open);});
      [...old.querySelectorAll(scrollSelectors)].forEach((el,index)=>{const position=scroll.get(identity(old)+'|'+index);if(position){el.scrollTop=position[0];el.scrollLeft=position[1];}});
      if (focusedKey === old) {
        const replacement = focus===old ? old : focusId ? old.querySelector('#'+CSS.escape(focusId)) : focusData?.length ? [...old.querySelectorAll(focus.tagName)].find(el=>focusData.every(attr=>el.getAttribute(attr.name)===attr.value)) : focus?.matches('summary') ? old.querySelector('summary') : null;
        (replacement && !replacement.disabled && !replacement.closest('[hidden],[inert]') ? replacement : old).focus({preventScroll:true});
        if(replacement && focusSelection) replacement.setSelectionRange?.(...focusSelection);
      }
    } else if (!old) {openPanelMotion(panel);if(panel.getAttribute('aria-modal')==='true'){panel.tabIndex=-1;panel.focus({preventScroll:true});}}
  }
  for (const [selector,count] of rowCounts) for (const el of [...root.querySelectorAll(selector)].slice(count)) openPanelMotion(el);
}
