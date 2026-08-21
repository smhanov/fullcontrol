#!/usr/bin/env node
// Isolated regression test for FullControl trusted clicks.
//
// Spins up its OWN relay (port 18766) + its OWN google-chrome (fresh profile,
// headless, own debug port) so the production fc-chrome on :100/9224/18765 is
// never touched. Loads the extension via CDP Extensions.loadUnpacked, points
// it at the test relay, opens the trusted-click fixture, and asserts that a
// ref-based click registers as a TRUSTED click (isTrusted === true).
//
// Usage:
//   node test/click-fix-test.mjs          # assert ref-click WORKS (post-fix)
//   node test/click-fix-test.mjs --expect-fail  # assert it FAILS (pre-fix repro)
//
// Exit 0 = expectation met, 1 = not.

import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { setTimeout as sleep } from "node:timers/promises";
import WebSocket from "../node_modules/ws/wrapper.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const EXPECT_FAIL = process.argv.includes("--expect-fail");

const RELAY_PORT = 18766;
const STATIC_PORT = 18999;
const DEBUG_PORT = 9333;
const BASE = `http://127.0.0.1:${RELAY_PORT}`;
const TOKEN_FILE = "/tmp/fc-test-token";
const PROFILE = "/tmp/fc-test-profile";
const EXT = path.join(ROOT, "extension");
const FIXTURE = `http://127.0.0.1:${STATIC_PORT}/trusted.html`;

const results = [];
let serverProc = null, chromeProc = null, staticProc = null;
let token = "";

function log(msg) { console.log(`[fc-test] ${msg}`); }

async function api(method, pathname, body) {
  const url = new URL(pathname, BASE);
  const headers = { authorization: `Bearer ${token}`, "content-type": "application/json" };
  const res = await fetch(url, { method, headers, body: body !== undefined ? JSON.stringify(body) : undefined });
  const ct = res.headers.get("content-type") || "";
  let data = ct.includes("json") ? await res.json() : await res.text();
  if (!res.ok) {
    const err = new Error(`${method} ${pathname} -> ${res.status} ${JSON.stringify(data)}`);
    err.status = res.status; err.data = data;
    throw err;
  }
  return data;
}

async function cdp(method, params = {}) {
  const info = await fetch(`http://127.0.0.1:${DEBUG_PORT}/json/version`).then(r => r.json());
  const ws = new WebSocket(info.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
  const id = Math.floor(Math.random() * 1e9);
  const result = await new Promise((res, rej) => {
    ws.onmessage = (ev) => {
      const m = JSON.parse(ev.data);
      if (m.id === id) res(m);
    };
    ws.send(JSON.stringify({ id, method, params }));
    setTimeout(() => rej(new Error(`cdp timeout ${method}`)), 15000);
  });
  ws.close();
  if (result.error) throw new Error(`${method}: ${result.error.message}`);
  return result.result;
}

let extId = "";
async function swEvaluate(expression) {
  // Find OUR extension's service worker target (filter by ext id — headless
  // chrome has built-in extension SWs that sort first) and evaluate in it.
  const targets = await fetch(`http://127.0.0.1:${DEBUG_PORT}/json/list`).then(r => r.json());
  const sw = targets.find(t => t.type === "service_worker" && t.url.startsWith(`chrome-extension://${extId}`));
  if (!sw) throw new Error("extension service worker not found");
  const ws = new WebSocket(sw.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
  const id = Math.floor(Math.random() * 1e9);
  const out = await new Promise((res, rej) => {
    ws.onmessage = (ev) => {
      const m = JSON.parse(ev.data);
      if (m.id === id) res(m);
    };
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
    env: {
      ...process.env,
      FULLCONTROL_PORT: String(RELAY_PORT),
      FULLCONTROL_HOST: "127.0.0.1",
      FULLCONTROL_TOKEN_FILE: TOKEN_FILE,
      // Isolated tab-ownership store — never touch the production relay's
      // .tabmeta.json (the test Chrome's tabs are not real).
      FC_TABMETA_FILE: path.join(ROOT, "test", `.tabmeta-${RELAY_PORT}.json`),
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  serverProc.stdout.on("data", d => process.env.FC_TEST_VERBOSE && process.stdout.write(`[relay] ${d}`));
  serverProc.stderr.on("data", d => process.stderr.write(`[relay:err] ${d}`));
}

function startStatic() {
  staticProc = spawn("python3", ["-m", "http.server", String(STATIC_PORT), "--bind", "127.0.0.1", "--directory", path.join(ROOT, "test")], {
    stdio: ["ignore", "pipe", "pipe"],
  });
}

function startChrome() {
  fs.rmSync(PROFILE, { recursive: true, force: true });
  fs.mkdirSync(PROFILE, { recursive: true });
  const chrome = "/usr/bin/google-chrome";
  const args = [
    `--user-data-dir=${PROFILE}`,
    `--remote-debugging-port=${DEBUG_PORT}`,
    "--remote-allow-origins=*",
    "--headless=new",
    "--no-first-run", "--no-default-browser-check", "--disable-sync",
    "--disable-features=MemorySaver,DiscardHeuristics",
    "--enable-unsafe-extension-debugging",
    "--window-size=1280,900",
    "about:blank",
  ];
  log(`launching ${chrome} (debug :${DEBUG_PORT})`);
  chromeProc = spawn(chrome, args, { stdio: ["ignore", "pipe", "pipe"] });
  chromeProc.stdout.on("data", d => process.env.FC_TEST_VERBOSE && process.stdout.write(`[chrome] ${d}`));
  chromeProc.stderr.on("data", d => process.env.FC_TEST_VERBOSE && process.stderr.write(`[chrome:err] ${d}`));
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

function cleanup() {
  for (const p of [chromeProc, serverProc, staticProc]) {
    if (!p) continue;
    try { p.kill("SIGKILL"); } catch {}
  }
}

async function main() {
  process.on("exit", cleanup);
  startRelay();
  startStatic();
  await waitFor(async () => (await fetch(`http://127.0.0.1:${STATIC_PORT}/trusted.html`)).ok, 10000, 200, "static server");
  await waitFor(async () => (await fetch(`${BASE}/health`)).ok, 10000, 200, "relay health");

  token = fs.readFileSync(TOKEN_FILE, "utf8").trim();
  log(`token ${token.slice(0, 8)}…`);

  startChrome();

  // Load the extension via CDP (--load-extension is ignored on Chrome 151+).
  await waitFor(async () => (await fetch(`http://127.0.0.1:${DEBUG_PORT}/json/version`)).ok, 20000, 300, "chrome debug port");
  const loaded = await cdp("Extensions.loadUnpacked", { path: EXT });
  extId = loaded.id;
  log(`extension loaded: ${extId}`);

  // Point the extension at the TEST relay. Setting storage.local fires the
  // SW's storage.onChanged → pushConfig(), which tells the offscreen doc to
  // disconnect and reconnect to the new URL. No extension reload needed
  // (reload is flaky for offscreen docs in headless).
  await waitFor(async () => {
    try {
      await swEvaluate(`chrome.storage.local.set({ relayUrl: "ws://127.0.0.1:${RELAY_PORT}/extension", token: ${JSON.stringify(token)} })`);
      return true;
    } catch { return false; }
  }, 20000, 300, "extension service worker");
  await sleep(500);

  // Wait for the extension to connect to the test relay.
  await waitFor(async () => {
    const h = await fetch(`${BASE}/health`).then(r => r.json());
    return h.extensionConnected;
  }, 45000, 400, "extension connected to test relay");
  await sleep(1500);

  // Open the fixture in a new tab.
  const created = await api("POST", "/tabs", { url: FIXTURE, active: true, waitUntil: true });
  const tabId = created.tab.id;
  await sleep(800);

  const logText = async () =>
    (await api("POST", `/tabs/${tabId}/evaluate`, { expression: "document.getElementById('log').textContent" })).result;

  // --- Diagnostic: prove the page rejects raw synthetic clicks (pre-fix repro). ---
  await check("fixture rejects raw synthetic click (diagnostic)", async () => {
    await api("POST", `/tabs/${tabId}/evaluate`, {
      expression: `(() => { const b = document.getElementById('btn'); b.dispatchEvent(new MouseEvent('pointerdown', {bubbles:true})); b.dispatchEvent(new MouseEvent('mousedown', {bubbles:true})); b.dispatchEvent(new MouseEvent('click', {bubbles:true})); return true; })()`,
    });
    const txt = await logText();
    if (!txt.includes("ignored synthetic click")) throw new Error(`page did not reject synthetic: ${txt}`);
  });

  // --- The actual regression: ref-based click via the API must register as trusted. ---
  await check("ref click registers as trusted (API /click {ref})", async () => {
    const snap = await api("POST", `/tabs/${tabId}/snapshot`, { interestingOnly: true });
    const btn = snap.nodes.find(n => n.id === "btn");
    if (!btn) throw new Error("btn not in snapshot: " + JSON.stringify(snap.nodes.slice(0, 10)));
    await api("POST", `/tabs/${tabId}/click`, { ref: btn.ref });
    await sleep(300);
    const txt = await logText();
    if (!txt.includes("#btn ACTIVATED")) throw new Error(`ref click did not register: ${txt}`);
  });

  // --- Trusted x/y click must also work (existing CDP path, sanity). ---
  await check("x/y click registers as trusted", async () => {
    const snap = await api("POST", `/tabs/${tabId}/snapshot`, { interestingOnly: true });
    const btn = snap.nodes.find(n => n.id === "btn2");
    if (!btn) throw new Error("btn2 not in snapshot");
    const x = btn.bbox.x + Math.floor(btn.bbox.w / 2);
    const y = btn.bbox.y + Math.floor(btn.bbox.h / 2);
    await api("POST", `/tabs/${tabId}/click`, { x, y });
    await sleep(300);
    const txt = await logText();
    if (!txt.includes("#btn2 ACTIVATED")) throw new Error(`x/y click did not register: ${txt}`);
  });

  const allOk = results.every(r => r.ok);
  const passed = allOk === !EXPECT_FAIL;
  console.log(JSON.stringify({ expectFail: EXPECT_FAIL, passed, results }, null, 2));
  cleanup();
  process.exit(passed ? 0 : 1);
}

main().catch(async (err) => {
  console.error("[fc-test] aborted:", err.message);
  console.log(JSON.stringify({ expectFail: EXPECT_FAIL, passed: false, results }, null, 2));
  cleanup();
  process.exit(1);
});
