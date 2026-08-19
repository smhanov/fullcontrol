#!/usr/bin/env node
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import { WebSocketServer, WebSocket } from "ws";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const HOST = process.env.FULLCONTROL_HOST || "0.0.0.0";
const PORT = Number(process.env.FULLCONTROL_PORT || 18765);
const TOKEN_FILE = process.env.FULLCONTROL_TOKEN_FILE || path.join(ROOT, ".token");

function loadOrCreateToken() {
  if (process.env.FULLCONTROL_TOKEN) return process.env.FULLCONTROL_TOKEN;
  try {
    const existing = fs.readFileSync(TOKEN_FILE, "utf8").trim();
    if (existing) return existing;
  } catch {}
  const token = crypto.randomBytes(24).toString("hex");
  fs.writeFileSync(TOKEN_FILE, token + "\n", { mode: 0o600 });
  return token;
}

const TOKEN = loadOrCreateToken();

let extensionSocket = null;
let nextReqId = 1;
const pending = new Map();
const agentClients = new Set();
const eventLog = [];
const MAX_EVENTS = 200;

// --- Concurrency: agent identity, tab leases, per-window write serialization ---
// Multiple agents can drive the same browser. Rules:
//   - Every request carries an agent id (X-Agent-Id header or ?agentId=);
//     default "default".
//   - A tab can be LEASED by one agent. Write actions (click/type/press/
//     select/navigate/reload/back/forward/scroll/hover/activate) are rejected
//     with 409 when another agent holds the lease. Read actions (snapshot,
//     screenshot, evaluate, console, wait) stay open to everyone.
//   - Writes to tabs in the SAME WINDOW serialize through a per-window mutex,
//     so two agents cannot fight over the visible tab / click ordering.
//   - Agents can mint their own window (POST /windows) and scope everything
//     to it via ?windowId= — the full isolation story.
const AGENT_HEADER = "x-agent-id";
const LEASE_TTL_MS = 5 * 60 * 1000; // default lease length
const leases = new Map(); // tabId -> { agentId, expiresAt }
const windowQueues = new Map(); // windowId -> Promise (write queue tail)
const tabWindowCache = new Map(); // tabId -> windowId (for mutex routing)

const WRITE_ACTIONS = new Set([
  "click", "type", "press", "select", "navigate", "reload", "back",
  "forward", "scroll", "hover", "activate",
]);
const MUTEX_ACTIONS = new Set([
  "click", "type", "press", "select", "navigate", "reload", "back",
  "forward", "scroll", "hover", "activate", "screenshot",
]);

function agentIdOf(req, url) {
  const h = req.headers[AGENT_HEADER];
  if (h) return String(h).slice(0, 64);
  return (url.searchParams.get("agentId") || "default").slice(0, 64);
}

function agentIdOfWs(ws) {
  return ws.agentId || "default";
}

function leaseFor(tabId) {
  const l = leases.get(tabId);
  if (!l) return null;
  if (l.expiresAt < Date.now()) {
    leases.delete(tabId);
    return null;
  }
  return l;
}

function checkLease(tabId, agentId) {
  const l = leaseFor(tabId);
  if (l && l.agentId !== agentId) {
    const err = new Error(
      `tab ${tabId} is leased by agent "${l.agentId}" (expires ${new Date(l.expiresAt).toISOString()})`
    );
    err.status = 409;
    throw err;
  }
  return l;
}

async function tabWindowId(tabId) {
  if (tabWindowCache.has(tabId)) return tabWindowCache.get(tabId);
  try {
    const tabs = await sendToExtension("listTabs", { query: {} });
    for (const t of tabs) tabWindowCache.set(t.id, t.windowId);
    return tabWindowCache.get(tabId) || null;
  } catch {
    return null;
  }
}

function withWindowMutex(windowId, fn) {
  if (!windowId) return fn();
  const prev = windowQueues.get(windowId) || Promise.resolve();
  const next = prev.then(fn, fn);
  windowQueues.set(windowId, next.catch(() => {})); // errors don't block the queue
  return next;
}

// Run a write action under lease check + per-window mutex.
async function guardedWrite(method, params, agentId, timeoutMs) {
  const tabId = Number(params.tabId);
  const lease = checkLease(tabId, agentId);
  if (lease) lease.expiresAt = Date.now() + LEASE_TTL_MS; // write renews the lease
  const winId = await tabWindowId(tabId);
  return withWindowMutex(winId, () => sendToExtension(method, params, timeoutMs));
}

function eventMatchesWindow(evt, windowId) {
  if (!windowId) return true;
  if (evt.windowId === windowId) return true;
  if (evt.tab && evt.tab.windowId === windowId) return true;
  if (evt.tabId != null && tabWindowCache.get(evt.tabId) === windowId) return true;
  return false;
}

function log(...args) {
  const ts = new Date().toISOString();
  console.log(ts, ...args);
}

function pushEvent(evt) {
  eventLog.push({ t: Date.now(), ...evt });
  if (eventLog.length > MAX_EVENTS) eventLog.shift();
  // Clean up relay-side state when tabs die.
  if (evt.event === "tabRemoved" && evt.tabId != null) {
    leases.delete(evt.tabId);
    tabWindowCache.delete(evt.tabId);
  }
  if (evt.tab && evt.tab.id != null && evt.tab.windowId != null) {
    tabWindowCache.set(evt.tab.id, evt.tab.windowId);
  }
  const payload = JSON.stringify({ type: "event", ...evt });
  for (const ws of agentClients) {
    if (ws.readyState === WebSocket.OPEN) {
      // Agents subscribed to a window only receive that window's events.
      if (ws.windowFilter && !eventMatchesWindow(evt, ws.windowFilter)) continue;
      ws.send(payload);
    }
  }
}

function sendToExtension(method, params, timeoutMs = 30000) {
  if (!extensionSocket || extensionSocket.readyState !== WebSocket.OPEN) {
    return Promise.reject(new Error("extension not connected"));
  }
  const id = nextReqId++;
  const msg = { type: "request", id, method, params: params || {} };
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`timeout waiting for ${method}`));
    }, timeoutMs);
    pending.set(id, {
      resolve: (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      reject: (e) => {
        clearTimeout(timer);
        reject(e);
      },
    });
    extensionSocket.send(JSON.stringify(msg));
  });
}

function handleExtensionMessage(raw) {
  let msg;
  try {
    msg = JSON.parse(raw);
  } catch {
    return;
  }
  if (msg.type === "hello") {
    extensionSocket.send(
      JSON.stringify({
        type: "welcome",
        token: TOKEN,
        httpPort: PORT,
        host: HOST,
      })
    );
    log("extension hello", msg.version || "");
    pushEvent({ event: "extensionConnected", version: msg.version });
    return;
  }
  if (msg.type === "ping") {
    extensionSocket.send(JSON.stringify({ type: "pong", t: msg.t }));
    return;
  }
  if (msg.type === "response") {
    const p = pending.get(msg.id);
    if (!p) return;
    pending.delete(msg.id);
    if (msg.error) p.reject(new Error(msg.error));
    else p.resolve(msg.result);
    return;
  }
  if (msg.type === "event") {
    pushEvent(msg);
  }
}

function authOk(req, url) {
  const header = req.headers.authorization || "";
  const bearer = header.startsWith("Bearer ") ? header.slice(7).trim() : "";
  const q = url.searchParams.get("token") || "";
  const x = req.headers["x-fullcontrol-token"] || "";
  const provided = bearer || q || x;
  return provided && provided === TOKEN;
}

function json(res, status, body) {
  const data = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "access-control-allow-origin": "*",
    "access-control-allow-headers": "authorization, content-type, x-fullcontrol-token",
    "access-control-allow-methods": "GET,POST,PUT,DELETE,OPTIONS",
    "cache-control": "no-store",
  });
  res.end(data);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let n = 0;
    req.on("data", (c) => {
      n += c.length;
      if (n > 20 * 1024 * 1024) {
        reject(new Error("body too large"));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => {
      if (!chunks.length) {
        resolve({});
        return;
      }
      const raw = Buffer.concat(chunks).toString("utf8");
      if (!raw) {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(raw));
      } catch {
        reject(new Error("invalid json"));
      }
    });
    req.on("error", reject);
  });
}

async function route(req, res, url) {
  if (req.method === "OPTIONS") {
    res.writeHead(204, {
      "access-control-allow-origin": "*",
      "access-control-allow-headers": "authorization, content-type, x-fullcontrol-token",
      "access-control-allow-methods": "GET,POST,PUT,DELETE,OPTIONS",
    });
    res.end();
    return;
  }

  if (url.pathname === "/health") {
    json(res, 200, {
      ok: true,
      extensionConnected: !!(extensionSocket && extensionSocket.readyState === WebSocket.OPEN),
      port: PORT,
    });
    return;
  }

  if (url.pathname === "/") {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(indexHtml());
    return;
  }

  if (url.pathname === "/openapi.json") {
    json(res, 200, openApi());
    return;
  }

  if (url.pathname === "/fixture") {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
    res.end(fs.readFileSync(path.join(__dirname, "fixture.html")));
    return;
  }

  if (!authOk(req, url)) {
    json(res, 401, { error: "unauthorized: provide Bearer token, ?token=, or X-Fullcontrol-Token" });
    return;
  }

  try {
    await handleApi(req, res, url);
  } catch (err) {
    if (err.status === 409) {
      json(res, 409, { error: err.message });
      return;
    }
    const status = /not connected/i.test(err.message) ? 503 : 400;
    json(res, status, { error: err.message || String(err) });
  }
}

async function handleApi(req, res, url) {
  const p = url.pathname;
  const method = req.method;

  if (p === "/status" && method === "GET") {
    const ext = extensionSocket && extensionSocket.readyState === WebSocket.OPEN
      ? await sendToExtension("getStatus", {}).catch((e) => ({ error: e.message }))
      : null;
    json(res, 200, {
      extensionConnected: !!(extensionSocket && extensionSocket.readyState === WebSocket.OPEN),
      agents: agentClients.size,
      port: PORT,
      extension: ext,
    });
    return;
  }

  if (p === "/events" && method === "GET") {
    json(res, 200, { events: eventLog });
    return;
  }

  if (p === "/rpc" && method === "POST") {
    const body = await readBody(req);
    if (!body.method) throw new Error("method required");
    const result = await sendToExtension(body.method, body.params || {}, body.timeout || 30000);
    json(res, 200, { result });
    return;
  }

  if (p === "/windows" && method === "GET") {
    json(res, 200, { windows: await sendToExtension("listWindows", {}) });
    return;
  }

  if (p === "/windows" && method === "POST") {
    // Mint a window for an agent. Default focused:false — do NOT steal the
    // user's focus (see extension v1.0.1 note). Agents scope tabs to it via
    // ?windowId= for full isolation.
    const body = await readBody(req);
    const win = await sendToExtension("createWindow", {
      url: body.url,
      focused: body.focused === true,
      state: body.state,
    });
    if (win && win.id) tabWindowCache.set(win.id, win.id);
    json(res, 200, { window: win });
    return;
  }

  if (p === "/leases" && method === "GET") {
    const now = Date.now();
    const active = [];
    for (const [tabId, l] of leases) {
      if (l.expiresAt > now) active.push({ tabId, agentId: l.agentId, expiresAt: l.expiresAt });
      else leases.delete(tabId);
    }
    json(res, 200, { leases: active });
    return;
  }

  if (p === "/tabs" && method === "GET") {
    const query = {};
    if (url.searchParams.get("windowId")) query.windowId = Number(url.searchParams.get("windowId"));
    if (url.searchParams.get("active")) query.active = url.searchParams.get("active") === "true";
    const tabs = await sendToExtension("listTabs", { query });
    for (const t of tabs) if (t.id != null) tabWindowCache.set(t.id, t.windowId);
    json(res, 200, { tabs });
    return;
  }

  if (p === "/tabs" && method === "POST") {
    const body = await readBody(req);
    const tab = await sendToExtension("createTab", body);
    if (tab && tab.id != null) tabWindowCache.set(tab.id, tab.windowId);
    json(res, 200, { tab });
    return;
  }

  const tabMatch = p.match(/^\/tabs\/(\d+)(?:\/([a-zA-Z]+))?$/);
  if (tabMatch) {
    const tabId = Number(tabMatch[1]);
    const action = tabMatch[2] || "";
    const agentId = agentIdOf(req, url);

    // Lease management endpoints (relay-side, no extension call).
    if (action === "lease" && method === "POST") {
      const body = await readBody(req);
      const ttlMs = Math.max(1000, Number(body.ttlMs) || LEASE_TTL_MS);
      const existing = leaseFor(tabId);
      if (existing && existing.agentId !== agentId) {
        json(res, 409, {
          error: `tab ${tabId} leased by agent "${existing.agentId}"`,
          lease: { agentId: existing.agentId, expiresAt: existing.expiresAt },
        });
        return;
      }
      const expiresAt = Date.now() + ttlMs;
      leases.set(tabId, { agentId, expiresAt });
      json(res, 200, { ok: true, tabId, agentId, expiresAt });
      return;
    }
    if (action === "release" && method === "POST") {
      const existing = leaseFor(tabId);
      if (!existing) {
        json(res, 200, { ok: true, released: false });
        return;
      }
      if (existing.agentId !== agentId && !(await readBody(req)).force) {
        json(res, 409, { error: `tab ${tabId} leased by agent "${existing.agentId}"` });
        return;
      }
      leases.delete(tabId);
      json(res, 200, { ok: true, released: true });
      return;
    }

    if (!action && method === "GET") {
      const tabs = await sendToExtension("listTabs", { query: {} });
      const tab = tabs.find((t) => t.id === tabId);
      if (!tab) throw new Error("tab not found");
      json(res, 200, { tab });
      return;
    }
    if (!action && method === "DELETE") {
      leases.delete(tabId);
      tabWindowCache.delete(tabId);
      json(res, 200, await sendToExtension("closeTab", { tabId }));
      return;
    }
    if (!action && (method === "PATCH" || method === "PUT")) {
      const body = await readBody(req);
      const tab = await sendToExtension("updateTab", { tabId, update: body });
      if (tab && tab.id != null) tabWindowCache.set(tab.id, tab.windowId);
      json(res, 200, { tab });
      return;
    }
    if (method !== "POST" && method !== "GET") throw new Error("method not allowed");
    const body = method === "GET" ? Object.fromEntries(url.searchParams) : await readBody(req);
    const params = { tabId, ...body };

    // Lease enforcement: write actions 409 when another agent holds the tab.
    if (WRITE_ACTIONS.has(action)) {
      try {
        checkLease(tabId, agentId);
      } catch (err) {
        json(res, 409, { error: err.message });
        return;
      }
    }

    // Writes (and screenshots, which activate the tab) serialize per window.
    const runAction = async (methodName, extra) => {
      const result = await guardedWrite(methodName, params, agentId);
      return extra ? extra(result) : result;
    };

    switch (action) {
      case "activate":
        json(res, 200, { tab: await runAction("activateTab") });
        return;
      case "reload":
        json(res, 200, await runAction("reloadTab"));
        return;
      case "navigate":
        json(res, 200, { tab: await runAction("navigate") });
        return;
      case "back":
        json(res, 200, await runAction("goBack"));
        return;
      case "forward":
        json(res, 200, await runAction("goForward"));
        return;
      case "screenshot": {
        const shot = await guardedWrite("screenshot", params, agentId, 20000);
        if (url.searchParams.get("raw") === "1" || body.raw) {
          const buf = Buffer.from(shot.data, "base64");
          res.writeHead(200, {
            "content-type": shot.mimeType,
            "content-length": buf.length,
            "access-control-allow-origin": "*",
          });
          res.end(buf);
          return;
        }
        json(res, 200, shot);
        return;
      }
      case "snapshot":
        json(res, 200, await sendToExtension("snapshot", params, 20000));
        return;
      case "click":
        json(res, 200, await runAction("click"));
        return;
      case "type":
        json(res, 200, await runAction("type"));
        return;
      case "press":
        json(res, 200, await runAction("press"));
        return;
      case "hover":
        json(res, 200, await runAction("hover"));
        return;
      case "scroll":
        json(res, 200, await runAction("scroll"));
        return;
      case "select":
        json(res, 200, await runAction("select"));
        return;
      case "wait":
        json(res, 200, await sendToExtension("waitFor", params, params.timeout || 20000));
        return;
      case "evaluate":
        json(res, 200, await sendToExtension("evaluate", params));
        return;
      case "cdp":
        json(res, 200, await sendToExtension("cdp", params, params.timeout || 30000));
        return;
      case "attach":
        json(res, 200, await sendToExtension("attach", params));
        return;
      case "detach":
        json(res, 200, await sendToExtension("detach", params));
        return;
      case "console":
        json(res, 200, await sendToExtension("console", params));
        return;
      default:
        throw new Error(`unknown tab action: ${action}`);
    }
  }

  if (p === "/cookies" && method === "GET") {
    json(res, 200, {
      cookies: await sendToExtension("cookies", {
        url: url.searchParams.get("url") || undefined,
        domain: url.searchParams.get("domain") || undefined,
      }),
    });
    return;
  }

  if (p === "/cookies" && method === "POST") {
    json(res, 200, { cookie: await sendToExtension("setCookie", await readBody(req)) });
    return;
  }

  json(res, 404, { error: "not found" });
}

function indexHtml() {
  return `<!doctype html>
<html><head><meta charset="utf-8"><title>FullControl</title>
<style>
body{font:14px/1.45 ui-sans-serif,system-ui;max-width:720px;margin:40px auto;padding:0 16px;background:#111;color:#eee}
code{background:#222;padding:1px 5px;border-radius:4px}
pre{background:#1a1a1a;padding:12px;border-radius:8px;overflow:auto}
a{color:#8ab4ff}
</style></head><body>
<h1>FullControl Agent Relay</h1>
<p>HTTP + WebSocket control plane for the FullControl Chrome extension.</p>
<p>Auth: <code>Authorization: Bearer &lt;token&gt;</code> or <code>?token=</code></p>
<ul>
<li><a href="/health">/health</a> (no auth)</li>
<li><code>GET /status</code> <code>GET /tabs</code> <code>POST /tabs</code></li>
<li><code>POST /tabs/:id/navigate</code> <code>/screenshot</code> <code>/snapshot</code></li>
<li><code>POST /tabs/:id/click</code> <code>/type</code> <code>/press</code> <code>/evaluate</code> <code>/cdp</code></li>
<li><code>POST /rpc</code> generic method passthrough</li>
<li>WebSocket <code>/agent?token=...</code> for events + RPC</li>
</ul>
<p>See <a href="/openapi.json">/openapi.json</a></p>
</body></html>`;
}

function openApi() {
  return {
    openapi: "3.0.3",
    info: { title: "FullControl", version: "1.0.0" },
    servers: [{ url: `http://${HOST}:${PORT}` }],
    security: [{ bearer: [] }],
    components: {
      securitySchemes: { bearer: { type: "http", scheme: "bearer" } },
    },
    paths: {
      "/health": { get: { summary: "Health, no auth" } },
      "/status": { get: { summary: "Relay + extension status" } },
      "/tabs": {
        get: { summary: "List tabs (?windowId=N scopes to a window)" },
        post: { summary: "Create tab {url, active, waitUntil, windowId}" },
      },
      "/tabs/{id}": { delete: { summary: "Close tab (releases lease)" } },
      "/tabs/{id}/lease": { post: { summary: "Claim tab {ttlMs}; 409 if leased by another agent" } },
      "/tabs/{id}/release": { post: { summary: "Release lease {force?}" } },
      "/leases": { get: { summary: "List active leases" } },
      "/windows": {
        get: { summary: "List windows" },
        post: { summary: "Mint a window {url, focused?} for per-agent isolation" },
      },
      "/tabs/{id}/navigate": { post: { summary: "{url}" } },
      "/tabs/{id}/screenshot": { get: { summary: "PNG/JPEG screenshot" }, post: {} },
      "/tabs/{id}/snapshot": { get: { summary: "Accessibility-ish page snapshot" }, post: {} },
      "/tabs/{id}/click": { post: { summary: "{selector|ref|x,y}" } },
      "/tabs/{id}/type": { post: { summary: "{text, selector?, ref?}" } },
      "/tabs/{id}/evaluate": { post: { summary: "{expression, world?}" } },
      "/tabs/{id}/cdp": { post: { summary: "{method, params}" } },
      "/rpc": { post: { summary: "{method, params}" } },
    },
  };
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
  route(req, res, url).catch((err) => {
    json(res, 500, { error: err.message || String(err) });
  });
});

const wss = new WebSocketServer({ noServer: true });

server.on("upgrade", (req, socket, head) => {
  const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
  if (url.pathname === "/extension") {
    wss.handleUpgrade(req, socket, head, (ws) => {
      if (extensionSocket && extensionSocket.readyState === WebSocket.OPEN) {
        try {
          extensionSocket.close(4000, "replaced");
        } catch {}
      }
      extensionSocket = ws;
      log("extension connected");
      ws.on("message", (data) => handleExtensionMessage(data.toString()));
      ws.on("close", () => {
        if (extensionSocket === ws) extensionSocket = null;
        log("extension disconnected");
        pushEvent({ event: "extensionDisconnected" });
        for (const [, p] of pending) p.reject(new Error("extension disconnected"));
        pending.clear();
      });
      ws.on("error", (err) => log("extension ws error", err.message));
    });
    return;
  }
  if (url.pathname === "/agent") {
    if (!authOk(req, url)) {
      socket.write("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n");
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      // Concurrency: agents may identify themselves and subscribe to one
      // window's events (so agent B doesn't get spammed by agent A's churn).
      ws.agentId = (url.searchParams.get("agentId") || "default").slice(0, 64);
      ws.windowFilter = url.searchParams.get("window") ? Number(url.searchParams.get("window")) : null;
      agentClients.add(ws);
      log("agent connected", agentIdOfWs(ws), agentClients.size);
      ws.send(
        JSON.stringify({
          type: "welcome",
          extensionConnected: !!(extensionSocket && extensionSocket.readyState === WebSocket.OPEN),
          agentId: ws.agentId,
          windowFilter: ws.windowFilter,
        })
      );
      ws.on("message", async (data) => {
        let msg;
        try {
          msg = JSON.parse(data.toString());
        } catch {
          ws.send(JSON.stringify({ type: "error", error: "invalid json" }));
          return;
        }
        if (msg.type === "ping") {
          ws.send(JSON.stringify({ type: "pong", t: msg.t }));
          return;
        }
        const method = msg.method || msg.type;
        const id = msg.id;
        try {
          // Lease enforcement on WS writes too.
          if (WRITE_ACTIONS.has(method) && msg.params?.tabId != null) {
            checkLease(Number(msg.params.tabId), ws.agentId);
          }
          const result = await sendToExtension(method, msg.params || {}, msg.timeout || 30000);
          ws.send(JSON.stringify({ type: "response", id, result }));
        } catch (err) {
          ws.send(JSON.stringify({ type: "response", id, error: err.message || String(err) }));
        }
      });
      ws.on("close", () => {
        agentClients.delete(ws);
        log("agent disconnected", agentClients.size);
      });
    });
    return;
  }
  socket.destroy();
});

server.listen(PORT, HOST, () => {
  log(`FullControl relay listening on http://${HOST}:${PORT}`);
  log(`Token file: ${TOKEN_FILE}`);
  log(`Extension WS: ws://${HOST}:${PORT}/extension`);
  log(`Agent WS:     ws://${HOST}:${PORT}/agent?token=...`);
});

process.on("SIGINT", () => {
  server.close();
  process.exit(0);
});
