#!/usr/bin/env python3
"""FullControl extension watchdog (relay-health based auto-recovery).

Chrome 137+ ignores --load-extension even in Chrome-for-Testing; the reliable
path is CDP Extensions.loadUnpacked. But that alone is not enough: the MV3
service worker + offscreen document (the relay WebSocket holder) can die while
Chrome keeps running, and CfT 152 does NOT auto-restore the unpacked extension
after a chrome restart. A Preferences-file check false-positives on a
registered-but-dead extension (the id persists even when nothing is running),
which is why the old loader could watch a dead extension for hours.

This watchdog uses the RELAY's /health as ground truth (it reflects the live
WebSocket state, `extensionConnected`), and only considers the extension truly
gone when CDP shows NO extension targets at all:

  relay reachable AND health.extensionConnected == false
  AND CDP up AND no chrome-extension://<id> target in /json/list
  for 3 consecutive 10s checks (~30s)
    -> Extensions.uninstall + Extensions.loadUnpacked (same path as
       ext-diagnose.mjs --recover). Auto-heals every drop in ~40-60s:
       offscreen death, chrome-restart non-load, post-crash states.

No lockfile needed: the recover condition is narrow (no live extension targets
+ relay disconnected for 30s), so a manual `ext-diagnose.mjs --recover` racing
the watchdog just does the same idempotent thing twice.
"""
import json
import time
import urllib.request
import websocket

CDP_HTTP = "http://localhost:9224"
RELAY_HEALTH = "http://localhost:18765/health"
EXT_PATH = "/home/smhanov/fullcontrol/extension"
EXT_ID = "jeemcinbgcbicgiiplmjjkdbbdaheffd"  # derived from EXT_PATH (deterministic)
RECOVER_AFTER = 3  # consecutive failed checks (~30s) before acting
CHECK_EVERY = 10  # seconds

def relay_health():
    """Return the extensionConnected bool, or None if the relay is unreachable."""
    try:
        with urllib.request.urlopen(RELAY_HEALTH, timeout=3) as r:
            data = json.loads(r.read().decode())
        return bool(data.get("extensionConnected"))
    except Exception:
        return None  # relay down / starting — not the extension's fault

def extension_targets():
    """Any live CDP target owned by the extension (SW, offscreen, popup...)."""
    with urllib.request.urlopen(CDP_HTTP + "/json/list", timeout=3) as r:
        targets = json.loads(r.read().decode())
    return [
        t for t in targets
        if t.get("url", "").startswith(f"chrome-extension://{EXT_ID}")
    ]

def cdp_json(path):
    with urllib.request.urlopen(CDP_HTTP + path, timeout=5) as r:
        return json.loads(r.read().decode())

def recover_extension():
    """Uninstall + loadUnpacked: clears stale registration, fresh SW+offscreen."""
    info = cdp_json("/json/version")
    ws = websocket.create_connection(
        info["webSocketDebuggerUrl"], origin="http://localhost:9224",
        suppress_origin=True, timeout=20)
    ws.settimeout(15)
    mid = 0
    def send(method, params=None):
        nonlocal mid
        mid += 1
        ws.send(json.dumps({"id": mid, "method": method, "params": params or {}}))
        while True:
            resp = json.loads(ws.recv())
            if resp.get("id") == mid:
                return resp
    try:
        try:
            res = send("Extensions.uninstall", {"id": EXT_ID})
            print(f"uninstall: {res.get('result') or res.get('error', {}).get('message', 'ok')}", flush=True)
        except Exception as e:
            print(f"uninstall (may already be gone): {e}", flush=True)
        time.sleep(1)
        res = send("Extensions.loadUnpacked", {"path": EXT_PATH})
        ext_id = (res.get("result") or {}).get("id")
        print(f"loadUnpacked: {ext_id or res.get('error', {}).get('message', 'no id')}", flush=True)
        return bool(ext_id)
    finally:
        ws.close()

def main():
    print("fc-extloader watchdog: relay health + CDP target check every 10s", flush=True)
    fails = 0
    while True:
        time.sleep(CHECK_EVERY)
        connected = relay_health()
        if connected is None:
            fails = 0  # relay down/starting — not the extension's problem
            continue
        if connected:
            fails = 0
            continue
        # Relay says disconnected. Is the extension even loaded?
        try:
            if extension_targets():
                fails = 0  # extension alive, WS reconnecting — let it
                continue
        except Exception as e:
            print(f"CDP check failed (chrome down?): {e}", flush=True)
            fails = 0
            continue
        fails += 1
        if fails < RECOVER_AFTER:
            continue
        print(f"extension gone for ~{RECOVER_AFTER * CHECK_EVERY}s (relay: disconnected, no CDP targets) — recovering", flush=True)
        try:
            if recover_extension():
                print("recovery loadUnpacked OK", flush=True)
            else:
                print("recovery loadUnpacked returned no id", flush=True)
        except Exception as e:
            print(f"recovery failed: {e}", flush=True)
        fails = 0  # re-arm; next loop re-checks actual state
        time.sleep(5)  # let the fresh SW boot + offscreen connect

if __name__ == "__main__":
    main()
