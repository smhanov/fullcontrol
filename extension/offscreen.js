const DEFAULT_RELAY = "ws://127.0.0.1:18765/extension";
const RECONNECT_MS = 800;
const HEARTBEAT_MS = 15000;

let socket = null;
let reconnectTimer = null;
let heartbeatTimer = null;
let relayUrl = DEFAULT_RELAY;
let token = "";
let connecting = false;

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (!msg || msg.channel !== "fc-offscreen") return;
  if (msg.type === "ping") {
    // Liveness probe from the SW (ensureOffscreen) — answer so the SW knows
    // this doc is alive and doesn't tear us down + recreate.
    sendResponse({ ok: true });
    return true;
  }
  if (msg.type === "keepalive") {
    // SW -> offscreen nudge; nothing to do, just keep the channel warm.
    return false;
  }
  if (msg.type === "config") {
    const nextUrl = msg.relayUrl || DEFAULT_RELAY;
    const nextToken = msg.token || "";
    const urlChanged = nextUrl !== relayUrl;
    relayUrl = nextUrl;
    token = nextToken;
    if (urlChanged || !socket || socket.readyState !== WebSocket.OPEN) {
      disconnect();
      connect();
    }
    sendResponse({ ok: true });
    return true;
  }
  if (msg.type === "send") {
    send(msg.payload);
    sendResponse({ ok: true });
    return true;
  }
  return false;
});

function disconnect() {
  if (heartbeatTimer) clearInterval(heartbeatTimer);
  heartbeatTimer = null;
  if (reconnectTimer) clearTimeout(reconnectTimer);
  reconnectTimer = null;
  if (socket) {
    try {
      socket.onopen = socket.onclose = socket.onerror = socket.onmessage = null;
      socket.close();
    } catch {}
    socket = null;
  }
  connecting = false;
}

function connect() {
  if (connecting) return;
  if (socket && (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING)) {
    return;
  }
  connecting = true;
  try {
    socket = new WebSocket(relayUrl);
  } catch (err) {
    connecting = false;
    chrome.runtime.sendMessage({ channel: "fc-relay", type: "status", connected: false, lastError: String(err) });
    scheduleReconnect();
    return;
  }
  socket.onopen = () => {
    connecting = false;
    chrome.runtime.sendMessage({ channel: "fc-relay", type: "status", connected: true, lastError: "" });
    send({ type: "hello", role: "extension", token, version: chrome.runtime.getManifest().version });
    heartbeatTimer = setInterval(() => send({ type: "ping", t: Date.now() }), HEARTBEAT_MS);
  };
  socket.onmessage = (ev) => {
    chrome.runtime.sendMessage({ channel: "fc-relay", type: "message", data: ev.data });
  };
  socket.onclose = () => {
    connecting = false;
    socket = null;
    if (heartbeatTimer) clearInterval(heartbeatTimer);
    heartbeatTimer = null;
    chrome.runtime.sendMessage({ channel: "fc-relay", type: "status", connected: false, lastError: "disconnected" });
    scheduleReconnect();
  };
  socket.onerror = () => {
    chrome.runtime.sendMessage({ channel: "fc-relay", type: "status", connected: false, lastError: "websocket error" });
  };
}

function scheduleReconnect() {
  if (reconnectTimer) return;
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    connect();
  }, RECONNECT_MS);
}

function send(obj) {
  if (socket && socket.readyState === WebSocket.OPEN) {
    socket.send(typeof obj === "string" ? obj : JSON.stringify(obj));
  }
}

chrome.storage.local.get(["relayUrl", "token"], (cfg) => {
  if (cfg.relayUrl) relayUrl = cfg.relayUrl;
  if (cfg.token) token = cfg.token;
  connect();
});
