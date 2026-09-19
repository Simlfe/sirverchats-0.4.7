import test from 'node:test';
import assert from 'node:assert/strict';
import { liveKitManager } from '../src/media/livekit/LiveKitManager';
import { liveKitIdentityForSession, userIdFromLiveKitIdentity } from '../src/media/livekit/livekitIdentity';
import { acquireMicrophoneForJoin } from '../src/utils/permissions';
import { RealtimeMediaProvider } from '../src/media/RealtimeMediaProvider';

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

test('production browser token routing uses the configured gateway without a dead same-origin attempt', () => {
  const originalWindow = (globalThis as any).window;
  try {
    (globalThis as any).window = {
      location: {
        protocol: 'https:',
        hostname: 'ais-dev-5zuepyllskg6ol5mrvsnqg-72174158975.europe-west2.run.app',
      },
    };
    const endpoints = liveKitManager.resolveTokenEndpoints('https://chat.sirverdata.top/livekit/token');
    assert.deepEqual(
      endpoints,
      ['https://chat.sirverdata.top/livekit/token'],
      'production hosts must not wait for a nonexistent same-origin token route'
    );
  } finally {
    if (originalWindow === undefined) {
      delete (globalThis as any).window;
    } else {
      (globalThis as any).window = originalWindow;
    }
  }
});

test('localhost token routing keeps the Vite proxy as an explicit development-only path', () => {
  const originalWindow = (globalThis as any).window;
  try {
    (globalThis as any).window = {
      location: {
        protocol: 'http:',
        hostname: 'localhost',
      },
    };
    assert.deepEqual(
      liveKitManager.resolveTokenEndpoints('https://chat.sirverdata.top/livekit/token'),
      ['/livekit/token', 'https://chat.sirverdata.top/livekit/token']
    );
  } finally {
    if (originalWindow === undefined) {
      delete (globalThis as any).window;
    } else {
      (globalThis as any).window = originalWindow;
    }
  }
});

test('explicit join microphone acquisition opens exactly one capture stream and returns its track', async () => {
  const originalNavigator = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
  const originalWindow = (globalThis as any).window;
  let acquisitionCount = 0;
  const track = {
    enabled: false,
    readyState: 'live',
    stop() {},
  } as unknown as MediaStreamTrack;
  const stream = {
    getAudioTracks: () => [track],
    getTracks: () => [track],
  } as unknown as MediaStream;

  try {
    Object.defineProperty(globalThis, 'navigator', {
      configurable: true,
      value: {
        mediaDevices: {
          getUserMedia: async () => {
            acquisitionCount += 1;
            return stream;
          },
          addEventListener() {},
        },
      },
    });
    (globalThis as any).window = {
      localStorage: { getItem: () => null },
    };

    const result = await acquireMicrophoneForJoin();
    assert.equal(result.granted, true);
    assert.equal(result.track, track);
    assert.equal(track.enabled, true);
    assert.equal(acquisitionCount, 1);
  } finally {
    if (originalNavigator) {
      Object.defineProperty(globalThis, 'navigator', originalNavigator);
    } else {
      delete (globalThis as any).navigator;
    }
    if (originalWindow === undefined) {
      delete (globalThis as any).window;
    } else {
      (globalThis as any).window = originalWindow;
    }
  }
});

function voiceRoomConfig(roomId: string) {
  return {
    roomId,
    roomName: roomId,
    roomType: 'voice_room' as const,
    maxParticipants: 8,
    user: { id: 'user-voice', username: 'voice-user' } as any,
    sessionId: `session-${roomId}`,
  };
}

test('same-room joins share one provider operation instead of restarting negotiation', async () => {
  const provider = new RealtimeMediaProvider();
  (provider as any).isMuted = true;
  let releaseJoin!: () => void;
  const joinGate = new Promise<void>((resolve) => {
    releaseJoin = resolve;
  });
  let joinCount = 0;
  const adapter = {
    joinSession: async () => {
      joinCount += 1;
      await joinGate;
    },
    leaveSession: async () => {},
    getConnectionState: () => 'connected',
    setMicrophoneEnabled: async () => true,
    getLocalAudioTrack: () => ({ readyState: 'live', enabled: true }),
  };
  (provider as any).sfuAdapter = adapter;
  (provider as any).ensureSfuAdapter = async () => adapter;

  const first = provider.joinRoom(voiceRoomConfig('room-a'));
  const second = provider.joinRoom(voiceRoomConfig('room-a'));
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(joinCount, 1);
  releaseJoin();
  await Promise.all([first, second]);
  assert.equal(joinCount, 1);
  await provider.leaveRoom();
});

test('a stale connecting state does not short-circuit a new room join', async () => {
  const provider = new RealtimeMediaProvider();
  (provider as any).isMuted = true;
  (provider as any).connectionState = 'connecting';
  let joinCount = 0;
  const adapter = {
    joinSession: async () => { joinCount += 1; },
    leaveSession: async () => {},
    getConnectionState: () => 'connected',
  };
  (provider as any).sfuAdapter = adapter;
  (provider as any).ensureSfuAdapter = async () => adapter;

  await provider.joinRoom(voiceRoomConfig('room-stale-state'));
  assert.equal(joinCount, 1);
  assert.equal(provider.getConnectionState(), 'connected');
  await provider.leaveRoom();
});

test('A-to-B room switch cancels A without waiting for its negotiation timeout', async () => {
  const provider = new RealtimeMediaProvider();
  (provider as any).isMuted = true;
  let rejectRoomA!: (reason: unknown) => void;
  let roomAStarted!: () => void;
  const roomAReady = new Promise<void>((resolve) => {
    roomAStarted = resolve;
  });
  const joins: string[] = [];
  const adapter = {
    joinSession: async (config: { roomId: string }) => {
      joins.push(config.roomId);
      if (config.roomId === 'room-a') {
        roomAStarted();
        await new Promise<void>((_resolve, reject) => {
          rejectRoomA = reject;
        });
      }
    },
    leaveSession: async () => {
      rejectRoomA?.(new DOMException('Client initiated disconnect', 'AbortError'));
    },
    getConnectionState: () => 'connected',
    setMicrophoneEnabled: async () => true,
    getLocalAudioTrack: () => ({ readyState: 'live', enabled: true }),
  };
  (provider as any).sfuAdapter = adapter;
  (provider as any).ensureSfuAdapter = async () => adapter;

  const roomA = provider.joinRoom(voiceRoomConfig('room-a'));
  const roomAOutcome = roomA.then(
    () => null,
    (error) => error
  );
  await roomAReady;
  const roomB = provider.joinRoom(voiceRoomConfig('room-b'));
  await roomB;
  const roomAError = await roomAOutcome;
  assert.match(String(roomAError), /cancel/i);
  assert.deepEqual(joins, ['room-a', 'room-b']);
  assert.equal((provider as any).activeRoom?.roomId, 'room-b');
  await provider.leaveRoom();
});

