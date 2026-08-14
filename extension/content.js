(() => {
  if (window.__fullcontrolInjected) return;
  window.__fullcontrolInjected = true;

  let nextRef = 1;
  const refs = new WeakMap();
  const byRef = new Map();

  function refFor(el) {
    if (!el) return null;
    let id = refs.get(el);
    if (id) return id;
    id = `e${nextRef++}`;
    refs.set(el, id);
    byRef.set(id, new WeakRef(el));
    return id;
  }

  function fromRef(id) {
    if (!id) return null;
    const wr = byRef.get(id);
    return wr ? wr.deref() || null : null;
  }

  function resolve(selector, ref) {
    if (ref) {
      const el = fromRef(ref);
      if (!el) throw new Error(`stale ref: ${ref}`);
      return el;
    }
    if (selector) {
      const el = document.querySelector(selector);
      if (!el) throw new Error(`not found: ${selector}`);
      return el;
    }
    throw new Error("selector or ref required");
  }

  function visible(el) {
    if (!(el instanceof Element)) return false;
    const st = getComputedStyle(el);
    if (st.display === "none" || st.visibility === "hidden" || Number(st.opacity) === 0) return false;
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  }

  function roleOf(el) {
    const explicit = el.getAttribute("role");
    if (explicit) return explicit;
    const tag = el.tagName.toLowerCase();
    const map = {
      a: "link",
      button: "button",
      input: el.type === "checkbox" ? "checkbox" : el.type === "radio" ? "radio" : el.type === "submit" ? "button" : "textbox",
      textarea: "textbox",
      select: "combobox",
      img: "img",
      h1: "heading",
      h2: "heading",
      h3: "heading",
      h4: "heading",
      h5: "heading",
      h6: "heading",
      nav: "navigation",
      main: "main",
      header: "banner",
      footer: "contentinfo",
      form: "form",
      table: "table",
      li: "listitem",
      ul: "list",
      ol: "list",
    };
    return map[tag] || tag;
  }

  function nameOf(el) {
    const labelled = el.getAttribute("aria-label") || el.getAttribute("alt") || el.getAttribute("title") || el.getAttribute("placeholder");
    if (labelled) return labelled.trim();
    if (el.labels && el.labels[0]) return el.labels[0].innerText.trim().slice(0, 120);
    const text = (el.innerText || el.value || "").replace(/\s+/g, " ").trim();
    return text.slice(0, 120);
  }

  const INTERESTING = new Set([
    "a", "button", "input", "textarea", "select", "option",
    "h1", "h2", "h3", "h4", "h5", "h6",
    "img", "label", "form", "nav", "main", "header", "footer",
    "summary", "details", "dialog", "textarea",
  ]);

  function isInteresting(el) {
    if (!(el instanceof Element)) return false;
    const tag = el.tagName.toLowerCase();
    if (INTERESTING.has(tag)) return true;
    if (el.getAttribute("role")) return true;
    if (el.isContentEditable) return true;
    if (el.onclick || el.getAttribute("onclick") || el.tabIndex >= 0) return true;
    return false;
  }

  function walk(root, interestingOnly, depth, maxDepth, out) {
    if (!root || depth > maxDepth) return;
    const children = root.children ? Array.from(root.children) : [];
    for (const el of children) {
      if (!visible(el)) {
        walk(el, interestingOnly, depth + 1, maxDepth, out);
        continue;
      }
      const keep = !interestingOnly || isInteresting(el);
      if (keep) {
        const r = el.getBoundingClientRect();
        out.push({
          ref: refFor(el),
          tag: el.tagName.toLowerCase(),
          role: roleOf(el),
          name: nameOf(el),
          id: el.id || undefined,
          type: el.type || undefined,
          href: el.href || undefined,
          value: typeof el.value === "string" ? el.value.slice(0, 200) : undefined,
          checked: el.checked,
          disabled: el.disabled || undefined,
          placeholder: el.placeholder || undefined,
          bbox: {
            x: Math.round(r.x),
            y: Math.round(r.y),
            w: Math.round(r.width),
            h: Math.round(r.height),
          },
        });
      }
      walk(el, interestingOnly, depth + 1, maxDepth, out);
    }
  }

  function snapshot(opts) {
    const nodes = [];
    walk(document.body || document.documentElement, opts.interestingOnly !== false, 0, 30, nodes);
    const payload = {
      url: location.href,
      title: document.title,
      nodes,
    };
    if (opts.includeHtml) {
      payload.html = document.documentElement.outerHTML.slice(0, 400000);
    }
    return payload;
  }

  function center(el) {
    el.scrollIntoView({ block: "center", inline: "center" });
    const r = el.getBoundingClientRect();
    return { x: r.x + r.width / 2, y: r.y + r.height / 2, bbox: r.toJSON() };
  }

  function fire(el, type, init) {
    el.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, view: window, ...init }));
  }

  function doClick(el, button, clickCount) {
    const c = center(el);
    el.focus({ preventScroll: true });
    fire(el, "pointerover", { clientX: c.x, clientY: c.y });
    fire(el, "mouseover", { clientX: c.x, clientY: c.y });
    for (let i = 1; i <= clickCount; i++) {
      fire(el, "pointerdown", { clientX: c.x, clientY: c.y, button });
      fire(el, "mousedown", { clientX: c.x, clientY: c.y, button });
      fire(el, "pointerup", { clientX: c.x, clientY: c.y, button });
      fire(el, "mouseup", { clientX: c.x, clientY: c.y, button });
      fire(el, "click", { clientX: c.x, clientY: c.y, button, detail: i });
    }
    if (el instanceof HTMLElement) el.click();
    return { ok: true, ref: refFor(el), ...c };
  }

  function setNativeValue(el, value) {
    const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(proto, "value")?.set;
    if (setter) setter.call(el, value);
    else el.value = value;
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
  }

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    Promise.resolve()
      .then(() => handle(msg))
      .then((result) => sendResponse(result || { ok: true }))
      .catch((err) => sendResponse({ error: err.message || String(err) }));
    return true;
  });

  function handle(msg) {
    switch (msg.type) {
      case "snapshot":
        return snapshot(msg);
      case "click": {
        const el = resolve(msg.selector, msg.ref);
        return doClick(el, msg.button === "right" ? 2 : 0, msg.clickCount || 1);
      }
      case "hover": {
        const el = resolve(msg.selector, msg.ref);
        const c = center(el);
        fire(el, "pointerover", { clientX: c.x, clientY: c.y });
        fire(el, "mouseover", { clientX: c.x, clientY: c.y });
        fire(el, "mouseenter", { clientX: c.x, clientY: c.y });
        return { ok: true, ref: refFor(el), ...c };
      }
      case "focus": {
        const el = resolve(msg.selector, msg.ref);
        center(el);
        el.focus({ preventScroll: true });
        if (msg.clear && "value" in el) setNativeValue(el, "");
        return { ok: true, ref: refFor(el) };
      }
      case "type": {
        const el = document.activeElement;
        if (!el) throw new Error("nothing focused");
        if ("value" in el) {
          setNativeValue(el, (el.value || "") + (msg.text || ""));
        } else if (el.isContentEditable) {
          document.execCommand("insertText", false, msg.text || "");
        }
        if (msg.submit) {
          const form = el.form || el.closest("form");
          if (form) form.requestSubmit ? form.requestSubmit() : form.submit();
          else el.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
        }
        return { ok: true };
      }
      case "press": {
        const el = document.activeElement || document.body;
        const ev = { key: msg.key, bubbles: true, cancelable: true };
        el.dispatchEvent(new KeyboardEvent("keydown", ev));
        el.dispatchEvent(new KeyboardEvent("keypress", ev));
        el.dispatchEvent(new KeyboardEvent("keyup", ev));
        return { ok: true };
      }
      case "scroll": {
        if (msg.selector || msg.ref) {
          const el = resolve(msg.selector, msg.ref);
          el.scrollIntoView({ block: "center", inline: "center" });
          return { ok: true, ref: refFor(el) };
        }
        window.scrollBy(msg.deltaX || msg.x || 0, msg.deltaY || msg.y || 0);
        return { ok: true, scrollX: window.scrollX, scrollY: window.scrollY };
      }
      case "select": {
        const el = resolve(msg.selector, msg.ref);
        if (!(el instanceof HTMLSelectElement)) throw new Error("not a select");
        const values = msg.values || [];
        for (const opt of el.options) {
          opt.selected = values.includes(opt.value) || values.includes(opt.text);
        }
        el.dispatchEvent(new Event("input", { bubbles: true }));
        el.dispatchEvent(new Event("change", { bubbles: true }));
        return { ok: true, value: el.value };
      }
      case "query": {
        if (msg.ref) {
          const el = fromRef(msg.ref);
          return { found: !!el, ref: msg.ref };
        }
        if (msg.selector) {
          const el = document.querySelector(msg.selector);
          return el ? { found: true, ref: refFor(el), name: nameOf(el) } : { found: false };
        }
        if (msg.text) {
          const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_ELEMENT);
          let n;
          while ((n = walker.nextNode())) {
            if (visible(n) && (n.innerText || "").includes(msg.text)) {
              return { found: true, ref: refFor(n), name: nameOf(n) };
            }
          }
          return { found: false };
        }
        return { found: false };
      }
      case "evaluate":
        throw new Error("use CDP evaluate");
      default:
        throw new Error(`unknown content command: ${msg.type}`);
    }
  }
})();
