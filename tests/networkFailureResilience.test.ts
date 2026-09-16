import test from 'node:test';
import assert from 'node:assert/strict';
import { BackendAvailabilityTracker, isInfrastructureFailure } from '../src/services/backendAvailability';
import type { Message } from '../src/types';

function createCachedHistory(): Message[] {
  return [
    {
      id: 'cached-1',
      channel: 'ch-test',
      sender: 'u1',
      content: 'Message 1 from cache',
      created: '2026-03-01T12:00:00.000Z',
      updated: '2026-03-01T12:00:00.000Z',
    } as Message,
    {
      id: 'cached-2',
      channel: 'ch-test',
      sender: 'u2',
      content: 'Message 2 from cache',
      created: '2026-03-01T12:01:00.000Z',
      updated: '2026-03-01T12:01:00.000Z',
    } as Message,
  ];
}

test('resilience: 401 Unauthorized does not open outage circuit breaker, cached content remains viewable', async () => {
  const tracker = new BackendAvailabilityTracker();
  const cachedMessages = createCachedHistory();

  const authError = Object.assign(new Error('Unauthorized token expired'), { status: 401 });
  assert.equal(isInfrastructureFailure(authError), false);

  await assert.rejects(
    tracker.run('auth-req', async () => {
      throw authError;
    }),
  );

  // Status is degraded, NOT offline; circuit breaker is NOT tripped
  assert.notEqual(tracker.getSnapshot().status, 'offline');
  assert.equal(tracker.canRequest(), true);

  // Cached content remains accessible
  assert.equal(cachedMessages.length, 2);
  assert.equal(cachedMessages[0].content, 'Message 1 from cache');
});

test('resilience: 500, 530 and transport failures open circuit breaker, but cached content remains usable', async () => {
  const tracker = new BackendAvailabilityTracker();
  const cachedMessages = createCachedHistory();

  const cloudflare530 = Object.assign(new Error('Cloudflare error 1033: Argo Tunnel error'), { status: 530 });
  assert.equal(isInfrastructureFailure(cloudflare530), true);

  await assert.rejects(
    tracker.run('cf-req', async () => {
      throw cloudflare530;
    }),
  );

  assert.equal(tracker.getSnapshot().status, 'offline');
  assert.equal(tracker.canRequest(), false);

  // User UI still has immediate access to local cached messages
  assert.equal(cachedMessages.length, 2);

  // When backend recovers, calling markSuccess() restores online state immediately
  tracker.markSuccess();
  assert.equal(tracker.getSnapshot().status, 'online');
  assert.equal(tracker.canRequest(), true);
});

test('resilience: 429 rate limit is flagged as infrastructure backoff without losing local state', async () => {
  const tracker = new BackendAvailabilityTracker();
  const rateLimitError = Object.assign(new Error('Too Many Requests'), { status: 429 });

  assert.equal(isInfrastructureFailure(rateLimitError), true);

  await assert.rejects(
    tracker.run('rate-limited', async () => {
      throw rateLimitError;
    }),
  );

  assert.equal(tracker.getSnapshot().status, 'offline');
  assert.equal(tracker.canRequest(), false);

  // Reset restores clean state
  tracker.reset();
  assert.equal(tracker.getSnapshot().status, 'online');
  assert.equal(tracker.canRequest(), true);
});
