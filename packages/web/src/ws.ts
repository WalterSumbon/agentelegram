/**
 * WebSocket client — connects then authenticates via in-band auth message.
 *
 * Flow:
 * 1. Open WebSocket (no credentials in URL)
 * 2. Send { type: "auth", token: "<jwt>" }
 * 3. Wait for { type: "auth_ok" } before sending other events
 */
import type { ClientEvent, ServerEvent } from '@agentelegram/shared';

type EventHandler = (event: ServerEvent & Record<string, unknown>) => void;
type ConnectHandler = () => void;

let socket: WebSocket | null = null;
let handlers: EventHandler[] = [];
let connectHandlers: ConnectHandler[] = [];
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
let currentToken: string | null = null;
let pendingEvents: ClientEvent[] = [];
let authenticated = false;

export function connectWs(token: string): void {
  currentToken = token;
  authenticated = false;

  if (socket && (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING)) {
    return;
  }

  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  const url = `${protocol}//${window.location.host}/ws`;
  const ws = new WebSocket(url);
  socket = ws;

  ws.onopen = () => {
    console.log('[ws] connected, sending auth...');
    // Send auth message immediately — no credentials in URL
    ws.send(JSON.stringify({ type: 'auth', token }));
  };

  ws.onmessage = (ev) => {
    try {
      const event = JSON.parse(ev.data);

      // Handle auth_ok — connection is now fully authenticated
      if (event.type === 'auth_ok') {
        console.log('[ws] authenticated as', event.participantName);
        authenticated = true;
        // Flush pending events
        const queued = pendingEvents.splice(0);
        for (const qe of queued) {
          ws.send(JSON.stringify(qe));
        }
        // Notify connect handlers
        for (const h of connectHandlers) h();
        return;
      }

      for (const h of handlers) h(event);
    } catch (err) {
      console.error('[ws] parse error:', err);
    }
  };

  ws.onclose = (ev) => {
    console.log('[ws] closed:', ev.code, ev.reason);
    authenticated = false;
    // Only clear if this is still the active socket (prevents HMR race)
    if (socket === ws) socket = null;
    // Auto-reconnect unless auth failure
    if (ev.code !== 4001 && currentToken) {
      reconnectTimer = setTimeout(() => connectWs(currentToken!), 2000);
    }
  };

  ws.onerror = (err) => {
    console.error('[ws] error:', err);
  };
}

export function disconnectWs(): void {
  currentToken = null;
  authenticated = false;
  pendingEvents = [];
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
  if (socket) {
    socket.close();
    socket = null;
  }
}

/**
 * Send an event. If the socket isn't authenticated yet, queue it for delivery after auth_ok.
 */
export function sendWsEvent(event: ClientEvent): void {
  if (socket?.readyState === WebSocket.OPEN && authenticated) {
    socket.send(JSON.stringify(event));
  } else {
    pendingEvents.push(event);
  }
}

export function onWsEvent(handler: EventHandler): () => void {
  handlers.push(handler);
  return () => {
    handlers = handlers.filter((h) => h !== handler);
  };
}

/**
 * Register a handler that fires every time the WS (re)connects and authenticates.
 */
export function onWsConnect(handler: ConnectHandler): () => void {
  connectHandlers.push(handler);
  return () => {
    connectHandlers = connectHandlers.filter((h) => h !== handler);
  };
}
