import test from 'node:test';
import assert from 'node:assert/strict';
import { chooseFeedPreview, isOriginalFeedUrl } from '../src/services/thumbnailPolicy';
import { calculateThumbnailDimensions } from '../src/services/thumbnailDimensions';

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
