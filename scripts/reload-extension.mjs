#!/usr/bin/env node
// Reload the FullControl extension on a running Chrome via its service worker.
// Usage: node reload-extension.mjs <debugPort>
// Tabs are untouched; only the extension reloads (background.js + offscreen).
import WebSocket from "/home/smhanov/fullcontrol/node_modules/ws/wrapper.mjs";

const DEBUG_PORT = process.argv[2] || "9224";

async function getJson(path) {
  const r = await fetch(`http://127.0.0.1:${DEBUG_PORT}${path}`);
  return r.json();
}

async function connect(wsUrl, fn) {
  const ws = new WebSocket(wsUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
  try {
    return await fn(ws);
  } finally {
    ws.close();
  }
}

// Find the FullControl extension SW target (id known from loadUnpacked; match
// by URL containing background.js and NOT built-in extensions).
const targets = await getJson("/json/list");
const sw = targets.find(t =>
  t.type === "service_worker" &&
  /chrome-extension:\/\/[a-z]+\/background\.js/.test(t.url) &&
  !/nmmhkkeg|nkeimhog|fignfif|ghbmnnj/.test(t.url)
);
if (!sw) {
  console.error("FullControl service worker not found. Targets:");
  for (const t of targets) console.error(" ", t.type, t.url);
  process.exit(1);
}
console.log("SW:", sw.url);

const res = await connect(sw.webSocketDebuggerUrl, (ws) => {
  const id = Math.floor(Math.random() * 1e9);
  return new Promise((resolve, reject) => {
    ws.onmessage = (ev) => {
      const m = JSON.parse(ev.data);
      if (m.id === id) resolve(m);
    };
    ws.send(JSON.stringify({ id, method: "Runtime.evaluate", params: { expression: "chrome.runtime.reload()", awaitPromise: true } }));
    setTimeout(() => reject(new Error("timeout")), 10000);
  });
});
if (res.result?.exceptionDetails) {
  console.error("reload threw:", JSON.stringify(res.result.exceptionDetails));
  process.exit(1);
}
console.log("chrome.runtime.reload() dispatched — extension reloading.");
