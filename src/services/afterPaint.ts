/** Schedule non-critical startup work after the first usable frame. */
export function afterFirstPaint(task: () => void): () => void {
  if (typeof window === 'undefined') return () => {};
  let cancelled = false;
  let firstFrame: number | null = null;
  let secondFrame: number | null = null;
  let fallbackTimer: number | null = null;
  const run = () => {
    if (!cancelled) task();
  };
  if (typeof window.requestAnimationFrame === 'function') {
    // The first callback runs before paint. The second animation-frame
    // boundary guarantees the browser had an opportunity to present the
    // initial UI before noncritical synchronous startup work begins.
    firstFrame = window.requestAnimationFrame(() => {
      if (!cancelled) secondFrame = window.requestAnimationFrame(run);
    });
  } else {
    fallbackTimer = window.setTimeout(run, 0);
  }
  return () => {
    cancelled = true;
    if (firstFrame !== null && typeof window.cancelAnimationFrame === 'function') {
      window.cancelAnimationFrame(firstFrame);
    }
    if (secondFrame !== null && typeof window.cancelAnimationFrame === 'function') {
      window.cancelAnimationFrame(secondFrame);
    }
    if (fallbackTimer !== null) window.clearTimeout(fallbackTimer);
  };
}
