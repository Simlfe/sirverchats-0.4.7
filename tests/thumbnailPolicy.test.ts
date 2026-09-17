import test from 'node:test';
import assert from 'node:assert/strict';
import { chooseFeedPreview, isOriginalFeedUrl } from '../src/services/thumbnailPolicy';
import { calculateThumbnailDimensions } from '../src/services/thumbnailDimensions';
import { getAttachmentThumbnailUrl } from '../src/services/attachmentPreview';

test('feed policy rejects a remote original URL', () => {
  const original = 'https://api.sirverdata.top/api/files/attachments/a/photo.jpg';
  assert.equal(isOriginalFeedUrl(original, original), true);
  assert.equal(isOriginalFeedUrl(`${original}?thumb=480x480f`, original), false);
  assert.equal(isOriginalFeedUrl('blob:http://localhost/preview', original), false);
});

test('feed preview selection never falls back to the original', () => {
  assert.equal(chooseFeedPreview('', ''), '');
  assert.equal(chooseFeedPreview('', 'https://api.example/file.jpg'), '');
  assert.equal(chooseFeedPreview('', 'https://api.example/file.jpg?thumb=480x480f'), 'https://api.example/file.jpg?thumb=480x480f');
  assert.equal(chooseFeedPreview('', 'blob:http://localhost/preview'), 'blob:http://localhost/preview');
});

test('thumbnail dimensions are bounded without upscaling', () => {
  assert.deepEqual(calculateThumbnailDimensions(4000, 2000, 480), { width: 480, height: 240 });
  assert.deepEqual(calculateThumbnailDimensions(120, 80, 480), { width: 120, height: 80 });
  assert.ok(calculateThumbnailDimensions(8192, 8192, 480).width <= 480);
});

test('getAttachmentThumbnailUrl normalizes messages collection and gates non-media files', () => {
  // Non-image/non-video returns empty string
  assert.equal(
    getAttachmentThumbnailUrl({
      id: 'doc123',
      file: 'project.zip',
      type: 'application/zip',
      collectionName: 'attachments',
    }),
    ''
  );

  // Normalizes collectionName 'messages' to 'attachments'
  const imgWithMessagesColl = getAttachmentThumbnailUrl({
    id: 'att123',
    file: 'screenshot.png',
    type: 'image/png',
    collectionName: 'messages',
  });
  assert.ok(imgWithMessagesColl.includes('/api/files/attachments/att123/screenshot.png?thumb=480x480f'));
  assert.ok(!imgWithMessagesColl.includes('/api/files/messages/'));

  // Video attachment supports thumb query
  const videoThumb = getAttachmentThumbnailUrl({
    id: 'vid123',
    file: 'intro.mp4',
    type: 'video/mp4',
    collectionName: 'attachments',
  });
  assert.ok(videoThumb.includes('/api/files/attachments/vid123/intro.mp4?thumb=480x480f'));

  // Explicit thumbnail is prioritized
  const explicitThumb = getAttachmentThumbnailUrl({
    id: 'att456',
    file: 'original.png',
    thumbnail: 'thumb_small.webp',
    collectionName: 'attachments',
  });
  assert.ok(explicitThumb.includes('/api/files/attachments/att456/thumb_small.webp'));
});
