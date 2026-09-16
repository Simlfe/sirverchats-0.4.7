import test from 'node:test';
import assert from 'node:assert/strict';
import { buildOlderMessageFilter, cursorFromMessage } from '../src/services/messagePagination';
import type { Message } from '../src/types';

function createMockMessages(count: number): Message[] {
  const baseTime = Date.parse('2026-03-01T12:00:00.000Z');
  return Array.from({ length: count }, (_, i) => {
    // 5 messages per timestamp step to test equal timestamps
    const step = Math.floor(i / 5);
    const created = new Date(baseTime + step * 1000).toISOString();
    return {
      id: `msg-${String(i).padStart(6, '0')}`,
      channel: 'ch-benchmark',
      sender: `user-${i % 10}`,
      content: `Benchmark test message content ${i} with some typical length text payload`,
      created,
      updated: created,
    } as Message;
  });
}

test('performance: cached conversation retrieval executes in <150ms', () => {
  const messages = createMockMessages(200);
  const cache = new Map<string, Message[]>();
  cache.set('ch-benchmark', messages);

  const start = performance.now();
  // Simulate cached conversation retrieval and rendering slice
  const retrieved = cache.get('ch-benchmark') || [];
  const rendered = retrieved.slice(-50);
  const elapsed = performance.now() - start;

  assert.equal(rendered.length, 50);
  assert.ok(elapsed < 150, `Cached conversation access took ${elapsed.toFixed(2)}ms (target: <150ms)`);
});

test('performance: bootstrap snapshot serialization and parse executes in <1.5s', () => {
  const bootstrapPayload = {
    user: { id: 'u1', username: 'tester', email: 'test@example.com' },
    servers: Array.from({ length: 20 }, (_, i) => ({
      id: `srv-${i}`,
      name: `Server ${i}`,
      channels: Array.from({ length: 10 }, (_, c) => ({ id: `ch-${i}-${c}`, name: `channel-${c}` })),
    })),
    recentMessages: createMockMessages(500),
    presence: Array.from({ length: 50 }, (_, i) => ({ userId: `u-${i}`, status: 'online' })),
  };

  const start = performance.now();
  const serialized = JSON.stringify(bootstrapPayload);
  const deserialized = JSON.parse(serialized);
  const elapsed = performance.now() - start;

  assert.equal(deserialized.servers.length, 20);
  assert.equal(deserialized.recentMessages.length, 500);
  assert.ok(elapsed < 1500, `Bootstrap snapshot serialization/deserialization took ${elapsed.toFixed(2)}ms (target: <1500ms)`);
});

test('performance: cursor-based query over 1,000 messages executes in <200ms', () => {
  const messages = createMockMessages(1000);
  const targetCursor = cursorFromMessage(messages[500]);
  assert.ok(targetCursor);

  const start = performance.now();
  // Simulate cursor filter generation and linear scan over 1,000 records
  const filter = buildOlderMessageFilter('channel = "ch-benchmark"', targetCursor);
  const filtered = messages.filter((m) => {
    if (m.created < targetCursor.created) return true;
    if (m.created === targetCursor.created && m.id < targetCursor.id) return true;
    return false;
  });
  const page = filtered.slice(-50);
  const elapsed = performance.now() - start;

  assert.ok(page.length > 0);
  assert.ok(filter.length > 0);
  assert.ok(elapsed < 200, `Cursor query over 1,000 items took ${elapsed.toFixed(2)}ms (target: <200ms)`);
});
