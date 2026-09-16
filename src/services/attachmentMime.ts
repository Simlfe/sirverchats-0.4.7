/** Lightweight MIME/extension helpers kept free of image/GIF processing code. */

export const IMAGE_EXTS = ['.jpg', '.jpeg', '.png', '.gif', '.webp', '.svg', '.bmp', '.ico', '.heic', '.avif'];
export const VIDEO_EXTS = ['.mp4', '.webm', '.ogg', '.mov', '.m4v', '.mkv', '.avi', '.wmv', '.flv'];
export const AUDIO_EXTS = ['.mp3', '.wav', '.ogg', '.flac', '.m4a', '.aac', '.opus', '.wma'];
export const UNRENDERABLE_IMAGE_EXTS = ['.exr', '.hdr', '.psd', '.psb', '.tga', '.dds', '.cr2', '.nef', '.arw', '.dng', '.raf', '.orf', '.eps', '.ai', '.tiff', '.tif'];

export function inferMimeType(filename: string, existingType?: string): string {
  if (existingType && existingType !== 'application/octet-stream' && existingType !== 'binary/octet-stream') {
    return existingType;
  }
  const lower = (filename || '').toLowerCase();
  if (IMAGE_EXTS.some((ext) => lower.endsWith(ext))) {
    const ext = lower.split('.').pop();
    if (ext === 'svg') return 'image/svg+xml';
    if (ext === 'jpg' || ext === 'jpeg') return 'image/jpeg';
    if (ext === 'png') return 'image/png';
    if (ext === 'gif') return 'image/gif';
    if (ext === 'webp') return 'image/webp';
    return `image/${ext || 'png'}`;
  }
  if (VIDEO_EXTS.some((ext) => lower.endsWith(ext))) {
    const ext = lower.split('.').pop();
    if (ext === 'mp4' || ext === 'm4v') return 'video/mp4';
    if (ext === 'webm') return 'video/webm';
    if (ext === 'mov') return 'video/quicktime';
    return `video/${ext || 'mp4'}`;
  }
  if (AUDIO_EXTS.some((ext) => lower.endsWith(ext))) {
    const ext = lower.split('.').pop();
    if (ext === 'mp3') return 'audio/mpeg';
    if (ext === 'wav') return 'audio/wav';
    if (ext === 'ogg' || ext === 'opus') return 'audio/ogg';
    if (ext === 'm4a' || ext === 'aac') return 'audio/mp4';
    return `audio/${ext || 'mpeg'}`;
  }
  if (UNRENDERABLE_IMAGE_EXTS.some((ext) => lower.endsWith(ext))) {
    return 'image/x-unrenderable';
  }
  return existingType || 'application/octet-stream';
}
