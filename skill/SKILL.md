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
3. First line of the relay's `.token` file (repo dir — `FULLCONTROL_TOKEN_FILE` overrides)
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
# NOTE: `result` is a JSON string ONLY when the page returns a string;
# numbers/booleans/objects come back as native JSON. A helper that blindly
# `json.loads(result)` throws — only parse when isinstance(v, str).

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

### Pick the act path by framework (do this before burning turns)

Synthetic `el.dispatchEvent` events and raw value-set are untrusted —
modern frameworks silently ignore them. Choose the act primitive by what the
page uses:

| Page uses | Use | Don't use |
| --- | --- | --- |
| React / Vue / any `isTrusted` check | `/click {ref}` (trusted CDP) | `evaluate el.click()` / `dispatchEvent` |
| AngularJS + select2 (Namecheap DNS) | `/select {ref, value}` — the ONLY reliable dropdown path | raw value-set + change, synthetic clicks |
| Native `<select>` that HANGS `/select` | trusted `/click` the combobox → options render as `listbox`/`option` refs → click the option | retrying `/select` with a bigger timeout — it just times out again |
| Angular Material (CDK) overlays / mat-select | `/click {ref}` to OPEN panels; then snapshot | `/press Escape` to close (never works — panels accumulate; attribute options by `id="<FieldId>-panel"` boundaries) |
| Plain HTML buttons/links | `/click {ref}` or `/click {x,y}` | — |
| Search boxes that server-filter (LinkedIn DM, mat-select search) | treat as TRAP: typing hides the list / never filters. Reset via navigation, or read the page's API | fighting the input |

Notes:

- All act endpoints live on `POST /tabs/:id/<action>`: `select activate
  reload wait hover scroll back forward console cookies`.
- Typing into React-controlled inputs: raw `el.value = ...` does NOT fire
  React's change handlers. When `/type`'s trusted input is not an option,
  use `el.focus()` + `document.execCommand('selectAll', false)` +
  `document.execCommand('insertText', false, text)` so the framework's
  handlers fire.
- `form.submit()` bypasses the SPA's own submit handler — fields silently
  drop from the request. Prefer a trusted `/click` on the real submit
  control, then verify which fields applied.

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

# Any extension method. NOTE: /rpc is a TOP-LEVEL endpoint (never
# /tabs/:id/rpc) and only knows BACKGROUND methods (ping, listTabs,
# closeWindow). Content-script-only commands (e.g. query) return
# "unknown method".
curl -sS "${AUTH[@]}" -X POST "$HOST/rpc" \
  -d '{"method":"ping","params":{}}'
```

Other: `GET /windows`, `GET /cookies?url=`, `POST /cookies`, `GET /events`.

WebSocket (optional, for live tab/console events):

`ws://HOST:18765/agent?token=TOKEN`

Send `{"id":1,"method":"listTabs","params":{}}`. Replies are `{"type":"response","id":1,"result":…}`.

## File uploads (native pickers) — drive via CDP, never the OS dialog

Any flow that opens an `<input type=file>` (avatar uploads, attachment
pickers) pops a NATIVE OS dialog automation cannot touch. Feed the hidden
input over CDP instead:

1. Click the button that triggers the picker (the hidden input appears in
   the DOM).
2. `POST /tabs/:id/cdp`: `DOM.getDocument` (root `nodeId`) →
   `DOM.querySelector` `{nodeId, selector:"#avatar_upload"}` →
   `DOM.setFileInputFiles` `{nodeId, files:["/abs/path.jpg"]}`. The file
   must exist on the browser host.
3. **The triggering click re-renders the DOM — always re-query the nodeId
   AFTER the click.** A nodeId captured before goes stale and the set
   silently no-ops.
4. The page shows its own crop/preview modal — finish with normal
   snapshot/click. Verify via the resulting asset URL, not bytes (servers
   re-encode/crop).

## Common flow gotchas

### Google OAuth sign-in opens a NEW TAB — not a popup

Clicking "Sign in with Google" mints a new tab at `accounts.google.com/...`
(chooser → consent → redirect); the original site tab sits idle. If the
snapshot doesn't change after the click, do NOT retry-click — `GET /tabs`
and look for the new `accounts.google.com` tab, drive it, and poll the
original tab for the signed-in app shell. Same-tab variant exists on
SvelteKit sites (chooser/consent/redirect in the SAME tab) — check the
current tab's URL first.

### hCaptcha / anti-bot signup flows

Real Chrome passes the hCaptcha checkbox; headless and stealth browsers do
not. The checkbox sits ~25px inside the widget's top-left corner, so
trusted-click `{x: bbox.x + 25, y: bbox.y + 25}` on the widget iframe node —
the CDP click lands INSIDE the cross-origin iframe and opens the challenge
(a second iframe). **Do NOT auto-solve the puzzle with vision** — a wrong
click silently resets the challenge; route to the human watching the
visible browser instead. Verify a token exists before submitting:
`/evaluate` `(document.querySelector('[name=h-captcha-response]')||{}).value`
non-empty.

### Cloudflare-walled download pages (direct-link capture)

For sites that 403 curl (Cloudflare + Turnstile) but work in a real browser,
where the download button mints a one-time direct link: the real browser
auto-passes "Just a moment" in ~5–10s and invisible Turnstile auto-solves;
the success handler then renders the generated link into the DOM (e.g.
`#downloaddirect_info a`). Read that href via `/evaluate` — `window.open()`
popups get eaten by the blocker. Then curl the direct CDN link from your
machine with `-C -` resume, a browser UA, and `--retry 5`.

## Heavy SPAs & long-running work

- **Background tabs never hydrate React SPAs.** A tab opened with
  `active:false` gets the HTML shell but the app never mounts while hidden
  (`evaluate` returns empty `innerText` forever, no error). `activate` the
  tab and it renders within seconds. Corollary: bulk crawls CANNOT fan out
  across background tabs — use one dedicated ACTIVE tab and iterate
  navigate → wait → extract. If a crawl starts failing wholesale with "no
  content rendered", suspect the tab went inactive before blaming selectors.
- **SPA e-commerce playbook** (logged-in storefronts): poll through auth
  redirects (SPAs async-redirect; handle BOTH signed-in and signed-out
  states); toast overlays intercept hit-tested clicks — dismiss before the
  next action; duplicate button names in confirm dialogs — pick the one
  whose bbox is INSIDE the dialog; cards render async — walk to the next
  title boundary and verify the confirmation toast appeared before moving
  on; read prices/totals from a FULL snapshot (`interestingOnly:false`);
  empty states render different headings (wait on the union of possible
  states); cross-origin checkout iframes render async — screenshots are the
  read path for their contents; card entry + pay stays human-in-the-loop.
- **Enumeration gaps.** Buttons can be styled `<span>`/`<div>` with no
  `role=button` — sweep ALL element types by innerText
  (`a,div,span,p,li,input,button`, visible rect + short text) when a
  role-based sweep finds nothing. Design-system web components (`<gcds-*>`
  etc.) hide links from `a[href]` sweeps — sweep custom-element tags and
  read their attributes, or dump `documentElement.innerHTML` and regex it.
- **Long-run discipline.** (a) After 2 consecutive failures on a bulk op,
  stop patching the script — switch primitives (different browser,
  snapshot+click, or the human). (b) Never trust the script's own "OK" log
  — verify against LIVE state (page counter, API, fresh snapshot) after
  each batch. (c) On a blocker that forces repeated diagnostics, check in
  with the user: what's captured, the holdup, 2–3 options. (d) Admin
  panels drop sessions fast — expect re-login/2FA; probe which accounts are
  actually logged in before promising a flow.

## Helper (if the repo is local)

```bash
node <repo>/scripts/fc.mjs --host HOST[:PORT] --token TOKEN tabs
node <repo>/scripts/fc.mjs --host HOST open https://example.com
node <repo>/scripts/fc.mjs --host HOST snapshot TAB
node <repo>/scripts/fc.mjs --host HOST shot TAB -o /tmp/page.png
# `<repo>` = the checkout directory, e.g. `~/fullcontrol`.
```

If that file is missing, use curl as above. Do not refuse the task.

## Errors

| Symptom | Fix |
| --- | --- |
| connection refused | wrong host/port; relay not running (`node server/index.js`). If you are ON the relay host itself, probe `GET /health` first - an agent "can not reach the relay" is often the relay answering fine while the extension is not connected (next row) |
| 401 | bad/missing token |
| 503 `extension not connected` | Chrome/extension not talking to relay |
| `extensionConnected:false` for minutes while the browser still runs | the extension offscreen document (the relay-WebSocket holder) died and the service-worker keepalive did not recreate it - it will NOT come back on its own; do not poll /status in a loop. Restart the browser process (the session/tabs restore); the extension reconnects within seconds. On a desktop browser without a debug port, ask the user to restart it |
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
  discord, Google Photos picker. Some pages (e.g. wygo.world ticket
  checkout) block evaluate/cdp but still accept snapshot/click/type/select.
- **WORKS** (use evaluate freely): x.com, cursor.com, deepseek,
  console.cloud.google.com, ap.www.namecheap.com, propertyline (MPAC),
  app.slack.com (Slack web client), atlassian.net / id.atlassian.com (Jira
  Cloud), linkedin.com, github.com, notebook.google.com /
  notebooklm.google.com (NotebookLM — CDP `DOM.setFileInputFiles` works too).

When a page isn't listed, one `attach` probe on a control tab decides it —
then stop probing and use what works.

### Screenshots can lie

- Byte-identical md5 across calls = stale/unchanged capture; md5-compare
  before believing a difference.
- Screenshot right after navigate/click = mid-load spinner/blank. Wait
  5–15s or verify state via snapshot first.
- Screenshot captures the **visible** tab only — activate first.
- Default response is a JSON envelope `{"mimeType":"image/png","data":"<base64>"}`,
  not raw bytes — pass `?raw=1` (or decode `data`) or the file is text and
  image tools reject it.
- Vision models misread small numeric text. When a verification hinges on a
  number, cross-check with `/evaluate` on `document.body.innerText` — the
  DOM is ground truth, the screenshot is not.

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
- Check in with the user on long harvest loops when a blocker forces
  repeated diagnostics — status beats a silent wall of retries.
- Verify against live state (page counter / API / fresh snapshot), never
  your own script's "OK" log — a script reporting success is a hypothesis.
