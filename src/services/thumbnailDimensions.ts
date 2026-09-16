/** Pure sizing helper kept free of browser and application-singleton imports. */
export function calculateThumbnailDimensions(
  sourceWidth: number,
  sourceHeight: number,
  maxDim = 480,
): { width: number; height: number } {
  const safeWidth = Math.max(1, Math.round(sourceWidth || 1));
  const safeHeight = Math.max(1, Math.round(sourceHeight || 1));
  const safeMax = Math.max(1, Math.round(maxDim || 480));
  const scale = Math.min(1, safeMax / safeWidth, safeMax / safeHeight);
  return {
    width: Math.max(1, Math.round(safeWidth * scale)),
    height: Math.max(1, Math.round(safeHeight * scale)),
  };
}
