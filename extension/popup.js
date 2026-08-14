const $ = (id) => document.getElementById(id);

function render(cfg) {
  const ok = !!cfg.connected;
  $("dot").classList.toggle("ok", ok);
  $("status").textContent = ok ? "Connected to relay" : "Disconnected";
  $("relay").value = cfg.relayUrl || "ws://127.0.0.1:18765/extension";
  $("http").textContent = cfg.httpPort ? `http://0.0.0.0:${cfg.httpPort}` : "waiting…";
  $("token").textContent = cfg.token || "waiting…";
  $("err").textContent = cfg.lastError && !ok ? cfg.lastError : "";
}

chrome.storage.local.get(null, render);
chrome.storage.onChanged.addListener(() => chrome.storage.local.get(null, render));

$("save").onclick = () => {
  chrome.storage.local.set({ relayUrl: $("relay").value.trim() });
};

$("copy").onclick = async () => {
  const { token } = await chrome.storage.local.get("token");
  if (token) await navigator.clipboard.writeText(token);
};
