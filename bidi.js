/**
 * RTL for AI — pure text logic (no DOM).
 *
 * Contains a focused subset of the Unicode Bidirectional Algorithm (UAX#9):
 * character classification, neutral resolution, and the decision about which
 * runs must be wrapped in an isolating <bdi>. Also tokenises stray Markdown
 * and `(citation src="N")` artifacts.
 *
 * Kept DOM-free so it can be unit-tested under Node (see test.js) and reused
 * by the content script, which only does the DOM plumbing.
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module && module.exports) {
    module.exports = api;
  } else {
    root.RTLFixBidi = api;
  }
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  /* ------------------------------------------------------------------ *
   * Script helpers
   * ------------------------------------------------------------------ */

  // Characters that appear in Persian but not in Standard Arabic.
  const FA_ONLY = new Set([
    0x067e, // پ
    0x0686, // چ
    0x0698, // ژ
    0x06af, // گ
    0x06a9, // ک
    0x06cc, // ی
  ]);

  // Arabic punctuation / tatweel: must stay with the RTL flow, so they also
  // split neighbouring equations apart (x = 1، y = 2).
  const RTL_PUNCT = new Set([0x060c, 0x061b, 0x061f, 0x0640]);

  /* ------------------------------------------------------------------ *
   * Unicode character classification (a small subset of UAX#9)
   *
   * R = strong RTL (Arabic/Hebrew letters, Arabic-Indic digits, Arabic punct.)
   * L = strong LTR (Latin/Greek/Cyrillic letters, ASCII digits, math symbols)
   * N = neutral (spaces, ASCII punctuation, dashes, quotes, other symbols)
   * ------------------------------------------------------------------ */
  const R = 1;
  const L = 2;
  const N = 3;

  const RANGES = [
    [0x0030, 0x0039, L], // 0-9
    [0x0041, 0x005a, L], // A-Z
    [0x0061, 0x007a, L], // a-z
    [0x00c0, 0x024f, L], // Latin-1 & Latin Extended
    [0x0300, 0x036f, L], // combining marks
    [0x0370, 0x03ff, L], // Greek (α β θ λ μ σ …)
    [0x0400, 0x052f, L], // Cyrillic
    [0x0590, 0x05ff, R], // Hebrew
    [0x0600, 0x06ff, R], // Arabic (incl. digits ٠-٩ ۰-۹ and ، ؛ ؟)
    [0x0750, 0x077f, R], // Arabic Supplement
    [0x08a0, 0x08ff, R], // Arabic Extended-A
    [0x1d00, 0x1d7f, L], // Phonetic Extensions
    [0x1e00, 0x1eff, L], // Latin Extended Additional
    [0x1f00, 0x1fff, L], // Greek Extended
    [0x2070, 0x209f, L], // Super/subscripts ⁰¹² … ₀₁₂
    [0x2100, 0x214f, L], // Letterlike symbols (ℎ, ℂ …)
    [0x2190, 0x21ff, L], // Arrows
    [0x2200, 0x22ff, L], // Math operators (− ∑ √ ∫ ∂ …)
    [0x2300, 0x23ff, L], // Miscellaneous technical
    [0x2500, 0x25ff, L], // Box drawing & geometric (brackets/braces)
    [0xfb50, 0xfdff, R], // Arabic Presentation Forms-A
    [0xfe70, 0xfeff, R], // Arabic Presentation Forms-B
    [0x1ee00, 0x1eeff, R], // Arabic Mathematical Letters
  ];

  // ASCII math/technical symbols that behave as strongly LTR.
  const LTR_SYMBOLS = new Set([
    0x25, // %
    0x2a, // *
    0x2b, // +
    0x2d, // -
    0x2f, // /
    0x3c, // <
    0x3e, // >
    0x5e, // ^
    0x5f, // _
    0x7c, // |
    0x7e, // ~
  ]);

  function charClass(cp) {
    if (LTR_SYMBOLS.has(cp)) return L;
    for (let i = 0; i < RANGES.length; i += 1) {
      const range = RANGES[i];
      if (cp >= range[0] && cp <= range[1]) return range[2];
    }
    return N;
  }

  function isArabicLetter(cp) {
    if (RTL_PUNCT.has(cp)) return false;
    if (cp >= 0x0600 && cp <= 0x06ff) {
      return !((cp >= 0x0660 && cp <= 0x0669) || (cp >= 0x06f0 && cp <= 0x06f9));
    }
    return (
      (cp >= 0x0750 && cp <= 0x077f) ||
      (cp >= 0x08a0 && cp <= 0x08ff) ||
      (cp >= 0xfb50 && cp <= 0xfdff) ||
      (cp >= 0xfe70 && cp <= 0xfeff) ||
      (cp >= 0x0590 && cp <= 0x05ff)
    );
  }

  function isLatinLetter(cp) {
    return (
      (cp >= 0x41 && cp <= 0x5a) ||
      (cp >= 0x61 && cp <= 0x7a) ||
      (cp >= 0x00c0 && cp <= 0x024f) ||
      (cp >= 0x0370 && cp <= 0x03ff) ||
      (cp >= 0x1e00 && cp <= 0x1fff)
    );
  }

  /**
   * Build a per-code-unit class array, then resolve neutral runs (UAX#9 N1/N2):
   * a neutral run surrounded by two equal strong directions takes that
   * direction, otherwise it takes the paragraph base direction.
   */
  function classify(text, base) {
    const cls = new Array(text.length);
    for (let i = 0; i < text.length; i += 1) {
      const cp = text.codePointAt(i);
      const c = charClass(cp);
      cls[i] = c;
      if (cp > 0xffff) {
        cls[i + 1] = c;
        i += 1;
      }
    }
    for (let i = 0; i < cls.length; ) {
      if (cls[i] !== N) {
        i += 1;
        continue;
      }
      let j = i;
      while (j < cls.length && cls[j] === N) j += 1;
      const prev = i > 0 ? cls[i - 1] : base;
      const next = j < cls.length ? cls[j] : base;
      const value = prev === next && prev !== N ? prev : base;
      for (let k = i; k < j; k += 1) cls[k] = value;
      i = j;
    }
    return cls;
  }

  /** A run is worth isolating only if it contains a real letter of its script. */
  function hasLetter(text, start, end, target) {
    const test = target === L ? isLatinLetter : isArabicLetter;
    for (let i = start; i < end; i += 1) {
      const cp = text.codePointAt(i);
      if (test(cp)) return true;
      if (cp > 0xffff) i += 1;
    }
    return false;
  }

  /**
   * Split a string into plain-text pieces and isolatable runs of `target`
   * class. Returns [{text}] / [{wrap}] in logical order.
   */
  function splitRuns(text, cls, target) {
    const pieces = [];
    let buf = 0;
    let i = 0;
    while (i < text.length) {
      if (cls[i] !== target) {
        i += 1;
        continue;
      }
      let j = i;
      while (j < text.length && cls[j] === target) j += 1;
      if (hasLetter(text, i, j, target)) {
        if (i > buf) pieces.push({ text: text.slice(buf, i) });
        pieces.push({ wrap: text.slice(i, j) });
        buf = j;
      }
      i = j;
    }
    if (buf < text.length) pieces.push({ text: text.slice(buf) });
    return pieces;
  }

  /** Convenience: the isolation plan for a paragraph with a given base. */
  function plan(text, base) {
    return splitRuns(text, classify(text, base), base === R ? L : R);
  }

  /* ------------------------------------------------------------------ *
   * Script counting — decides the base direction of a block
   * ------------------------------------------------------------------ */
  function analyse(text) {
    let arabic = 0;
    let latin = 0;
    let firstStrong = 0;
    let persian = false;
    for (const ch of text) {
      const cp = ch.codePointAt(0);
      if (isArabicLetter(cp)) {
        arabic += 1;
        if (!firstStrong) firstStrong = R;
        if (FA_ONLY.has(cp)) persian = true;
      } else if (isLatinLetter(cp)) {
        latin += 1;
        if (!firstStrong) firstStrong = L;
      }
    }
    return { arabic, latin, firstStrong, persian };
  }

  /** Base direction for a block: UAX#9 first-strong, with a dominant-script tie-break. */
  function baseDirection(text) {
    const { arabic, latin, firstStrong } = analyse(text);
    if (arabic === 0) return 0; // nothing to fix
    if (firstStrong === R) return R;
    return arabic >= latin ? R : L;
  }

  /* ------------------------------------------------------------------ *
   * Markdown / citation tokenisation
   * ------------------------------------------------------------------ */

  // Ordered pattern: bold, then code, then links, then italic (which needs a
  // guard character so that `a * b` multiplication is left alone). Bold allows
  // a single `*` inside it, so `**a * b**` (a bolded multiplication) works.
  const MARKDOWN_RE =
    /(\*\*(?:[^*\n]|\*(?!\*))+?\*\*)|(`[^`\n]+`)|(\[[^\]\n]+\]\([^)\s]+\))|((?:^|[^*\w])\*[^*\s][^*\n]*?[^*\s]\*(?!\w))|((?:^|[^*\w])\*[^*\s]\*(?!\w))/g;

  // Non-global copy, safe for .test() (a /g regex is stateful and skips hits).
  const CITATION_TEST = /\(\s*citation\s+src\s*=\s*"(\d+)"\s*\)/i;
  const CITATION_CLEAN_RE = /\(\s*citation\s+src\s*=\s*"(\d+)"\s*\)/gi;

  function looksLikeMarkup(text) {
    return CITATION_TEST.test(text) || /\*\*|`[^`]+`|\[[^\]]+\]\([^)]+\)|\*/.test(text);
  }

  function pushCitations(out, text) {
    let last = 0;
    let m;
    CITATION_CLEAN_RE.lastIndex = 0;
    while ((m = CITATION_CLEAN_RE.exec(text)) !== null) {
      if (m.index > last) out.push({ type: "text", value: text.slice(last, m.index) });
      out.push({ type: "cite", value: m[1] });
      last = m.index + m[0].length;
    }
    if (last === 0) {
      out.push({ type: "text", value: text });
      return;
    }
    if (last < text.length) out.push({ type: "text", value: text.slice(last) });
  }

  /**
   * Turn a string that leaked raw Markdown / citation artifacts into a list of
   * inline tokens: {type: 'text'|'strong'|'em'|'code'|'a'|'cite', value, href}.
   */
  function tokenizeInline(text) {
    const out = [];
    let last = 0;
    let m;
    MARKDOWN_RE.lastIndex = 0;
    while ((m = MARKDOWN_RE.exec(text)) !== null) {
      const full = m[0];
      const start = m.index;

      // The italic alternatives include a leading guard character.
      let body = full;
      let bodyStart = start;
      if (!m[1] && !m[2] && !m[3]) {
        body = full.replace(/^[^*\w]/, "");
        bodyStart = start + (full.length - body.length);
      }
      if (!body) continue;

      const head = text.slice(last, bodyStart);
      if (head) pushCitations(out, head);

      if (m[3]) {
        const link = m[3].match(/^\[([^\]]+)\]\(([^)\s]+)\)$/);
        out.push({
          type: "a",
          value: link ? link[1] : m[3],
          href: link ? link[2] : null,
        });
      } else {
        const type = m[1] ? "strong" : m[2] ? "code" : "em";
        const fence = m[1] ? 2 : 1;
        out.push({ type, value: body.slice(fence, body.length - fence) });
      }
      last = start + full.length;
    }
    const rest = text.slice(last);
    if (rest) pushCitations(out, rest);
    return out;
  }

  return {
    R,
    L,
    N,
    FA_ONLY,
    charClass,
    plan,
    analyse,
    baseDirection,
    looksLikeMarkup,
    tokenizeInline,
    CITATION_TEST,
  };
});
