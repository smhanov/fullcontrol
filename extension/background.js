const DEFAULT_RELAY = "ws://127.0.0.1:18765/extension";
const attachedTabs = new Set();
const consoleBuffers = new Map();

let connected = false;
let lastError = "";
let token = "";
let relayUrl = DEFAULT_RELAY;
let httpPort = 18765;

chrome.runtime.onInstalled.addListener(() => ensureOffscreen());
chrome.runtime.onStartup.addListener(() => ensureOffscreen());
// 0.5 min = Chrome's documented minimum for chrome.alarms (0.4 gets
// clamped). This races the 30s MV3 SW idle timeout on purpose: each alarm
// event resets the SW idle timer AND re-verifies the offscreen doc (the
// WebSocket holder), so a dead offscreen is recreated within ~30-60s.
chrome.alarms.create("keepalive", { periodInMinutes: 0.5 });
chrome.alarms.onAlarm.addListener((a) => {
  if (a.name === "keepalive") ensureOffscreen();
});

chrome.storage.local.get(["relayUrl", "token", "httpPort"], (cfg) => {
  if (cfg.relayUrl) relayUrl = cfg.relayUrl;
  if (cfg.token) token = cfg.token;
  if (cfg.httpPort) httpPort = cfg.httpPort;
  ensureOffscreen();
});

chrome.storage.onChanged.addListener((changes) => {
  let push = false;
  if (changes.relayUrl) {
    relayUrl = changes.relayUrl.newValue || DEFAULT_RELAY;
    push = true;
  }
  if (changes.token && changes.token.newValue) {
    token = changes.token.newValue;
    push = true;
  }
  if (push) pushConfig();
});

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || msg.channel !== "fc-relay") return;
  if (msg.type === "status") {
    connected = !!msg.connected;
    lastError = msg.lastError || "";
    chrome.storage.local.set({ connected, lastError, relayUrl });
    sendResponse?.({ ok: true });
    return true;
  }
  if (msg.type === "message") {
    handleRelayRaw(msg.data).catch((err) => console.warn("relay handler", err));
    // Every relay event also nudges the offscreen doc (SW -> offscreen
    // runtime messages keep it from Chrome's idle-close; the relay pongs the
    // extension's 15s WS heartbeat, so this fires at least every ~15s).
    keepOffscreenAlive();
    sendResponse?.({ ok: true });
    return true;
  }
  return false;
});

async function ensureOffscreen() {
  const contexts = await chrome.runtime.getContexts({
    contextTypes: ["OFFSCREEN_DOCUMENT"],
  });
  if (contexts.length) {
    // A dying/zombie context still shows up in getContexts but drops
    // messages — verify it actually answers, and if not, tear it down and
    // recreate. Chrome allows only ONE offscreen doc per extension, so
    // closeDocument() must precede createDocument().
    if (await pingOffscreen()) return pushConfig();
    try {
      await chrome.offscreen.closeDocument();
    } catch {}
  }
  await chrome.offscreen.createDocument({
    url: "offscreen.html",
    reasons: ["BLOBS"],
    justification: "Keep a persistent WebSocket to the FullControl relay",
  });
  await pushConfig();
}

// Resolves true only if the offscreen doc answers a ping within 3s.
function pingOffscreen() {
  return new Promise((resolve) => {
    let settled = false;
    function done(v) {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        resolve(v);
      }
    }
    const timer = setTimeout(() => done(false), 3000);
    try {
      chrome.runtime
        .sendMessage({ channel: "fc-offscreen", type: "ping" })
        .then((resp) => done(!!(resp && resp.ok === true)))
        .catch(() => done(false));
    } catch {
      done(false);
    }
  });
}

// Cheap SW -> offscreen nudge; no response needed. Keeps the offscreen doc
// (WS holder) warm so Chrome's idle-close never takes it down.
function keepOffscreenAlive() {
  chrome.runtime
    .sendMessage({ channel: "fc-offscreen", type: "keepalive" })
    .catch(() => {});
}

async function pushConfig() {
  try {
    await chrome.runtime.sendMessage({
      channel: "fc-offscreen",
      type: "config",
      relayUrl,
      token,
    });
  } catch {
    // offscreen may still be starting
  }
}

function sendToRelay(obj) {
  chrome.runtime.sendMessage({ channel: "fc-offscreen", type: "send", payload: obj }).catch(() => {});
}

function reply(id, result, error) {
  sendToRelay({ type: "response", id, result, error: error || null });
}

function errMessage(err) {
  if (!err) return "error";
  if (typeof err === "string") return err;
  return err.message || String(err);
}

async function handleRelayRaw(raw) {
  let msg;
  try {
    msg = JSON.parse(raw);
  } catch {
    return;
  }
  await handleRelay(msg);
}

async function handleRelay(msg) {
  if (!msg || typeof msg !== "object") return;
  if (msg.type === "welcome") {
    const patch = {};
    if (msg.token && msg.token !== token) {
      token = msg.token;
      patch.token = token;
    }
    if (msg.httpPort) {
      httpPort = msg.httpPort;
      patch.httpPort = httpPort;
    }
    if (Object.keys(patch).length) chrome.storage.local.set(patch);
    return;
  }
  if (msg.type === "pong" || msg.type === "ping") return;
  if (msg.type !== "request") return;
  const { id, method, params } = msg;
  try {
    const result = await dispatch(method, params || {});
    reply(id, result, null);
  } catch (err) {
    reply(id, null, errMessage(err));
  }
}

async function dispatch(method, params) {
  switch (method) {
    case "ping":
      return { ok: true, t: Date.now() };
    case "getStatus":
      return {
        connected,
        relayUrl,
        extensionId: chrome.runtime.id,
        version: chrome.runtime.getManifest().version,
      };
    case "listTabs":
      return listTabs(params);
    case "listWindows":
      return chrome.windows.getAll({ populate: true });
    case "createWindow":
      // Mint a window. focused defaults to false so agents never steal the
      // user's focus; pass focused:true only for human-in-the-loop moments.
      return chrome.windows.create({
        url: params.url || "about:blank",
        focused: params.focused === true,
        state: params.state,
      });
    case "closeWindow":
      await chrome.windows.remove(num(params.windowId));
      return { ok: true };
    case "createTab":
      return createTab(params);
    case "closeTab":
      await chrome.tabs.remove(num(params.tabId));
      return { ok: true };
    case "activateTab":
      return activateTab(params);
    case "updateTab":
      return tabInfo(await chrome.tabs.update(num(params.tabId), params.update || {}));
    case "reloadTab":
      await chrome.tabs.reload(num(params.tabId), { bypassCache: !!params.bypassCache });
      return { ok: true };
    case "navigate":
      return navigate(params);
    case "goBack":
      await chrome.tabs.goBack(num(params.tabId));
      return { ok: true };
    case "goForward":
      await chrome.tabs.goForward(num(params.tabId));
      return { ok: true };
    case "screenshot":
      return screenshot(params);
    case "snapshot":
      return snapshot(params);
    case "click":
      return click(params);
    case "type":
      return typeText(params);
    case "press":
      return pressKey(params);
    case "hover":
      return hover(params);
    case "scroll":
      return scroll(params);
    case "select":
      return selectOption(params);
    case "waitFor":
      return waitFor(params);
    case "evaluate":
      return evaluate(params);
    case "cdp":
      return cdp(params);
    case "attach":
      await attach(num(params.tabId));
      return { ok: true };
    case "detach":
      await detach(num(params.tabId));
      return { ok: true };
    case "console":
      return { entries: consoleBuffers.get(num(params.tabId)) || [] };
    case "cookies":
      return getCookies(params);
    case "setCookie":
      return chrome.cookies.set(params);
    case "getHistory":
      return chrome.history.search({
        text: params.text || "",
        maxResults: params.maxResults || 50,
        startTime: params.startTime || 0,
      });
    case "getBookmarks":
      return params.id ? chrome.bookmarks.getSubTree(params.id) : chrome.bookmarks.getTree();
    default:
      throw new Error(`unknown method: ${method}`);
  }
}

async function listTabs(params) {
  const query = params.query || {};
  const tabs = await chrome.tabs.query(query);
  return tabs.map(tabInfo);
}

function tabInfo(tab) {
  return {
    id: tab.id,
    windowId: tab.windowId,
    index: tab.index,
    title: tab.title,
    url: tab.url,
    pendingUrl: tab.pendingUrl,
    active: tab.active,
    highlighted: tab.highlighted,
    pinned: tab.pinned,
    audible: tab.audible,
    muted: tab.mutedInfo?.muted || false,
    status: tab.status,
    favIconUrl: tab.favIconUrl,
    incognito: tab.incognito,
    width: tab.width,
    height: tab.height,
    groupId: tab.groupId,
  };
}

async function createTab(params) {
  const wantActive = params.active !== false;
  // Create inactive first: chrome.tabs.create({active:true}) raises the whole
  // window to the foreground (seen Aug 2026 on Linux), stealing the user's
  // focus. Activating via tabs.update afterwards makes the tab active inside
  // its window WITHOUT raising it.
  const tab = await chrome.tabs.create({
    url: params.url || "about:blank",
    active: false,
    windowId: params.windowId,
    index: params.index,
    pinned: !!params.pinned,
  });
  if (wantActive) {
    await chrome.tabs.update(tab.id, { active: true });
  }
  if (params.waitUntil) {
    await waitTabComplete(tab.id, params.timeout || 30000);
  }
  return tabInfo(await chrome.tabs.get(tab.id));
}

async function activateTab(params) {
  const tabId = num(params.tabId);
  const tab = await chrome.tabs.get(tabId);
  // Do NOT raise the window by default — that steals focus from whatever the
  // user is doing (seen Aug 2026: Edge pops to front on e14 on every agent
  // activate/screenshot). Activating the tab inside its window is enough for
  // CDP/snapshot work. Pass {focus:true} to explicitly raise (human-in-the-
  // loop moments: captcha solving, user observation).
  if (params.focus) {
    await chrome.windows.update(tab.windowId, { focused: true });
  }
  return tabInfo(await chrome.tabs.update(tabId, { active: true }));
}

async function navigate(params) {
  const tabId = num(params.tabId);
  const tab = await chrome.tabs.update(tabId, { url: params.url });
  if (params.waitUntil !== false) {
    await waitTabComplete(tabId, params.timeout || 30000);
  }
  return tabInfo(await chrome.tabs.get(tab.id));
}

function waitTabComplete(tabId, timeout) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => {
      chrome.tabs.onUpdated.removeListener(listener);
      reject(new Error("navigation timeout"));
    }, timeout);
    function listener(id, info) {
      if (id === tabId && info.status === "complete") {
        clearTimeout(t);
        chrome.tabs.onUpdated.removeListener(listener);
        resolve();
      }
    }
    chrome.tabs.get(tabId).then((tab) => {
      if (tab.status === "complete") {
        clearTimeout(t);
        chrome.tabs.onUpdated.removeListener(listener);
        resolve();
      }
    }).catch(() => {});
    chrome.tabs.onUpdated.addListener(listener);
  });
}

async function screenshot(params) {
  const tabId = params.tabId != null ? num(params.tabId) : undefined;
  let windowId;
  if (tabId != null) {
    const tab = await chrome.tabs.get(tabId);
    // Make the tab active in its window WITHOUT raising the window — raising
    // steals focus from the user on every agent screenshot (seen Aug 2026 on
    // e14). captureVisibleTab only needs the tab active, not the window
    // focused, in modern Chromium. If the capture still fails, fall back to
    // focusing the window (below) so screenshots never break.
    if (!tab.active) await chrome.tabs.update(tabId, { active: true });
    await sleep(80);
    windowId = tab.windowId;
  }
  const format = params.format === "jpeg" ? "jpeg" : "png";
  const opts = { format, quality: params.quality || 90 };
  try {
    const dataUrl = await chrome.tabs.captureVisibleTab(windowId, opts);
    return {
      mimeType: format === "jpeg" ? "image/jpeg" : "image/png",
      data: dataUrl.replace(/^data:image\/\w+;base64,/, ""),
      dataUrl,
    };
  } catch (err) {
    // Some pages/versions need the window raised. Only do it as a fallback
    // so the common case never steals focus.
    if (tabId != null) {
      const tab = await chrome.tabs.get(tabId);
      await chrome.windows.update(tab.windowId, { focused: true });
      await sleep(120);
      const dataUrl = await chrome.tabs.captureVisibleTab(windowId, opts);
      return {
        mimeType: format === "jpeg" ? "image/jpeg" : "image/png",
        data: dataUrl.replace(/^data:image\/\w+;base64,/, ""),
        dataUrl,
      };
    }
    throw err;
  }
}

async function snapshot(params) {
  const tabId = num(params.tabId);
  const payload = {
    type: "snapshot",
    includeHtml: !!params.includeHtml,
    compact: params.compact !== false,
    interestingOnly: params.interestingOnly !== false,
  };
  return withContent(tabId, payload);
}

async function click(params) {
  const tabId = num(params.tabId);
  const button = params.button || "left";
  const clickCount = params.clickCount || 1;
  if (params.x != null && params.y != null) {
    await attach(tabId);
    await trustedClick(tabId, params.x, params.y, button, clickCount);
    return { ok: true, via: "cdp", x: params.x, y: params.y };
  }
  // Ref/selector clicks: resolve the element's live center, then click it
  // with TRUSTED CDP input (isTrusted=true). Synthetic dispatchEvent clicks
  // are ignored by React, Angular CDK overlays, select2, and any page that
  // checks event.isTrusted — the #1 cause of "click didn't register".
  // Fall back to synthetic events if CDP attach fails (some pages deny the
  // debugger: "Cannot access a chrome-extension:// URL...").
  if (params.selector || params.ref) {
    try {
      const pt = await withContent(tabId, {
        type: "point",
        selector: params.selector,
        ref: params.ref,
      });
      if (pt && Number.isFinite(pt.x) && Number.isFinite(pt.y)) {
        await attach(tabId);
        await trustedClick(tabId, pt.x, pt.y, button, clickCount);
        return { ok: true, via: "cdp", x: pt.x, y: pt.y, ref: pt.ref, bbox: pt.bbox };
      }
    } catch (err) {
      // attach or point resolution failed — fall through to synthetic
    }
  }
  return withContent(tabId, {
    type: "click",
    selector: params.selector,
    ref: params.ref,
    button,
    clickCount,
  });
}

// Trusted mouse click via the CDP Input domain. Chrome treats these as real
// user input (isTrusted=true), hit-tested at (x, y), generating the proper
// pointerdown/mousedown/pointerup/mouseup/click sequence. A mouseMoved
// precedes the press so hover/pointerenter handlers fire and hit-testing is
// correct, and clickCount>1 emits the press/release pairs for a real
// double-click.
async function trustedClick(tabId, x, y, button, clickCount) {
  const count = Math.max(1, clickCount || 1);
  const btn =
    button === 2 || button === "right" ? "right" :
    button === 1 || button === "middle" ? "middle" :
    button === 3 || button === "back" ? "back" :
    button === 4 || button === "forward" ? "forward" : "left";
  const buttons = btn === "right" ? 2 : btn === "middle" ? 4 : btn === "back" ? 8 : btn === "forward" ? 16 : 1;
  await sendCdp(tabId, "Input.dispatchMouseEvent", {
    type: "mouseMoved",
    x,
    y,
    button: "none",
    buttons: 0,
  });
  for (let i = 1; i <= count; i++) {
    await sendCdp(tabId, "Input.dispatchMouseEvent", {
      type: "mousePressed",
      x,
      y,
      button: btn,
      buttons,
      clickCount: i,
    });
    await sendCdp(tabId, "Input.dispatchMouseEvent", {
      type: "mouseReleased",
      x,
      y,
      button: btn,
      buttons: 0,
      clickCount: i,
    });
  }
}

async function hover(params) {
  return withContent(num(params.tabId), {
    type: "hover",
    selector: params.selector,
    ref: params.ref,
  });
}

async function typeText(params) {
  const tabId = num(params.tabId);
  if (params.selector || params.ref) {
    await withContent(tabId, {
      type: "focus",
      selector: params.selector,
      ref: params.ref,
      clear: params.clear !== false,
    });
  }
  if (params.slowly) {
    await attach(tabId);
    for (const ch of params.text || "") {
      await sendCdp(tabId, "Input.dispatchKeyEvent", {
        type: "keyDown",
        text: ch,
        unmodifiedText: ch,
      });
      await sendCdp(tabId, "Input.dispatchKeyEvent", {
        type: "keyUp",
        text: ch,
        unmodifiedText: ch,
      });
    }
    return { ok: true, via: "cdp" };
  }
  return withContent(tabId, {
    type: "type",
    text: params.text || "",
    submit: !!params.submit,
  });
}

async function pressKey(params) {
  const tabId = num(params.tabId);
  const key = params.key;
  try {
    await attach(tabId);
    const def = keyDef(key);
    await sendCdp(tabId, "Input.dispatchKeyEvent", {
      type: "rawKeyDown",
      key: def.key,
      code: def.code,
      windowsVirtualKeyCode: def.keyCode,
      nativeVirtualKeyCode: def.keyCode,
      modifiers: def.modifiers,
    });
    if (def.text) {
      await sendCdp(tabId, "Input.dispatchKeyEvent", {
        type: "char",
        text: def.text,
        unmodifiedText: def.text,
        key: def.key,
        code: def.code,
        windowsVirtualKeyCode: def.keyCode,
      });
    }
    await sendCdp(tabId, "Input.dispatchKeyEvent", {
      type: "keyUp",
      key: def.key,
      code: def.code,
      windowsVirtualKeyCode: def.keyCode,
      nativeVirtualKeyCode: def.keyCode,
      modifiers: def.modifiers,
    });
    return { ok: true, via: "cdp", key };
  } catch {
    return withContent(tabId, { type: "press", key });
  }
}

async function scroll(params) {
  return withContent(num(params.tabId), {
    type: "scroll",
    selector: params.selector,
    ref: params.ref,
    x: params.x,
    y: params.y,
    deltaX: params.deltaX,
    deltaY: params.deltaY,
  });
}

async function selectOption(params) {
  return withContent(num(params.tabId), {
    type: "select",
    selector: params.selector,
    ref: params.ref,
    values: params.values || (params.value != null ? [params.value] : []),
  });
}

async function waitFor(params) {
  const tabId = num(params.tabId);
  const timeout = params.timeout || 15000;
  const start = Date.now();
  let lastErr = "not found";
  while (Date.now() - start < timeout) {
    try {
      const result = await withContent(tabId, {
        type: "query",
        selector: params.selector,
        ref: params.ref,
        text: params.text,
      });
      if (result && result.found) return result;
      lastErr = result?.error || "not found";
    } catch (err) {
      lastErr = errMessage(err);
    }
    await sleep(200);
  }
  throw new Error(`waitFor timeout: ${lastErr}`);
}

async function evaluate(params) {
  const tabId = num(params.tabId);
  await attach(tabId);
  const r = await sendCdp(tabId, "Runtime.evaluate", {
    expression: params.expression,
    returnByValue: true,
    awaitPromise: params.awaitPromise !== false,
  });
  if (r.exceptionDetails) {
    const d = r.exceptionDetails;
    throw new Error(d.exception?.description || d.text || "evaluate exception");
  }
  return { result: r.result?.value, via: "cdp" };
}

async function cdp(params) {
  const tabId = num(params.tabId);
  await attach(tabId);
  return { result: await sendCdp(tabId, params.method, params.params || {}) };
}

async function getCookies(params) {
  if (params.url) return chrome.cookies.getAll({ url: params.url });
  if (params.domain) return chrome.cookies.getAll({ domain: params.domain });
  return chrome.cookies.getAll({});
}

async function attach(tabId) {
  if (attachedTabs.has(tabId)) return;
  await new Promise((resolve, reject) => {
    chrome.debugger.attach({ tabId }, "1.3", () => {
      if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
      else resolve();
    });
  });
  attachedTabs.add(tabId);
  try {
    await sendCdp(tabId, "Runtime.enable", {});
    await sendCdp(tabId, "Page.enable", {});
    await sendCdp(tabId, "Network.enable", {});
  } catch {}
}

async function detach(tabId) {
  if (!attachedTabs.has(tabId)) return;
  await new Promise((resolve) => {
    chrome.debugger.detach({ tabId }, () => resolve());
  });
  attachedTabs.delete(tabId);
}

function sendCdp(tabId, method, params) {
  return new Promise((resolve, reject) => {
    chrome.debugger.sendCommand({ tabId }, method, params || {}, (result) => {
      if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
      else resolve(result);
    });
  });
}

async function injectContent(tabId) {
  await chrome.scripting.executeScript({
    target: { tabId, allFrames: true },
    files: ["content.js"],
  });
}

async function withContent(tabId, message) {
  try {
    return await sendToTab(tabId, message);
  } catch {
    await injectContent(tabId);
    return await sendToTab(tabId, message);
  }
}

function sendToTab(tabId, message) {
  return new Promise((resolve, reject) => {
    chrome.tabs.sendMessage(tabId, message, { frameId: 0 }, (response) => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
        return;
      }
      if (!response) {
        reject(new Error("empty content response"));
        return;
      }
      if (response.error) {
        reject(new Error(response.error));
        return;
      }
      resolve(response);
    });
  });
}

function keyDef(key) {
  const special = {
    Enter: { key: "Enter", code: "Enter", keyCode: 13, text: "\r" },
    Tab: { key: "Tab", code: "Tab", keyCode: 9 },
    Escape: { key: "Escape", code: "Escape", keyCode: 27 },
    Backspace: { key: "Backspace", code: "Backspace", keyCode: 8 },
    Delete: { key: "Delete", code: "Delete", keyCode: 46 },
    ArrowUp: { key: "ArrowUp", code: "ArrowUp", keyCode: 38 },
    ArrowDown: { key: "ArrowDown", code: "ArrowDown", keyCode: 40 },
    ArrowLeft: { key: "ArrowLeft", code: "ArrowLeft", keyCode: 37 },
    ArrowRight: { key: "ArrowRight", code: "ArrowRight", keyCode: 39 },
    Home: { key: "Home", code: "Home", keyCode: 36 },
    End: { key: "End", code: "End", keyCode: 35 },
    PageUp: { key: "PageUp", code: "PageUp", keyCode: 33 },
    PageDown: { key: "PageDown", code: "PageDown", keyCode: 34 },
    Space: { key: " ", code: "Space", keyCode: 32, text: " " },
  };
  if (special[key]) return { modifiers: 0, ...special[key] };
  if (key.length === 1) {
    const upper = key.toUpperCase();
    return {
      key,
      code: /^[a-zA-Z]$/.test(key) ? `Key${upper}` : key,
      keyCode: upper.charCodeAt(0),
      text: key,
      modifiers: 0,
    };
  }
  return { key, code: key, keyCode: 0, modifiers: 0 };
}

function num(v) {
  const n = Number(v);
  if (!Number.isFinite(n)) throw new Error(`invalid id: ${v}`);
  return n;
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

chrome.debugger.onEvent.addListener((source, method, params) => {
  if (!source.tabId) return;
  if (method === "Runtime.consoleAPICalled" || method === "Runtime.exceptionThrown") {
    const buf = consoleBuffers.get(source.tabId) || [];
    buf.push({ t: Date.now(), method, params });
    if (buf.length > 200) buf.shift();
    consoleBuffers.set(source.tabId, buf);
  }
  sendToRelay({ type: "event", event: "cdp", tabId: source.tabId, method, params });
});

chrome.debugger.onDetach.addListener((source, reason) => {
  if (source.tabId) attachedTabs.delete(source.tabId);
  sendToRelay({ type: "event", event: "detached", tabId: source.tabId, reason });
});

chrome.tabs.onCreated.addListener((tab) => {
  sendToRelay({ type: "event", event: "tabCreated", tab: tabInfo(tab) });
});
chrome.tabs.onRemoved.addListener((tabId, info) => {
  attachedTabs.delete(tabId);
  sendToRelay({ type: "event", event: "tabRemoved", tabId, info });
});
chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  sendToRelay({ type: "event", event: "tabUpdated", tabId, changeInfo, tab: tabInfo(tab) });
});
chrome.tabs.onActivated.addListener((info) => {
  sendToRelay({ type: "event", event: "tabActivated", info });
});

ensureOffscreen();
