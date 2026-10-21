import type { LobbySummary } from './schemas';
import { normalizeLobbySummary } from './NetworkManager';

export type LobbyDirectoryConnectionState =
  | 'connecting'
  | 'live'
  | 'polling'
  | 'offline';

/**
 * Lightweight read-only directory connection. It never sends account or
 * session credentials: public lobby discovery only needs the server-owned
 * lobby summaries, while actual create/join authentication happens on the
 * separate NetworkManager room socket.
 */
export class LobbyBrowserClient {
  public onLobbies?: (lobbies: LobbySummary[]) => void;
  public onConnectionState?: (
    state: LobbyDirectoryConnectionState,
    message: string
  ) => void;
  public onPing?: (pingMs: number | null) => void;

  private ws: WebSocket | null = null;
  private active = false;
  private connectionGeneration = 0;
  private reconnectTimer: number | null = null;
  private pingTimer: number | null = null;
  private pollTimer: number | null = null;
  private lastPingSentAt = 0;

  public constructor(
    private readonly webSocketUrl: string,
    private readonly httpBaseUrl: string
  ) {}

  public start(): void {
    if (this.active) {
      this.requestList();
      return;
    }
    this.active = true;
    this.connect();
  }

  public stop(): void {
    this.active = false;
    this.connectionGeneration++;
    this.clearTimer('reconnectTimer');
    this.clearTimer('pingTimer');
    this.clearTimer('pollTimer');
    if (this.ws) {
      const socket = this.ws;
      this.ws = null;
      socket.onopen = null;
      socket.onmessage = null;
      socket.onclose = null;
      socket.onerror = null;
      try {
        if (socket.readyState === WebSocket.OPEN) {
          socket.send(JSON.stringify({ type: 'lobby_list_unsubscribe' }));
        }
      } catch {
        // Closing below also unsubscribes server-side.
      }
      try {
        socket.close();
      } catch {
        // Ignore already-closed sockets.
      }
    }
    this.onPing?.(null);
  }

  public requestList(): void {
    if (this.ws?.readyState === WebSocket.OPEN) {
      try {
        this.ws.send(
          JSON.stringify({
            type: 'lobby_list_request',
            requestId: `list_${Date.now()}`,
          })
        );
        return;
      } catch {
        // Fall through to HTTP polling.
      }
    }
    void this.fetchList();
  }

  private clearTimer(name: 'reconnectTimer' | 'pingTimer' | 'pollTimer'): void {
    if (this[name] !== null) {
      window.clearTimeout(this[name] as number);
      this[name] = null;
    }
  }

  private connect(): void {
    if (!this.active) return;
    const generation = ++this.connectionGeneration;
    this.onConnectionState?.('connecting', 'Connecting to the live lobby server…');

    try {
      const socket = new WebSocket(this.webSocketUrl);
      this.ws = socket;

      socket.onopen = () => {
        if (!this.active || generation !== this.connectionGeneration) return;
        this.clearTimer('pollTimer');
        this.onConnectionState?.('live', 'Live lobby updates connected.');
        try {
          socket.send(
            JSON.stringify({
              type: 'lobby_list_subscribe',
              requestId: `subscribe_${Date.now()}`,
            })
          );
        } catch {
          this.beginPolling(generation);
          return;
        }
        this.startPingLoop(socket, generation);
      };

      socket.onmessage = (event) => {
        if (!this.active || generation !== this.connectionGeneration) return;
        try {
          const data = JSON.parse(String(event.data)) as Record<string, unknown>;
          if (data.type === 'pong') {
            const clientTime = Number(data.clientTime || 0);
            if (clientTime > 0) {
              this.onPing?.(Math.max(1, Math.round(performance.now() - clientTime)));
            } else if (this.lastPingSentAt > 0) {
              this.onPing?.(
                Math.max(1, Math.round(performance.now() - this.lastPingSentAt))
              );
            }
            return;
          }
          if (data.type === 'lobby_list' || data.type === 'lobby_list_updated') {
            const rawLobbies = Array.isArray(data.lobbies) ? data.lobbies : [];
            this.onLobbies?.(
              rawLobbies.map((lobby) =>
                normalizeLobbySummary(lobby as Record<string, unknown>)
              )
            );
          }
        } catch {
          // Ignore one malformed directory packet; the next update wins.
        }
      };

      socket.onerror = () => {
        if (!this.active || generation !== this.connectionGeneration) return;
        this.beginPolling(generation);
      };

      socket.onclose = () => {
        if (!this.active || generation !== this.connectionGeneration) return;
        this.ws = null;
        this.clearTimer('pingTimer');
        this.beginPolling(generation);
        this.reconnectTimer = window.setTimeout(() => {
          if (this.active) this.connect();
        }, 3000);
      };
    } catch {
      this.beginPolling(generation);
    }
  }

  private startPingLoop(socket: WebSocket, generation: number): void {
    this.clearTimer('pingTimer');
    const sendPing = () => {
      if (!this.active || generation !== this.connectionGeneration) return;
      if (socket.readyState !== WebSocket.OPEN) return;
      this.lastPingSentAt = performance.now();
      try {
        socket.send(
          JSON.stringify({ type: 'ping', clientTime: this.lastPingSentAt })
        );
      } catch {
        return;
      }
      this.pingTimer = window.setTimeout(sendPing, 5000);
    };
    sendPing();
  }

  private beginPolling(generation: number): void {
    if (!this.active || generation !== this.connectionGeneration) return;
    this.onConnectionState?.(
      'polling',
      'Live socket unavailable — refreshing lobbies over HTTP…'
    );
    void this.fetchList();
    this.clearTimer('pollTimer');
    const poll = () => {
      if (!this.active || generation !== this.connectionGeneration) return;
      void this.fetchList();
      this.pollTimer = window.setTimeout(poll, 4000);
    };
    this.pollTimer = window.setTimeout(poll, 4000);
  }

  private async fetchList(): Promise<void> {
    if (!this.active || typeof fetch !== 'function') return;
    try {
      const response = await fetch(`${this.httpBaseUrl}/api/lobbies`);
      if (!response.ok) throw new Error('Lobby list request failed');
      const data = (await response.json()) as Record<string, unknown>;
      const rawLobbies = Array.isArray(data.lobbies) ? data.lobbies : [];
      if (!this.active) return;
      this.onLobbies?.(
        rawLobbies.map((lobby) =>
          normalizeLobbySummary(lobby as Record<string, unknown>)
        )
      );
    } catch {
      if (this.active) {
        this.onConnectionState?.(
          'offline',
          'Could not reach the lobby server. Check your connection and retry.'
        );
      }
    }
  }
}
