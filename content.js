/**
 * RTL for AI — content script (DOM glue)
 *
 * All text analysis lives in bidi.js; per-site DOM knowledge lives in sites.js.
 * This file only touches the DOM:
 *
 *   1. Detects blocks whose dominant script is Arabic/Persian and gives them
 *      the correct base direction (`dir`) plus a `lang` hint.
 *   2. Wraps every strongly-LTR fragment (Latin words, Greek/math symbols,
 *      equations, numbers joined by operators) in an isolating <bdi dir="ltr">
 *      so it stays readable inside RTL flow — and the reverse for LTR blocks.
 *   3. Optionally repairs stray Markdown emphasis/code/links and
 *      `(citation src="N")` artifacts that leaked into the answer.
 *
 * Runs on the live DOM (these apps stream and re-render messages) and is
 * idempotent. Nodes are only ever built with createElement/textContent —
 * never innerHTML — so rendered content can never inject markup.
 */
(() => {
  "use strict";

  const BIDI = globalThis.RTLFixBidi;
  if (!BIDI) return;

  const SITES = globalThis.RTLSites;
  const SITE = SITES?.current() ?? { id: "generic", label: "this site", messageRoots: [], skip: [] };

  const { R, L } = BIDI;
  const BDI_ATTR = "data-rtlfix-bdi"; // marks our isolating wrappers
  const BLOCK_ATTR = "data-rtlfix"; // marks paragraphs we repaired
  const CITE_CLASS = "rtlfix-cite";

  /* ------------------------------------------------------------------ *
   * Settings (kept in sync with the popup through browser.storage)
   * ------------------------------------------------------------------ */
  const settings = { enabled: true, repairMarkdown: true };

  /* ------------------------------------------------------------------ *
   * Selectors
   * ------------------------------------------------------------------ */

  // Text containers we may fix.
  const BLOCK_SELECTOR =
    "p,li,td,th,caption,h1,h2,h3,h4,h5,h6,blockquote,figcaption,dd,dt,summary";

  // Never touch these: code/math are LTR by nature, form fields are user input.
  // Site-specific entries from the active adapter are appended at runtime.

  // Rendered math containers. KaTeX/MathJax lay these out internally LTR but
  // ship no `direction` rule of their own (duck.ai's KaTeX build at least),
  // so content.css re-asserts LTR + isolation inside our RTL blocks, and
  // fixStandaloneMath() uses the list to spot standalone display equations.
  const MATH_SELECTORS = [
    ".katex",
    ".katex-mathml",
    ".MathJax",
    ".MathJax_Display",
    ".MathJax_Preview",
    "mjx-container",
    ".math",
    ".math-inline",
    ".math-block",
  ];

  const BASE_SKIP = [
    "bdi",
    "pre",
    "code",
    "kbd",
    "samp",
    "textarea",
    "input",
    "select",
    "button",
    "[contenteditable='true']",
    "[data-rtlfix-skip]",
    ".monaco-editor",
    ".cm-editor",
    `.${CITE_CLASS}`,
    `[${BDI_ATTR}]`,
  ].concat(MATH_SELECTORS);

  // Global skips + whatever the current site's adapter adds.
  const SKIP_SELECTOR = BASE_SKIP.concat(SITE.skip || []).join(",");

  /* ------------------------------------------------------------------ *
   * Building DOM from bidi / markdown plans
   * ------------------------------------------------------------------ */

  function appendPieces(frag, pieces, base) {
    for (const piece of pieces) {
      if (!piece.wrap) {
        frag.appendChild(document.createTextNode(piece.text));
        continue;
      }
      const bdi = document.createElement("bdi");
      bdi.setAttribute("dir", base === R ? "ltr" : "rtl");
      bdi.setAttribute(BDI_ATTR, "");
      const first = piece.wrap.codePointAt(0);
      if (base === L && BIDI.FA_ONLY.has(first)) bdi.lang = "fa";
      bdi.textContent = piece.wrap;
      frag.appendChild(bdi);
    }
  }

  function appendTokens(frag, tokens) {
    for (const token of tokens) {
      switch (token.type) {
        case "strong":
        case "em":
        case "code": {
          const node = document.createElement(token.type);
          node.textContent = token.value;
          frag.appendChild(node);
          break;
        }
        case "a": {
          const anchor = document.createElement("a");
          anchor.textContent = token.value;
          if (token.href) {
            anchor.href = token.href;
            anchor.rel = "noreferrer noopener";
            anchor.target = "_blank";
          }
          frag.appendChild(anchor);
          break;
        }
        case "cite": {
          const badge = document.createElement("sup");
          badge.className = CITE_CLASS;
          badge.setAttribute("dir", "ltr");
          badge.textContent = `[${token.value}]`;
          badge.title = `منبع ${token.value}`;
          frag.appendChild(badge);
          break;
        }
        default:
          frag.appendChild(document.createTextNode(token.value));
      }
    }
  }

  /* ------------------------------------------------------------------ *
   * Repair pass
   * ------------------------------------------------------------------ */

  function collectTextNodes(block, extraReject) {
    const walker = document.createTreeWalker(block, NodeFilter.SHOW_TEXT, {
      acceptNode(node) {
        const value = node.nodeValue;
        const parent = node.parentElement;
        if (!value || !value.trim()) return NodeFilter.FILTER_REJECT;
        if (!parent || parent.closest(SKIP_SELECTOR)) return NodeFilter.FILTER_REJECT;
        if (extraReject && extraReject(parent, value)) return NodeFilter.FILTER_REJECT;
        return NodeFilter.FILTER_ACCEPT;
      },
    });
    const nodes = [];
    while (walker.nextNode()) nodes.push(walker.currentNode);
    return nodes;
  }

  /** Replace raw Markdown / citation artifacts with real elements. */
  function repairMarkdown(block) {
    const nodes = collectTextNodes(block, (parent, value) =>
      parent.closest("a,strong,em,b,i") ? true : !BIDI.looksLikeMarkup(value)
    );

    let anyRepaired = false;
    for (const node of nodes) {
      const tokens = BIDI.tokenizeInline(node.nodeValue);
      if (!tokens.some((token) => token.type !== "text")) continue; // nothing leaked
      const frag = document.createDocumentFragment();
      appendTokens(frag, tokens);
      node.parentNode.replaceChild(frag, node);
      anyRepaired = true;
    }
    return anyRepaired;
  }

  /* ------------------------------------------------------------------ *
   * Bidi isolation pass
   * ------------------------------------------------------------------ */

  function isolateTextNodes(block, base) {
    const target = base === R ? L : R;
    const nodes = collectTextNodes(block, (parent, value) => {
      // Cheap bail-out: not a single character of the target class.
      for (const ch of value) {
        if (BIDI.charClass(ch.codePointAt(0)) === target) return false;
      }
      return true;
    });

    for (const node of nodes) {
      const pieces = BIDI.plan(node.nodeValue, base);
      if (!pieces.some((piece) => piece.wrap)) continue;
      const frag = document.createDocumentFragment();
      appendPieces(frag, pieces, base);
      node.parentNode.replaceChild(frag, node);
    }
  }

  /* ------------------------------------------------------------------ *
   * Standalone display math
   *
   * Some apps (duck.ai) render a display equation as an ordinary <p>
   * wrapping an *inline* .katex span. Such a paragraph has no Arabic
   * characters, so baseDirection() finds nothing to fix and the formula
   * stays LTR/left-aligned — jutting out of the RTL message flow. When a
   * math-only block sits inside (or right after) RTL prose, it inherits the
   * message's RTL flow and gets centered like a textbook display formula.
   * ------------------------------------------------------------------ */

  const MATH_SELECTOR = MATH_SELECTORS.join(",");

  /** True when earlier content near the block (or an explicit ancestor dir) is RTL. */
  function rtlFlow(block) {
    for (let el = block.parentElement; el && el !== document.body; el = el.parentElement) {
      const d = el.getAttribute && el.getAttribute("dir");
      if (d) return d === "rtl"; // explicit direction on an ancestor decides
    }
    const rtlNearby = (sib) =>
      !!(
        sib &&
        sib.nodeType === Node.ELEMENT_NODE &&
        ((sib.getAttribute && sib.getAttribute("dir")) === "rtl" ||
          (typeof sib.querySelector === "function" && sib.querySelector("[dir='rtl']")))
      );
    // Scan order is document order, so prose *before* the equation is already
    // fixed by the time we get here. Climb a few wrapper levels — apps often
    // wrap each paragraph in its own <div>.
    let scope = block;
    for (let depth = 0; depth < 4 && scope && scope !== document.body; depth += 1) {
      for (let sib = scope.previousElementSibling; sib; sib = sib.previousElementSibling) {
        if (rtlNearby(sib)) return true;
      }
      scope = scope.parentElement;
    }
    return false;
  }

  function fixStandaloneMath(block) {
    if (typeof block.querySelector !== "function") return;
    if (!block.querySelector(MATH_SELECTOR)) return;

    // Prose voice of the block: text minus rendered math/code (collectTextNodes
    // already skips those subtrees). If prose still carries a strong direction,
    // fixBlock's normal path owns the block instead.
    const prose = collectTextNodes(block).map((n) => n.nodeValue).join("");
    if (BIDI.baseDirection(prose)) return;
    if (!rtlFlow(block)) return; // nothing RTL to align with — leave it alone

    block.setAttribute("dir", "rtl");
    block.classList.add("rtlfix-block", "rtlfix-math");
    fixed.set(block, `rtl:${block.textContent.length}`);
  }

  /* ------------------------------------------------------------------ *
   * Block-level fix
   * ------------------------------------------------------------------ */

  // Blocks already fixed, keyed by element, valued by "dir:textLength".
  const fixed = new WeakMap();

  function fixBlock(block) {
    if (!block || block.nodeType !== Node.ELEMENT_NODE) return;
    if (block.closest(SKIP_SELECTOR)) return;

    const text = block.textContent || "";
    if (text.length < 2) return;

    const dir = block.getAttribute("dir") || "";
    if (fixed.get(block) === `${dir}:${text.length}`) return;

    const base = BIDI.baseDirection(text);
    if (!base) {
      // No strong prose direction — usually an all-Latin paragraph. One
      // exception: a standalone display equation inside an RTL message.
      fixStandaloneMath(block);
      return;
    }

    // Streaming can turn a standalone equation into ordinary prose; make sure
    // the centering class doesn't stick to it.
    if (block.classList.contains("rtlfix-math")) block.classList.remove("rtlfix-math");

    if (settings.repairMarkdown && BIDI.looksLikeMarkup(text)) {
      if (repairMarkdown(block)) block.setAttribute(BLOCK_ATTR, "repaired");
    }

    if (base === R) {
      block.setAttribute("dir", "rtl");
      block.lang = BIDI.analyse(text).persian ? "fa" : "ar";
    } else {
      block.setAttribute("dir", "ltr");
    }
    block.classList.add("rtlfix-block");

    isolateTextNodes(block, base);
    fixed.set(block, `${block.getAttribute("dir")}:${block.textContent.length}`);
  }

  /* ------------------------------------------------------------------ *
   * Scanning
   * ------------------------------------------------------------------ */

  function scan(root) {
    if (!settings.enabled || !root) return;

    let scope = root;
    if (scope.nodeType === Node.TEXT_NODE) scope = scope.parentElement;
    if (!scope) return;
    if (scope.nodeType === Node.ELEMENT_NODE && scope.closest(SKIP_SELECTOR)) return;

    if (scope.nodeType === Node.ELEMENT_NODE && scope.matches(BLOCK_SELECTOR)) {
      fixBlock(scope);
    }
    if (typeof scope.querySelectorAll !== "function") return;
    for (const block of scope.querySelectorAll(BLOCK_SELECTOR)) fixBlock(block);
  }

  let scheduled = false;
  const dirtyRoots = new Set();

  function scheduleScan(root) {
    dirtyRoots.add(root || document.body);
    if (scheduled) return;
    scheduled = true;
    requestAnimationFrame(() => {
      scheduled = false;
      const roots = Array.from(dirtyRoots);
      dirtyRoots.clear();
      for (const r of roots) scan(r);
    });
  }

  /* ------------------------------------------------------------------ *
   * Wiring
   * ------------------------------------------------------------------ */

  function observe() {
    const observer = new MutationObserver((mutations) => {
      for (const mutation of mutations) {
        if (mutation.type === "characterData") {
          scheduleScan(mutation.target.parentElement);
          continue;
        }
        for (const node of mutation.addedNodes) {
          if (node.nodeType === Node.ELEMENT_NODE || node.nodeType === Node.TEXT_NODE) {
            scheduleScan(node);
          }
        }
        for (const node of mutation.removedNodes) {
          if (node.nodeType === Node.ELEMENT_NODE) scheduleScan(node.parentElement);
        }
      }
    });
    observer.observe(document.documentElement, {
      subtree: true,
      childList: true,
      characterData: true,
    });
  }

  function storageLocal() {
    const storage = globalThis.browser?.storage ?? globalThis.chrome?.storage;
    return storage?.local ?? null;
  }

  function applySettings(values) {
    const wasEnabled = settings.enabled;
    settings.enabled = values.enabled !== false;
    settings.repairMarkdown = values.repairMarkdown !== false;
    if (settings.enabled && !wasEnabled) scheduleScan(document.body);
  }

  function loadSettings() {
    const local = storageLocal();
    if (!local) return Promise.resolve();
    try {
      const result = local.get({ enabled: true, repairMarkdown: true });
      if (result && typeof result.then === "function") {
        return result.then(applySettings).catch(() => {});
      }
    } catch {
      /* storage unavailable — keep defaults */
    }
    return Promise.resolve();
  }

  function watchSettings() {
    const onChanged = (globalThis.browser?.storage ?? globalThis.chrome?.storage)?.onChanged;
    if (!onChanged) return;
    onChanged.addListener((changes, area) => {
      if (area !== "local") return;
      applySettings({
        enabled: changes.enabled?.newValue ?? settings.enabled,
        repairMarkdown: changes.repairMarkdown?.newValue ?? settings.repairMarkdown,
      });
    });
  }

  function init() {
    watchSettings();
    observe();

    // The very first scan must wait for the stored toggles, otherwise it would
    // briefly render with the defaults and contradict the user's choices (e.g.
    // repairing Markdown when they turned that off). Fall back to a timed start
    // so a hung storage call can never leave the page unprocessed.
    let started = false;
    const start = () => {
      if (started) return;
      started = true;
      scheduleScan(document.body);
      // Adapter-declared message roots get an immediate pass so first paint is
      // already correct; the observer still covers anything they don't match.
      for (const selector of SITE.messageRoots || []) {
        for (const root of document.querySelectorAll(selector)) scheduleScan(root);
      }
    };
    Promise.resolve()
      .then(loadSettings)
      .then(start)
      .catch(start);
    setTimeout(start, 400);

    window.addEventListener("popstate", () => scheduleScan(document.body));
    document.addEventListener("visibilitychange", () => {
      if (!document.hidden) scheduleScan(document.body);
    });
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init, { once: true });
  } else {
    init();
  }
})();
