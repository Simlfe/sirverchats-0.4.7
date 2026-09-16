/**
 * LiveKit identities are unique per browser/device session.  LiveKit closes
 * an existing participant when a second connection joins with the same
 * identity, which used to create a reconnect loop for users signed in on
 * more than one device.
 */
export const LIVEKIT_SESSION_SEPARATOR = '::sirver:';

export function liveKitIdentityForSession(userId: string, sessionId?: string | null): string {
  const base = String(userId || '').trim();
  const session = String(sessionId || '').trim();
  if (!base || !session) return base;
  return `${base}${LIVEKIT_SESSION_SEPARATOR}${session}`;
}

export function userIdFromLiveKitIdentity(identity: string): string {
  const value = String(identity || '');
  const separatorIndex = value.indexOf(LIVEKIT_SESSION_SEPARATOR);
  return separatorIndex >= 0 ? value.slice(0, separatorIndex) : value;
}

export function isLiveKitIdentityOwnedByUser(identity: string, userId: string): boolean {
  const canonicalIdentity = userIdFromLiveKitIdentity(identity);
  return Boolean(canonicalIdentity) && canonicalIdentity === String(userId || '').trim();
}
