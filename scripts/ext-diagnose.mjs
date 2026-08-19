#!/usr/bin/env node
// Diagnose + recover the FullControl extension on a running Chrome.
// Usage: node ext-diagnose.mjs <debugPort>
// Actions: probe targets, check chrome.management state, optionally
// uninstall+loadUnpacked to force a clean reload (tabs untouched).
import WebSocket from "/home/smhanov/fullcontrol/node_modules/ws/wrapper.mjs";

const DEBUG_PORT = process.argv[2] || "9224";
const EXT_PATH = "/home/smhanov/fullcontrol/extension";
const EXT_ID = "jeemcinbgcbicgiiplmjjkdbbdaheffd";

async function getJson(path) {
  const r = await fetch(`http://127.0.0.1:${DEBUG_PORT}${path}`);
  return r.json();
}

async function cdp(method, params = {}) {
  const info = await getJson("/json/version");
  const ws = new WebSocket(info.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
  const id = Math.floor(Math.random() * 1e9);
  const result = await new Promise((res, rej) => {
    ws.onmessage = (ev) => { const m = JSON.parse(ev.data); if (m.id === id) res(m); };
    ws.send(JSON.stringify({ id, method, params }));
    setTimeout(() => rej(new Error(`timeout ${method}`)), 15000);
  });
  ws.close();
  if (result.error) throw new Error(`${method}: ${result.error.message}`);
  return result.result;
}

const targets = await getJson("/json/list");
const extTargets = targets.filter(t => t.url.startsWith(`chrome-extension://${EXT_ID}`));
console.log("extension targets:", extTargets.length, extTargets.map(t => `${t.type}:${t.url.slice(0, 60)}`).join(" | "));

// chrome.management.get works from any extension context; there is none now,
// so use the browser-level SystemInfo? No — management needs an ext context.
// Try to find ANY extension SW to run it, else report and loadUnpacked.
const anyExtSw = targets.find(t => t.type === "service_worker" && t.url.startsWith("chrome-extension://"));
console.log("other extension SWs:", anyExtSw ? anyExtSw.url : "none");

if (process.argv.includes("--recover")) {
  console.log("uninstalling + re-loading", EXT_ID);
  try {
    await cdp("Extensions.uninstall", { id: EXT_ID });
    console.log("uninstalled");
  } catch (e) {
    console.log("uninstall (may already be gone):", e.message);
  }
  await new Promise(r => setTimeout(r, 1000));
  const res = await cdp("Extensions.loadUnpacked", { path: EXT_PATH });
  console.log("loadUnpacked:", JSON.stringify(res));
}
