import { getFileUrl } from '../pocketbase';
import { isLocalPreviewUrl } from './thumbnailPolicy';

/**
 * Return a URL that is safe to use in an attachment feed preview.
 *
 * A feed must never turn a remote original filename into an image request. If
 * a persisted thumbnail is unavailable, PocketBase's server-side thumb query
 * is used for legacy records; otherwise the caller receives an empty string
 * and can render a placeholder until the user explicitly opens the original.
 */
export function getAttachmentThumbnailUrl(record: any): string {
  if (!record) return '';

  const localPreview = record.url || record.previewUrl;
  if (isLocalPreviewUrl(localPreview)) return localPreview;

  const explicit = record.thumbnail;
  if (explicit) {
    if (/^(blob:|data:|https?:\/\/)/i.test(explicit)) return explicit;
    const collection =
      record.collectionName ||
      record['@collectionName'] ||
      (record.isPrivate ? 'private_attachments' : 'attachments');
    return record.id ? getFileUrl(collection, record.id, explicit) : '';
  }

  const id = record.id;
  const file = record.file;
  if (!id || !file) return '';
  if (isLocalPreviewUrl(file)) return file;
  // A fully-qualified file value is the original URL. Never request it from
  // the feed when the server did not provide a thumbnail.
  if (/^https?:\/\//i.test(file)) return '';

  const collection =
    record.collectionName ||
    record['@collectionName'] ||
    (record.isPrivate ? 'private_attachments' : 'attachments');
  return getFileUrl(collection, id, file, 'thumb=480x480f');
}
