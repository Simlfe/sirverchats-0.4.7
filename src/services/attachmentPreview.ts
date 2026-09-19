import { getAttachmentCollectionName, getFileUrl } from '../pocketbase';
import { isLocalPreviewUrl } from './thumbnailPolicy';
import { isAttachmentImage, isAttachmentVideo } from './attachmentProcessor';

/**
 * Return a URL that is safe to use in an attachment feed preview.
 *
 * A feed must never turn a remote original filename into an image request. If
 * a persisted thumbnail is unavailable, PocketBase's server-side thumb query
 * is used for legacy image/video records; otherwise the caller receives an empty string
 * and can render a placeholder until the user explicitly opens the original.
 */
export function getAttachmentThumbnailUrl(record: any): string {
  if (!record) return '';

  const localPreview = record.url || record.previewUrl;
  if (isLocalPreviewUrl(localPreview)) return localPreview;

  const explicit = record.thumbnail;
  if (explicit) {
    if (/^(blob:|data:|https?:\/\/)/i.test(explicit)) return explicit;
    const collection = getAttachmentCollectionName(record, Boolean(record.isPrivate));
    return record.id ? getFileUrl(collection, record.id, explicit) : '';
  }

  const id = record.id;
  const file = record.file;
  if (!id || !file) return '';
  if (isLocalPreviewUrl(file)) return file;
  // If file is already a fully qualified URL, return it directly
  if (/^https?:\/\//i.test(file)) return file;

  const collection = getAttachmentCollectionName(record, Boolean(record.isPrivate));

  // Return thumbnail URL for image and video formats
  const fileType = record.type || record.mime || record.thumbnail_mime || '';
  const isImgOrVid = isAttachmentImage(file, fileType) || isAttachmentVideo(file, fileType);
  if (isImgOrVid) {
    return getFileUrl(collection, id, file, 'thumb=480x480f');
  }

  return '';
}
