/** Schedule non-critical startup work after the first usable frame. */
export function afterFirstPaint(task: () => void): () => void {
  if (typeof window === 'undefined') return () => {};
  let cancelled = false;
  const run = () => {
    if (!cancelled) task();
  };
  const raf = typeof window.requestAnimationFrame === 'function'
    ? window.requestAnimationFrame(run)
    : window.setTimeout(run, 0);
  return () => {
    cancelled = true;
    if (typeof raf === 'number' && typeof window.cancelAnimationFrame === 'function') {
      window.cancelAnimationFrame(raf);
    } else {
      window.clearTimeout(raf as number);
    }
  };
}
