/** Lightweight MIME/extension helpers kept free of image/GIF processing code. */

export const IMAGE_EXTS = ['.jpg', '.jpeg', '.png', '.gif', '.webp', '.svg', '.bmp', '.ico', '.heic', '.avif'];
export const VIDEO_EXTS = ['.mp4', '.webm', '.ogg', '.mov', '.m4v', '.mkv', '.avi', '.wmv', '.flv'];
export const AUDIO_EXTS = ['.mp3', '.wav', '.ogg', '.flac', '.m4a', '.aac', '.opus', '.wma'];
export const UNRENDERABLE_IMAGE_EXTS = ['.exr', '.hdr', '.psd', '.psb', '.tga', '.dds', '.cr2', '.nef', '.arw', '.dng', '.raf', '.orf', '.eps', '.ai', '.tiff', '.tif'];

const MIME_ALIASES: Record<string, string> = {
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  jpe: 'image/jpeg',
  png: 'image/png',
  gif: 'image/gif',
  webp: 'image/webp',
  svg: 'image/svg+xml',
  bmp: 'image/bmp',
  ico: 'image/x-icon',
  heic: 'image/heic',
  heif: 'image/heif',
  avif: 'image/avif',
  // These formats intentionally remain non-previewable in the app.
  tiff: 'image/x-unrenderable',
  tif: 'image/x-unrenderable',
  exr: 'image/x-unrenderable',
  hdr: 'image/x-unrenderable',
  psd: 'image/x-unrenderable',
  psb: 'image/x-unrenderable',
  tga: 'image/x-unrenderable',
  dds: 'image/x-unrenderable',
  cr2: 'image/x-unrenderable',
  nef: 'image/x-unrenderable',
  arw: 'image/x-unrenderable',
  dng: 'image/x-unrenderable',
  raf: 'image/x-unrenderable',
  orf: 'image/x-unrenderable',
  eps: 'image/x-unrenderable',
  ai: 'image/x-unrenderable',
  mp4: 'video/mp4',
  m4v: 'video/mp4',
  webm: 'video/webm',
  mov: 'video/quicktime',
  mkv: 'video/x-matroska',
  avi: 'video/x-msvideo',
  wmv: 'video/x-ms-wmv',
  flv: 'video/x-flv',
  mp3: 'audio/mpeg',
  wav: 'audio/wav',
  ogg: 'audio/ogg',
  opus: 'audio/ogg',
  flac: 'audio/flac',
  m4a: 'audio/mp4',
  aac: 'audio/aac',
  wma: 'audio/x-ms-wma',
};

function mimeFromFilename(filename: string): string | undefined {
  const lower = (filename || '').toLowerCase();
  const extension = lower.match(/\.([a-z0-9]+)(?:$|[?#])/i)?.[1];
  if (!extension) return undefined;
  return MIME_ALIASES[extension];
}

function normalizeExistingMimeType(existingType?: string): string | undefined {
  const raw = String(existingType || '').trim().toLowerCase();
  if (!raw || raw === 'application/octet-stream' || raw === 'binary/octet-stream') {
    return undefined;
  }

  const mime = raw.split(';', 1)[0].trim();
  // Older attachment records stored the extension/label (for example
  // `webp`) instead of a MIME type. Treat that value as a MIME alias rather
  // than allowing it to make a valid image look like a generic document.
  if (MIME_ALIASES[mime.replace(/^\./, '')]) {
    return MIME_ALIASES[mime.replace(/^\./, '')];
  }

  // Keep real MIME values, but reject arbitrary labels such as `WEBP`,
  // `image`, or `file` that are not useful to media detection.
  if (/^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+*-]+$/i.test(mime)) {
    return mime;
  }
  return undefined;
}

export function inferMimeType(filename: string, existingType?: string): string {
  return normalizeExistingMimeType(existingType) || mimeFromFilename(filename) || 'application/octet-stream';
}
