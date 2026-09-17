import test from 'node:test';
import assert from 'node:assert/strict';
import type { User } from '../src/types';
import {
  expireStaleUsers,
  isUserPresenceExpired,
  USER_PRESENCE_EXPIRY_MS,
} from '../src/services/presencePolicy';

const now = Date.parse('2026-09-17T12:00:00.000Z');

function user(overrides: Partial<User>): User {
  return {
    id: overrides.id || 'user-1',
    username: overrides.username || 'tester',
    email: overrides.email || 'tester@example.com',
    status: 'online',
    ...overrides,
  } as User;
}

test('presence policy uses one 90-second expiry window', () => {
  const fresh = user({ last_seen: new Date(now - USER_PRESENCE_EXPIRY_MS).toISOString() });
  const stale = user({ last_seen: new Date(now - USER_PRESENCE_EXPIRY_MS - 1).toISOString() });

  assert.equal(isUserPresenceExpired(fresh, now), false);
  assert.equal(isUserPresenceExpired(stale, now), true);
});

test('presence expiry transitions a stale online user to offline once', () => {
  const fresh = user({ id: 'fresh', last_seen: new Date(now - 10_000).toISOString() });
  const stale = user({ id: 'stale', last_seen: new Date(now - USER_PRESENCE_EXPIRY_MS - 1).toISOString() });
  const original = [fresh, stale];

  const expired = expireStaleUsers(original, now);
  assert.notEqual(expired, original);
  assert.equal(expired[0], fresh);
  assert.equal(expired[1].status, 'offline');

  const unchanged = expireStaleUsers(expired, now + 15_000);
  assert.equal(unchanged, expired);
});

test('presence expiry preserves the original array when nobody changed', () => {
  const users = [
    user({ id: 'fresh', last_seen: new Date(now - 10_000).toISOString() }),
    user({ id: 'offline', status: 'offline', last_seen: new Date(now - 200_000).toISOString() }),
  ];

  assert.equal(expireStaleUsers(users, now), users);
});
