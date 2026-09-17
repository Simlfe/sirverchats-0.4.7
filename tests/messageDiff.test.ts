import test from 'node:test';
import assert from 'node:assert/strict';
import { isSingleMessageEqual, mergeMessageListPreservingReferences } from '../src/lib/messageDiff';
import type { Message } from '../src/types';

function baseMessage(): Message {
  return {
    id: 'm-1',
    channel: 'channel-1',
    sender: 'user-1',
    content: 'hello',
    created: '2026-01-01T00:00:00.000Z',
    updated: '2026-01-01T00:00:00.000Z',
  };
}

test('same-count attachment thumbnail changes invalidate the rendered message', () => {
  const previous = {
    ...baseMessage(),
    attachments: [{ id: 'a-1', file: 'photo.jpg', thumbnail: 'thumb-old.webp' }],
  } as Message;
  const next = {
    ...baseMessage(),
    attachments: [{ id: 'a-1', file: 'photo.jpg', thumbnail: 'thumb-new.webp' }],
  } as Message;

  assert.equal(isSingleMessageEqual(previous, next), false);
  assert.equal(mergeMessageListPreservingReferences([previous], [next])[0], next);
});

test('newly hydrated sender data invalidates a cached unexpanded message', () => {
  const previous = baseMessage();
  const next = {
    ...baseMessage(),
    expand: {
      sender: {
        id: 'user-1',
        username: 'alice',
        display_name: 'Alice',
        email: '',
        role: 'user',
        status: 'online',
        avatar: 'alice.webp',
        updated: '2026-01-02T00:00:00.000Z',
      },
    },
  } as Message;

  assert.equal(isSingleMessageEqual(previous, next), false);
});

test('render-equivalent messages retain their previous object reference', () => {
  const previous = baseMessage();
  const next = { ...previous };
  const result = mergeMessageListPreservingReferences([previous], [next]);
  assert.equal(result[0], previous);
});
