/**
 * RTL for AI — site adapters
 *
 * The bidi/markdown logic in bidi.js is site-agnostic. What *does* differ per
 * AI app is the DOM: which subtrees must be left alone (composer boxes,
 * sidebars, toolbars). That per-site knowledge is isolated here so adding an
 * app means adding one entry — no core changes.
 *
 * Each adapter is matched by hostname. Fields:
 *
 *   label        Human-readable name for the popup.
 *   skip         Extra selectors never to touch on this site, on top of the
 *                global ones (code, math, inputs, contenteditable) in content.js.
 *   containers   Optional. Message wrappers whose `dir` the site's layout keys
 *                off (column alignment, list indents); they follow the
 *                direction of their content, like lists do everywhere.
 *
 * An unknown host falls back to a fully generic scan, so the extension still
 * works if a UI is redesigned.
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
      // Composer/input chrome, sidebar and top toolbar.
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
      // The ProseMirror composer and the nav/sidebar.
      skip: [
        "#prompt-textarea",
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
      // Gemini sets dir on the answer wrapper itself and styles everything
      // inside with logical properties; when it guesses LTR for a Persian
      // answer, paragraphs and lists end up misaligned and over-indented.
      containers: [".markdown-main-panel"],
      skip: [
        "nav",
        "aside",
        "[class*='input-container']",
        "[class*='text-input']",
        "[role='navigation']",
      ],
    },
  ];

  const GENERIC = { id: "generic", label: "this site", skip: [] };

  /** Find the adapter for a hostname, or null when the host is unknown. */
  function match(hostname) {
    const host = String(hostname || "")
      .trim()
      .toLowerCase()
      .replace(/^www\./, "");
    if (!host) return null;
    // Exact host, or a sub-domain such as chatgpt.com's regional hosts.
    return (
      ADAPTERS.find((adapter) => adapter.hosts.includes(host)) ??
      ADAPTERS.find((adapter) => adapter.hosts.some((known) => host.endsWith(`.${known}`))) ??
      null
    );
  }

  /** Adapter for the current tab, read from `location`. Defaults to generic. */
  function current(loc) {
    const where = loc ?? (typeof location !== "undefined" ? location : null);
    return match(where?.hostname) ?? GENERIC;
  }

  return { match, current };
});
