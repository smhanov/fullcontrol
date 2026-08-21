# FullControl

A Chrome extension plus a network relay so an agent — on this machine or another — can fully observe and control a real browser.

Chrome extensions cannot bind a TCP port. The companion relay (`server/index.js`) listens on **port 18765** and bridges HTTP / WebSocket clients to the extension.

```
remote agent  --HTTP/WS-->  relay :18765  --WebSocket-->  extension  -->  Chrome tabs
```

## Features

- List, create, focus, navigate, and close tabs
- Page snapshots (interactive elements with stable `ref`s)
- Screenshots (PNG / JPEG, JSON or raw bytes)
- Click, type, hover, scroll, select, keypress
- `evaluate` and raw Chrome DevTools Protocol (`cdp`)
- Live events over WebSocket (tab changes, console, CDP)
- Token auth so agents on other machines can connect

The relay never attaches to other Chrome processes. Use a dedicated profile if you do not want this mixed with a daily session.

## Install

Needs Node 18+.

```bash
git clone https://github.com/smhanov/fullcontrol.git
cd fullcontrol
npm install
node server/index.js
```

In Chrome: `chrome://extensions` → enable **Developer mode** → **Load unpacked** → select `extension/`.

Click the toolbar icon. Status should be **Connected**. Copy the token (also written to `.token`).

Stock Google Chrome 137+ ignores `--load-extension`. Install with **Load unpacked**, or use the isolated launcher below.

### Isolated Chrome (does not touch your daily profile)

```bash
./scripts/launch-isolated.sh
```

That uses a local Chrome-for-Testing binary under `.tools/` when present.

## Agent API

Base URL: `http://<host>:18765`

Auth (any one):

- `Authorization: Bearer <token>`
- `X-Fullcontrol-Token: <token>`
- `?token=<token>`

Token comes from `.token`, the toolbar popup, or `FULLCONTROL_TOKEN`.

| Method | Path | Purpose |
| --- | --- | --- |
| GET | `/health` | Liveness, no auth |
| GET | `/status` | Extension connection + reaper state + owned tabs |
| GET | `/tabs` | List tabs (annotated with `owner` when agent-created) |
| POST | `/tabs` | Create tab `{url, active, waitUntil, windowId}` (stamps `owner` from `X-Agent-Id`) |
| GET | `/tabs/:id` | Get one tab |
| DELETE | `/tabs/:id` | Close tab (releases lease + ownership) |
| PATCH | `/tabs/:id` | Update tab `{update}` |
| POST | `/tabs/:id/activate` | Focus tab |
| POST | `/tabs/:id/navigate` | `{url}` |
| POST | `/tabs/:id/reload` | Reload page |
| POST | `/tabs/:id/back` | History back |
| POST | `/tabs/:id/forward` | History forward |
| POST | `/tabs/:id/lease` | Claim tab `{ttlMs}`; 409 if leased by another agent |
| POST | `/tabs/:id/release` | Release lease `{force?}` |
| GET/POST | `/tabs/:id/screenshot` | PNG (or `?raw=1` for bytes) |
| GET/POST | `/tabs/:id/snapshot` | Interactive elements + refs |
| POST | `/tabs/:id/click` | `{selector}` / `{ref}` / `{x,y}` (trusted CDP) |
| POST | `/tabs/:id/type` | `{text, selector?, ref?, clear?, submit?}` |
| POST | `/tabs/:id/press` | `{key}` |
| POST | `/tabs/:id/hover` | `{selector\|ref}` |
| POST | `/tabs/:id/scroll` | `{deltaY}` or `{selector}` |
| POST | `/tabs/:id/select` | `{selector, values}` |
| POST | `/tabs/:id/wait` | `{selector\|text}` |
| POST | `/tabs/:id/evaluate` | `{expression}` (via CDP) |
| POST | `/tabs/:id/cdp` | Raw Chrome DevTools `{method, params}` |
| POST | `/tabs/:id/attach` | Attach debugger |
| POST | `/tabs/:id/detach` | Detach debugger |
| GET | `/tabs/:id/console` | Console buffer |
| GET | `/leases` | List active leases |
| GET/POST | `/windows` | List / mint windows (per-agent isolation) |
| GET/POST | `/reaper` | Tab reaper stats / trigger a sweep |
| GET/POST | `/cookies` | Read / set cookies `{url}` |
| GET | `/events` | Recent event log |
| POST | `/rpc` | Any extension method |

WebSocket for remote agents:

```
ws://<host>:18765/agent?token=<token>
```

Send `{ "id": 1, "method": "listTabs", "params": {} }`.  
Receive `{ "type": "response", "id": 1, "result": ... }` and live `{ "type": "event", ... }`.

CLI helper:

```bash
node scripts/fc.mjs --host HOST[:PORT] --token TOKEN tabs
node scripts/fc.mjs --host HOST open https://example.com
node scripts/fc.mjs --host HOST snapshot TAB
node scripts/fc.mjs --host HOST shot TAB -o /tmp/page.png
```

## Agent identity & concurrency

Identify yourself on every request with `X-Agent-Id: <name>` (default
`"default"`). This powers three mechanisms (v1.0.2+):

- **Tab ownership** — `POST /tabs` stamps the tab with your agent id; the
  tab is listed with `owner` and tracked by the tab reaper.
- **Tab leases** — `POST /tabs/:id/lease {"ttlMs":300000}` claims a tab;
  other agents' write actions on it get `409` (reads stay open). Writes by
  the holder renew the lease. Release in a `finally`:
  `POST /tabs/:id/release` (or `{"force":true}` to take over a stuck lease).
  `GET /leases` lists them.
- **Per-agent windows** — `POST /windows {"url":...}` mints an isolated
  window (`focused:false` default, so it never steals the user's focus);
  create tabs in it with `POST /tabs {"windowId":W}` and list with
  `GET /tabs?windowId=W`. Writes to tabs in the same window serialize via a
  per-window mutex, so parallel agents don't race the visible tab.

## Tab reaper (v1.0.5)

Agents leak tabs — every `POST /tabs` mints one and "close in a finally"
is only a suggestion. The relay now reclaims tabs it can prove are
abandoned, while **never** closing tabs a human took over:

- **Ownership**: `POST /tabs` records `{owner, lastAgentUrl, lastAgentAt}`
  (persisted to `.tabmeta.json`, gitignored — survives relay restarts).
- **Sweep** (periodic): a tab is closed only if it is agent-owned, has had
  no agent reads/writes for `FC_REAPER_IDLE_MS`, and has **no veto**:
  - URL diverged from the last URL the agent set (a human navigated it
    elsewhere, or a page redirect moved it) — veto-only, never a trigger.
  - Recent human input on the tab (content-script beacon: mousedown /
    keydown / wheel / touchstart, `isTrusted` only).
  - Active tab in a recently focused window; pinned; audible; or leased.
- **Unowned tabs = the human's own** — never touched.
- **Config (env):** `FC_REAPER_IDLE_MS` (0 = off, the default),
  `FC_REAPER_HUMAN_MS` (default 30 min), `FC_REAPER_INTERVAL_MS`
  (min 60s, default 10 min), `FC_REAPER_DRY_RUN` (default `"1"` =
  observe-only; `"0"` closes).
- **Ops:** `GET /reaper` (config + last sweep stats: considered /
  wouldClose / closed / vetoed / vetoReasons), `POST /reaper` (sweep now),
  `GET /status` (reaper + ownedTabs).

Agents should still close what they open (`DELETE /tabs/:id` in a
`finally`) — the reaper is the safety net, not the excuse.

## Config

| Env | Default | Meaning |
| --- | --- | --- |
| `FULLCONTROL_HOST` | `0.0.0.0` | Relay bind host |
| `FULLCONTROL_PORT` | `18765` | Relay port |
| `FULLCONTROL_TOKEN` | — | Fixed token (else generated + written to `.token`) |
| `FULLCONTROL_TOKEN_FILE` | `<repo>/.token` | Token file path |
| `FC_TABMETA_FILE` | `<repo>/.tabmeta.json` | Tab ownership store |
| `FC_REAPER_IDLE_MS` | `0` | Reaper idle threshold (0 = disabled) |
| `FC_REAPER_HUMAN_MS` | `1800000` | Human-takeover veto window |
| `FC_REAPER_INTERVAL_MS` | `600000` | Sweep period |
| `FC_REAPER_DRY_RUN` | `1` | `0` = actually close tabs |

## Give this to an agent

Copy `skill/SKILL.md` into the agent's skills directory (Claude: `~/.claude/skills/fullcontrol-browser/SKILL.md`). Then tell the agent the hostname:

> use fullcontrol on alice-laptop  
> control http://10.0.0.4:18765 and book the Tuesday slot

The skill tells the agent to probe `/health`, snapshot before acting, and never click blind.

## Tests

Runs a throwaway Chrome-for-Testing profile. Does not touch other Chrome sessions.

```bash
npm test
```

## Layout

```
extension/     Chrome MV3 extension (load unpacked; bump manifest.json version on every code change)
server/        HTTP + WebSocket relay (index.js is the whole server)
scripts/       launch-isolated.sh, fc.mjs, make-icons.mjs, reload-extension.mjs
               (CDP extension reload), ext-diagnose.mjs (uninstall+loadUnpacked
               recovery), ensure-extension.py (extloader/watchdog), gpt_fc.py
               (ChatGPT driver via the relay)
skill/         Agent skill (SKILL.md) — the file to hand to an agent
test/          Isolated e2e harness (own relay port + profile; never touches
               production state, including .tabmeta.json)
```

## Updating the extension on a running browser

MV3 service workers are script-cached per profile — editing files on disk
does NOT change what a running browser executes. Ground truth is the
manifest version: `GET /status` → `extension.version`. To push changes:

1. Edit, bump `extension/manifest.json` (e.g. 1.0.5 → 1.0.6).
2. Commit, push, `git pull` on the target host.
3. Reload: if the browser has a debug port (Chrome for Testing), use
   `node scripts/reload-extension.mjs <debugPort>` (surgical, tabs
   untouched); if that leaves the SW dead, recover with
   `node scripts/ext-diagnose.mjs <debugPort> --recover`
   (uninstall + loadUnpacked — the reliable path).
   Browsers without a debug port need a manual reload (⟳ on
   `chrome://extensions` / `edge://extensions`) or a browser restart —
   and a restart alone may NOT be enough, the SW cache survives it.
4. Verify `GET /status` shows the new version AND a live ref-click returns
   `via:"cdp"`.

## License

MIT
