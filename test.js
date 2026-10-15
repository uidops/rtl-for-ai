#!/usr/bin/env node
/**
 * Unit tests for bidi.js — run with:  node test.js
 *
 * Sample strings cover Persian prose mixed with book titles, equations and
 * Persian digits.
 */
"use strict";

const BIDI = require("./bidi.js");
const { R, L } = BIDI;

let passed = 0;
let failed = 0;

function check(name, condition, detail) {
  if (condition) {
    passed += 1;
    console.log(`  ok   ${name}`);
  } else {
    failed += 1;
    console.log(`  FAIL ${name}${detail ? `\n       ${detail}` : ""}`);
  }
}

function wraps(text, base) {
  return BIDI.plan(text, base)
    .filter((piece) => piece.wrap)
    .map((piece) => piece.wrap);
}

function rejoin(text, base) {
  return BIDI.plan(text, base)
    .map((piece) => piece.text ?? piece.wrap)
    .join("");
}

/* ------------------------------------------------------------------ *
 * Base-direction detection
 * ------------------------------------------------------------------ */
console.log("\nbase direction");

const PARA =
  "ابتدا این است که بعد از تبدیل ماتریس به فرم پله‌ای کاهش‌یافته، برای هر متغیر آزاد یک بردار جهت فضای جواب می‌سازیم. در مثال شما:";
check("Persian paragraph → RTL", BIDI.baseDirection(PARA) === R);

const MIXED =
  "است؛ برای هر متغیر RREF بنابراین این دو بردار یک پایه برای هسته‌اند. ترفند «منفی‌یک» راهی برای خواندن همین جهت‌ها از آزاد، یک محفظه ۱− در جایگاه آن می‌گذارند.";
check("Persian paragraph with Latin + Persian digits → RTL", BIDI.baseDirection(MIXED) === R);

check("Equation-only line → left untouched (no RTL)", BIDI.baseDirection("x_1 = -x_4,  x_2 = 1/2 x_3") === 0);
check("Pure English → no fix (0)", BIDI.baseDirection("The answer is 42.") === 0);
check("Latin lead-in but Persian-dominant → RTL", BIDI.baseDirection("RREF یک روش عمومی برای قرار دادن هر متغیر آزاد است") === R);
check("Latin-dominant with a Persian word → LTR", BIDI.baseDirection("The word سلام means peace") === L);
check("Persian detected (lang hint)", BIDI.analyse(PARA).persian === true);
check("Arabic without Persian letters → not fa", BIDI.analyse("هذا نص عربي فقط").persian === false);

/* ------------------------------------------------------------------ *
 * Isolation planning
 * ------------------------------------------------------------------ */
console.log("\nisolation planning");

const TITLE = "در کتاب Mathematics for Machine Learning روش «منفی‌یک» را توضیح می‌دهد.";
check(
  "book title isolated as one LTR run",
  JSON.stringify(wraps(TITLE, R)) === JSON.stringify(["Mathematics for Machine Learning"]),
  `got ${JSON.stringify(wraps(TITLE, R))}`
);

check(
  "bold-able Latin token isolated",
  JSON.stringify(wraps("اشاره نمی‌کرد Minus-1 در کتاب", R)) === JSON.stringify(["Minus-1"])
);

const EQUATIONS = "x_1 = −x_4، x_2 = ½x_3 + ½x_4.";
check(
  "two equations split around the Arabic comma",
  JSON.stringify(wraps(EQUATIONS, R)) === JSON.stringify(["x_1 = −x_4", "x_2 = ½x_3 + ½x_4"]),
  `got ${JSON.stringify(wraps(EQUATIONS, R))}`
);

check("pure Persian → nothing to wrap", wraps("این یک جمله کاملا فارسی است.", R).length === 0);
check("Persian digits stay in RTL flow", wraps("نتیجه برابر ۴۲ است", R).length === 0);
check("lone number is not wrapped", wraps("پاسخ عدد 42 است", R).length === 0);
check("single Latin letter is wrapped", JSON.stringify(wraps("متغیر x آزاد است", R)) === JSON.stringify(["x"]));

const MATRIX = "\\[ \\begin{bmatrix} 1 & 0 & 0 & 1 \\\\ 0 & 1 & -1/2 & -1/2 \\end{bmatrix} \\]";
check("matrix kept as one LTR blob", wraps(MATRIX, R).length === 1 && wraps(MATRIX, R)[0].length > 20);

check("round-trip preserves the string (equations)", rejoin(EQUATIONS, R) === EQUATIONS);
check("round-trip preserves the string (mixed)", rejoin(MIXED, R) === MIXED);
check("round-trip preserves the string (title)", rejoin(TITLE, R) === TITLE);

const LTR_BLOCK = "The word سلام appears in the answer.";
check(
  "LTR block isolates the Persian fragment",
  JSON.stringify(wraps(LTR_BLOCK, L)) === JSON.stringify(["سلام"])
);

check(
  "equation with multiplication wraps as ONE LTR blob",
  JSON.stringify(wraps("a * b = c در ریاضیات", R)) === JSON.stringify(["a * b = c"]),
  `got ${JSON.stringify(wraps("a * b = c در ریاضیات", R))}`
);

/* ------------------------------------------------------------------ *
 * Markdown / citation repair
 * ------------------------------------------------------------------ */
console.log("\nmarkdown & citation repair");

function types(text) {
  return BIDI.tokenizeInline(text).map((token) => token.type);
}
function values(text) {
  return BIDI.tokenizeInline(text).map((token) => token.value);
}

check(
  "stray bold marker repaired",
  JSON.stringify(types("اشاره نمی‌کرد **Minus-1** در کتاب")) ===
    JSON.stringify(["text", "strong", "text"])
);
check(
  "bold content extracted",
  JSON.stringify(values("اشاره نمی‌کرد **Minus-1** در کتاب")) ===
    JSON.stringify(["اشاره نمی‌کرد ", "Minus-1", " در کتاب"])
);
check(
  "stray italic marker repaired",
  JSON.stringify(types("کتاب *Mathematics for ML* را ببینید")) === JSON.stringify(["text", "em", "text"])
);
check("bold wins over nested asterisks", JSON.stringify(values("**a * b**")) === JSON.stringify(["a * b"]));
check("inline code repaired", JSON.stringify(types("دستور `npm install` را بزنید")) === JSON.stringify(["text", "code", "text"]));
check(
  "link repaired",
  JSON.stringify(types("ببینید [اینجا](https://example.com)")) === JSON.stringify(["text", "a"])
);
check(
  "link with trailing text",
  JSON.stringify(types("[اینجا](https://example.com) را ببینید")) === JSON.stringify(["a", "text"])
);
check("plain multiplication left alone", JSON.stringify(types("a * b = c")) === JSON.stringify(["text"]));
check("plain text untouched", JSON.stringify(types("این متن ساده است.")) === JSON.stringify(["text"]));

check("citation artifact detected", BIDI.CITATION_TEST.test('(citation src="2")'));
check(
  "citation turned into a badge",
  JSON.stringify(types("پایان جمله. (citation src=\"2\")")) === JSON.stringify(["text", "cite"])
);
check(
  "citation number extracted",
  JSON.stringify(values('(citation src="7")')) === JSON.stringify(["7"])
);
check(
  "citation keeps surrounding text",
  JSON.stringify(values("پایان (citation src=\"2\")")) === JSON.stringify(["پایان ", "2"])
);
check("citation with spaces tolerated", BIDI.CITATION_TEST.test('(  citation   src = "3"  )'));

const roundTrip = BIDI.tokenizeInline("**Minus-1** در کتاب (citation src=\"2\")")
  .map((token) => token.value)
  .join("");
check(
  "markdown round-trip keeps the text",
  roundTrip === "Minus-1 در کتاب 2",
  `got ${JSON.stringify(roundTrip)}`
);

/* ------------------------------------------------------------------ *
 * Classification spot-checks
 * ------------------------------------------------------------------ */
console.log("\nclassification");

const classOf = (ch) => BIDI.charClass(ch.codePointAt(0));
check("Latin letter is L", classOf("a") === L);
check("Arabic letter is R", classOf("س") === R);
check("Persian digit is R", classOf("۴") === R);
check("ASCII digit is L", classOf("4") === L);
check("Arabic comma is R", classOf("،") === R);
check("ASCII comma is neutral", classOf(",") === BIDI.N);
check("minus sign is L", classOf("−") === L);
check("em dash is neutral", classOf("—") === BIDI.N);
check("Greek letter is L", classOf("σ") === L);

/* ------------------------------------------------------------------ *
 * Site adapters
 * ------------------------------------------------------------------ */
console.log("\nsite adapters");

const SITES = require("./sites.js");

check("duck.ai host matched", SITES.match("duck.ai")?.id === "duck.ai");
check("www prefix stripped", SITES.match("www.duck.ai")?.id === "duck.ai");
check("duckduckgo.com mapped to Duck.ai", SITES.match("duckduckgo.com")?.id === "duck.ai");
check("chatgpt.com matched", SITES.match("chatgpt.com")?.id === "chatgpt");
check("legacy chat.openai.com matched", SITES.match("chat.openai.com")?.id === "chatgpt");
check("gemini.google.com matched", SITES.match("gemini.google.com")?.id === "gemini");
check("subdomain matched by suffix", SITES.match("chat.gemini.google.com")?.id === "gemini");
check("unknown host returns null", SITES.match("example.com") === null);
check("empty host returns null", SITES.match("") === null);
check("host matching is case-insensitive", SITES.match("ChatGPT.COM")?.id === "chatgpt");

const duck = SITES.match("duck.ai");
check("duck adapter label", duck?.label === "Duck.ai");
check("chatgpt adapter label", SITES.match("chatgpt.com")?.label === "ChatGPT");
check("gemini adapter label", SITES.match("gemini.google.com")?.label === "Gemini");
check("duck adapter skips composer", duck.skip.some((s) => s.includes("composer")));
check("duck adapter skips the sidebar chrome", duck.skip.some((s) => s.includes("duckai-sidebar")));
check("chatgpt adapter skips the composer",
  SITES.match("chatgpt.com").skip.some((s) => s.includes("prompt-textarea")));
check("every adapter declares a non-empty skip list",
  ["duck.ai", "chatgpt.com", "gemini.google.com"].every((h) => SITES.match(h).skip.length > 0));

const generic = SITES.current({ hostname: "example.com" });
check("unknown host falls back to generic", generic.id === "generic");
check("generic adapter still safe (no skips crash)", Array.isArray(generic.skip));
check("current() uses real location without arg", typeof SITES.current().id === "string");

/* ------------------------------------------------------------------ */
console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed === 0 ? 0 : 1);
