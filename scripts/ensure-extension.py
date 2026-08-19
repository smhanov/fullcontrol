#!/usr/bin/env python3
"""Ensure the FullControl extension is loaded in the FC Chrome (via CDP).

Chrome 137+ ignores --load-extension even in Chrome-for-Testing; the reliable
path is CDP Extensions.loadUnpacked. The extension persists in the profile once
loaded, so this only needs to act on first run / after profile resets.

Loops forever, checking every 10s: CDP up? extension registered in profile?
if not, load. Registration is checked in the profile's Preferences file (the
extension id persists there once loadUnpacked has run) — NOT by looking for a
service-worker target, because MV3 SWs suspend when idle and vanish from
/json/list, which made the old check reload the extension every 10s and kill
its offscreen doc (the WS holder) before it could connect (Aug 2026).
"""
import json
import time
import urllib.request
import websocket

CDP_HTTP = "http://localhost:9224"
EXT_PATH = "/home/smhanov/fullcontrol/extension"
EXT_ID = "jeemcinbgcbicgiiplmjjkdbbdaheffd"  # derived from EXT_PATH (deterministic)
PROFILE = "/home/smhanov/fullcontrol/chrome-profile"
PREF_FILES = [
    f"{PROFILE}/Default/Preferences",
    f"{PROFILE}/Default/Secure Preferences",
]

def extension_loaded():
    # Registered in the profile = installed. The SW/offscreen come and go
    # (MV3 lifecycle) but the Preferences entry persists until a full
    # profile reset — exactly the condition the loader is meant to fix.
    for p in PREF_FILES:
        try:
            with open(p, "r", encoding="utf-8", errors="ignore") as f:
                if EXT_ID in f.read():
                    return True
        except FileNotFoundError:
            continue
        except Exception:
            continue
    return False

def cdp_json(path):
    with urllib.request.urlopen(CDP_HTTP + path, timeout=5) as r:
        return json.loads(r.read().decode())

def load_extension():
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
    # extension_loaded() already decided the extension is NOT registered in
    # the profile — just load it.
    res = send("Extensions.loadUnpacked", {"path": EXT_PATH})
    ext_id = (res.get("result") or {}).get("id")
    ws.close()
    return bool(ext_id)

def main():
    print("ensure-extension: watching for FC Chrome CDP on 9224", flush=True)
    while True:
        try:
            if extension_loaded():
                time.sleep(10)
                continue
            print("extension not loaded; attempting loadUnpacked", flush=True)
            try:
                if load_extension():
                    print("extension loaded OK", flush=True)
                else:
                    print("loadUnpacked returned no id (already loaded?)", flush=True)
            except Exception as e:
                print(f"loadUnpacked failed: {e}", flush=True)
        except Exception as e:
            print(f"check failed (CDP down?): {e}", flush=True)
        time.sleep(10)

if __name__ == "__main__":
    main()
