#!/usr/bin/env python3
"""
gpt_fc.py — drive ChatGPT (plan-billed account) through the FullControl relay.

Port of Noah's cdp_gpt_ui2.py approach (execCommand insertText, temp chats,
virtualization-proof waits) onto the FC local browser API instead of raw CDP.
Works because evaluate + trusted CDP clicks work on chatgpt.com.

CONCURRENCY: safe to run from multiple agents at once. Each run mints its OWN
browser window (POST /windows, focused:false — never steals the user's focus)
and leases its temp-chat tab (POST /tabs/:id/lease) under its agent id
(X-Agent-Id header). Writes to the tab 409 any other agent; the per-window
write mutex serializes writes within a window; the lease is renewed during
long waits so no one can hijack a mid-generation tab. Cleanup in `finally`:
release lease -> close tab -> close window.

USER RULE (Noah, explicit): every task gets its OWN fresh TEMPORARY chat.
Never type into existing conversations. Temp chats are closed after use.

Usage:
  python3 scripts/gpt_fc.py "your prompt" [--model gpt-5-6] [--timeout 600]
  python3 scripts/gpt_fc.py --file /path/to/prompt.txt [--agent-id worker-3]
  echo "prompt" | python3 scripts/gpt_fc.py --stdin

Output: JSON on stdout: {"ok":true,"text":"...","chars":N,"model":"...","elapsed":S}
        {"ok":false,"error":"..."} on failure (tab+window still cleaned up).
"""
import argparse, json, os, signal, sys, time, urllib.request, urllib.error

# SIGTERM/SIGINT must run the finally cleanup (close tab+window, release lease).
# Default SIGTERM kills Python without unwinding — that's how orphaned temp
# windows happened in the first concurrent test.
def _handle_sig(signum, frame):
    raise SystemExit(128 + signum)

signal.signal(signal.SIGTERM, _handle_sig)
signal.signal(signal.SIGINT, _handle_sig)

FC_HOST = os.environ.get("FC_HOST", "http://localhost:18765")
TOKEN = os.environ.get("FC_TOKEN", "")
if not TOKEN:
    tok_path = os.path.expanduser("~/fullcontrol/.token")
    if os.path.exists(tok_path):
        TOKEN = open(tok_path).read().strip()
AGENT_ID = os.environ.get("HERMES_AGENT_ID") or os.environ.get("FC_AGENT_ID") or "default"

CHUNK = 24000  # chars; ProseMirror composer chokes on much larger single pastes
LEASE_TTL_MS = 10 * 60 * 1000  # 10 min; renewed during long waits
RENEW_EVERY_S = 120
SEND_SEL = '[data-testid="send-button"]'
STOP_SEL = '[data-testid="stop-button"]'


def fc(method, path, data=None, timeout=30):
    url = f"{FC_HOST}{path}"
    body = json.dumps(data).encode() if data is not None else None
    req = urllib.request.Request(url, data=body, method=method)
    req.add_header("Authorization", f"Bearer {TOKEN}")
    req.add_header("X-Agent-Id", AGENT_ID)
    req.add_header("Content-Type", "application/json")
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            return json.loads(r.read().decode())
    except urllib.error.HTTPError as e:
        try:
            return json.loads(e.read().decode())
        except Exception:
            return {"error": f"HTTP {e.code}"}
    except Exception as e:
        return {"error": str(e)}


def evaluate(tab, expr, timeout=30):
    r = fc("POST", f"/tabs/{tab}/evaluate", {"expression": expr}, timeout=timeout)
    if "error" in r:
        raise RuntimeError(f"evaluate failed: {r['error']}")
    res = r.get("result")
    if res is None:
        raise RuntimeError("evaluate returned null result")
    try:
        return json.loads(res)
    except Exception:
        return res


def wait_for(fn, timeout, desc, poll=2.0):
    deadline = time.time() + timeout
    last = None
    while time.time() < deadline:
        last = fn()
        if last:
            return last
        time.sleep(poll)
    raise TimeoutError(f"timed out after {timeout}s waiting for {desc} (last={last!r})")


def composer_state(tab):
    expr = (
        "JSON.stringify({"
        "hasComposer: !!document.querySelector('#prompt-textarea'),"
        "composerText: (document.querySelector('#prompt-textarea')||{}).innerText||'',"
        "sendBtn: !!document.querySelector('[data-testid=send-button]'),"
        "sendDisabled: (document.querySelector('[data-testid=send-button]')||{}).disabled===true,"
        "stopBtn: !!document.querySelector('[data-testid=stop-button]')})"
    )
    return evaluate(tab, expr)


def insert_text(tab, text):
    esc = json.dumps(text)
    expr = (
        "(()=>{try{const el=document.querySelector('#prompt-textarea');"
        "el.focus();"
        f"const ok=document.execCommand('insertText',false,{esc});"
        "const d=document.querySelector('#prompt-textarea');"
        "return JSON.stringify({ok, content:(d||{}).innerText||''});"
        "}catch(e){return JSON.stringify({err:String(e)});}})()"
    )
    return evaluate(tab, expr)


def click_send(tab):
    r = fc("POST", f"/tabs/{tab}/click", {"selector": SEND_SEL, "focus": True})
    if r.get("error"):
        raise RuntimeError(f"send click failed: {r['error']}")


def read_last_assistant(tab):
    expr = (
        "JSON.stringify((()=>{"
        "const ms=[...document.querySelectorAll('[data-message-author-role=assistant]')]"
        ".filter(m=>(m.innerText||'').trim().length>0);"
        "const err=[...document.querySelectorAll('[data-testid*=error]')]"
        ".map(e=>e.innerText.trim()).filter(t=>t.length>0).slice(0,3);"
        "return {count: ms.length, last: ms.length?ms[ms.length-1].innerText:'', errors: err};"
        "})())"
    )
    return evaluate(tab, expr)


class GptSession:
    """One temp-chat session in a dedicated per-agent window, leased to us."""

    def __init__(self, model=None, use_window=True):
        self.tab = None
        self.window = None
        self._last_renew = 0.0
        url = "https://chatgpt.com/?temporary-chat=true"
        if model:
            url += f"&model={model}"  # often stripped by the app; best-effort
        if use_window:
            w = fc("POST", "/windows", {"url": url})
            if w.get("error"):
                raise RuntimeError(f"create window failed: {w['error']}")
            self.window = (w.get("window") or {}).get("id")
            if not self.window:
                raise RuntimeError(f"create window returned no id: {w}")
            tabs = fc("GET", f"/tabs?windowId={self.window}")
            tab_list = tabs.get("tabs") or []
            if not tab_list:
                raise RuntimeError(f"no tab in minted window {self.window}")
            self.tab = tab_list[0]["id"]
        else:
            r = fc("POST", "/tabs", {"url": url, "active": True, "waitUntil": True})
            self.tab = (r.get("tab") or {}).get("id") or r.get("id")
            if not self.tab:
                raise RuntimeError(f"create tab failed: {r}")
        self.lease()

    def lease(self):
        r = fc("POST", f"/tabs/{self.tab}/lease", {"ttlMs": LEASE_TTL_MS})
        if r.get("error"):
            raise RuntimeError(f"lease failed: {r['error']} (held by another agent?)")
        self._last_renew = time.time()

    def renew_if_due(self):
        if time.time() - self._last_renew > RENEW_EVERY_S:
            self.lease()

    def close(self):
        if self.tab:
            fc("POST", f"/tabs/{self.tab}/release", {})  # best-effort
            fc("DELETE", f"/tabs/{self.tab}")
        if self.window:
            fc("POST", "/rpc", {"method": "closeWindow", "params": {"windowId": self.window}})
        self.tab = self.window = None


def debug_state(tab):
    """Dump composer/button/message state for diagnosing submit failures."""
    expr = (
        "JSON.stringify((()=>{"
        "const ta=document.querySelector('#prompt-textarea');"
        "const sb=document.querySelector('[data-testid=send-button]');"
        "const st=document.querySelector('[data-testid=stop-button]');"
        "const ae=document.activeElement;"
        "return {"
        "composerText:(ta||{}).innerText||'',"
        "activeTag:ae?ae.tagName:'none',"
        "activeCls:(ae&&ae.className&&String(ae.className).slice(0,60))||'',"
        "sendBtn:!!sb, sendDisabled:sb?sb.disabled===true:null,"
        "sendRect:(()=>{if(!sb)return null;const r=sb.getBoundingClientRect();"
        "return {x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2),w:Math.round(r.width),h:Math.round(r.height)}})()"
        ",stopBtn:!!st,"
        "msgs:[...document.querySelectorAll('[data-message-author-role]')].map(m=>m.getAttribute('data-message-author-role'))"
        "};})())"
    )
    return evaluate(tab, expr)


def raise_window(tab):
    """Activate the tab AND raise its window (focus:true). CDP input events
    (Enter keys, mouse clicks) only land on the ACTIVE tab of the FOCUSED
    window — a background window's events get silently dropped. Since the
    extension processes requests on one thread, raise+submit pairs stay
    atomic per agent, so concurrent agents each get their input in. Harmless
    on FC local (Xvfb, no human at the display); never use focus:true on e14."""
    r = fc("POST", f"/tabs/{tab}/activate", {"focus": True})
    if r.get("error"):
        raise RuntimeError(f"activate tab failed: {r['error']}")
    return r


def press_enter(tab):
    """Raise the window, focus the composer, submit via trusted CDP Enter."""
    raise_window(tab)
    expr = (
        "(()=>{const el=document.querySelector('#prompt-textarea');"
        "if(!el)return false;el.focus();return document.activeElement===el;})()"
    )
    focused = evaluate(tab, expr)
    if not focused:
        raise RuntimeError("could not focus composer")
    r = fc("POST", f"/tabs/{tab}/press", {"key": "Enter", "focus": True})
    if r.get("error"):
        raise RuntimeError(f"press Enter failed: {r['error']}")


def submitted_state(tab):
    """True when the message left the composer (sent) or generation started."""
    s = composer_state(tab)
    return (not s.get("composerText")) or s.get("stopBtn")


def send_message(sess, text, gen_timeout, debug=False):
    """Insert text, submit with trusted Enter (verified), fall back to clicking
    the send button if Enter doesn't clear the composer. Wait for re-arm."""
    tab = sess.tab
    wait_for(lambda: composer_state(tab).get("hasComposer"), 30, "composer")
    ins = insert_text(tab, text)
    if ins.get("err"):
        raise RuntimeError(f"insertText failed: {ins['err']}")
    if ins.get("content", "").strip() != text.strip():
        raise RuntimeError(f"insertText mismatch: got {ins.get('content')!r}")
    # primary: trusted Enter (immune to button hit-test races under load)
    press_enter(tab)
    try:
        wait_for(lambda: submitted_state(tab), 10, "message submitted", poll=1.0)
    except TimeoutError:
        if debug:
            print(f"[gpt_fc:{AGENT_ID}] after Enter: {json.dumps(debug_state(tab))}", file=sys.stderr)
        # fallback: raise window + hit-test click on the send button
        raise_window(tab)
        click_send(tab)
        try:
            wait_for(lambda: submitted_state(tab), 10, "message submitted (click)", poll=1.0)
        except TimeoutError:
            if debug:
                print(f"[gpt_fc:{AGENT_ID}] after click: {json.dumps(debug_state(tab))}", file=sys.stderr)
            raise
    def rearmed():
        s = composer_state(tab)
        return s.get("sendBtn") and not s.get("stopBtn")
    wait_for(rearmed, gen_timeout, "composer re-arm", poll=2.0)


def completion_state(tab):
    """True completion signal: ChatGPT renders the per-message action row
    (copy-turn-action-button) inside the LAST conversation turn only when the
    reply is fully rendered. innerText length is NOT reliable under load — the
    final DOM render lags the stream end by up to ~10s and can even blank out
    mid-stream (observed). Returns {copy, count, lastText, errors}."""
    expr = (
        "JSON.stringify((()=>{"
        "const turns=[...document.querySelectorAll('[data-testid^=conversation-turn-]')];"
        "const lt=turns[turns.length-1]||null;"
        "const ms=[...document.querySelectorAll('[data-message-author-role=assistant]')]"
        ".filter(m=>(m.innerText||'').trim().length>0);"
        "const err=[...document.querySelectorAll('[data-testid*=error]')]"
        ".map(e=>e.innerText.trim()).filter(t=>t.length>0).slice(0,3);"
        "return {"
        "copy: lt? !!lt.querySelector('[data-testid=copy-turn-action-button]') : false,"
        "count: ms.length,"
        "lastText: ms.length?ms[ms.length-1].innerText:'',"
        "errors: err"
        "};})())"
    )
    return evaluate(tab, expr)


def wait_final(sess, timeout, debug=False):
    """Wait for the reply to fully render: stop button gone AND the last turn's
    action row (copy-turn-action-button) present — the only reliable completion
    signal (innerText stability lies under concurrent load). Confirm once more
    after a 2s pause, then return the last assistant message."""
    tab = sess.tab
    t0 = time.time()
    deadline = t0 + timeout
    while time.time() < deadline:
        sess.renew_if_due()
        d = completion_state(tab)
        if d.get("copy") and d.get("lastText"):
            time.sleep(2)
            d2 = completion_state(tab)
            if d2.get("copy") and d2.get("lastText") and len(d2.get("lastText")) == len(d.get("lastText")):
                if debug:
                    print(f"[gpt_fc:{AGENT_ID}] final {len(d2['lastText'])} chars at +{time.time()-t0:.1f}s", file=sys.stderr)
                return {"count": d2["count"], "last": d2["lastText"], "errors": d2.get("errors") or []}
        if debug:
            print(f"[gpt_fc:{AGENT_ID}] poll +{time.time()-t0:.1f}s copy={d.get('copy')} len={len(d.get('lastText') or '')}", file=sys.stderr)
        time.sleep(2.0)
    return read_last_assistant(tab)


def main():
    global AGENT_ID
    ap = argparse.ArgumentParser()
    ap.add_argument("prompt", nargs="?", help="prompt text (or use --file/--stdin)")
    ap.add_argument("--file", help="read prompt from file")
    ap.add_argument("--stdin", action="store_true", help="read prompt from stdin")
    ap.add_argument("--model", default=None, help="model slug (best-effort; app may use default)")
    ap.add_argument("--timeout", type=int, default=600, help="max seconds for final reply")
    ap.add_argument("--gen-timeout", type=int, default=180, help="max seconds per chunk generation")
    ap.add_argument("--no-window", action="store_true",
                    help="skip per-agent window; lease a shared-window tab instead")
    ap.add_argument("--agent-id", default=AGENT_ID, help="X-Agent-Id (default: env or 'default')")
    ap.add_argument("--debug", action="store_true", help="dump state on submit failure")
    ap.add_argument("--no-close", action="store_true", help="leave tab+window open for inspection")
    args = ap.parse_args()
    AGENT_ID = args.agent_id
    if args.file:
        prompt = open(args.file).read()
    elif args.stdin:
        prompt = sys.stdin.read()
    else:
        prompt = args.prompt
    if not prompt or not prompt.strip():
        print(json.dumps({"ok": False, "error": "empty prompt"}))
        sys.exit(1)

    sess = None
    t0 = time.time()
    try:
        sess = GptSession(args.model, use_window=not args.no_window)
        wait_for(lambda: composer_state(sess.tab).get("hasComposer"), 60, "temp chat composer")

        if len(prompt) <= CHUNK:
            send_message(sess, prompt, args.gen_timeout, debug=args.debug)
        else:
            parts = [prompt[i:i + CHUNK] for i in range(0, len(prompt), CHUNK)]
            n = len(parts)
            for i, part in enumerate(parts, 1):
                send_message(sess, f"[CONVERSATION PART {i}/{n}]\n{part}", args.gen_timeout, debug=args.debug)

        rd = wait_final(sess, args.timeout, debug=args.debug)
        text = (rd.get("last") or "").strip()
        errors = rd.get("errors") or []
        if errors:
            print(json.dumps({"ok": False, "error": "chat error: " + errors[0][:300],
                              "chars": len(text), "text": text[:2000],
                              "elapsed": round(time.time() - t0, 1)}))
            sys.exit(1)
        if not text:
            print(json.dumps({"ok": False, "error": "empty assistant reply",
                              "elapsed": round(time.time() - t0, 1)}))
            sys.exit(1)
        print(json.dumps({"ok": True, "text": text, "chars": len(text),
                          "model": args.model or "default",
                          "elapsed": round(time.time() - t0, 1)}))
    except TimeoutError as e:
        print(json.dumps({"ok": False, "error": str(e), "elapsed": round(time.time() - t0, 1)}))
        sys.exit(2)
    except Exception as e:
        print(json.dumps({"ok": False, "error": f"{type(e).__name__}: {e}",
                          "elapsed": round(time.time() - t0, 1)}))
        sys.exit(3)
    finally:
        if sess and not args.no_close:
            sess.close()


if __name__ == "__main__":
    main()
