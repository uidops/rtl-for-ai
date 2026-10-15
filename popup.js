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
    repairInput.checked = values.repairMarkdown !== false;
    repairInput.disabled = !enabledInput.checked;
    renderStatus();
  }

  // Host → label comes from sites.js (single source of truth, shared with the
  // content script), so adding an app there updates the popup automatically.
  function detectActiveTab() {
    tabs
      ?.query({ active: true, currentWindow: true })
      .then(([tab]) => {
        activeLabel = globalThis.RTLSites?.match(new URL(tab.url).hostname)?.label ?? null;
        renderStatus();
      })
      .catch(() => {});
  }

  function save() {
    const values = { enabled: enabledInput.checked, repairMarkdown: repairInput.checked };
    storage.local.set(values).catch(() => {});
    render(values);
  }

  detectActiveTab();
  if (storage?.local) {
    storage.local.get(DEFAULTS).then(render, () => render(DEFAULTS));
    enabledInput.addEventListener("change", save);
    repairInput.addEventListener("change", save);
  } else {
    status.textContent = "storage unavailable";
  }
})();
