#!/usr/bin/env node
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { setTimeout as sleep } from "node:timers/promises";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const PORT = Number(process.env.FULLCONTROL_PORT || 18765);
const BASE = `http://127.0.0.1:${PORT}`;
const PROFILE = path.join(ROOT, "test-profile");
const TOKEN_FILE = path.join(ROOT, ".token");
const EXT = path.join(ROOT, "extension");

const results = [];
let chromeProc = null;
let serverProc = null;
let token = "";

function log(msg) {
  console.log(`[e2e] ${msg}`);
}

async function api(method, pathname, body, extra = {}) {
  const url = new URL(pathname, BASE);
  if (extra.query) {
    for (const [k, v] of Object.entries(extra.query)) url.searchParams.set(k, v);
  }
  const headers = {
    authorization: `Bearer ${token}`,
    "content-type": "application/json",
  };
  const res = await fetch(url, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const ct = res.headers.get("content-type") || "";
  let data;
  if (extra.raw) {
    data = Buffer.from(await res.arrayBuffer());
    return { status: res.status, data, headers: res.headers };
  }
  if (ct.includes("json")) data = await res.json();
  else data = await res.text();
  if (!res.ok) {
    const err = new Error(`${method} ${pathname} -> ${res.status} ${JSON.stringify(data)}`);
    err.status = res.status;
    err.data = data;
    throw err;
  }
  return data;
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

function waitFor(fn, timeout = 30000, interval = 250, label = "condition") {
  const start = Date.now();
  return (async () => {
    let last = "";
    while (Date.now() - start < timeout) {
      try {
        const v = await fn();
        if (v) return v;
      } catch (err) {
        last = err.message;
      }
      await sleep(interval);
    }
    throw new Error(`timeout waiting for ${label}${last ? `: ${last}` : ""}`);
  })();
}

function findChrome() {
  const candidates = [
    process.env.CHROME_PATH,
    path.join(ROOT, ".tools/chrome-linux64/chrome"),
    "/usr/bin/google-chrome",
    "/usr/bin/google-chrome-stable",
    "/usr/bin/chromium-browser",
    "/usr/bin/chromium",
  ].filter(Boolean);
  for (const c of candidates) {
    if (fs.existsSync(c)) return c;
  }
  throw new Error("chrome not found");
}

function startServer() {
  serverProc = spawn("node", ["server/index.js"], {
    cwd: ROOT,
    env: { ...process.env, FULLCONTROL_PORT: String(PORT), FULLCONTROL_HOST: "127.0.0.1" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  serverProc.stdout.on("data", (d) => process.stdout.write(`[relay] ${d}`));
  serverProc.stderr.on("data", (d) => process.stderr.write(`[relay] ${d}`));
}

function startChrome() {
  fs.rmSync(PROFILE, { recursive: true, force: true });
  fs.mkdirSync(PROFILE, { recursive: true });
  const prefsDir = path.join(PROFILE, "Default");
  fs.mkdirSync(prefsDir, { recursive: true });
  // Auto-allow debugger attach so CDP commands don't stall on an infobar.
  fs.writeFileSync(
    path.join(prefsDir, "Preferences"),
    JSON.stringify({
      profile: { exit_type: "Normal" },
      extensions: { ui: { developer_mode: true } },
    })
  );

  const chrome = findChrome();
  const args = [
    `--user-data-dir=${PROFILE}`,
    `--disable-extensions-except=${EXT}`,
    `--load-extension=${EXT}`,
    "--enable-unsafe-extension-debugging",
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-sync",
    "--disable-background-networking",
    "--disable-client-side-phishing-detection",
    "--disable-component-update",
    "--disable-default-apps",
    "--disable-hang-monitor",
    "--disable-popup-blocking",
    "--disable-prompt-on-repost",
    "--disable-translate",
    "--metrics-recording-only",
    "--safebrowsing-disable-auto-update",
    "--password-store=basic",
    "--use-mock-keychain",
    "--disable-features=Translate,MediaRouter,OptimizationHints",
    "--remote-debugging-port=0",
    "--window-size=1280,900",
    "--window-position=80,80",
    `${BASE}/fixture`,
  ];
  if (!process.env.DISPLAY) args.push("--headless=new");
  log(`launching ${chrome}`);
  chromeProc = spawn(chrome, args, {
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, HOME: PROFILE },
  });
  chromeProc.stdout.on("data", (d) => {
    const s = d.toString();
    if (process.env.E2E_VERBOSE) process.stdout.write(`[chrome] ${s}`);
  });
  chromeProc.stderr.on("data", (d) => {
    const s = d.toString();
    if (process.env.E2E_VERBOSE) process.stderr.write(`[chrome] ${s}`);
  });
}

async function cleanup() {
  if (chromeProc) {
    chromeProc.kill("SIGTERM");
    await sleep(500);
    try {
      chromeProc.kill("SIGKILL");
    } catch {}
  }
  if (serverProc) {
    serverProc.kill("SIGTERM");
    await sleep(200);
    try {
      serverProc.kill("SIGKILL");
    } catch {}
  }
}

async function main() {
  process.on("exit", () => {
    try {
      chromeProc?.kill("SIGKILL");
    } catch {}
    try {
      serverProc?.kill("SIGKILL");
    } catch {}
  });

  startServer();
  await waitFor(async () => {
    const r = await fetch(`${BASE}/health`);
    return r.ok;
  }, 10000, 100, "relay health");

  token = fs.readFileSync(TOKEN_FILE, "utf8").trim();
  log(`token ${token.slice(0, 8)}…`);

  startChrome();

  await waitFor(async () => {
    const h = await fetch(`${BASE}/health`).then((r) => r.json());
    return h.extensionConnected;
  }, 45000, 400, "extension websocket");
  // service worker / offscreen may flap once while storing the token
  await sleep(1500);
  await waitFor(async () => {
    const h = await fetch(`${BASE}/health`).then((r) => r.json());
    return h.extensionConnected;
  }, 15000, 200, "stable extension websocket");

  await check("status", async () => {
    const s = await api("GET", "/status");
    if (!s.extensionConnected) throw new Error("not connected");
  });

  let tab;
  await check("list/create tabs", async () => {
    const listed = await api("GET", "/tabs");
    if (!Array.isArray(listed.tabs)) throw new Error("no tabs array");
    const created = await api("POST", "/tabs", { url: `${BASE}/fixture`, active: true, waitUntil: true });
    tab = created.tab;
    if (!tab?.id) throw new Error("createTab failed");
    if (!/fixture/.test(tab.url || "")) {
      // may still be pending; navigate explicitly
    }
  });

  await check("navigate + wait", async () => {
    const r = await api("POST", `/tabs/${tab.id}/navigate`, { url: `${BASE}/fixture`, waitUntil: true });
    tab = r.tab;
    if (!/fixture/.test(tab.url)) throw new Error(`unexpected url ${tab.url}`);
  });

  await check("evaluate", async () => {
    const r = await api("POST", `/tabs/${tab.id}/evaluate`, {
      expression: "document.title",
    });
    if (r.result !== "FullControl Fixture") throw new Error(`title=${r.result}`);
  });

  let snap;
  await check("snapshot", async () => {
    snap = await api("POST", `/tabs/${tab.id}/snapshot`, { interestingOnly: true });
    if (!snap.nodes || snap.nodes.length < 3) throw new Error(`few nodes: ${snap.nodes?.length}`);
    const btn = snap.nodes.find((n) => n.id === "go" || n.name === "Click me");
    if (!btn) throw new Error("button not in snapshot: " + JSON.stringify(snap.nodes.slice(0, 8)));
  });

  await check("type into input", async () => {
    await api("POST", `/tabs/${tab.id}/type`, { selector: "#name", text: "Ada", clear: true });
    const r = await api("POST", `/tabs/${tab.id}/evaluate`, {
      expression: "document.getElementById('name').value",
    });
    if (r.result !== "Ada") throw new Error(`typed value=${r.result}`);
  });

  await check("select option", async () => {
    await api("POST", `/tabs/${tab.id}/select`, { selector: "#color", values: ["green"] });
    const r = await api("POST", `/tabs/${tab.id}/evaluate`, {
      expression: "document.getElementById('color').value",
    });
    if (r.result !== "green") throw new Error(`select value=${r.result}`);
  });

  await check("click button", async () => {
    await api("POST", `/tabs/${tab.id}/click`, { selector: "#go" });
    await sleep(200);
    const r = await api("POST", `/tabs/${tab.id}/evaluate`, {
      expression: "document.getElementById('out').textContent",
    });
    if (r.result !== "clicked:Ada:green") throw new Error(`out=${r.result}`);
  });

  await check("screenshot", async () => {
    const shot = await api("GET", `/tabs/${tab.id}/screenshot`);
    if (!shot.data || shot.data.length < 100) throw new Error("empty screenshot");
    const buf = Buffer.from(shot.data, "base64");
    if (buf[0] !== 0x89 || buf[1] !== 0x50) throw new Error("not a png");
    fs.writeFileSync(path.join(ROOT, "test-screenshot.png"), buf);
  });

  await check("cdp Runtime.evaluate", async () => {
    const r = await api("POST", `/tabs/${tab.id}/cdp`, {
      method: "Runtime.evaluate",
      params: { expression: "1+2", returnByValue: true },
    });
    if (r.result?.result?.value !== 3 && r.result?.value !== 3) {
      // shape: { result: { result: { value: 3 } } }
      const v = r.result?.result?.value;
      if (v !== 3) throw new Error(`cdp value ${JSON.stringify(r)}`);
    }
  });

  await check("rpc ping", async () => {
    const r = await api("POST", "/rpc", { method: "ping", params: {} });
    if (!r.result?.ok) throw new Error(JSON.stringify(r));
  });

  await check("close tab", async () => {
    await api("DELETE", `/tabs/${tab.id}`);
    const listed = await api("GET", "/tabs");
    if (listed.tabs.some((t) => t.id === tab.id)) throw new Error("tab still present");
  });

  log("ALL PASSED");
  console.log(JSON.stringify(results, null, 2));
  await cleanup();
  process.exit(0);
}

main().catch(async (err) => {
  console.error("[e2e] aborted:", err);
  console.log(JSON.stringify(results, null, 2));
  await cleanup();
  process.exit(1);
});
