/**
 * WebSocket client — connects with JWT, sends/receives chat protocol events.
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

export function connectWs(token: string): void {
  currentToken = token;
  if (socket && (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING)) {
    return;
  }

  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  const url = `${protocol}//${window.location.host}/ws?token=${encodeURIComponent(token)}`;
  socket = new WebSocket(url);

  socket.onopen = () => {
    console.log('[ws] connected');
    // Flush pending events
    const queued = pendingEvents.splice(0);
    for (const ev of queued) {
      socket!.send(JSON.stringify(ev));
    }
    // Notify connect handlers
    for (const h of connectHandlers) h();
  };

  socket.onmessage = (ev) => {
    try {
      const event = JSON.parse(ev.data);
      for (const h of handlers) h(event);
    } catch (err) {
      console.error('[ws] parse error:', err);
    }
  };

  socket.onclose = (ev) => {
    console.log('[ws] closed:', ev.code, ev.reason);
    socket = null;
    // Auto-reconnect unless auth failure
    if (ev.code !== 4001 && currentToken) {
      reconnectTimer = setTimeout(() => connectWs(currentToken!), 2000);
    }
  };

  socket.onerror = (err) => {
    console.error('[ws] error:', err);
  };
}

export function disconnectWs(): void {
  currentToken = null;
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
 * Send an event. If the socket isn't open yet, queue it for delivery on connect.
 */
export function sendWsEvent(event: ClientEvent): void {
  if (socket?.readyState === WebSocket.OPEN) {
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
 * Register a handler that fires every time the WS (re)connects.
 */
export function onWsConnect(handler: ConnectHandler): () => void {
  connectHandlers.push(handler);
  return () => {
    connectHandlers = connectHandlers.filter((h) => h !== handler);
  };
}
