---
name: fullcontrol-browser
description: "Drive a remote Chrome browser that has the FullControl extension installed. Use when: the user gives a hostname/IP of a FullControl browser, asks you to open/click/type/screenshot/snapshot a real browser tab, control a browser on another machine, or use FullControl / the FullControl Agent relay. Also use for browser automation via HTTP on port 18765. Covers trusted CDP clicks, tab leases/ownership, the tab reaper, and multi-agent windows."
argument-hint: "<host> [task]"
user-invocable: true
disable-model-invocation: false
---

# FullControl Browser

Control a real Chrome window over HTTP. The user gives you a **hostname** (or IP) of a machine running the FullControl relay + extension. You observe and drive that browser — you are not using a local headless browser.

## Connect

Parse the target from the user message or `$ARGUMENTS`:

| User says | Use |
| --- | --- |
| `alice-laptop` / `10.0.0.4` | `http://HOST:18765` |
| `alice-laptop:18765` | `http://HOST:18765` |
| `http://alice-laptop:18765` | as given |
| `https://…` | as given (rare) |

Optional token (any one):

1. User pasted a token
2. `$FULLCONTROL_TOKEN`
3. First line of `/home/smhanov/fullcontrol/.token` (local relay only)
4. Ask the user — do not guess

```bash
HOST="http://HOST:18765"
TOKEN="…"
AUTH=(-H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json")
```

Probe before doing work:

```bash
curl -sS "$HOST/health"
# {"ok":true,"extensionConnected":true,"port":18765}

curl -sS "${AUTH[@]}" "$HOST/status"
# extensionConnected must be true
```

If `/health` fails: host/port/firewall wrong.  
If health ok but `extensionConnected` is false: relay is up, Chrome extension is not connected. Tell the user to open Chrome and confirm the toolbar icon is green.  
If `/status` is 401: token wrong.

## Loop (always)

Never click or type blind.

1. `GET /tabs` — pick or create a tab; remember `id`
2. Navigate if needed (`waitUntil` defaults on)
3. `POST /tabs/:id/snapshot` — see interactive nodes (`ref`, `selector` via `id`/`name`/`role`)
4. Act (`click` / `type` / `select` / `press` / `scroll`)
5. Snapshot or screenshot again to verify
6. Repeat until the task is done

Prefer **snapshot refs** over guessed CSS. Use **screenshot** when layout/visual state matters (canvas, maps, “does this look right?”). Save screenshot PNG bytes to a temp file and read the image.

Keep one working `tabId`. Do not spray new tabs unless asked.

## API

All authenticated routes need the Bearer token. JSON in/out unless noted.

### Tabs

```bash
curl -sS "${AUTH[@]}" "$HOST/tabs"
curl -sS "${AUTH[@]}" -X POST "$HOST/tabs" \
  -d '{"url":"https://example.com","active":true,"waitUntil":true}'
# → { "tab": { "id": 123, "url": "...", "title": "...", "status": "complete" } }

curl -sS "${AUTH[@]}" -X POST "$HOST/tabs/123/navigate" \
  -d '{"url":"https://example.com"}'
curl -sS "${AUTH[@]}" -X POST "$HOST/tabs/123/activate" -d '{}'
curl -sS "${AUTH[@]}" -X POST "$HOST/tabs/123/reload" -d '{}'
curl -sS "${AUTH[@]}" -X POST "$HOST/tabs/123/back" -d '{}'
curl -sS "${AUTH[@]}" -X DELETE "$HOST/tabs/123"
```

`createTab` / `navigate` wait for `status=complete` unless `"waitUntil": false`.

### Observe

```bash
# Interactive elements + refs (primary)
curl -sS "${AUTH[@]}" -X POST "$HOST/tabs/123/snapshot" \
  -d '{"interestingOnly":true}'

# PNG as JSON { mimeType, data } (base64)
curl -sS "${AUTH[@]}" "$HOST/tabs/123/screenshot" -o /tmp/fc-shot.json
# or raw bytes:
curl -sS "${AUTH[@]}" "$HOST/tabs/123/screenshot?raw=1" -o /tmp/fc-shot.png

curl -sS "${AUTH[@]}" -X POST "$HOST/tabs/123/evaluate" \
  -d '{"expression":"document.title"}'
# → { "result": "…", "via": "cdp" }

curl -sS "${AUTH[@]}" "$HOST/tabs/123/console"
```

Snapshot node shape:

```json
{
  "url": "https://…",
  "title": "…",
  "nodes": [
    {
      "ref": "e12",
      "tag": "button",
      "role": "button",
      "name": "Sign in",
      "id": "go",
      "href": null,
      "bbox": { "x": 80, "y": 200, "w": 120, "h": 36 }
    }
  ]
}
```

`includeHtml: true` adds truncated `html` (use sparingly).

Screenshot captures the **visible** tab. Activate the tab first if it is in the background.

### Act

```bash
# Click by CSS, snapshot ref, or coordinates
# NOTE (since 074c751): ref/selector clicks dispatch TRUSTED CDP input
# (isTrusted=true) — they register on React/Angular-CDK/select2 pages that
# ignore synthetic dispatchEvent clicks. Falls back to synthetic only when
# the debugger is denied. Response includes via:"cdp" + x,y,bbox.
# NOTE (since d59d7b7): click/press/type accept {"focus":true} to RAISE the
# window — use ONLY for human-in-the-loop moments (captchas). Default does
# not steal focus, so the user's screen is never yanked mid-task.
curl -sS "${AUTH[@]}" -X POST "$HOST/tabs/123/click" -d '{"selector":"#go"}'
curl -sS "${AUTH[@]}" -X POST "$HOST/tabs/123/click" -d '{"ref":"e12"}'
curl -sS "${AUTH[@]}" -X POST "$HOST/tabs/123/click" -d '{"x":100,"y":200}'

# Refs are bbox-anchored and go stale on ANY DOM re-render. Re-snapshot
# before every interaction after a mutation; never retry with the same ref.
# /select is the ONLY reliable dropdown path on select2/AngularJS pages
# (raw value-set + change reverts; synthetic clicks ignored).
curl -sS "${AUTH[@]}" -X POST "$HOST/tabs/123/select" -d '{"ref":"e9","value":"12"}'

curl -sS "${AUTH[@]}" -X POST "$HOST/tabs/123/hover" -d '{"ref":"e12"}'

# Type (focuses selector/ref, clears by default, then inserts)
curl -sS "${AUTH[@]}" -X POST "$HOST/tabs/123/type" \
  -d '{"selector":"#email","text":"ada@example.com","clear":true}'
curl -sS "${AUTH[@]}" -X POST "$HOST/tabs/123/type" \
  -d '{"selector":"#q","text":"query","submit":true}'

curl -sS "${AUTH[@]}" -X POST "$HOST/tabs/123/press" -d '{"key":"Enter"}'
# keys: Enter Tab Escape Backspace Delete ArrowUp ArrowDown ArrowLeft ArrowRight Home End PageUp PageDown Space

curl -sS "${AUTH[@]}" -X POST "$HOST/tabs/123/select" \
  -d '{"selector":"#color","values":["green"]}'

curl -sS "${AUTH[@]}" -X POST "$HOST/tabs/123/scroll" -d '{"deltaY":800}'
curl -sS "${AUTH[@]}" -X POST "$HOST/tabs/123/scroll" -d '{"selector":"#footer"}'

curl -sS "${AUTH[@]}" -X POST "$HOST/tabs/123/wait" \
  -d '{"selector":"#results","timeout":15000}'
curl -sS "${AUTH[@]}" -X POST "$HOST/tabs/123/wait" \
  -d '{"text":"Signed in","timeout":15000}'
```

### Multi-agent concurrency (v1.0.2+)

Multiple agents can share one browser. Identify yourself on every request
with `X-Agent-Id: <name>` (default `"default"`):

- **Tab leases**: `POST /tabs/:id/lease {"ttlMs":300000}` claims a tab.
  Other agents' write actions (`click type press select navigate reload back
  forward scroll hover activate`) get `409` on it; reads stay open. Writes by
  the holder renew the lease. Release with `POST /tabs/:id/release`
  (`{"force":true}` to take over a stuck lease). `GET /leases` lists them.
- **Per-window mutex**: writes to tabs in the same window serialize — agents
  sharing a window wait their turn instead of racing the visible tab.
- **Per-agent windows**: `POST /windows {"url":...}` mints a window
  (`focused:false` default — never steals the user's focus); scope tabs with
  `POST /tabs {"windowId":W}` and list with `GET /tabs?windowId=W`. Full
  isolation for parallel agents.
- **Filtered events**: `ws://HOST:18765/agent?token=...&agentId=X&window=W`
  only streams events for that window.

Safe pattern: lease the tab in a `finally`-released block; on a 409 pick
another tab/window instead of fighting.

### Tab ownership & reaper (v1.0.5) — clean up after yourself

`POST /tabs` stamps the tab with your `X-Agent-Id` (`owner`), the URL you
asked for (`lastAgentUrl`), and a last-activity timestamp. `GET /tabs`
returns `owner` per tab; `GET /status` lists `ownedTabs`. Records persist
to `.tabmeta.json` (gitignored) so they survive relay restarts.

**Always `DELETE /tabs/:id` in a `finally` for tabs you open.** If you
leak one, the relay's reaper is the backstop:

- A sweep (periodic; `FC_REAPER_IDLE_MS` idle threshold, default off)
  closes a tab only when ALL hold: it has an ownership record, no agent
  read/write for the idle window, and **no veto**:
  - **URL diverged** from `lastAgentUrl` (a human navigated it elsewhere,
    or a page redirect moved it) — veto-only, never a trigger.
  - Recent human input on the tab (mousedown/keydown/wheel/touchstart
    beacon, `isTrusted` only), or it's the active tab in a recently
    focused window — a human is likely looking at it.
  - Pinned, audible (playing media), or leased.
- Tabs with NO ownership record are treated as the human's own and are
  **never** touched by the reaper.
- `GET /reaper` shows config + last sweep stats; `POST /reaper` triggers a
  sweep. Config is relay env vars (`FC_REAPER_IDLE_MS`, `FC_REAPER_HUMAN_MS`,
  `FC_REAPER_INTERVAL_MS`, `FC_REAPER_DRY_RUN`) — see the repo README.

Because the reaper only needs the URL the agent last set, **reuse tabs
where possible**: if a suitable tab already exists (`GET /tabs`), navigate
it instead of minting a new one — fewer tabs, less reaping, and you never
clobber the user's own tabs by mistake.

### Escape hatches

```bash
# Raw Chrome DevTools Protocol
curl -sS "${AUTH[@]}" -X POST "$HOST/tabs/123/cdp" \
  -d '{"method":"Runtime.evaluate","params":{"expression":"1+2","returnByValue":true}}'

# Any extension method
curl -sS "${AUTH[@]}" -X POST "$HOST/rpc" \
  -d '{"method":"ping","params":{}}'
```

Other: `GET /windows`, `GET /cookies?url=`, `POST /cookies`, `GET /events`.

WebSocket (optional, for live tab/console events):

`ws://HOST:18765/agent?token=TOKEN`

Send `{"id":1,"method":"listTabs","params":{}}`. Replies are `{"type":"response","id":1,"result":…}`.

## Helper (if the repo is local)

```bash
node /home/smhanov/fullcontrol/scripts/fc.mjs --host HOST[:PORT] --token TOKEN tabs
node /home/smhanov/fullcontrol/scripts/fc.mjs --host HOST open https://example.com
node /home/smhanov/fullcontrol/scripts/fc.mjs --host HOST snapshot TAB
node /home/smhanov/fullcontrol/scripts/fc.mjs --host HOST shot TAB -o /tmp/page.png
```

If that file is missing, use curl as above. Do not refuse the task.

## Errors

| Symptom | Fix |
| --- | --- |
| connection refused | wrong host/port; relay not running (`node server/index.js`) |
| 401 | bad/missing token |
| 503 `extension not connected` | Chrome/extension not talking to relay |
| `stale ref` | snapshot again, use the new `ref` |
| `not found: #foo` | snapshot; element may be in iframe, shadow DOM, or not exist |
| screenshot empty / wrong tab | `activate` first |
| evaluate/CSP talk | ignore — evaluate already goes through CDP |
| debugger attach prompt | user must click Allow once on that Chrome profile |
| `No tab with given id <N>` | the tab DIED in Chrome (Memory Saver discard, human Ctrl+W, renderer crash). RECOVER, don't abort: `GET /tabs`, re-resolve by URL, or `POST /tabs` to recreate, then continue. Re-fetch the tab list after any long gap — ids go stale. |
| `evaluate` fails: "Cannot access a chrome-extension:// URL of different extension" | page blocks debugger attach — this is PAGE-SPECIFIC, not a broken relay. Fall back to `snapshot` + `screenshot?raw=1` (both work). See the availability table below; don't retry-loop. |

Restricted pages (`chrome://`, Chrome Web Store, PDF viewer) often block content-script click/type. Use `cdp` / `evaluate` or navigate elsewhere.

### Per-page evaluate/attach availability (stable, don't re-probe)

`evaluate`/`cdp`/`attach` are blocked on some pages but work on others.
Multi-session evidence:

- **BLOCKED** (snapshot + screenshot only): amazon.com/.ca, gmail.com,
  slack, discord, Google Photos picker.
- **WORKS** (use evaluate freely): x.com, cursor.com, deepseek,
  console.cloud.google.com, namecheap.com, linkedin.com, github.com.

When a page isn't listed, one `attach` probe on a control tab decides it —
then stop probing and use what works.

### Screenshots can lie

- Byte-identical md5 across calls = stale/unchanged capture; md5-compare
  before believing a difference.
- Screenshot right after navigate/click = mid-load spinner/blank. Wait
  5–15s or verify state via snapshot first.
- Screenshot captures the **visible** tab only — activate first.

## Conduct

- Only the browser the user named. Do not touch other Chrome profiles or local GUI sessions.
- Do not log or repeat the token once it works.
- Prefer the user's existing tab when it already has the right page.
- **Close what you open.** `DELETE /tabs/:id` in a `finally` for every tab
  you created. Do not leave stray `about:blank` tabs behind. If you must
  leave a tab open (e.g. a sign-in the human must finish), say so in your
  report and note the tab id.
- Do not navigate a tab the user is clearly using (their active tab with
  unsaved work) unless asked.
- After finishing, leave a short report: tab id, final URL, what you did,
  anything blocked (login wall, captcha).
