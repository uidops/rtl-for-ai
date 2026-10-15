#!/usr/bin/env node
/**
 * End-to-end check — runs the real sites.js + bidi.js + content.js pipeline
 * against a small DOM, for each supported AI app, and asserts:
 *
 *   • Persian assistant prose gets dir="rtl" lang="fa"
 *   • Latin fragments / equations get isolated in <bdi dir="ltr">
 *   • stray Markdown and citation artifacts are repaired
 *   • the site adapter's skip list is honoured (composer/nav untouched)
 *   • the skip really comes from the adapter (same DOM, unknown host → processed)
 *
 * Run with:  node e2e.js
 */
"use strict";

const fs = require("fs");
const vm = require("vm");

/* ------------------------------------------------------------------ *
 * Minimal DOM
 * ------------------------------------------------------------------ */
function makeDom() {
  class N {
    constructor() {
      this.parentNode = null;
    }
    get parentElement() {
      const p = this.parentNode;
      return p && p.nodeType === 1 ? p : null;
    }
  }

  class TextNode extends N {
    constructor(value) {
      super();
      this.nodeType = 3;
      this.nodeValue = value;
    }
    get textContent() {
      return this.nodeValue;
    }
    set textContent(v) {
      this.nodeValue = String(v);
    }
  }

  class Element extends N {
    constructor(tag) {
      super();
      this.nodeType = 1;
      this.tagName = String(tag).toUpperCase();
      this.attrs = Object.create(null);
      this.childNodes = [];
      this.classes = new Set();
      this._lang = "";
      this.style = {};
      this.sitePadding = ["0px", "0px"]; // [left, right] the site's CSS would compute
    }
    get className() {
      return Array.from(this.classes).join(" ");
    }
    set className(v) {
      this.classes = new Set(String(v).split(/\s+/).filter(Boolean));
      // Keep the class attribute in sync (real DOM treats them as one thing),
      // so `[class*='x']` selectors resolve correctly.
      this.attrs.class = String(v);
    }
    get lang() {
      return this._lang;
    }
    set lang(v) {
      this._lang = String(v || "");
      if (this._lang) this.attrs.lang = this._lang;
    }
    get classList() {
      const c = this.classes;
      return {
        add: (...n) => n.forEach((x) => c.add(x)),
        remove: (...n) => n.forEach((x) => c.delete(x)),
        contains: (n) => c.has(n),
      };
    }
    setAttribute(k, v) {
      this.attrs[k] = String(v);
      if (k === "class") this.className = v;
      if (k === "lang") this._lang = String(v);
    }
    getAttribute(k) {
      return Object.prototype.hasOwnProperty.call(this.attrs, k) ? this.attrs[k] : null;
    }
    hasAttribute(k) {
      return Object.prototype.hasOwnProperty.call(this.attrs, k);
    }
    appendChild(node) {
      if (node.nodeType === 11) {
        for (const c of Array.from(node.childNodes)) this.appendChild(c);
        node.childNodes.length = 0;
        return node;
      }
      if (node.parentNode) {
        const i = node.parentNode.childNodes.indexOf(node);
        if (i >= 0) node.parentNode.childNodes.splice(i, 1);
      }
      node.parentNode = this;
      this.childNodes.push(node);
      return node;
    }
    replaceChild(neu, old) {
      const i = this.childNodes.indexOf(old);
      if (i < 0) throw new Error("replaceChild: node is not a child");
      if (neu.nodeType === 11) {
        this.childNodes.splice(i, 1, ...neu.childNodes);
        for (const c of neu.childNodes) c.parentNode = this;
        neu.childNodes.length = 0;
      } else {
        this.childNodes[i] = neu;
        neu.parentNode = this;
      }
      old.parentNode = null;
      return old;
    }
    get textContent() {
      return this.childNodes.map((c) => c.textContent).join("");
    }
    set textContent(v) {
      this.childNodes = [];
      if (v) this.appendChild(new TextNode(String(v)));
    }
    matches(sel) {
      return String(sel)
        .split(",")
        .some((part) => matchesComplex(this, part.trim()));
    }
    closest(sel) {
      let el = this;
      while (el && el.nodeType === 1) {
        if (el.matches(sel)) return el;
        el = el.parentNode && el.parentNode.nodeType === 1 ? el.parentNode : null;
      }
      return null;
    }
    querySelectorAll(sel) {
      const out = [];
      const walk = (el) => {
        for (const child of el.childNodes) {
          if (child.nodeType !== 1) continue;
          if (child.matches(sel)) out.push(child);
          walk(child);
        }
      };
      walk(this);
      return out;
    }
    querySelector(sel) {
      return this.querySelectorAll(sel)[0] || null;
    }
    get previousElementSibling() {
      const sibs = (this.parentNode && this.parentNode.childNodes) || [];
      const i = sibs.indexOf(this);
      for (let j = i - 1; j >= 0; j -= 1) if (sibs[j].nodeType === 1) return sibs[j];
      return null;
    }
  }

  class Fragment extends N {
    constructor() {
      super();
      this.nodeType = 11;
      this.childNodes = [];
    }
    appendChild(node) {
      if (node.parentNode) {
        const i = node.parentNode.childNodes.indexOf(node);
        if (i >= 0) node.parentNode.childNodes.splice(i, 1);
      }
      node.parentNode = this;
      this.childNodes.push(node);
      return node;
    }
    get textContent() {
      return this.childNodes.map((c) => c.textContent).join("");
    }
  }

  /* ---- selector matching (tag, .class, #id, [attr], [attr*='x'], descendant) ---- */
  function matchAttr(el, body) {
    const m = body.match(/^([\w-]+)\s*(?:([*^$~|]?=)\s*(.*?)\s*)?$/);
    if (!m) return false;
    const [, name, op, raw] = m;
    if (!el.hasAttribute(name)) return false;
    if (!op) return true;
    const want = String(raw).replace(/^["']|["']$/g, "");
    const have = el.getAttribute(name) || "";
    switch (op) {
      case "=":
        return have === want;
      case "*=":
        return have.includes(want);
      case "^=":
        return have.startsWith(want);
      case "$=":
        return have.endsWith(want);
      case "|=":
        return have === want || have.startsWith(`${want}-`);
      case "~=":
        return have.split(/\s+/).includes(want);
      default:
        return false;
    }
  }

  function matchesSimple(el, sel) {
    if (!sel) return false;
    const re = /([a-zA-Z][\w-]*)|\.([\w-]+)|#([\w-]+)|\[([^\]]+)\]/g;
    let m;
    let consumed = 0;
    let any = false;
    while ((m = re.exec(sel)) !== null) {
      if (m.index !== consumed) return false;
      consumed = re.lastIndex;
      any = true;
      if (m[1]) {
        if (el.tagName.toLowerCase() !== m[1].toLowerCase()) return false;
      } else if (m[2]) {
        if (!el.classes.has(m[2])) return false;
      } else if (m[3]) {
        if (el.getAttribute("id") !== m[3]) return false;
      } else if (m[4]) {
        if (!matchAttr(el, m[4])) return false;
      }
    }
    return any && consumed === sel.length;
  }

  function matchesComplex(el, part) {
    if (!part) return false;
    const steps = part.split(/\s+/).filter(Boolean);
    if (!steps.length) return false;
    if (!matchesSimple(el, steps[steps.length - 1])) return false;
    let idx = steps.length - 2;
    let cur = el.parentElement;
    while (idx >= 0 && cur) {
      if (matchesSimple(cur, steps[idx])) idx -= 1;
      cur = cur.parentElement;
    }
    return idx < 0;
  }

  const html = new Element("html");
  const body = new Element("body");
  html.appendChild(body);

  const document = {
    readyState: "complete",
    documentElement: html,
    body,
    createElement: (tag) => new Element(tag),
    createTextNode: (v) => new TextNode(v),
    createDocumentFragment: () => new Fragment(),
    querySelectorAll: (sel) => html.querySelectorAll(sel),
    querySelector: (sel) => html.querySelector(sel),
    createTreeWalker(root, _what, filter) {
      const nodes = [];
      const walk = (node) => {
        for (const child of node.childNodes || []) {
          if (child.nodeType === 3) {
            if (filter.acceptNode(child) === 1) nodes.push(child);
          } else if (child.nodeType === 1) walk(child);
        }
      };
      walk(root);
      let i = -1;
      return {
        get currentNode() {
          return nodes[i];
        },
        nextNode() {
          i += 1;
          return i < nodes.length ? nodes[i] : null;
        },
      };
    },
  };

  return { Element, TextNode, document, body };
}

/* ------------------------------------------------------------------ *
 * Scenario runner
 * ------------------------------------------------------------------ */

/**
 * Build a DOM, then load the content scripts against it under `hostname`.
 * `stored` (optional) is what browser.storage.local.get resolves to.
 * The first scan waits for stored settings, so `await settle()` before asserting.
 */
function runScenario(hostname, build, stored) {
  const dom = makeDom();
  build(dom, dom.body);

  const sandbox = {
    console,
    URL,
    document: dom.document,
    location: { hostname, href: `https://${hostname}/` },
    requestAnimationFrame: (fn) => fn(),
    setTimeout,
    MutationObserver: class {
      observe() {}
    },
    Node: { ELEMENT_NODE: 1, TEXT_NODE: 3 },
    NodeFilter: { SHOW_TEXT: 4, FILTER_ACCEPT: 1, FILTER_REJECT: 2 },
    getComputedStyle: (el) => ({
      paddingLeft: el.style.paddingLeft ?? el.sitePadding[0],
      paddingRight: el.style.paddingRight ?? el.sitePadding[1],
    }),
  };
  if (stored) {
    sandbox.browser = {
      storage: {
        local: { get: () => Promise.resolve(stored) },
        onChanged: { addListener() {} },
      },
    };
  }
  sandbox.globalThis = sandbox;
  sandbox.self = sandbox;
  vm.createContext(sandbox);

  for (const file of ["sites.js", "bidi.js", "content.js"]) {
    vm.runInContext(fs.readFileSync(file, "utf8"), sandbox, { filename: file });
  }
  return dom;
}

const settle = () => new Promise((r) => setTimeout(r, 0));

/* ---- message content shared by every app ------------------------------- */
const PROSE =
  "در کتاب **Mathematics for ML** روش «منفی‌یک» آمد و x_1 = −x_4 معادله است. (citation src=\"2\")";
const PLAIN_FA = "این یک جمله کاملا فارسی است.";
const EQUATION_ONLY = "x_1 = -x_4,  x_2 = 1/2 x_3";

/* ------------------------------------------------------------------ *
 * Assertions
 * ------------------------------------------------------------------ */
const issues = [];
function check(name, ok, detail) {
  console.log(`  ${ok ? "ok  " : "FAIL"} ${name}${!ok && detail ? `  → ${detail}` : ""}`);
  if (!ok) issues.push(name);
}

function hasClass(el, cls) {
  return !!el && el.classes.has(cls);
}

/**
 * @param hostname   host the scenario runs under (drives the site adapter)
 * @param structure  builder for extra DOM (composer/nav/etc.)
 * @param expected   { composer: bool, nav: bool, boxed: bool } — whether each
 *                   extra structure should have been left untouched
 */
async function exerciseApp(hostname, structure, expected) {
  console.log(`\n${hostname}`);
  const dom = runScenario(hostname, (d) => {
    const main = new d.Element("main");
    for (const text of [PROSE, PLAIN_FA, EQUATION_ONLY]) {
      const p = new d.Element("p");
      p.appendChild(new d.TextNode(text));
      main.appendChild(p);
    }
    d.body.appendChild(main);
    if (structure) structure(d, d.body);
  });
  await settle();

  const paras = dom.document.querySelectorAll("main p");
  const [prose, plain, eq] = paras;

  check("3 paragraphs found", paras.length === 3, `got ${paras.length}`);
  check("Persian prose → dir=rtl", prose.getAttribute("dir") === "rtl");
  check("Persian prose → lang=fa", prose.getAttribute("lang") === "fa");
  check("Persian prose → .rtlfix-block", hasClass(prose, "rtlfix-block"));
  check("plain Persian → dir=rtl", plain.getAttribute("dir") === "rtl");
  check("equation-only paragraph left untouched",
    eq.getAttribute("dir") === null && !hasClass(eq, "rtlfix-block"),
    `dir=${eq.getAttribute("dir")}`);

  const ltrBdi = dom.document
    .querySelectorAll("bdi")
    .filter((b) => b.getAttribute("dir") === "ltr");
  check("Latin fragments isolated in <bdi dir=ltr>", ltrBdi.length >= 2, `got ${ltrBdi.length}`);

  const strongs = dom.document.querySelectorAll("strong");
  check("stray **bold** repaired into <strong>",
    strongs.some((s) => s.textContent === "Mathematics for ML"));

  const cites = dom.document.querySelectorAll("sup.rtlfix-cite");
  check("citation artifact → sup.rtlfix-cite [2]",
    cites.length === 1 && cites[0].textContent === "[2]",
    `got ${cites.length}`);

  const bdiInsideStrong = dom.document
    .querySelectorAll("strong bdi")
    .some((b) => b.textContent.includes("Mathematics"));
  check("repaired title also bidi-isolated", bdiInsideStrong);

  // --- adapter-driven skips -------------------------------------------
  if (expected) {
    const composerP = dom.document.querySelector("#prompt-textarea p");
    check(`composer untouched (${expected.composer ? "expect untouched" : "expect processed"})`,
      expected.composer
        ? composerP.getAttribute("dir") === null && !hasClass(composerP, "rtlfix-block")
        : composerP.getAttribute("dir") === "rtl",
      `dir=${composerP.getAttribute("dir")}`);

    const navP = dom.document.querySelector("nav p");
    check(`nav untouched (${expected.nav ? "expect untouched" : "expect processed"})`,
      expected.nav
        ? navP.getAttribute("dir") === null && !hasClass(navP, "rtlfix-block")
        : navP.getAttribute("dir") === "rtl",
      `dir=${navP.getAttribute("dir")}`);

    const boxedP = dom.document.querySelector(".composer p");
    check(`.composer untouched (${expected.boxed ? "expect untouched" : "expect processed"})`,
      expected.boxed
        ? boxedP.getAttribute("dir") === null && !hasClass(boxedP, "rtlfix-block")
        : boxedP.getAttribute("dir") === "rtl");
  }
}

/* ---- structures each adapter must skip -------------------------------- */
function buildExtras(d, body) {
  const composer = new d.Element("div");
  composer.setAttribute("contenteditable", "true");
  composer.setAttribute("id", "prompt-textarea");
  const composerP = new d.Element("p");
  composerP.appendChild(new d.TextNode("پیش‌نویس **bold** فارسی"));
  composer.appendChild(composerP);

  const nav = new d.Element("nav");
  const navP = new d.Element("p");
  navP.appendChild(new d.TextNode("منوی فارسی"));
  nav.appendChild(navP);

  const boxed = new d.Element("div");
  boxed.className = "composer";
  const boxedP = new d.Element("p");
  boxedP.appendChild(new d.TextNode("داخل composer فارسی"));
  boxed.appendChild(boxedP);

  body.appendChild(composer);
  body.appendChild(nav);
  body.appendChild(boxed);
}

/* ------------------------------------------------------------------ *
 * Run each supported app
 * ------------------------------------------------------------------ */

async function main() {
  console.log("end-to-end: core fix per AI app\n");

  // ChatGPT: adapter skips nav + [class*='composer']; contenteditable composer
  // is protected by the global rule.
  await exerciseApp("chatgpt.com", buildExtras, { composer: true, nav: true, boxed: true });

  // Gemini: adapter skips nav (but declares no .composer rule, and declares
  // input/textarea which don't apply to a plain div). The contenteditable
  // composer is still protected by the global rule.
  await exerciseApp("gemini.google.com", buildExtras, { composer: true, nav: true, boxed: false });

  // Duck.ai: adapter skips [data-testid*='composer'] and "aside nav" (a
  // descendant rule), so a plain <nav> and a plain .composer div ARE processed.
  await exerciseApp("duck.ai", buildExtras, { composer: true, nav: false, boxed: false });

  /* ---- display math inside an RTL message (duck.ai-style DOM) ------------ *
   * duck.ai renders a display equation as an ordinary <p> around an inline
   * .katex span, wrapped in its own div. Inside an RTL answer it must follow
   * the RTL flow (dir=rtl + .rtlfix-math); with no RTL context around it must
   * stay untouched. */
  console.log("\ndisplay math in RTL flow (duck.ai-style DOM)");
  {
    let eqEn, eqFa, katexFa, introFa, introEn;
    runScenario("duck.ai", (d) => {
      const buildAnswer = (rtl) => {
        const container = new d.Element("div");
        const intro = new d.Element("p");
        intro.appendChild(new d.TextNode(rtl ? PLAIN_FA : "Consider the following theorem."));
        const wrap = new d.Element("div"); // apps wrap each paragraph in a div
        const eq = new d.Element("p");
        const katex = new d.Element("span");
        katex.className = "katex";
        katex.appendChild(new d.TextNode("dim(ker Φ) + dim(Im Φ) = dim(V)"));
        eq.appendChild(katex);
        eq.appendChild(new d.TextNode(".")); // trailing period after the formula
        wrap.appendChild(eq);
        container.appendChild(intro);
        container.appendChild(wrap);
        return { container, intro, eq, katex };
      };
      // English answer first: by the time its equation is scanned, nothing in
      // the document is RTL yet, so it must stay untouched (no false positive).
      const en = buildAnswer(false);
      const fa = buildAnswer(true);
      d.body.appendChild(en.container);
      d.body.appendChild(fa.container);
      eqEn = en.eq; introEn = en.intro;
      eqFa = fa.eq; introFa = fa.intro; katexFa = fa.katex;
    });
    await settle();

    check("Persian prose before the equation → dir=rtl",
      introFa.getAttribute("dir") === "rtl", `dir=${introFa.getAttribute("dir")}`);
    check("standalone equation in RTL flow → dir=rtl",
      eqFa.getAttribute("dir") === "rtl", `dir=${eqFa.getAttribute("dir")}`);
    check("standalone equation in RTL flow → .rtlfix-math",
      hasClass(eqFa, "rtlfix-math") && hasClass(eqFa, "rtlfix-block"));
    check("equation markup untouched (no <bdi> inside .katex)",
      eqFa.querySelectorAll("bdi").length === 0);
    check("equation in a non-RTL answer stays untouched",
      eqEn.getAttribute("dir") === null && !hasClass(eqEn, "rtlfix-math") && !hasClass(eqEn, "rtlfix-block"),
      `dir=${eqEn.getAttribute("dir")}`);
    check("English prose stays untouched",
      introEn.getAttribute("dir") === null, `dir=${introEn.getAttribute("dir")}`);
    check("KaTeX span preserved (content intact)",
      katexFa.textContent === "dim(ker Φ) + dim(Im Φ) = dim(V)");
  }

  /* ---- KaTeX source text must not vote on direction --------------------- *
   * KaTeX keeps the LaTeX source in a hidden MathML annotation, so a list
   * item that is mostly formulas carries more Latin letters in textContent
   * than Persian prose. Seen on duck.ai: the item flipped to LTR and every
   * Persian clause was isolated in reverse order. */
  console.log("\nformula-heavy Persian prose (KaTeX source text)");
  {
    const katexOf = (d, src) => {
      const k = new d.Element("span");
      k.className = "katex";
      const mathml = new d.Element("span");
      mathml.className = "katex-mathml";
      mathml.appendChild(new d.TextNode(src));
      k.appendChild(mathml);
      return k;
    };
    let item, eqText, katexSrc;
    runScenario("duck.ai", (d) => {
      const intro = new d.Element("p");
      intro.appendChild(new d.TextNode(PLAIN_FA));
      const list = new d.Element("ul");
      item = new d.Element("li");
      item.appendChild(katexOf(d, "\\operatorname{Im}\\Phi"));
      item.appendChild(new d.TextNode("، تصویر "));
      item.appendChild(katexOf(d, "\\Phi"));
      item.appendChild(new d.TextNode(" است: "));
      katexSrc = "\\operatorname{Im}\\Phi=\\{\\Phi(v):v\\in V\\}\\subseteq W.";
      item.appendChild(katexOf(d, katexSrc));
      item.appendChild(new d.TextNode(" رتبه یا rank"));
      list.appendChild(item);
      // A display equation whose only Persian is \text{…} inside the formula.
      eqText = new d.Element("p");
      eqText.appendChild(katexOf(d, "\\underbrace{4}_{\\dim} = \\underbrace{2}_{\\text{تهی‌بودگی}} + \\underbrace{2}_{\\text{رتبه}}."));
      d.body.appendChild(intro);
      d.body.appendChild(list);
      d.body.appendChild(eqText);
    });
    await settle();

    check("formula-heavy Persian list item → dir=rtl",
      item.getAttribute("dir") === "rtl", `dir=${item.getAttribute("dir")}`);
    check("its Persian clauses are not isolated as RTL islands",
      item.querySelectorAll("bdi").every((b) => b.getAttribute("dir") === "ltr"));
    check("KaTeX source left untouched",
      item.querySelectorAll(".katex-mathml").some((m) => m.textContent === katexSrc));
    check("equation with \\text{Persian} inside → standalone math (dir=rtl, .rtlfix-math)",
      eqText.getAttribute("dir") === "rtl" && hasClass(eqText, "rtlfix-math"),
      `dir=${eqText.getAttribute("dir")}`);
  }

  /* ---- containers follow their content's direction ---------------------- *
   * Gemini lays out an answer from its wrapper's dir (centered columns, list
   * indents via padding-inline-start). When it guesses LTR for a Persian
   * answer, flipping only the paragraphs leaves lists over-indented and out
   * of line with the text. The wrapper and the lists must flip too, while an
   * English paragraph inside stays explicitly LTR. */
  console.log("\ncontainer direction (Gemini-style DOM)");
  {
    const para = (d, text) => {
      const p = new d.Element("p");
      p.appendChild(new d.TextNode(text));
      return p;
    };
    const item = (d, text) => {
      const li = new d.Element("li");
      li.appendChild(para(d, text));
      return li;
    };
    let panel, outer, inner, english, enList, physical, chip;
    runScenario("gemini.google.com", (d) => {
      panel = new d.Element("div");
      panel.className = "markdown markdown-main-panel";
      panel.setAttribute("dir", "ltr"); // Gemini's guess
      outer = new d.Element("ol");
      const first = item(d, "هسته یا پوچی (Kernel / Nullity)");
      inner = new d.Element("ul");
      inner.appendChild(item(d, "مفهوم: مجموعه تمام بردارهایی که به صفر نگاشته می‌شوند."));
      first.appendChild(inner);
      outer.appendChild(first);
      english = para(d, "The theorem conserves dimension.");
      panel.appendChild(para(d, PLAIN_FA));
      panel.appendChild(outer);
      panel.appendChild(english);
      // A paragraph holding only a source chip (a button labelled "PNG").
      chip = new d.Element("p");
      const button = new d.Element("button");
      button.appendChild(new d.TextNode("PNG"));
      chip.appendChild(button);
      panel.appendChild(chip);
      d.body.appendChild(panel);
      // An English list outside any RTL context stays untouched.
      enList = new d.Element("ul");
      enList.appendChild(item(d, "Plain English item."));
      d.body.appendChild(enList);
      // duck.ai-style list indented with a physical padding-left.
      physical = new d.Element("ul");
      physical.sitePadding = ["20px", "0px"];
      physical.appendChild(item(d, "این یک مورد فارسی است."));
      d.body.appendChild(physical);
    });
    await settle();

    check("Persian answer wrapper → dir=rtl (overrides the site's ltr)",
      panel.getAttribute("dir") === "rtl", `dir=${panel.getAttribute("dir")}`);
    check("Persian list → dir=rtl", outer.getAttribute("dir") === "rtl", `dir=${outer.getAttribute("dir")}`);
    check("nested Persian list → dir=rtl", inner.getAttribute("dir") === "rtl", `dir=${inner.getAttribute("dir")}`);
    check("English paragraph inside the RTL wrapper → dir=ltr",
      english.getAttribute("dir") === "ltr", `dir=${english.getAttribute("dir")}`);
    check("button-only paragraph (source chip) is not treated as English prose",
      chip.getAttribute("dir") === null, `dir=${chip.getAttribute("dir")}`);
    check("English list outside RTL context untouched",
      enList.getAttribute("dir") === null, `dir=${enList.getAttribute("dir")}`);
    check("English list item untouched",
      enList.querySelector("p").getAttribute("dir") === null);
    check("physical padding-left mirrored to the right on an RTL list",
      physical.style.paddingRight === "20px" && physical.style.paddingLeft === "0px",
      JSON.stringify(physical.style));
    check("logical-padding list left alone (no inline padding)",
      outer.style.paddingRight === undefined, JSON.stringify(outer.style));
  }

  /* ---- the skip must come from the adapter, not hardcoded logic --------- */
  console.log("\nunknown host (adapter-independent baseline)");
  {
    const dom = runScenario("example.com", buildExtras);
    await settle();
    const navP = dom.document.querySelector("nav p");
    const boxedP = dom.document.querySelector(".composer p");
    const compP = dom.document.querySelector("#prompt-textarea p");
    check("unknown host still applies the core RTL fix",
      dom.document.querySelectorAll("p.rtlfix-block").length >= 1);
    check("unknown host does NOT skip nav (no adapter rule)",
      navP.getAttribute("dir") === "rtl", `dir=${navP.getAttribute("dir")}`);
    check("unknown host does NOT skip .composer (no adapter rule)",
      boxedP.getAttribute("dir") === "rtl", `dir=${boxedP.getAttribute("dir")}`);
    check("contenteditable composer still skipped by global rule",
      compP.getAttribute("dir") === null, `dir=${compP.getAttribute("dir")}`);
  }

  /* ---- settings: stored toggles must win over the defaults --------------- */
  const singleParagraph = (text) => (d) => {
    const p = new d.Element("p");
    p.appendChild(new d.TextNode(text));
    d.body.appendChild(p);
  };

  console.log("\nsettings toggles");
  {
    const dom = runScenario("chatgpt.com", singleParagraph("**bold** و سلام"),
      { enabled: true, repairMarkdown: false });
    await settle();

    const para = dom.document.querySelector("p");
    check("repairMarkdown=false → marker NOT converted to <strong>",
      dom.document.querySelectorAll("strong").length === 0);
    check("repairMarkdown=false → bidi/dir fix still applied",
      para.getAttribute("dir") === "rtl", `dir=${para.getAttribute("dir")}`);
  }

  console.log("\nenabled toggle");
  {
    const dom = runScenario("chatgpt.com", singleParagraph("این متن فارسی است."),
      { enabled: false, repairMarkdown: true });
    await settle();

    const p = dom.document.querySelector("p");
    check("enabled=false → no paragraph touched",
      p.getAttribute("dir") === null && !hasClass(p, "rtlfix-block"),
      `dir=${p.getAttribute("dir")}`);
  }

  console.log("");
  if (issues.length) {
    console.log(`${issues.length} e2e check(s) failed:`);
    for (const i of issues) console.log(`  - ${i}`);
    process.exit(1);
  }
  console.log("All e2e checks passed.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
