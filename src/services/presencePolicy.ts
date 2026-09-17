import type { User } from '../types';

export const USER_PRESENCE_EXPIRY_MS = 90_000;

export function isUserPresenceExpired(
  user: Pick<User, 'last_seen'>,
  nowMs: number = Date.now()
): boolean {
  if (!user.last_seen) return true;
  const lastSeenMs = Date.parse(user.last_seen);
  return !Number.isFinite(lastSeenMs) || nowMs - lastSeenMs > USER_PRESENCE_EXPIRY_MS;
}

/**
 * Mark stale users offline without changing the array when there is no state
 * transition. Returning the original reference lets React skip the periodic
 * presence refresh once every stale user has already been handled.
 */
export function expireStaleUsers(users: User[], nowMs: number = Date.now()): User[] {
  let nextUsers: User[] | null = null;

  users.forEach((user, index) => {
    if (user.status === 'offline' || !user.last_seen || !isUserPresenceExpired(user, nowMs)) {
      return;
    }

    if (!nextUsers) nextUsers = [...users];
    nextUsers[index] = { ...user, status: 'offline' };
  });

  return nextUsers ?? users;
}
