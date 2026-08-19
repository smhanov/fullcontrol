#!/usr/bin/env node
// Concurrency test: multiple agents driving one FullControl browser.
//
// Spins up its OWN relay (:18768) + OWN headless google-chrome (fresh
// profile, debug :9336) + OWN static server (:18998). Loads the extension via
// CDP Extensions.loadUnpacked, points it at the test relay, then verifies:
//   1. lease claim/release
//   2. agent B write on A's leased tab -> 409
//   3. reads (snapshot) NOT blocked by another agent's lease
//   4. lease expiry (short ttl) -> B can write after it lapses
//   5. write renews the lease
//   6. force-release
//   7. per-window mutex: two agents writing different tabs in same window
//   8. per-agent windows: POST /windows + scoped GET /tabs?windowId=N
//   9. WS event filter (?window=N only gets that window's events)
//
// Usage: node test/concurrency-test.mjs
// Exit 0 = all pass, 1 = failure. Never touches the production relay/browser.

import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { setTimeout as sleep } from "node:timers/promises";
import WebSocket from "../node_modules/ws/wrapper.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const RELAY_PORT = 18768;
const STATIC_PORT = 18998;
const DEBUG_PORT = 9336;
const BASE = `http://127.0.0.1:${RELAY_PORT}`;
const TOKEN_FILE = "/tmp/fc-test-token";
const PROFILE = "/tmp/fc-test-profile-conc";
const EXT = path.join(ROOT, "extension");
const FIXTURE = `http://127.0.0.1:${STATIC_PORT}/trusted.html`;

const results = [];
let serverProc = null, chromeProc = null, staticProc = null;
let token = "";

function log(msg) { console.log(`[conc] ${msg}`); }

async function api(method, pathname, body, agentId, expectStatus) {
  const headers = {
    authorization: `Bearer ${token}`,
    "content-type": "application/json",
  };
  if (agentId) headers["x-agent-id"] = agentId;
  const res = await fetch(new URL(pathname, BASE), {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const ct = res.headers.get("content-type") || "";
  let data = ct.includes("json") ? await res.json() : await res.text();
  if (expectStatus && res.status !== expectStatus) {
    throw new Error(`${method} ${pathname} (agent ${agentId}): expected ${expectStatus}, got ${res.status}: ${JSON.stringify(data)}`);
  }
  if (res.status >= 400 && !expectStatus) {
    throw new Error(`${method} ${pathname} (agent ${agentId}): ${res.status} ${JSON.stringify(data)}`);
  }
  return { status: res.status, data };
}

async function cdp(method, params = {}) {
  const info = await fetch(`http://127.0.0.1:${DEBUG_PORT}/json/version`).then((r) => r.json());
  const ws = new WebSocket(info.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
  const id = Math.floor(Math.random() * 1e9);
  const result = await new Promise((res, rej) => {
    ws.onmessage = (ev) => { const m = JSON.parse(ev.data); if (m.id === id) res(m); };
    ws.send(JSON.stringify({ id, method, params }));
    setTimeout(() => rej(new Error(`cdp timeout ${method}`)), 15000);
  });
  ws.close();
  if (result.error) throw new Error(`${method}: ${result.error.message}`);
  return result.result;
}

let extId = "";
async function swEvaluate(expression) {
  const targets = await fetch(`http://127.0.0.1:${DEBUG_PORT}/json/list`).then((r) => r.json());
  const sw = targets.find((t) => t.type === "service_worker" && t.url.startsWith(`chrome-extension://${extId}`));
  if (!sw) throw new Error("extension service worker not found");
  const ws = new WebSocket(sw.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
  const id = Math.floor(Math.random() * 1e9);
  const out = await new Promise((res, rej) => {
    ws.onmessage = (ev) => { const m = JSON.parse(ev.data); if (m.id === id) res(m); };
    ws.send(JSON.stringify({ id, method: "Runtime.evaluate", params: { expression, awaitPromise: true, returnByValue: true } }));
    setTimeout(() => rej(new Error("sw evaluate timeout")), 15000);
  });
  ws.close();
  if (out.result?.exceptionDetails) throw new Error(`sw eval exception: ${JSON.stringify(out.result.exceptionDetails)}`);
  return out.result?.result?.value;
}

function startRelay() {
  serverProc = spawn("node", ["server/index.js"], {
    cwd: ROOT,
    env: { ...process.env, FULLCONTROL_PORT: String(RELAY_PORT), FULLCONTROL_HOST: "127.0.0.1", FULLCONTROL_TOKEN_FILE: TOKEN_FILE },
    stdio: ["ignore", "pipe", "pipe"],
  });
  serverProc.stdout.on("data", (d) => process.env.FC_TEST_VERBOSE && process.stdout.write(`[relay] ${d}`));
  serverProc.stderr.on("data", (d) => process.stderr.write(`[relay:err] ${d}`));
}

function startStatic() {
  staticProc = spawn("python3", ["-m", "http.server", String(STATIC_PORT), "--bind", "127.0.0.1", "--directory", path.join(ROOT, "test")], {
    stdio: ["ignore", "pipe", "pipe"],
  });
}

function startChrome() {
  fs.rmSync(PROFILE, { recursive: true, force: true });
  fs.mkdirSync(PROFILE, { recursive: true });
  chromeProc = spawn("/usr/bin/google-chrome", [
    `--user-data-dir=${PROFILE}`,
    `--remote-debugging-port=${DEBUG_PORT}`,
    "--remote-allow-origins=*",
    "--headless=new",
    "--no-first-run", "--no-default-browser-check", "--disable-sync",
    "--disable-features=MemorySaver,DiscardHeuristics",
    "--enable-unsafe-extension-debugging",
    "--window-size=1280,900",
    "about:blank",
  ], { stdio: ["ignore", "pipe", "pipe"] });
  chromeProc.stdout.on("data", (d) => process.env.FC_TEST_VERBOSE && process.stdout.write(`[chrome] ${d}`));
  chromeProc.stderr.on("data", (d) => process.env.FC_TEST_VERBOSE && process.stderr.write(`[chrome:err] ${d}`));
}

async function waitFor(fn, timeout = 30000, interval = 300, label = "condition") {
  const start = Date.now();
  let last = "";
  while (Date.now() - start < timeout) {
    try { const v = await fn(); if (v) return v; } catch (e) { last = e.message; }
    await sleep(interval);
  }
  throw new Error(`timeout waiting for ${label}${last ? `: ${last}` : ""}`);
}

async function check(name, fn) {
  const start = Date.now();
  try {
    await fn();
    results.push({ name, ok: true, ms: Date.now() - start });
    log(`PASS ${name} (${Date.now() - start}ms)`);
  } catch (err) {
    results.push({ name, ok: false, ms: Date.now() - start, error: err.message });
    log(`FAIL ${name}: ${err.message}`);
    throw err;
  }
}

async function newTab(url = FIXTURE, agent = "default") {
  const { data } = await api("POST", "/tabs", { url, active: true, waitUntil: true }, agent);
  await sleep(800);
  return data.tab;
}

async function clickRef(tab, agent) {
  const { data: snap } = await api("POST", `/tabs/${tab.id}/snapshot`, { interestingOnly: true }, agent);
  const btn = snap.nodes.find((n) => n.id === "btn");
  if (!btn) throw new Error("btn not in snapshot");
  return api("POST", `/tabs/${tab.id}/click`, { ref: btn.ref }, agent);
}

function cleanup() {
  for (const p of [chromeProc, serverProc, staticProc]) if (p) { try { p.kill("SIGKILL"); } catch {} }
}

async function main() {
  process.on("exit", cleanup);
  startRelay();
  startStatic();
  await waitFor(async () => (await fetch(`http://127.0.0.1:${STATIC_PORT}/trusted.html`)).ok, 10000, 200, "static server");
  await waitFor(async () => (await fetch(`${BASE}/health`)).ok, 10000, 200, "relay health");
  token = fs.readFileSync(TOKEN_FILE, "utf8").trim();

  startChrome();
  await waitFor(async () => (await fetch(`http://127.0.0.1:${DEBUG_PORT}/json/version`)).ok, 20000, 300, "chrome debug port");
  const loaded = await cdp("Extensions.loadUnpacked", { path: EXT });
  extId = loaded.id;
  await waitFor(async () => {
    try {
      await swEvaluate(`chrome.storage.local.set({ relayUrl: "ws://127.0.0.1:${RELAY_PORT}/extension", token: ${JSON.stringify(token)} })`);
      return true;
    } catch { return false; }
  }, 20000, 300, "extension service worker");
  await sleep(500);
  await waitFor(async () => (await fetch(`${BASE}/health`).then((r) => r.json())).extensionConnected, 45000, 400, "extension connected");
  await sleep(1500);

  let tabA;

  // 1. Lease claim + write by same agent.
  await check("lease claim + own write", async () => {
    tabA = await newTab();
    await api("POST", `/tabs/${tabA.id}/lease`, { ttlMs: 60000 }, "agent-a");
    const r = await clickRef(tabA, "agent-a");
    if (r.status !== 200) throw new Error(`own write failed: ${r.status}`);
  });

  // 2. Agent B write on A's leased tab -> 409.
  await check("agent B write on leased tab -> 409", async () => {
    const { data } = await api("POST", `/tabs/${tabA.id}/click`, { ref: "e1" }, "agent-b", 409);
    const msg = typeof data === "string" ? data : data.error || JSON.stringify(data);
    if (!/leased by agent "agent-a"/.test(msg)) throw new Error(`unexpected error: ${msg}`);
  });

  // 3. Reads not blocked by lease.
  await check("agent B read (snapshot) not blocked", async () => {
    const r = await api("POST", `/tabs/${tabA.id}/snapshot`, { interestingOnly: true }, "agent-b");
    if (r.status !== 200) throw new Error(`snapshot blocked: ${r.status}`);
  });

  // 4. Lease expiry.
  await check("lease expires -> agent B can write", async () => {
    const { data } = await api("POST", "/tabs", { url: FIXTURE, active: true, waitUntil: true }, "agent-b");
    const tab = data.tab;
    await sleep(500);
    await api("POST", `/tabs/${tab.id}/lease`, { ttlMs: 1200 }, "agent-a");
    await sleep(1600); // let it lapse
    const r = await clickRef(tab, "agent-b");
    if (r.status !== 200) throw new Error(`write after expiry blocked: ${r.status}`);
    await api("DELETE", `/tabs/${tab.id}`, undefined, "default");
  });

  // 5. Write renews the lease.
  await check("write renews lease", async () => {
    await api("POST", `/tabs/${tabA.id}/lease`, { ttlMs: 1500 }, "agent-a");
    await sleep(900);
    await clickRef(tabA, "agent-a"); // renews to +60s
    await sleep(1100); // past original expiry but within renewed
    const { data } = await api("POST", `/tabs/${tabA.id}/click`, { ref: "e1" }, "agent-b", 409);
    const msg = typeof data === "string" ? data : data.error || JSON.stringify(data);
    if (!/leased by agent "agent-a"/.test(msg)) throw new Error(`lease not renewed: ${msg}`);
  });

  // 6. Force release.
  await check("force release", async () => {
    await api("POST", `/tabs/${tabA.id}/release`, { force: true }, "agent-b");
    const r = await clickRef(tabA, "agent-b");
    if (r.status !== 200) throw new Error(`write after force release blocked: ${r.status}`);
    await api("POST", `/tabs/${tabA.id}/release`, {}, "agent-b");
  });

  // 7. Per-window mutex: two agents write different tabs in the SAME window.
  await check("per-window mutex (concurrent writes both succeed, serialized)", async () => {
    const { data: winData } = await api("POST", "/windows", { url: FIXTURE }, "agent-a");
    const winId = winData.window?.id;
    if (!winId) throw new Error("no window id: " + JSON.stringify(winData));
    const mk = await api("POST", "/tabs", { url: FIXTURE, active: true, windowId: winId, waitUntil: true }, "agent-a");
    const tab1 = mk.data.tab;
    await sleep(500);
    const mk2 = await api("POST", "/tabs", { url: FIXTURE, active: true, windowId: winId, waitUntil: true }, "agent-b");
    const tab2 = mk2.data.tab;
    await sleep(500);
    // Fire both writes at once; the mutex must serialize them, not drop one.
    const [r1, r2] = await Promise.allSettled([
      clickRef(tab1, "agent-a"),
      clickRef(tab2, "agent-b"),
    ]);
    if (r1.status !== "fulfilled" || r1.value.status !== 200) throw new Error(`agent-a write failed: ${JSON.stringify(r1)}`);
    if (r2.status !== "fulfilled" || r2.value.status !== 200) throw new Error(`agent-b write failed: ${JSON.stringify(r2)}`);
    await api("DELETE", `/tabs/${tab1.id}`, undefined, "agent-a");
    await api("DELETE", `/tabs/${tab2.id}`, undefined, "agent-b");
  });

  // 8. Per-agent windows + scoped tab list.
  await check("per-agent windows + scoped list", async () => {
    const w1 = await api("POST", "/windows", { url: FIXTURE }, "agent-a");
    const w2 = await api("POST", "/windows", { url: FIXTURE }, "agent-b");
    const id1 = w1.data.window.id, id2 = w2.data.window.id;
    if (!id1 || !id2 || id1 === id2) throw new Error(`bad window ids ${id1}/${id2}`);
    await api("POST", "/tabs", { url: FIXTURE, active: true, windowId: id1, waitUntil: true }, "agent-a");
    await api("POST", "/tabs", { url: FIXTURE, active: true, windowId: id2, waitUntil: true }, "agent-b");
    await sleep(800);
    const a = await api("GET", `/tabs?windowId=${id1}`, undefined, "agent-a");
    const b = await api("GET", `/tabs?windowId=${id2}`, undefined, "agent-b");
    const tabsA = a.data.tabs, tabsB = b.data.tabs;
    if (!tabsA.length || !tabsB.length) throw new Error(`empty scoped lists A=${tabsA.length} B=${tabsB.length}`);
    if (tabsA.some((t) => t.windowId !== id1)) throw new Error("A sees non-A tab");
    if (tabsB.some((t) => t.windowId !== id2)) throw new Error("B sees non-B tab");
    // cleanup windows
    await api("DELETE", `/tabs/${tabsA[0].id}`, undefined, "agent-a");
    await api("DELETE", `/tabs/${tabsB[0].id}`, undefined, "agent-b");
    // closeWindow via rpc (no relay route yet; direct method)
    await api("POST", "/rpc", { method: "closeWindow", params: { windowId: id1 } }, "agent-a");
    await api("POST", "/rpc", { method: "closeWindow", params: { windowId: id2 } }, "agent-b");
  });

  // 9. WS event filter.
  await check("WS event filter (?window=N)", async () => {
    const win = await api("POST", "/windows", { url: FIXTURE }, "agent-a");
    const winId = win.data.window.id;
    const events = [];
    const ws = new WebSocket(`ws://127.0.0.1:${RELAY_PORT}/agent?token=${token}&window=${winId}&agentId=agent-a`);
    await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
    ws.onmessage = (ev) => {
      const m = JSON.parse(ev.data);
      if (m.type === "event") events.push(m);
    };
    await sleep(500);
    // Create a tab in THIS window -> event should arrive.
    const t = await api("POST", "/tabs", { url: FIXTURE, active: true, windowId: winId, waitUntil: true }, "agent-a");
    await sleep(800);
    // Create a tab in a DIFFERENT window -> should NOT arrive.
    const { data: wins } = await api("GET", "/windows", undefined, "agent-b");
    const otherWin = wins.windows.find((w) => w.id !== winId);
    if (!otherWin) throw new Error("no second window available for leak check");
    const other = await api("POST", "/tabs", { url: FIXTURE, active: true, windowId: otherWin.id, waitUntil: true }, "agent-b");
    await sleep(800);
    ws.close();
    const inWin = events.some((e) => e.tabId === t.data.tab.id || (e.tab && e.tab.id === t.data.tab.id));
    const leaked = events.some((e) => e.tabId === other.data.tab.id || (e.tab && e.tab.id === other.data.tab.id));
    if (!inWin) throw new Error("own-window event never arrived: " + JSON.stringify(events.slice(-3)));
    if (leaked) throw new Error("other-window event leaked through filter: " + JSON.stringify(events.slice(-3)));
    await api("DELETE", `/tabs/${t.data.tab.id}`, undefined, "agent-a");
    await api("DELETE", `/tabs/${other.data.tab.id}`, undefined, "agent-b");
    await api("POST", "/rpc", { method: "closeWindow", params: { windowId: winId } }, "agent-a");
  });

  // 10. Leases listing.
  await check("GET /leases lists active lease", async () => {
    await api("POST", `/tabs/${tabA.id}/lease`, { ttlMs: 30000 }, "agent-a");
    const { data } = await api("GET", "/leases", undefined, "agent-b");
    const hit = data.leases.find((l) => l.tabId === tabA.id && l.agentId === "agent-a");
    if (!hit) throw new Error("lease not listed: " + JSON.stringify(data.leases));
    await api("POST", `/tabs/${tabA.id}/release`, {}, "agent-a");
  });

  await api("DELETE", `/tabs/${tabA.id}`, undefined, "default");

  const allOk = results.every((r) => r.ok);
  console.log(JSON.stringify({ passed: allOk, results }, null, 2));
  cleanup();
  process.exit(allOk ? 0 : 1);
}

main().catch(async (err) => {
  console.error("[conc] aborted:", err.message);
  console.log(JSON.stringify({ passed: false, results }, null, 2));
  cleanup();
  process.exit(1);
});
