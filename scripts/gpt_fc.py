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
  python3 scripts/gpt_fc.py "your prompt" [--model gpt-5-6] [--timeout 900]
  python3 scripts/gpt_fc.py --file /path/to/prompt.txt [--agent-id worker-3]
  echo "prompt" | python3 scripts/gpt_fc.py --stdin

Output: JSON on stdout: {"ok":true,"text":"...","chars":N,"model":"...","elapsed":S}
        {"ok":false,"error":"..."} on failure (tab+window still cleaned up).
On a generation timeout the driver re-attaches to the still-open tab and
waits for the reply to finish (--timeout-retries/--grace) instead of
discarding the in-progress reply — ChatGPT keeps generating in the background.
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
        "const r=sb?sb.getBoundingClientRect():null;"
        "const at=(r&&r.width>0)?document.elementFromPoint(r.x+r.width/2,r.y+r.height/2):null;"
        "return {"
        "composerText:(ta||{}).innerText||'',"
        "activeTag:ae?ae.tagName:'none',"
        "activeCls:(ae&&ae.className&&String(ae.className).slice(0,60))||'',"
        "hasFocus:document.hasFocus(),"
        "sendBtn:!!sb, sendDisabled:sb?sb.disabled===true:null,"
        "sendRect:(()=>{if(!sb)return null;const r=sb.getBoundingClientRect();"
        "return {x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2),w:Math.round(r.width),h:Math.round(r.height)}})()"
        ",atPoint:(at?at.tagName+'|'+(at.getAttribute&&at.getAttribute('data-testid')||'')+'|'+(at.className&&String(at.className).slice(0,40)||''):'null')"
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


def _norm(s):
    """Collapse whitespace so ProseMirror's extra blank lines around lists
    don't fail the insertText verification."""
    return " ".join((s or "").split())


def send_message(sess, text, gen_timeout, debug=False):
    """Insert text, submit with trusted Enter (verified), fall back to clicking
    the send button if Enter doesn't clear the composer. Wait for re-arm."""
    tab = sess.tab
    wait_for(lambda: composer_state(tab).get("hasComposer"), 30, "composer")
    ins = insert_text(tab, text)
    if ins.get("err"):
        raise RuntimeError(f"insertText failed: {ins['err']}")
    if _norm(ins.get("content", "")) != _norm(text):
        raise RuntimeError(f"insertText mismatch: got {ins.get('content')!r}")
    # primary: trusted Enter (immune to button hit-test races under load)
    press_enter(tab)
    try:
        wait_for(lambda: submitted_state(tab), 10, "message submitted", poll=1.0)
    except TimeoutError:
        raise_if_rate_limited(tab, "after Enter:")
        if debug:
            print(f"[gpt_fc:{AGENT_ID}] after Enter: {json.dumps(debug_state(tab))}", file=sys.stderr)
        # fallback: raise window + hit-test click on the send button
        raise_window(tab)
        click_send(tab)
        try:
            wait_for(lambda: submitted_state(tab), 10, "message submitted (click)", poll=1.0)
        except TimeoutError:
            raise_if_rate_limited(tab, "after click:")
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
    final DOM render lags the stream end and can even blank out mid-stream.
    Also reports OpenAI rate-limit dialogs ("Too many requests") which block
    the composer with a full-screen overlay. Returns
    {copy, count, lastText, errors, rl}."""
    expr = (
        "JSON.stringify((()=>{"
        "const turns=[...document.querySelectorAll('[data-testid^=conversation-turn-]')];"
        "const lt=turns[turns.length-1]||null;"
        "const ms=[...document.querySelectorAll('[data-message-author-role=assistant]')]"
        ".filter(m=>(m.innerText||'').trim().length>0);"
        "const err=[...document.querySelectorAll('[data-testid*=error]')]"
        ".map(e=>e.innerText.trim()).filter(t=>t.length>0).slice(0,3);"
        "const rld=[...document.querySelectorAll('[role=dialog]')]"
        ".find(x=>/Too many requests|requests too quickly/i.test(x.innerText||''));"
        "return {"
        "copy: lt? !!lt.querySelector('[data-testid=copy-turn-action-button]') : false,"
        "count: ms.length,"
        "lastText: ms.length?ms[ms.length-1].innerText:'',"
        "errors: err,"
        "rl: !!rld, rlText: rld?(rld.innerText||'').slice(0,150):''"
        "};})())"
    )
    return evaluate(tab, expr)


class RateLimited(Exception):
    """OpenAI throttled us (Too many requests dialog). Retry with backoff."""


def raise_if_rate_limited(tab, ctx=""):
    st = completion_state(tab)
    if st.get("rl"):
        raise RateLimited(f"{ctx} rate-limited: {st.get('rlText','')[:100]}")


def wait_final(sess, timeout, debug=False):
    """Wait for the reply to fully render. Two conditions, both required:

    1. copy-turn-action-button inside the last turn — the per-message action
       row renders when the STREAM ends (the only reliable end-of-stream
       signal; innerText stability alone lies mid-stream).
    2. After that, the text must STABILIZE — the final DOM text flush can lag
       the stream end by seconds under load (observed up to 10s+), so copy
       appearing is not enough. Text growth resets the stable counter.
    """
    tab = sess.tab
    last_len, stable = -1, 0
    t0 = time.time()
    deadline = t0 + timeout
    while time.time() < deadline:
        sess.renew_if_due()
        d = completion_state(tab)
        if d.get("rl"):
            raise RateLimited(f"wait_final: {d.get('rlText','')[:100]}")
        if d.get("copy") and d.get("lastText"):
            ln = len(d.get("lastText"))
            if ln == last_len:
                stable += 1
                if stable >= 5:  # ~10s stable after stream end — the final
                    # text chunk can arrive up to ~10s late under load
                    time.sleep(2)
                    d2 = completion_state(tab)
                    if d2.get("copy") and len(d2.get("lastText") or "") == ln:
                        if debug:
                            print(f"[gpt_fc:{AGENT_ID}] final {ln} chars at +{time.time()-t0:.1f}s", file=sys.stderr)
                        return {"count": d2["count"], "last": d2["lastText"], "errors": d2.get("errors") or []}
                    last_len = len(d2.get("lastText") or "")
                    stable = 0
            else:
                last_len = ln
                stable = 0
        else:
            last_len, stable = -1, 0
        if debug:
            print(f"[gpt_fc:{AGENT_ID}] poll +{time.time()-t0:.1f}s copy={d.get('copy')} len={len(d.get('lastText') or '')} stable={stable}", file=sys.stderr)
        time.sleep(2.0)
    # Deadline hit. Distinguish "finished right after the last poll" (copy
    # button present = complete, safe to return) from "genuinely still
    # generating" (copy absent = truncated). The latter must NOT be reported
    # as ok:true — that's how truncated replies silently slipped through as
    # "success" before.
    d = completion_state(tab)
    if d.get("copy") and d.get("lastText"):
        return {"count": d["count"], "last": d["lastText"], "errors": d.get("errors") or []}
    raise TimeoutError(
        f"reply incomplete after {timeout}s "
        f"(copy-button never appeared; {len(d.get('lastText') or '')} chars so far)"
    )


def recover_timeout(sess, grace, debug=False):
    """After a TimeoutError the tab usually still holds the reply — ChatGPT
    keeps generating in the background, so our deadline expiring does NOT stop
    the model. Re-attach and poll for the copy-button up to `grace` seconds;
    return the finished text or None. This turns wasted runs into recovered
    results instead of closing a tab mid-generation (which also throws away
    the plan-billed tokens already spent)."""
    tab = sess.tab
    deadline = time.time() + grace
    while time.time() < deadline:
        sess.renew_if_due()
        try:
            d = completion_state(tab)
        except Exception:
            return None
        if d.get("rl"):
            return None  # genuinely throttled; caller should retry, not read
        if d.get("copy") and d.get("lastText"):
            return d["lastText"].strip() or None
        if debug:
            print(f"[gpt_fc:{AGENT_ID}] recover poll +{time.time()-deadline+grace:.1f}s copy={d.get('copy')} len={len(d.get('lastText') or '')}", file=sys.stderr)
        time.sleep(5)
    return None


def main():
    global AGENT_ID
    ap = argparse.ArgumentParser()
    ap.add_argument("prompt", nargs="?", help="prompt text (or use --file/--stdin)")
    ap.add_argument("--file", help="read prompt from file")
    ap.add_argument("--stdin", action="store_true", help="read prompt from stdin")
    ap.add_argument("--model", default=None, help="model slug (best-effort; app may use default)")
    ap.add_argument("--timeout", type=int, default=900, help="max seconds for final reply")
    ap.add_argument("--gen-timeout", type=int, default=600, help="max seconds per chunk generation (gpt-5-6-thinking can take 5-15 min on big planning tasks)")
    ap.add_argument("--no-window", action="store_true",
                    help="skip per-agent window; lease a shared-window tab instead")
    ap.add_argument("--agent-id", default=AGENT_ID, help="X-Agent-Id (default: env or 'default')")
    ap.add_argument("--debug", action="store_true", help="dump state on submit failure")
    ap.add_argument("--no-close", action="store_true", help="leave tab+window open for inspection")
    ap.add_argument("--retries", type=int, default=2,
                    help="rate-limit retries with backoff (default 2 → 3 attempts, 30/60s)")
    ap.add_argument("--timeout-retries", type=int, default=1,
                    help="on a generation timeout, re-attach to the still-open tab and wait for the reply to finish (default 1)")
    ap.add_argument("--grace", type=int, default=300,
                    help="max extra seconds to wait for a timed-out reply to finish (used by --timeout-retries)")
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
    retries = max(0, args.retries)
    backoffs = [30, 60, 120, 240]
    for attempt in range(retries + 1):
        try:
            sess = GptSession(args.model, use_window=not args.no_window)
            wait_for(lambda: composer_state(sess.tab).get("hasComposer"), 60, "temp chat composer")
            raise_if_rate_limited(sess.tab, "pre-submit:")  # fresh chat may open into the modal

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
            return
        except RateLimited as e:
            if attempt >= retries:
                print(json.dumps({"ok": False, "error": f"rate limited after {retries+1} attempts: {e}",
                                  "elapsed": round(time.time() - t0, 1)}))
                sys.exit(4)
            wait_s = backoffs[attempt] if attempt < len(backoffs) else 240
            print(f"[gpt_fc:{AGENT_ID}] {e} — retry {attempt+2}/{retries+1} in {wait_s}s", file=sys.stderr)
            time.sleep(wait_s)
        except TimeoutError as e:
            # The tab usually still holds the reply — ChatGPT keeps generating
            # after our deadline. Re-attach and wait for it to finish instead
            # of burning the (already plan-billed) generation. This is the
            # automated version of the "re-attach and read the last assistant
            # node" recovery trick.
            if sess and args.timeout_retries > 0:
                rec = recover_timeout(sess, args.grace, debug=args.debug)
                if rec:
                    print(json.dumps({"ok": True, "recovered_after_timeout": True,
                                      "text": rec, "chars": len(rec),
                                      "model": args.model or "default",
                                      "elapsed": round(time.time() - t0, 1)}))
                    return
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
