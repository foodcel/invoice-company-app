// Dialogs own their scrolling; keep the underlying document at the same position.
export function installModalScrollLock(doc = document) {
  const view = doc.defaultView;
  let locked = false, position = null, previousTop = '';
  function update() {
    const modal = Boolean(doc.querySelector('[role="dialog"][aria-modal="true"], [data-motion-exit="modal"]'));
    if (modal === locked) return;
    locked = modal;
    if (modal) {
      position = { x: view.scrollX, y: view.scrollY };
      previousTop = doc.body.style.getPropertyValue('--modal-scroll-top');
      doc.body.style.setProperty('--modal-scroll-top', `${-position.y}px`);
      doc.documentElement.classList.add('modal-open');
    } else {
      doc.documentElement.classList.remove('modal-open');
      if (previousTop) doc.body.style.setProperty('--modal-scroll-top', previousTop);
      else doc.body.style.removeProperty('--modal-scroll-top');
      view.scrollTo(position.x, position.y);
      position = null;
    }
  }
  const observer = new MutationObserver(update);
  observer.observe(doc.body, { childList: true, subtree: true });
  update();
  return () => {
    observer.disconnect();
    if (locked) {
      doc.documentElement.classList.remove('modal-open');
      if (previousTop) doc.body.style.setProperty('--modal-scroll-top', previousTop);
      else doc.body.style.removeProperty('--modal-scroll-top');
      view.scrollTo(position.x, position.y);
    }
  };
}
