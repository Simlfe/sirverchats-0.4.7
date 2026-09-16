/** Pure attachment preview policy shared by the feed and instrumentation. */

export function isRemoteUrl(value: string | undefined | null): boolean {
  return Boolean(value && /^https?:\/\//i.test(value));
}

export function isLocalPreviewUrl(value: string | undefined | null): boolean {
  return Boolean(value && /^(?:blob:|data:)/i.test(value));
}

/**
 * Feed code must never use a remote original as a preview.  Local blob/data
 * URLs are safe because they are generated from a file the user already chose.
 */
export function isOriginalFeedUrl(url: string | undefined | null, originalUrl: string | undefined | null): boolean {
  if (!url || !originalUrl || url !== originalUrl) return false;
  return isRemoteUrl(url) && !/[?&]thumb=/i.test(url);
}

export function chooseFeedPreview(explicitThumbnail: string | undefined | null, generatedThumbnail: string | undefined | null): string {
  if (explicitThumbnail) return explicitThumbnail;
  if (generatedThumbnail && (isLocalPreviewUrl(generatedThumbnail) || /[?&]thumb=/i.test(generatedThumbnail))) return generatedThumbnail;
  return '';
}
