import test from 'node:test';
import assert from 'node:assert/strict';
import {
  LIVEKIT_SESSION_SEPARATOR,
  isLiveKitIdentityOwnedByUser,
  liveKitIdentityForSession,
  userIdFromLiveKitIdentity,
} from '../src/media/livekit/livekitIdentity';

test('LiveKit identities are unique per session while preserving the account id', () => {
  const first = liveKitIdentityForSession('user-1', 'session-a');
  const second = liveKitIdentityForSession('user-1', 'session-b');
  assert.notEqual(first, second);
  assert.equal(first, `user-1${LIVEKIT_SESSION_SEPARATOR}session-a`);
  assert.equal(userIdFromLiveKitIdentity(first), 'user-1');
  assert.equal(userIdFromLiveKitIdentity('user-1'), 'user-1');
});

test('identity ownership accepts session suffixes but rejects another account', () => {
  assert.equal(isLiveKitIdentityOwnedByUser('user-1::sirver:session-a', 'user-1'), true);
  assert.equal(isLiveKitIdentityOwnedByUser('user-1', 'user-1'), true);
  assert.equal(isLiveKitIdentityOwnedByUser('user-10::sirver:session-a', 'user-1'), false);
  assert.equal(isLiveKitIdentityOwnedByUser('user-2::sirver:session-a', 'user-1'), false);
});
