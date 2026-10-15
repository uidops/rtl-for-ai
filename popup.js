/**
 * RTL for AI — popup script
 * Reads/writes the shared options; the content script reacts via storage.onChanged.
 * Also identifies the active tab so the footer can name the app it is acting on.
 */
(() => {
  "use strict";

  const DEFAULTS = { enabled: true, repairMarkdown: true };
  const enabledInput = document.getElementById("enabled");
  const repairInput = document.getElementById("repairMarkdown");
  const status = document.getElementById("status");

  const storage = globalThis.browser?.storage ?? globalThis.chrome?.storage;
  const tabs = globalThis.browser?.tabs ?? globalThis.chrome?.tabs;

  // Host → label comes from sites.js (single source of truth, shared with the
  // content script), so adding an app there updates the popup automatically.
  function labelForHost(hostname) {
    const adapter = globalThis.RTLSites?.match?.(hostname);
    if (adapter?.label && adapter.id !== "generic") return adapter.label;
    const host = String(hostname || "").toLowerCase().replace(/^www\./, "");
    if (!host) return null;
    if (host === "duck.ai" || host.endsWith(".duckduckgo.com")) return "Duck.ai";
    return null;
  }

  let activeLabel = null;

  function renderStatus() {
    if (!enabledInput.checked) {
      status.textContent = "paused";
      return;
    }
    status.textContent = activeLabel ? `on ${activeLabel}` : "no supported tab";
  }

  function render(values) {
    enabledInput.checked = values.enabled !== false;
    repairInput.disabled = enabledInput.checked === false;
    repairInput.checked = values.repairMarkdown !== false && !repairInput.disabled;
    renderStatus();
  }

  function detectActiveTab() {
    if (!tabs?.query) return;
    try {
      const result = tabs.query({ active: true, currentWindow: true });
      const handle = (list) => {
        const url = list && list[0] && list[0].url;
        if (!url) return;
        try {
          activeLabel = labelForHost(new URL(url).hostname);
        } catch {
          activeLabel = null;
        }
        renderStatus();
      };
      if (result && typeof result.then === "function") result.then(handle).catch(() => {});
      else if (Array.isArray(result)) handle(result);
    } catch {
      /* ignore */
    }
  }

  function save() {
    if (!storage?.local) return;
    const values = {
      enabled: enabledInput.checked,
      repairMarkdown: repairInput.checked,
    };
    try {
      const done = storage.local.set(values);
      if (done && typeof done.then === "function") done.catch(() => {});
    } catch {
      /* ignore */
    }
    render(values);
  }

  function init() {
    detectActiveTab();
    if (!storage?.local) {
      status.textContent = "storage unavailable";
      return;
    }
    try {
      const result = storage.local.get(DEFAULTS);
      if (result && typeof result.then === "function") {
        result.then(render).catch(() => render(DEFAULTS));
      } else {
        render(DEFAULTS);
      }
    } catch {
      render(DEFAULTS);
    }
  }

  enabledInput.addEventListener("change", save);
  repairInput.addEventListener("change", save);
  init();
})();
