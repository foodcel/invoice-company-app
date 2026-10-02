let open = null;
function close() {
  if (!open) return;
  open.list.hidden = true; open.button.setAttribute('aria-expanded', 'false'); open = null;
}
document.addEventListener('pointerdown', e => { if (open && !open.wrap.contains(e.target)) close(); });
document.addEventListener('keydown', e => { if (open && e.key === 'Escape') { e.preventDefault(); e.stopImmediatePropagation(); const button = open.button; close(); button.focus(); } });

export function enhanceSelects(root) {
  if (open && !open.wrap.isConnected) close();
  for (const select of root.querySelectorAll('select')) {
    if (select.closest('.integrated-select')) {
      select.closest('.integrated-select').querySelector('.select-trigger').firstChild.textContent = select.selectedOptions[0]?.textContent || '';
      continue;
    }
    const wrap = document.createElement('div'); wrap.className = 'integrated-select';
    const button = document.createElement('button'); button.type = 'button'; button.className = 'select-trigger';
    const label = select.getAttribute('aria-label') || select.closest('label')?.firstChild?.textContent.trim() || 'Choisir une option';
    button.setAttribute('aria-label', label); button.setAttribute('aria-haspopup', 'listbox'); button.setAttribute('aria-expanded', 'false');
    const text = document.createElement('span'); text.textContent = select.selectedOptions[0]?.textContent || '';
    button.append(text);
    const arrow = document.createElement('span'); arrow.className = 'select-chevron'; arrow.setAttribute('aria-hidden', 'true'); button.append(arrow);
    const list = document.createElement('div'); list.className = 'select-options'; list.setAttribute('role', 'listbox'); list.setAttribute('aria-label', label); list.hidden = true;
    select.before(wrap); wrap.append(select, button, list); select.tabIndex = -1;
    const choose = index => {
      const option = select.options[index]; if (!option || option.disabled) return;
      select.value = option.value; text.textContent = option.textContent; close(); button.focus();
      select.dispatchEvent(new Event('change', {bubbles: true}));
    };
    const show = () => {
      close(); list.replaceChildren(...[...select.options].map((option, index) => {
        const item = document.createElement('button'); item.type = 'button'; item.setAttribute('role', 'option'); item.textContent = option.textContent;
        item.setAttribute('aria-selected', String(index === select.selectedIndex)); item.disabled = option.disabled;
        item.addEventListener('click', () => choose(index)); return item;
      }));
      list.hidden = false; button.setAttribute('aria-expanded', 'true'); open = {wrap, button, list};
      list.children[Math.max(0, select.selectedIndex)]?.focus({preventScroll: true});
      list.children[Math.max(0, select.selectedIndex)]?.scrollIntoView({block: 'nearest'});
    };
    button.addEventListener('click', () => { if (open?.wrap === wrap) close(); else show(); });
    button.addEventListener('keydown', e => { if (['ArrowDown','ArrowUp','Home','End'].includes(e.key)) {e.preventDefault(); show();} });
    let search = '', searchTimer;
    list.addEventListener('keydown', e => {
      const index = [...list.children].indexOf(document.activeElement);
      let target = index;
      if (e.key === 'ArrowDown') target = Math.min(select.options.length - 1, index + 1);
      else if (e.key === 'ArrowUp') target = Math.max(0, index - 1);
      else if (e.key === 'Home') target = 0;
      else if (e.key === 'End') target = select.options.length - 1;
      else if (e.key === 'Tab') {close(); return;}
      else if (e.key.length === 1 && e.key !== ' ') {
        clearTimeout(searchTimer); search += e.key.toLocaleLowerCase(); searchTimer = setTimeout(() => search = '', 700);
        const found = [...select.options].findIndex(option => option.textContent.toLocaleLowerCase().startsWith(search));
        if (found >= 0) target = found;
      } else return;
      e.preventDefault(); list.children[target]?.focus();
    });
    select.addEventListener('focus', () => button.focus());
    select.addEventListener('change', () => { text.textContent = select.selectedOptions[0]?.textContent || ''; });
  }
}
