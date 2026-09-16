/**
 * Small, framework-free availability state used by read paths.  A failed
 * request must not immediately fan out into compatibility retries or repeat
 * while a tunnel/VPS is unavailable.  The breaker is deliberately short so a
 * recovered home server becomes usable without a page reload.
 */

export type BackendAvailability = 'online' | 'degraded' | 'offline';

export interface BackendError extends Error {
  status?: number;
  code?: string;
  requestId?: string;
}

export function isClientCancellation(error: unknown): boolean {
  const candidate = error as any;
  if (!candidate) return false;
  if (candidate.code === 'TIMEOUT' || candidate.status === 408) return false;
  if (candidate.isAbort === true) return true;
  if (candidate.name === 'AbortError') return true;
  const message = String(candidate.message || candidate.response?.message || '').toLowerCase();
  return (
    message.includes('autocancelled') ||
    message.includes('user aborted') ||
    message.includes('operation was aborted') ||
    message.includes('client initiated') ||
    message.includes('request was cancelled')
  );
}

export function isInfrastructureFailure(error: unknown): boolean {
  if (isClientCancellation(error)) {
    return false;
  }
  const candidate = error as any;
  const status = Number(candidate?.status || candidate?.response?.status || candidate?.response?.code || 0);
  const message = String(candidate?.message || candidate?.response?.message || '').toLowerCase();
  const transportMessage = /(?:network|timeout|timed out|cloudflare|error 1033|failed to fetch|offline|connection refused|connection reset|dns)/.test(message);
  return (
    status === 408 ||
    status === 429 ||
    status === 500 ||
    status === 502 ||
    status === 503 ||
    status === 504 ||
    status === 530 ||
    transportMessage ||
    // Browser fetch commonly reports a TypeError with no status for a
    // connection failure. An arbitrary status-less application error should
    // remain degraded instead of opening the outage breaker.
    (status === 0 && (candidate?.name === 'TypeError' || candidate?.code === 'ECONNRESET' || candidate?.code === 'ENOTFOUND'))
  );
}

export interface BackendAvailabilitySnapshot {
  status: BackendAvailability;
  failures: number;
  circuitOpenUntil: number;
  lastError: string | null;
  lastChangedAt: number;
}

type AvailabilityListener = (snapshot: BackendAvailabilitySnapshot) => void;

const DEFAULT_COOLDOWN_MS = 10_000;

export class BackendAvailabilityTracker {
  private snapshot: BackendAvailabilitySnapshot = {
    status: 'online',
    failures: 0,
    circuitOpenUntil: 0,
    lastError: null,
    lastChangedAt: Date.now(),
  };
  private listeners = new Set<AvailabilityListener>();
  private inFlight = new Map<string, Promise<unknown>>();

  getSnapshot(): BackendAvailabilitySnapshot {
    return { ...this.snapshot };
  }

  subscribe(listener: AvailabilityListener): () => void {
    this.listeners.add(listener);
    listener(this.getSnapshot());
    return () => this.listeners.delete(listener);
  }

  canRequest(now = Date.now()): boolean {
    return this.snapshot.circuitOpenUntil <= now;
  }

  markSuccess(): void {
    const changed = this.snapshot.status !== 'online' || this.snapshot.failures !== 0 || this.snapshot.lastError !== null;
    this.snapshot = {
      ...this.snapshot,
      status: 'online',
      failures: 0,
      circuitOpenUntil: 0,
      lastError: null,
      ...(changed ? { lastChangedAt: Date.now() } : {}),
    };
    if (changed) this.notify();
  }

  markFailure(error: unknown, cooldownMs = DEFAULT_COOLDOWN_MS): void {
    const message = String((error as any)?.message || 'Chat service unavailable');
    const infrastructure = isInfrastructureFailure(error);
    this.snapshot = {
      ...this.snapshot,
      status: infrastructure ? 'offline' : 'degraded',
      failures: this.snapshot.failures + 1,
      circuitOpenUntil: infrastructure ? Date.now() + cooldownMs : this.snapshot.circuitOpenUntil,
      lastError: message,
      lastChangedAt: Date.now(),
    };
    this.notify();
  }

  reset(): void {
    this.snapshot = {
      status: 'online',
      failures: 0,
      circuitOpenUntil: 0,
      lastError: null,
      lastChangedAt: Date.now(),
    };
    this.notify();
  }

  /**
   * Coalesce identical reads and apply a bounded timeout/circuit breaker.  A
   * caller may pass an AbortSignal; the timeout still rejects promptly even if
   * the underlying SDK does not honour cancellation.
   */
  async run<T>(key: string, operation: (signal: AbortSignal) => Promise<T>, options?: {
    timeoutMs?: number;
    force?: boolean;
  }): Promise<T> {
    const existing = this.inFlight.get(key) as Promise<T> | undefined;
    if (existing) return existing;
    if (!options?.force && !this.canRequest()) {
      const error = new Error(this.snapshot.lastError || 'Chat service is temporarily unavailable') as BackendError;
      error.code = 'CIRCUIT_OPEN';
      error.status = 503;
      throw error;
    }

    const timeoutMs = Math.max(250, options?.timeoutMs ?? 15000);
    const promise = new Promise<T>((resolve, reject) => {
      const controller = new AbortController();
      let settled = false;
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        controller.abort();
        const error = new Error(`Request timed out after ${timeoutMs}ms`) as BackendError;
        error.code = 'TIMEOUT';
        error.status = 408;
        this.markFailure(error);
        reject(error);
      }, timeoutMs);

      Promise.resolve()
        .then(() => operation(controller.signal))
        .then((value) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          this.markSuccess();
          resolve(value);
        })
        .catch((error) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          if (!isClientCancellation(error)) {
            this.markFailure(error);
          }
          reject(error);
        });
    }).finally(() => {
      this.inFlight.delete(key);
    });

    this.inFlight.set(key, promise);
    return promise;
  }

  private notify(): void {
    const snapshot = this.getSnapshot();
    this.listeners.forEach((listener) => {
      try {
        listener(snapshot);
      } catch {
        // A status indicator must never break a read path.
      }
    });
  }
}

export const backendAvailability = new BackendAvailabilityTracker();
