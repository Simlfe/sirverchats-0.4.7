import test from 'node:test';
import assert from 'node:assert/strict';
import { BackendAvailabilityTracker, isClientCancellation, isInfrastructureFailure } from '../src/services/backendAvailability';
import { dedupeMessages, mergeMessagePage } from '../src/services/messagePagination';
import type { Message } from '../src/types';

function createMessage(id: string, channel: string, content: string, created: string): Message {
  return {
    id,
    channel,
    sender: 'u1',
    content,
    created,
    updated: created,
  } as Message;
}

test('conversation navigation: coalesces concurrent reads so only one uncached request fires', async () => {
  const tracker = new BackendAvailabilityTracker();
  let networkFetches = 0;

  const fetchChannelPage = (channelId: string) => {
    return tracker.run(`history:channel:${channelId}`, async () => {
      networkFetches += 1;
      await new Promise((resolve) => setTimeout(resolve, 10));
      return [
        createMessage('m1', channelId, 'Hello', '2026-03-01T12:00:00.000Z'),
        createMessage('m2', channelId, 'World', '2026-03-01T12:00:01.000Z'),
      ];
    });
  };

  // Multiple UI components mounting concurrently requesting the same channel history
  const [res1, res2, res3] = await Promise.all([
    fetchChannelPage('channel-A'),
    fetchChannelPage('channel-A'),
    fetchChannelPage('channel-A'),
  ]);

  assert.equal(networkFetches, 1, 'Exactly one uncached request should fire for concurrent navigation reads');
  assert.equal(res1.length, 2);
  assert.deepEqual(res1, res2);
  assert.deepEqual(res2, res3);
});

test('conversation switching: switching channels cancels old in-flight requests without false outage banner', async () => {
  const tracker = new BackendAvailabilityTracker();

  // User initiates channel A fetch which gets cancelled as user switches away
  const cancelError = new Error('The request was autocancelled.');
  (cancelError as any).name = 'AbortError';
  (cancelError as any).isAbort = true;

  await assert.rejects(
    tracker.run('history:channel:channel-A', async () => {
      throw cancelError;
    }),
    (err: any) => err.isAbort === true,
  );

  assert.equal(isClientCancellation(cancelError), true);
  assert.equal(isInfrastructureFailure(cancelError), false);

  // Circuit breaker must NOT trip
  assert.equal(tracker.getSnapshot().status, 'online');
  assert.equal(tracker.canRequest(), true);

  // Channel B request succeeds immediately without being blocked
  const channelBResult = await tracker.run('history:channel:channel-B', async () => {
    return [createMessage('mb1', 'channel-B', 'Welcome to B', '2026-03-01T12:01:00.000Z')];
  });

  assert.equal(channelBResult.length, 1);
  assert.equal(channelBResult[0].channel, 'channel-B');
  assert.equal(tracker.getSnapshot().status, 'online');
});

test('realtime deduplication: incoming realtime events do not produce duplicates with page history', () => {
  const existingPage: Message[] = [
    createMessage('m1', 'ch-1', 'First', '2026-03-01T12:00:00.000Z'),
    createMessage('m2', 'ch-1', 'Second', '2026-03-01T12:00:01.000Z'),
    createMessage('m3', 'ch-1', 'Third', '2026-03-01T12:00:02.000Z'),
  ];

  // Realtime receives an update for m2 and a new message m4
  const realtimeEvents: Message[] = [
    createMessage('m2', 'ch-1', 'Second (edited)', '2026-03-01T12:00:01.000Z'),
    createMessage('m4', 'ch-1', 'Fourth', '2026-03-01T12:00:03.000Z'),
  ];

  const merged = mergeMessagePage(existingPage, realtimeEvents);
  assert.equal(merged.length, 4, 'Should contain 4 distinct messages without duplicates');

  const ids = merged.map((m) => m.id);
  assert.deepEqual(ids, ['m1', 'm2', 'm3', 'm4']);

  // Optimistic echo deduplication
  const optimistic: Message = {
    ...createMessage('opt-123', 'ch-1', 'Pending message', '2026-03-01T12:00:04.000Z'),
    pending: true,
  } as any;

  const confirmed: Message = createMessage('real-123', 'ch-1', 'Pending message', '2026-03-01T12:00:04.000Z');

  const withOptimistic = dedupeMessages([...merged, optimistic]);
  assert.equal(withOptimistic.length, 5);

  // When confirmed arrives, dedupeMessages retains the canonical message
  const withConfirmed = dedupeMessages([...merged, confirmed]);
  assert.equal(withConfirmed.length, 5);
});

test('realtime deduplication: expanded sender objects still replace an optimistic echo', () => {
  const optimistic = {
    ...createMessage('optimistic-1', 'ch-1', 'hello', '2026-03-01T12:00:04.000Z'),
    is_pending: true,
  } as Message;
  const confirmed = {
    ...createMessage('real-1', 'ch-1', 'hello', '2026-03-01T12:00:04.100Z'),
    sender: { id: 'u1', username: 'u1' },
  } as any as Message;

  const merged = dedupeMessages([optimistic, confirmed]);
  assert.equal(merged.length, 1);
  assert.equal(merged[0].id, 'real-1');
});
