#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function die(msg, code = 1) {
  console.error(msg);
  process.exit(code);
}

function usage() {
  console.log(`Usage: fc.mjs [--host HOST[:PORT]] [--token TOKEN] <cmd> [args]

  health
  status
  tabs
  open <url>
  close <tab>
  activate <tab>
  nav <tab> <url>
  snapshot <tab> [--html]
  shot <tab> [-o file.png]
  click <tab> <selector|ref>
  type <tab> <selector> <text>
  press <tab> <key>
  select <tab> <selector> <value>
  eval <tab> <expression>
  wait <tab> <selector>
  rpc <method> [json-params]

Host defaults to $FULLCONTROL_HOST or http://127.0.0.1:18765
Token defaults to $FULLCONTROL_TOKEN or ${path.join(ROOT, ".token")}
`);
}

function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "-h" || a === "--help") out.help = true;
    else if (a === "--host" || a === "-H") out.host = argv[++i];
    else if (a === "--token" || a === "-t") out.token = argv[++i];
    else if (a === "--html") out.html = true;
    else if (a === "-o" || a === "--out") out.out = argv[++i];
    else if (a.startsWith("-")) die(`unknown flag ${a}`);
    else out._.push(a);
  }
  return out;
}

function resolveBase(host) {
  const raw = host || process.env.FULLCONTROL_HOST || "http://127.0.0.1:18765";
  if (/^https?:\/\//i.test(raw)) return raw.replace(/\/$/, "");
  if (raw.includes("://")) return raw.replace(/\/$/, "");
  if (raw.includes(":")) return `http://${raw}`;
  return `http://${raw}:18765`;
}

function resolveToken(explicit) {
  if (explicit) return explicit;
  if (process.env.FULLCONTROL_TOKEN) return process.env.FULLCONTROL_TOKEN;
  const p = process.env.FULLCONTROL_TOKEN_FILE || path.join(ROOT, ".token");
  try {
    return fs.readFileSync(p, "utf8").trim();
  } catch {
    return "";
  }
}

async function api(base, token, method, pathname, body, { raw = false } = {}) {
  const headers = { "content-type": "application/json" };
  if (token) headers.authorization = `Bearer ${token}`;
  const res = await fetch(base + pathname, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  if (raw) {
    if (!res.ok) die(`${method} ${pathname} -> ${res.status} ${await res.text()}`);
    return Buffer.from(await res.arrayBuffer());
  }
  const text = await res.text();
  let data;
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    data = text;
  }
  if (!res.ok) die(`${method} ${pathname} -> ${res.status} ${typeof data === "string" ? data : JSON.stringify(data)}`);
  return data;
}

function print(v) {
  console.log(typeof v === "string" ? v : JSON.stringify(v, null, 2));
}

const args = parseArgs(process.argv.slice(2));
if (args.help || !args._.length) {
  usage();
  process.exit(args.help ? 0 : 1);
}

const base = resolveBase(args.host);
const token = resolveToken(args.token);
const [cmd, ...rest] = args._;
const call = (method, pathname, body, opts) => api(base, token, method, pathname, body, opts);

const commands = {
  async health() {
    print(await call("GET", "/health"));
  },
  async status() {
    print(await call("GET", "/status"));
  },
  async tabs() {
    print(await call("GET", "/tabs"));
  },
  async open() {
    const url = rest[0] || "about:blank";
    print(await call("POST", "/tabs", { url, active: true, waitUntil: true }));
  },
  async close() {
    print(await call("DELETE", `/tabs/${rest[0]}`));
  },
  async activate() {
    print(await call("POST", `/tabs/${rest[0]}/activate`, {}));
  },
  async nav() {
    print(await call("POST", `/tabs/${rest[0]}/navigate`, { url: rest[1] }));
  },
  async snapshot() {
    print(await call("POST", `/tabs/${rest[0]}/snapshot`, { interestingOnly: true, includeHtml: !!args.html }));
  },
  async shot() {
    const buf = await call("GET", `/tabs/${rest[0]}/screenshot?raw=1`, undefined, { raw: true });
    const out = args.out || `screenshot-${rest[0]}.png`;
    fs.writeFileSync(out, buf);
    console.log(out);
  },
  async click() {
    const target = rest[1] || "";
    const body = target.startsWith("e") && /^e\d+$/.test(target) ? { ref: target } : { selector: target };
    print(await call("POST", `/tabs/${rest[0]}/click`, body));
  },
  async type() {
    print(await call("POST", `/tabs/${rest[0]}/type`, { selector: rest[1], text: rest.slice(2).join(" "), clear: true }));
  },
  async press() {
    print(await call("POST", `/tabs/${rest[0]}/press`, { key: rest[1] }));
  },
  async select() {
    print(await call("POST", `/tabs/${rest[0]}/select`, { selector: rest[1], values: rest.slice(2) }));
  },
  async eval() {
    print(await call("POST", `/tabs/${rest[0]}/evaluate`, { expression: rest.slice(1).join(" ") }));
  },
  async wait() {
    print(await call("POST", `/tabs/${rest[0]}/wait`, { selector: rest[1], timeout: 15000 }));
  },
  async rpc() {
    const params = rest[1] ? JSON.parse(rest[1]) : {};
    print(await call("POST", "/rpc", { method: rest[0], params }));
  },
};

if (!commands[cmd]) die(`unknown command: ${cmd}\n`);
await commands[cmd]();
