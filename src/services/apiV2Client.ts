import { BackendError, backendAvailability } from './backendAvailability';
import type { Channel, Message, MessageCursor, MessagePage, Server, User } from '../types';

export interface DmSummary {
  id: string;
  created: string;
  updated?: string;
  counterpart: User;
}

export interface DmSummaryEnvelope {
  items: DmSummary[];
}

export interface BootstrapResponse {
  user: User;
  servers: Server[];
  dms: DmSummary[];
  activeServerId: string | null;
  channels: Channel[];
  generatedAt: string;
}

export interface GatewayErrorShape {
  error?: string;
  code?: string;
  requestId?: string;
}

export interface ApiRequestOptions {
  /** Maximum time for this read before the availability breaker is updated. */
  timeoutMs?: number;
  /** Bypass an open breaker for an explicit user retry. */
  force?: boolean;
}

function gatewayBaseUrl(): string {
  const envValue = (import.meta as any)?.env?.VITE_API_V2_URL;
  return String(envValue || 'https://chat.sirverdata.top/api/v2').replace(/\/+$/, '');
}

function normalizeGatewayError(response: Response, body: string): BackendError {
  let parsed: GatewayErrorShape = {};
  try {
    parsed = body ? JSON.parse(body) : {};
  } catch {
    // Cloudflare and reverse proxies often return plain text/HTML.
  }
  const status = response.status;
  const message = parsed.error || (status === 530 ? 'The chat tunnel is unavailable' : body.slice(0, 180) || response.statusText || 'Chat service request failed');
  const error = new Error(message) as BackendError;
  error.status = status;
  error.code = parsed.code || (status === 530 ? 'TUNNEL_UNAVAILABLE' : 'GATEWAY_ERROR');
  error.requestId = parsed.requestId;
  return error;
}

function queryString(params: Record<string, string | number | null | undefined>): string {
  const query = new URLSearchParams();
  Object.entries(params).forEach(([key, value]) => {
    if (value !== undefined && value !== null && value !== '') query.set(key, String(value));
  });
  const result = query.toString();
  return result ? `?${result}` : '';
}

export class ApiV2Client {
  private readonly baseUrl: string;
  private getToken: () => string | null;

  constructor(baseUrl = gatewayBaseUrl(), getToken: () => string | null = () => null) {
    this.baseUrl = baseUrl.replace(/\/+$/, '');
    this.getToken = getToken;
  }

  /** Update the token source after PocketBase restores or refreshes a session. */
  setTokenProvider(provider: () => string | null): void {
    this.getToken = provider;
  }

  async request<T>(path: string, init: RequestInit = {}, options: ApiRequestOptions = {}): Promise<T> {
    const method = (init.method || 'GET').toUpperCase();
    const bodyKey = typeof init.body === 'string' ? init.body : '';
    const key = `${method}:${this.baseUrl}${path}:${bodyKey}`;
    return backendAvailability.run(key, async (signal) => {
      const headers = new Headers(init.headers || {});
      headers.set('Accept', 'application/json');
      const token = this.getToken();
      if (token && !headers.has('Authorization')) headers.set('Authorization', token.startsWith('Bearer ') ? token : `Bearer ${token}`);
      if (init.body && !headers.has('Content-Type')) headers.set('Content-Type', 'application/json');

      const response = await fetch(`${this.baseUrl}${path}`, { ...init, headers, signal });
      const text = await response.text();
      if (!response.ok) throw normalizeGatewayError(response, text);
      if (!text) return undefined as T;
      try {
        return JSON.parse(text) as T;
      } catch {
        const error = new Error('Gateway returned an invalid JSON response') as BackendError;
        error.status = response.status;
        error.code = 'INVALID_GATEWAY_RESPONSE';
        throw error;
      }
    }, options);
  }

  bootstrap(serverId?: string | null): Promise<BootstrapResponse> {
    // Bootstrap touches memberships and the user directory in one request.
    // Give a healthy but busy home VPS adequate room while still keeping an
    // upper bound for a dead tunnel.
    return this.request<BootstrapResponse>(`/bootstrap${queryString({ serverId })}`, {}, { timeoutMs: 15000 });
  }

  messages<T extends Message = Message>(kind: 'channel' | 'dm', id: string, limit = 20, cursor?: MessageCursor | null): Promise<MessagePage<T>> {
    // The gateway accepts the shared `{created,id}` cursor contract while
    // keeping the query names explicit for older reverse-proxy deployments.
    // Sending both fields also avoids URL-encoding a JSON object and remains
    // compatible with gateways that predate the `cursor` shorthand.
    return this.request<MessagePage<T>>(`/conversations/${kind}/${encodeURIComponent(id)}/messages${queryString({
      limit,
      beforeCreated: cursor?.created,
      beforeId: cursor?.id,
    })}`, {}, { timeoutMs: 15000 });
  }

  async dms(): Promise<DmSummary[]> {
    const response = await this.request<DmSummary[] | DmSummaryEnvelope>(
      '/dms',
      {},
      { timeoutMs: 15000 },
    );
    const items = Array.isArray(response) ? response : response?.items;
    if (!Array.isArray(items)) {
      const error = new Error('Gateway returned an invalid DM summary envelope') as BackendError;
      error.code = 'INVALID_GATEWAY_RESPONSE';
      throw error;
    }
    return items;
  }

  health(): Promise<{ status: string }> {
    return this.request<{ status: string }>('/health');
  }
}

export const apiV2Client = new ApiV2Client(undefined, () => {
  try {
    const token = (window as any)?.__SIRVER_POCKETBASE_TOKEN__;
    return token || null;
  } catch {
    return null;
  }
});
