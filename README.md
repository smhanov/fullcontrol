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
| GET | `/status` | Extension connection |
| GET | `/tabs` | List tabs |
| POST | `/tabs` | Create tab `{url, active, waitUntil}` |
| DELETE | `/tabs/:id` | Close tab |
| POST | `/tabs/:id/activate` | Focus tab |
| POST | `/tabs/:id/navigate` | `{url}` |
| GET/POST | `/tabs/:id/screenshot` | PNG (or `?raw=1` for bytes) |
| GET/POST | `/tabs/:id/snapshot` | Interactive elements + refs |
| POST | `/tabs/:id/click` | `{selector}` / `{ref}` / `{x,y}` |
| POST | `/tabs/:id/type` | `{text, selector?, ref?}` |
| POST | `/tabs/:id/press` | `{key}` |
| POST | `/tabs/:id/hover` | `{selector\|ref}` |
| POST | `/tabs/:id/scroll` | `{deltaY}` or `{selector}` |
| POST | `/tabs/:id/select` | `{selector, values}` |
| POST | `/tabs/:id/wait` | `{selector\|text}` |
| POST | `/tabs/:id/evaluate` | `{expression}` (via CDP) |
| POST | `/tabs/:id/cdp` | Raw Chrome DevTools `{method, params}` |
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
extension/     Chrome MV3 extension (load unpacked)
server/        HTTP + WebSocket relay
scripts/       launch-isolated.sh, fc.mjs, make-icons.mjs
skill/         Agent skill (SKILL.md)
test/          Isolated e2e harness
```

## License

MIT
