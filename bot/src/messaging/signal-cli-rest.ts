// A messaging backend for any bridge that answers signal-cli-rest-api's HTTP API
// (https://github.com/bbernhard/signal-cli-rest-api): Signal itself, or another platform's
// bridge that answers the same API. The platform name is configuration, not code.

import WebSocket from 'ws';
import { GoogleAuth } from 'google-auth-library';
import type {
  BackendGroup,
  IncomingItem,
  MessagingBackend,
  OutgoingMessage,
  ReceiverDiagnostics,
  SendOptions,
} from './backend.js';

// Minimal request surface ({ data, status }). Both a Google IdTokenClient and the plain-fetch
// requester below satisfy it.
export interface HttpRequester {
  request(opts: any): Promise<{ data: any; status: number; statusText?: string }>;
  getRequestHeaders(url?: string): Promise<any>;
}

export type SignalCliRestConfig = {
  platform: string;
  url: string;
  botId: string;
  /** Sent as `Authorization: Bearer <token>` to a bridge that asks for one. */
  token?: string;
  /** Skip Google OIDC for an https bridge on a private network. Plain http never uses it. */
  noAuth?: boolean;
};

const POLL_MS = 5000;
// Receive-socket liveness: a ping each interval; no answer by the next one drops the socket.
const WS_PING_MS = 30_000;

// Plain-HTTP requester for a bridge reached over a trusted private network (the VM-hosted
// bridge) or a local stub (load tests) — no Google OIDC. Shapes responses/errors like the
// google-auth-library client the callers expect.
function makePlainRequester(token?: string): HttpRequester {
  const authHeaders = (): Record<string, string> => (token ? { Authorization: `Bearer ${token}` } : {});
  return {
    async request(opts: any) {
      const method = (opts.method || 'GET').toUpperCase();
      const headers: Record<string, string> = { ...authHeaders(), ...(opts.headers || {}) };
      let body: string | undefined;
      if (opts.data !== undefined) {
        body = typeof opts.data === 'string' ? opts.data : JSON.stringify(opts.data);
        if (!headers['Content-Type'] && !headers['content-type']) headers['Content-Type'] = 'application/json';
      }
      const signals = [opts.timeout ? AbortSignal.timeout(opts.timeout) : undefined, opts.signal].filter(
        Boolean
      ) as AbortSignal[];
      const res = await fetch(opts.url, {
        method,
        headers,
        body,
        signal: signals.length > 1 ? AbortSignal.any(signals) : signals[0],
      });
      const text = await res.text();
      let data: any = text;
      try { data = text ? JSON.parse(text) : undefined; } catch { /* non-JSON, keep text */ }
      if (!res.ok) {
        const err: any = new Error(`Request failed ${res.status} ${res.statusText}`);
        err.response = { status: res.status, data };
        throw err;
      }
      return { data, status: res.status, statusText: res.statusText };
    },
    async getRequestHeaders() {
      return authHeaders();
    },
  };
}

/** signal-cli-rest-api sends to a group by putting "group.<base64(internalId)>" in recipients.
 *  Received messages carry the raw internal id; the groups list already gives "group.<base64>". */
export function groupRecipient(groupId: string): string {
  return groupId.startsWith('group.') ? groupId : `group.${Buffer.from(groupId, 'utf8').toString('base64')}`;
}

export class SignalCliRestBackend implements MessagingBackend {
  readonly platform: string;
  readonly botId: string;
  readonly url: string;
  private readonly token?: string;
  private readonly noAuth: boolean;
  private client?: Promise<HttpRequester>;

  private onItem?: (item: IncomingItem) => Promise<void>;
  private mode: 'unknown' | 'poll' | 'ws' | 'off' = 'unknown';
  private ws: WebSocket | null = null;
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private wsFailCount = 0;
  private lastError: string | null = null;

  constructor(cfg: SignalCliRestConfig) {
    this.platform = cfg.platform;
    this.url = cfg.url.replace(/\/+$/, '');
    this.botId = cfg.botId;
    this.token = cfg.token || undefined;
    this.noAuth = !!cfg.noAuth || !!this.token || /^http:\/\//i.test(this.url);
  }

  /** The HTTP client for this bridge: Google OIDC for a Cloud Run bridge, plain otherwise. */
  requester(): Promise<HttpRequester> {
    if (!this.client) {
      this.client = this.noAuth
        ? Promise.resolve(makePlainRequester(this.token))
        : new GoogleAuth().getIdTokenClient(this.url).then((c) => c as unknown as HttpRequester);
    }
    return this.client;
  }

  private get numberPath() {
    return encodeURIComponent(this.botId);
  }

  /** Call a bridge endpoint directly, for signal-cli-specific operations outside the interface
   *  (e.g. answering a rate-limit captcha). `path` starts with '/'. */
  async request(path: string, opts: { method?: string; data?: unknown; timeoutMs?: number; signal?: AbortSignal } = {}) {
    const client = await this.requester();
    return client.request({
      url: `${this.url}${path}`,
      method: opts.method || 'GET',
      headers: { 'Content-Type': 'application/json' },
      data: opts.data,
      timeout: opts.timeoutMs,
      signal: opts.signal,
    });
  }

  accountPath(suffix = ''): string {
    return `/v1/accounts/${this.numberPath}${suffix}`;
  }

  sendToGroup(groupId: string, msg: OutgoingMessage, opts?: SendOptions) {
    return this.send(groupRecipient(groupId), msg, opts);
  }

  sendToPerson(personId: string, msg: OutgoingMessage, opts?: SendOptions) {
    // The bridge rejects bare numbers; a "+" in front of a non-number id is accepted.
    const to = /^\d+$/.test(personId) ? `+${personId}` : personId;
    return this.send(to, msg, opts);
  }

  private async send(recipient: string, msg: OutgoingMessage, opts: SendOptions = {}) {
    const data: any = { number: this.botId, message: msg.message, recipients: [recipient] };
    if (msg.mentions && msg.mentions.length > 0) data.mentions = msg.mentions;
    if (msg.attachment?.dataB64) {
      // base64_attachments item: data:<mime>;filename=<name>;base64,<data>
      const a = msg.attachment;
      data.base64_attachments = [`data:${a.contentType};filename=${a.filename};base64,${a.dataB64}`];
    }
    const res = await this.request('/v2/send', {
      method: 'POST',
      data,
      timeoutMs: opts.timeoutMs ?? 45000,
      signal: opts.signal,
    });
    // Answers { "timestamp": <ms> } (number or string depending on version).
    const ts = Number((res?.data as any)?.timestamp);
    if (!(Number.isFinite(ts) && ts > 0)) {
      // Not fatal — the message went out — but without it no reaction can ever be matched back
      // to this post. Loud, because it would be invisible.
      console.warn(
        `[${this.platform}] send returned no usable timestamp (reactions/showcase disabled for this post): ${JSON.stringify(res?.data)?.slice(0, 200)}`
      );
      return undefined;
    }
    return ts;
  }

  async listGroups(opts: { timeoutMs?: number } = {}): Promise<BackendGroup[]> {
    const res = await this.request(`/v1/groups/${this.numberPath}`, { timeoutMs: opts.timeoutMs ?? 30000 });
    const groups = (res as any)?.data;
    if (!Array.isArray(groups)) {
      throw new Error(`Groups list response is not an array: ${JSON.stringify(groups)?.slice(0, 200)}`);
    }
    return groups.map((g: any) => ({ ...g, id: g.id || (g.internal_id ? `group.${g.internal_id}` : '') }));
  }

  receiverDiagnostics(): ReceiverDiagnostics {
    return { mode: this.mode, lastError: this.lastError };
  }

  // ── Receiving ──────────────────────────────────────────────────────────────
  // The bridge can run in poll (normal/native) mode, where GET /v1/receive returns an array, or
  // json-rpc mode, where receiving is a WebSocket. Probe once, then keep whichever works.

  private async deliver(raw: any): Promise<void> {
    // json-rpc WS sends { jsonrpc, method: 'receive', params: { envelope, account } }.
    // poll/GET sends { envelope, account }. Normalize to the latter.
    const item = raw && raw.method === 'receive' && raw.params ? raw.params : raw;
    await this.onItem?.(item).catch((err) => console.error(`[${this.platform}] Error handling incoming message:`, err));
  }

  async startReceiving(onItem: (item: IncomingItem) => Promise<void>): Promise<void> {
    this.onItem = onItem;
    try {
      const res = await this.request(`/v1/receive/${this.numberPath}`, { timeoutMs: 8000 });
      if (Array.isArray((res as any)?.data)) {
        const messages = (res as any).data as any[];
        if (messages.length > 0) {
          console.log(`[${this.platform}] probe drained ${messages.length} queued message(s)`);
          for (const item of messages) await this.deliver(item);
        }
        this.startPoll();
        return;
      }
      console.warn(`[${this.platform}] probe: receive GET returned non-array; using ws receiver`);
      this.startWs();
    } catch (err: any) {
      const status = err?.response?.status;
      const body =
        typeof err?.response?.data === 'string' ? err.response.data : JSON.stringify(err?.response?.data || '');
      this.lastError = `probe: ${status || ''} ${body || err?.message || ''}`.trim();
      console.warn(`[${this.platform}] probe failed (${this.lastError}); defaulting to ws receiver`);
      // json-rpc mode commonly 400s the GET; the ws receiver falls back to poll if it can't connect.
      this.startWs();
    }
  }

  stopReceiving(): void {
    this.mode = 'off'; // makes the ws-close/poll handlers stop reconnecting
    if (this.pollTimer) { clearInterval(this.pollTimer); this.pollTimer = null; }
    if (this.ws) { try { this.ws.close(); } catch { /* ignore */ } this.ws = null; }
  }

  /** One GET poll. Returns false if the bridge doesn't support poll-mode receive
   *  (non-array body, 400 json-rpc hint, or 404) so the caller can switch to WS. */
  private async pollOnce(): Promise<boolean> {
    try {
      const res = await this.request(`/v1/receive/${this.numberPath}`, { timeoutMs: 10000 });
      const messages = (res as any)?.data;
      if (!Array.isArray(messages)) {
        this.lastError = `poll: non-array body (${typeof messages}) — bridge likely in json-rpc mode`;
        console.warn(`[${this.platform}] ${this.lastError}; switching to ws receiver`);
        return false;
      }
      if (messages.length > 0) {
        console.log(`[${this.platform}] Received ${messages.length} message(s) via poll`);
        for (const item of messages) await this.deliver(item);
      }
      return true;
    } catch (err: any) {
      const status = err?.response?.status;
      const body =
        typeof err?.response?.data === 'string' ? err.response.data : JSON.stringify(err?.response?.data || '');
      const msg = String(err?.message || err);
      if (status === 404 || msg.includes('404') || msg.includes('Not Found')) {
        this.lastError = 'poll: 404 — trying ws receiver';
        console.warn(`[${this.platform}] receive GET 404; switching to ws receiver`);
        return false;
      }
      if (status === 400 && /websocket|json[\s_-]?rpc/i.test(body)) {
        this.lastError = `poll: 400 json-rpc hint — switching to ws (${body.substring(0, 120)})`;
        console.warn(`[${this.platform}] receive GET says json-rpc/websocket; switching to ws receiver`);
        return false;
      }
      this.lastError = `poll: ${msg}`;
      console.warn(`[${this.platform}] receive poll failed (will retry):`, msg);
      return true; // transient — stay in poll mode
    }
  }

  private startPoll(): void {
    this.mode = 'poll';
    console.log(`[${this.platform}] receive mode: poll (GET /v1/receive)`);
    if (this.pollTimer) clearInterval(this.pollTimer);
    const tick = async () => {
      const ok = await this.pollOnce().catch((e) => {
        this.lastError = `poll: ${String(e?.message || e)}`;
        return true;
      });
      if (ok === false) {
        if (this.pollTimer) {
          clearInterval(this.pollTimer);
          this.pollTimer = null;
        }
        this.startWs();
      }
    };
    this.pollTimer = setInterval(tick, POLL_MS);
    tick(); // immediate first poll
  }

  private startWs(): void {
    this.mode = 'ws';
    const wsUrl = `${this.url.replace(/^http/i, 'ws')}/v1/receive/${this.numberPath}`;

    (async () => {
      let authorization: string | undefined;
      try {
        const client = await this.requester();
        const hdrs: any = await client.getRequestHeaders(this.url);
        authorization =
          hdrs?.Authorization ||
          hdrs?.authorization ||
          (typeof hdrs?.get === 'function' ? hdrs.get('Authorization') : undefined);
      } catch (e) {
        console.error(`[${this.platform}] ws auth header fetch failed`, e);
      }

      console.log(`[${this.platform}] receive mode: ws — connecting ${wsUrl}`);
      const ws = new WebSocket(wsUrl, authorization ? { headers: { Authorization: authorization } } : undefined);
      this.ws = ws;
      let opened = false;
      // A socket can die without a close (a dropped NAT/VPC path): ping it, and drop it when
      // a ping goes unanswered so the close handler reconnects. Any frame counts as alive.
      let alive = true;
      let watchdog: ReturnType<typeof setInterval> | null = null;
      ws.on('pong', () => { alive = true; });

      ws.on('open', () => {
        opened = true;
        this.wsFailCount = 0;
        this.lastError = null;
        console.log(`[${this.platform}] receive websocket open`);
        watchdog = setInterval(() => {
          if (!alive) {
            console.warn(`[${this.platform}] receive websocket unresponsive; reconnecting`);
            ws.terminate();
            return;
          }
          alive = false;
          try { ws.ping(); } catch { /* close follows */ }
        }, WS_PING_MS);
      });
      ws.on('message', (data) => {
        alive = true;
        try {
          this.deliver(JSON.parse(data.toString())).catch(() => {});
        } catch (e) {
          console.warn(`[${this.platform}] ws message parse error`, e);
        }
      });
      ws.on('error', (err: any) => {
        this.lastError = `ws: ${String(err?.message || err)}`;
        console.error(`[${this.platform}] receive websocket error:`, err?.message || err);
      });
      ws.on('close', (code) => {
        if (watchdog) clearInterval(watchdog);
        this.ws = null;
        console.warn(`[${this.platform}] receive websocket closed (code=${code}, opened=${opened})`);
        if (this.mode !== 'ws') return;
        if (!opened) this.wsFailCount++;
        if (this.wsFailCount >= 3) {
          this.wsFailCount = 0;
          console.warn(`[${this.platform}] ws failed to connect repeatedly; falling back to poll receiver`);
          this.startPoll();
          return;
        }
        setTimeout(() => {
          if (this.mode === 'ws') this.startWs();
        }, 3000);
      });
    })();
  }
}
