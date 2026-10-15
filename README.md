# RTL for AI

A Firefox extension that fixes jumbled Persian/RTL text in AI chat apps.

When an answer mixes Persian with Latin words, book titles, equations or numbers, chat interfaces often render the paragraph with the wrong base direction. The result is text that reads *pell-mell*: clauses appear out of order, titles and equations float to the wrong side, and punctuation lands in the wrong place.

**RTL for AI** repairs this in the page, without changing the source text.

Supported sites:

| Site | Hosts |
| --- | --- |
| Duck.ai | `duck.ai`, `duckduckgo.com/aichat` |
| ChatGPT | `chatgpt.com`, `chat.openai.com` |
| Gemini | `gemini.google.com` |

## What it does

**1. Correct base direction**

Blocks whose dominant script is Arabic/Persian get `dir="rtl"` plus a `lang="fa"` hint. The decision follows the Unicode first-strong rule with a dominant-script tie-break, so `روش RREF را ببینید` stays RTL even though it contains Latin, while a pure equation line is left untouched.

**2. Bidi isolation**

Every strongly-LTR fragment — Latin words, book titles, equations, math symbols, numbers joined by operators — is wrapped in an isolating `<bdi dir="ltr">` so it stays readable inside RTL flow. Persian digits and pure-Persian text stay in the RTL flow where they belong.

```
x_1 = −x_4، x_2 = ½x_3 + ½x_4.
```

becomes two separately isolated equations split around the Arabic comma, each rendering in the correct reading order.

**3. Stray Markdown repair** *(optional, on by default)*

Turns leaked raw markers into real elements:

- `**bold**` → `<strong>`, `*italic*` → `<em>`, `` `code` `` → `<code>`
- `[text](url)` → a real link
- `(citation src="2")` → a compact superscript source badge

**4. Math stays math**

Rendered formulas (KaTeX/MathJax) are laid out internally LTR but inherit their paragraph's direction, which scrambles them once a block flips to RTL — duck.ai's KaTeX build, for example, ships no `direction` rule of its own. The extension re-asserts LTR + isolation per formula inside RTL blocks, and a paragraph that is *only* a display equation — how Duck.ai renders display math — follows the RTL flow of the answer and stays centered instead of jutting out to the left.

## Installation

Load it temporarily for development:

1. Open `about:debugging#/runtime/this-firefox`
2. Click **Load Temporary Add-on…**
3. Select `manifest.json` from this directory

To install permanently, package it with [`web-ext`](https://extensionworkshop.com/documentation/develop/getting-started-with-web-ext/):

```bash
npx web-ext build
```

Then install the generated `.zip` from `about:addons`.

## Usage

Click the toolbar icon to toggle:

- **Fix Persian (RTL) text** — master switch for direction and bidi isolation
- **Repair stray Markdown** — the artifact cleanup pass

The footer shows which site the current tab is on. Both settings are stored per-profile and apply immediately, with no reload needed.

## How it works

The page is scanned on load and on every DOM mutation (chat apps stream and re-render messages), so long answers are fixed as they arrive. Each paragraph is processed at most once per content change, and code blocks, math (KaTeX/MathJax), and input fields are always skipped by the text passes — formula direction and display-equation alignment are handled separately (see “Math stays math”).

Markup is built exclusively with `createElement` and `textContent` — never `innerHTML` — so page content can never inject markup.

### File layout

| File | Role |
| --- | --- |
| `manifest.json` | MV3 manifest: hosts, permissions, content script order |
| `bidi.js` | Pure text logic — UAX#9 subset, run splitting, Markdown tokenizing. No DOM. |
| `content.js` | DOM glue — sets direction, inserts `<bdi>`, repairs Markdown |
| `sites.js` | Per-site adapters — where prose lives, what to skip |
| `popup.html` / `popup.js` | Toolbar popup and options |
| `content.css` | Finishing touches: alignment, citation badge |
| `test.js` | Unit tests for the text logic |
| `integration.js` | Loads the scripts the way a content script does |
| `e2e.js` | Runs the full pipeline per site against a small DOM |

`bidi.js` and `sites.js` are UMD modules: they publish to `globalThis` in the browser and export under Node, which is what lets the same logic run in the tests.

## Adding a new site

Add one entry to `ADAPTERS` in `sites.js`:

```js
{
  id: "example",
  label: "Example",
  hosts: ["example.com"],
  messageRoots: ["article", "[data-message]"],  // scan hint
  skip: ["nav", "[class*='composer']"],         // never touch these
},
```

Then add the host to `host_permissions` and `matches` in `manifest.json`.

The adapter is optional — an unknown host falls back to a fully generic scan, so the extension still works if a UI is redesigned. Everything else is additive: no changes to the bidi or Markdown logic.

## Tests

```bash
node test.js          # 69 unit tests — text logic and adapters
node integration.js   # 28 checks — UMD wiring, manifest, popup, CSS contract
node e2e.js           # 53 checks — full pipeline per site
```

All three must pass before shipping.

## Permissions

| Permission | Why |
| --- | --- |
| `storage` | Persist the two toggles |
| `activeTab` | Let the popup name the site in the current tab |
| host permissions | Inject the content script on the supported sites |

No network requests are made. Nothing is collected or transmitted.

## License

[MIT](LICENSE)
