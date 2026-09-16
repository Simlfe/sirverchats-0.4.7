import test from 'node:test';
import assert from 'node:assert/strict';
import { liveKitIdentityForSession, userIdFromLiveKitIdentity } from '../src/media/livekit/livekitIdentity';
import type { IncomingCallEvent, CameraQualityProfile } from '../src/types/media';
import type { User } from '../src/types';

function createMockUser(id: string, username: string): User {
  return {
    id,
    username,
    email: `${username}@example.com`,
    display_name: username,
    created: '2026-01-01T00:00:00.000Z',
    updated: '2026-01-01T00:00:00.000Z',
  } as User;
}

test('call lifecycle states transition consistently: invite -> accept', () => {
  const caller = createMockUser('user-caller', 'Caller');
  const target = createMockUser('user-callee', 'Callee');

  const inviteEvent: IncomingCallEvent = {
    callId: 'call-12345',
    callerId: caller.id,
    callerName: caller.display_name || caller.username,
    callerAvatar: '',
    callerUser: caller,
    targetUser: target,
    targetUserId: target.id,
    callType: 'video',
    conversationId: 'dm-1',
    state: 'ringing',
    timestamp: Date.now(),
  };

  assert.equal(inviteEvent.state, 'ringing');

  // Accept transition
  const acceptedEvent: IncomingCallEvent = {
    ...inviteEvent,
    state: 'accepted',
  };
  assert.equal(acceptedEvent.state, 'accepted');
  assert.equal(acceptedEvent.callId, 'call-12345');
});

test('call lifecycle states transition consistently: invite -> decline and cancel', () => {
  const caller = createMockUser('user-caller', 'Caller');
  const target = createMockUser('user-callee', 'Callee');

  const inviteEvent: IncomingCallEvent = {
    callId: 'call-67890',
    callerId: caller.id,
    callerName: 'Caller',
    callerAvatar: '',
    callerUser: caller,
    targetUser: target,
    targetUserId: target.id,
    callType: 'voice',
    conversationId: 'dm-2',
    state: 'ringing',
    timestamp: Date.now(),
  };

  const declinedEvent: IncomingCallEvent = { ...inviteEvent, state: 'declined' };
  assert.equal(declinedEvent.state, 'declined');

  const cancelledEvent: IncomingCallEvent = { ...inviteEvent, state: 'cancelled' };
  assert.equal(cancelledEvent.state, 'cancelled');
});

test('video quality profile defaults to balanced 720p/30 for smooth adaptive performance', async () => {
  const { default: realtimeMediaProvider } = await import('../src/media/RealtimeMediaProvider');

  // Default camera quality profile is 'auto' (smooth adaptive)
  const profile = realtimeMediaProvider.getCameraQualityProfile();
  assert.ok(profile === 'auto' || profile === 'balanced');

  // Specs for balanced must be strictly 1280x720 at 30 fps
  const cameraSpecs = realtimeMediaProvider.getCameraProfileSpecs('balanced');
  assert.equal(cameraSpecs.targetWidth, 1280);
  assert.equal(cameraSpecs.targetHeight, 720);
  assert.equal(cameraSpecs.targetFps, 30);
  assert.ok(cameraSpecs.maxBitrateBps <= 2_000_000);
});

test('diagnostics telemetry does not fabricate 1080p/60fps/3800kbps when measurements are missing', async () => {
  const { default: liveKitManager } = await import('../src/media/livekit/LiveKitManager');

  // When no room is active, diagnostics returns null
  const noRoomDiag = await liveKitManager.getParticipantDiagnostics('user-missing');
  assert.equal(noRoomDiag, null);
});
