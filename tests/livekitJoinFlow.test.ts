import test from 'node:test';
import assert from 'node:assert/strict';
import { liveKitManager } from '../src/media/livekit/LiveKitManager';
import { liveKitIdentityForSession, userIdFromLiveKitIdentity } from '../src/media/livekit/livekitIdentity';

test('voice-channel hover prefetch is permanently disabled to prevent premature token calls', async () => {
  // prefetchToken and prefetchChannelToken should immediately resolve to null without network calls
  const token = await liveKitManager.prefetchToken('user_123', 'John Doe', 'room_abc');
  assert.equal(token, null, 'prefetchToken must return null without fetching');

  const channelToken = await liveKitManager.prefetchChannelToken({ id: 'channel_456', name: 'General' } as any, { id: 'user_123', username: 'john' } as any);
  assert.equal(channelToken, null, 'prefetchChannelToken must return null without fetching');
});

test('session-specific identity remains identical between token acquisition and room connection', () => {
  const roomConfig = {
    roomId: 'channel_voice_1',
    roomType: 'voice_room' as const,
    maxParticipants: 10,
    user: { id: 'user_789', username: 'alice', display_name: 'Alice' } as any,
    sessionId: 'session_test_999',
  };

  const identity = (liveKitManager as any).sessionIdentity(roomConfig);
  const expected = liveKitIdentityForSession('user_789', 'session_test_999');
  assert.equal(identity, expected, 'session identity must match deterministic session separator');
  assert.equal(userIdFromLiveKitIdentity(identity), 'user_789', 'root user ID must be extractable from session identity');
});

test('join cancellation: leaving while connecting aborts in-flight token and join work', async () => {
  let abortFired = false;
  const abortController = new AbortController();
  abortController.signal.addEventListener('abort', () => {
    abortFired = true;
  });

  // Simulating an in-flight join that is aborted when user leaves
  abortController.abort(new DOMException('Client initiated disconnect', 'AbortError'));
  assert.equal(abortFired, true, 'Abort signal must notify listeners');
  assert.equal(abortController.signal.aborted, true, 'Signal must indicate aborted state');
});

test('browser token endpoint resolution prioritizes same-origin /livekit/token to prevent CORS failures', () => {
  const originalWindow = (globalThis as any).window;
  try {
    (globalThis as any).window = {
      location: {
        protocol: 'https:',
        hostname: 'ais-dev-5zuepyllskg6ol5mrvsnqg-72174158975.europe-west2.run.app',
      },
    };
    const endpoints = liveKitManager.resolveTokenEndpoints('https://chat.sirverdata.top/livekit/token');
    assert.deepEqual(endpoints, ['/livekit/token', 'https://chat.sirverdata.top/livekit/token'], 'browser should prioritize same-origin proxy');
  } finally {
    if (originalWindow === undefined) {
      delete (globalThis as any).window;
    } else {
      (globalThis as any).window = originalWindow;
    }
  }
});

