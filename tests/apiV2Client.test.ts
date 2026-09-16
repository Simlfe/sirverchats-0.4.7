import test from 'node:test';
import assert from 'node:assert/strict';
import { ApiV2Client } from '../src/services/apiV2Client';

test('v2 message reads send the shared cursor as explicit tie-breaker fields', async () => {
  const originalFetch = globalThis.fetch;
  let requested: URL | null = null;
  globalThis.fetch = async (input) => {
    requested = new URL(String(input));
    return new Response(JSON.stringify({ items: [], nextCursor: null, hasMore: false }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  };
  try {
    const client = new ApiV2Client('https://chat.example.test/api/v2', () => 'token');
    await client.messages('dm', 'dm-1', 50, {
      created: '2026-01-01T00:00:00.000Z',
      id: 'm-2',
    });
    assert.ok(requested);
    assert.equal(requested?.searchParams.get('limit'), '50');
    assert.equal(requested?.searchParams.get('beforeCreated'), '2026-01-01T00:00:00.000Z');
    assert.equal(requested?.searchParams.get('beforeId'), 'm-2');
    assert.equal(requested?.searchParams.has('cursor'), false);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
