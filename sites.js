/**
 * RTL for AI — site adapters
 *
 * The bidi/markdown logic in bidi.js is site-agnostic. What *does* differ per
 * AI app is the DOM: where assistant prose lives, and which subtrees must be
 * left alone (composer boxes, sidebars, rendered code). That per-site knowledge
 * is isolated here so adding an app means adding one entry — no core changes.
 *
 * Each adapter is matched by hostname. Fields:
 *
 *   label          Human-readable name for the popup.
 *   messageRoots   Selectors scoping where assistant/user prose lives. Used as
 *                  a scan hint only; the generic block walk still runs everywhere.
 *   skip           Extra selectors never to touch on this site, on top of the
 *                  global ones (code, math, inputs) in content.js.
 *
 * Everything here is additive and optional: an unknown host falls back to a
 * fully generic scan, so the extension still works if a UI is redesigned.
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module && module.exports) {
    module.exports = api;
  } else {
    root.RTLSites = api;
  }
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  const ADAPTERS = [
    {
      id: "duck.ai",
      label: "Duck.ai",
      hosts: ["duck.ai", "duckduckgo.com"],
      // 2026 UI: the user message is a [data-testid='user-message'] div;
      // assistant prose has no stable hook left (class names are scrambled,
      // the old data-test-conversation-row attribute is gone), so first paint
      // there relies on the generic whole-body scan.
      messageRoots: ["[data-testid='user-message']", "[data-testid='feedback-prompt']"],
      // Duck.ai's composer/input chrome and its sidebar/toolbar.
      skip: [
        "[data-testid*='composer']",
        "[data-testid*='chat-input']",
        "[data-testid='duckai-sidebar']",
        "[data-testid='duckai-top-toolbar']",
        "aside nav",
      ],
    },
    {
      id: "chatgpt",
      label: "ChatGPT",
      hosts: ["chatgpt.com", "chat.openai.com"],
      messageRoots: [
        "[data-message-author-role]",
        "article",
      ],
      // The ProseMirror composer is contenteditable and must stay untouched, as
      // must the code-block copy buttons and the nav/sidebar.
      skip: [
        "#prompt-textarea",
        "[contenteditable='true'][id='prompt-textarea']",
        "nav",
        "aside",
        "[data-testid='composer-textarea']",
        "[class*='composer']",
      ],
    },
    {
      id: "gemini",
      label: "Gemini",
      hosts: ["gemini.google.com"],
      messageRoots: [
        "model-response",
        "user-query",
        ".conversation-container",
        "[class*='query-text']",
        "[class*='response-text']",
      ],
      skip: [
        "input",
        "textarea",
        "nav",
        "aside",
        "[class*='input-container']",
        "[class*='text-input']",
        "[role='navigation']",
      ],
    },
  ];

  function normalizeHost(hostname) {
    return String(hostname || "")
      .trim()
      .toLowerCase()
      .replace(/^www\./, "");
  }

  /** Find the adapter for a hostname, or null when the host is unknown. */
  function match(hostname) {
    const host = normalizeHost(hostname);
    if (!host) return null;
    for (const adapter of ADAPTERS) {
      if (adapter.hosts.includes(host)) return adapter;
    }
    // Sub-domains such as chatgpt.com's regional hosts.
    for (const adapter of ADAPTERS) {
      for (const known of adapter.hosts) {
        if (host.endsWith(`.${known}`)) return adapter;
      }
    }
    return null;
  }

  /** Adapter for the current tab, read from `location`. Defaults to generic. */
  function current(loc) {
    const where = loc ?? (typeof location !== "undefined" ? location : null);
    return match(where?.hostname) ?? { id: "generic", label: "this site", messageRoots: [], skip: [] };
  }

  return { ADAPTERS, match, current, normalizeHost };
});
