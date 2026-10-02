// Screen paper uses Letter geometry; form height does not affect it.
export function attachPreviewLayout(root) {
  const page = root.querySelector('.preview-page');
  const historyFrame = root.querySelector('.history-paper');
  const historySheet = historyFrame?.querySelector('.library-detail-paper');
  if (!page) return () => {};
  let frame = 0;
  const align = () => {
    if (historySheet?.offsetHeight > 0) {
      const scale = Math.min(historyFrame.clientWidth / 680, historyFrame.clientHeight / Math.min(historySheet.offsetHeight, 1000));
      if (scale > 0) historySheet.style.zoom = String(scale);
    }
  };
  const schedule = () => { cancelAnimationFrame(frame); frame = requestAnimationFrame(align); };
  const observer = new ResizeObserver(schedule);
  observer.observe(page);
  if (historyFrame) observer.observe(historyFrame);
  if (historySheet) observer.observe(historySheet);
  const content = new MutationObserver(schedule);
  content.observe(page, { childList:true, subtree:true, characterData:true });
  align();
  return () => { observer.disconnect(); content.disconnect(); cancelAnimationFrame(frame); };
}
