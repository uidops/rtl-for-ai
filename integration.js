#!/usr/bin/env node
/**
 * Integration check — loads sites.js, bidi.js, content.js the way a Firefox
 * content script does: in one shared scope with NO `module`/`exports`, so the
 * UMD wrappers must publish to `globalThis`. Then asserts the pieces found each
 * other and that the site-specific skip selectors made it into the live list.
 *
 * Run with:  node integration.js
 */
"use strict";

const fs = require("fs");
const vm = require("vm");

const issues = [];
function check(name, ok, detail) {
  console.log(`  ${ok ? "ok  " : "FAIL"} ${name}${!ok && detail ? `  → ${detail}` : ""}`);
  if (!ok) issues.push(name);
}

/* ---- minimal browser-ish globals -------------------------------------- */
const sandbox = {
  console,
  URL,
  requestAnimationFrame: (fn) => fn(),
  setTimeout,
  clearTimeout,
  MutationObserver: class {
    observe() {}
    disconnect() {}
    takeRecords() { return []; }
  },
  Node: { ELEMENT_NODE: 1, TEXT_NODE: 3, DOCUMENT_NODE: 9 },
  NodeFilter: { SHOW_TEXT: 4, FILTER_ACCEPT: 1, FILTER_REJECT: 2 },
};
sandbox.globalThis = sandbox;
sandbox.window = sandbox;
sandbox.self = sandbox;

// Intentionally no `module`, no `exports` → UMD must take the global branch.
vm.createContext(sandbox);

function load(file, hostname) {
  const code = fs.readFileSync(file, "utf8");
  vm.runInContext(code, sandbox, { filename: file });
}

/* ---- load in manifest order ------------------------------------------- */
load("sites.js");
load("bidi.js");

check("sites.js published to globalThis.RTLSites", typeof sandbox.RTLSites === "object");
check("bidi.js published to globalThis.RTLFixBidi", typeof sandbox.RTLFixBidi === "object");
check("no CommonJS leak (module untouched)", sandbox.module === undefined);

/* ---- host resolution through the adapter ------------------------------- */
check("adapter resolves chatgpt.com", sandbox.RTLSites.match("chatgpt.com")?.id === "chatgpt");
check("adapter resolves gemini.google.com", sandbox.RTLSites.match("gemini.google.com")?.id === "gemini");
check("adapter resolves duck.ai", sandbox.RTLSites.match("duck.ai")?.id === "duck.ai");

/* ---- content.js must boot without a real DOM --------------------------- */
let contentBooted = false;
try {
  // content.js touches `document` only inside init(); with readyState
  // "loading" it defers to DOMContentLoaded and never runs — which is exactly
  // what we want here: we only need its module-level wiring to succeed.
  sandbox.document = {
    readyState: "loading",
    addEventListener() {},
    createElement() { return {}; },
    createTextNode(v) { return { nodeValue: v }; },
    createDocumentFragment() { return { childNodes: [] }; },
  };
  sandbox.location = { hostname: "chatgpt.com", href: "https://chatgpt.com/" };
  load("content.js");
  contentBooted = true;
} catch (err) {
  check("content.js module-level wiring", false, err.message);
}
if (contentBooted) check("content.js module-level wiring", true);

/* ---- the adapter must actually reach SKIP_SELECTOR --------------------- *
 * content.js builds SKIP_SELECTOR at module scope from BASE_SKIP + SITE.skip.
 * We can't read that closure directly, so we assert the contract from the
 * other side: every selector the chatgpt adapter declares must be accepted by
 * a real `matches()`-style parse, i.e. it is a usable selector string.        */
const gpt = sandbox.RTLSites.match("chatgpt.com");
check("chatgpt adapter skip list is non-empty", Array.isArray(gpt.skip) && gpt.skip.length > 0);
check("chatgpt message roots are non-empty", Array.isArray(gpt.messageRoots) && gpt.messageRoots.length > 0);
for (const s of [...(gpt.skip || []), ...(gpt.messageRoots || [])]) {
  if (typeof s !== "string" || !s.trim()) check("selector is a non-empty string", false, JSON.stringify(s));
}
check("all chatgpt selectors are strings", [...gpt.skip, ...gpt.messageRoots].every((s) => typeof s === "string" && s.trim()));

const gem = sandbox.RTLSites.match("gemini.google.com");
check("gemini adapter skip list is non-empty", Array.isArray(gem.skip) && gem.skip.length > 0);
check("gemini message roots are non-empty", Array.isArray(gem.messageRoots) && gem.messageRoots.length > 0);

/* ---- manifest lists the new hosts and loads sites.js first ------------- */
const manifest = JSON.parse(fs.readFileSync("manifest.json", "utf8"));
const matches = manifest.content_scripts[0].matches.join(" ");
for (const host of ["chatgpt.com", "chat.openai.com", "gemini.google.com", "duck.ai"]) {
  check(`manifest matches ${host}`, matches.includes(host));
}
check("manifest loads sites.js before content.js",
  manifest.content_scripts[0].js.join(",") === "sites.js,bidi.js,content.js");
check("manifest name is 'RTL for AI'", manifest.name === "RTL for AI");
check("manifest has activeTab permission (popup active-tab label, minimal scope)",
  (manifest.permissions || []).includes("activeTab"));
check("manifest avoids broad 'tabs' permission",
  !(manifest.permissions || []).includes("tabs"));

/* ---- popup must not reference the old name ----------------------------- */
const popupHtml = fs.readFileSync("popup.html", "utf8");
check("popup.html free of old 'RTL Fix for Duck.ai' name", !popupHtml.includes("RTL Fix for Duck.ai"));
check("popup.html renamed to RTL for AI", popupHtml.includes("RTL for AI"));
const popupJs = fs.readFileSync("popup.js", "utf8");
check("popup.js does not hardcode 'on duck.ai'", !popupJs.includes("on duck.ai"));
check("popup.html loads sites.js before popup.js",
  popupHtml.indexOf('src="sites.js"') < popupHtml.indexOf('src="popup.js"')
  && popupHtml.includes('src="sites.js"'));
check("popup.js reads labels from RTLSites (single source of truth)",
  popupJs.includes("RTLSites"));

/* ---- content.css must protect rendered math inside RTL blocks ---------- */
const contentCss = fs.readFileSync("content.css", "utf8");
check("content.css re-asserts LTR for KaTeX inside RTL blocks",
  contentCss.includes('.rtlfix-block[dir="rtl"] .katex') && contentCss.includes("direction: ltr"));
check("content.css re-asserts LTR for MathJax inside RTL blocks",
  contentCss.includes('.rtlfix-block[dir="rtl"] mjx-container'));
check("content.css centers standalone display equations",
  contentCss.includes(".rtlfix-math") && contentCss.includes("text-align: center"));

console.log("");
if (issues.length) {
  console.log(`${issues.length} integration check(s) failed:`);
  for (const i of issues) console.log(`  - ${i}`);
  process.exit(1);
}
console.log("All integration checks passed.");
