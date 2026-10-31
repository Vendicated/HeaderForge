# Header Forge

A Chrome extension for rewriting **request** and **response** headers on any
site. Rules match URLs with wildcards (or regex), and each rule has separate
request-header and response-header sections.

Built as a Manifest V3 extension with no build step, no external dependencies,
and no network calls. Everything is stored locally in `chrome.storage.local`.

<img width="1611" height="1169" alt="Screenshot From 2026-10-31 04-37-44" src="https://github.com/user-attachments/assets/aebe283d-b11a-4d26-a1c1-3130b97f90a4" />
<img width="1136" height="416" alt="Screenshot From 2026-10-31 04-38-01" src="https://github.com/user-attachments/assets/39066d05-e774-4233-8071-afc2472ab4a8" />

This extension was written entirely by Deepseek v4.1 Flash in one single prompt (and a second one to make it change the dashboard page from [ultra AI-slop](#ultra-ai-slop) to an actually nice looking page)

![Manifest V3](https://img.shields.io/badge/Manifest-V3-4f46e5) ![No build step](https://img.shields.io/badge/build-none-059669)

## Install

1. Open `chrome://extensions`.
2. Turn on **Developer mode**.
3. Click **Load unpacked** and select this directory.
4. Click the toolbar icon (or **Details → Extension options**) to open the
   dashboard.

Chrome 120+ is required.

## What it does

- Match URLs by domain, full URL, path, wildcard or regular expression.
- Add, replace, append or remove headers.
- Separate **Request headers** and **Response headers** per rule.
- Header keys can be matched by exact name, wildcard (`x-debug-*`) or regex
  (`^x-trace-(id|span)$`), with an optional advanced engine.
- Enable/disable individual rules or pause everything with the master switch.
- Live status: compiled DNR rules, attached debugger tabs and invalid patterns.
- Duplicate rules and import/export JSON.

## URL patterns

The default **Wildcard** mode uses `*` as the only special character.

| Pattern                       | Matches                                          |
| ----------------------------- | ------------------------------------------------ |
| `example.com`                 | Any path on `https://example.com/`               |
| `https://example.com/*`       | Any path on exactly that origin                  |
| `https://*.example.com/api/*` | Any subdomain of example.com, path under `/api/` |
| `/api/*`                      | That path on **any** host                        |
| `*://*/*`                     | Every `http` and `https` URL                     |
| `https://example.com:8443/*`  | A non-default port                               |

Details:

- `*://` means `http://` or `https://`.
- A `*` in the host part does not cross `/`, so `*.example.com` cannot be
  tricked by a query string that contains `.example.com`.
- A `*` in the path/query part matches anything, including `/`.
- If you omit the scheme, `*://` is added.
- If you omit the path, `/*` is added.
- Matching is case-insensitive by default.

Switch a rule to **Regex** mode to supply a raw regular expression, e.g.
`^https://api\.example\.com/v[12]/`. Regex is matched against the full URL and
is case-insensitive by default. Chrome's DNR engine uses RE2, so lookarounds
and other PCRE-only features are rejected — the dashboard reports these.

## Header operations

Each header row has a key, a value, an operation and a key-match mode.

| Operation  | Behaviour                                                                                            |
| ---------- | ---------------------------------------------------------------------------------------------------- |
| **Set**    | Replace every matching header. Adds the header if it is missing (exact keys only).                   |
| **Append** | Append the value to matching headers, comma-separated. Adds the header if missing (exact keys only). |
| **Remove** | Delete every matching header.                                                                        |

Key-match modes:

- **Exact** — normal header-name matching, case-insensitive.
- **Wildcard** — `x-debug-*` sets/removes every header whose name starts with
  `x-debug-`.
- **Regex** — `^x-(trace|span)-id$`.

Wildcard and regex key modes are handled by the optional **Advanced key
matching** engine. Without it, those rows are ignored (the dashboard warns you
and marks the rule).

## Advanced key matching (optional)

`declarativeNetRequest` only understands literal header names, so wildcard and
regex **keys** need a different mechanism. When advanced mode is on, the
extension attaches Chrome's debugger to web tabs and uses the CDP `Fetch`
domain to rewrite headers that DNR cannot name.

It is off by default because Chrome shows a **"started debugging this browser"**
banner on attached tabs.

Caveats:

- It attaches to all open `http(s)` tabs, not just matching ones (the URL is
  filtered per request).
- The very first document load of a brand-new tab can race the attachment. Once
  attached, subsequent navigations and all subresources are covered; reload if
  you need the first request.
- Tabs with DevTools open cannot be attached. The dashboard surfaces attach
  errors.
- Regex keys use JavaScript `RegExp` (advanced engine), while URL regexes use
  RE2 (DNR). They are close but not identical.
- Chrome may refuse to rewrite a few forbidden/pseudo headers; the request is
  continued unchanged rather than hanging.

With advanced mode off, exact keys work everywhere with no banner and no
debugger.

## How it works

```
Exact header keys ──► declarativeNetRequest (dynamic rules)
                      • native, fast, survives restarts
                      • one DNR rule per user rule
                      • later rules get higher priority

Wildcard/regex keys ─► chrome.debugger + CDP Fetch domain (opt-in)
                      • attaches per tab
                      • rewrites request/response headers in flight
                      • only touches non-exact keys, so DNR stays in charge
```

The service worker watches `chrome.storage.local`, rebuilds the dynamic ruleset
on every change, validates regexes with
`chrome.declarativeNetRequest.isRegexSupported`, and reports problems back to
the dashboard.

## Files

```
manifest.json         MV3 manifest
background.js         service worker: state sync, DNR rules, badge, messages
lib/core.js           pure logic: matching, glob→regex, DNR builder, header ops
lib/advanced.js       optional debugger/CDP engine for wildcard & regex keys
dashboard.html        dashboard markup
dashboard.css         dashboard styling (light/dark)
dashboard.js          dashboard behaviour
icons/                extension icons + source SVG
tests/core.test.mjs   Node unit tests for the pure logic
```

## Development

```bash
npm test          # 26 unit tests, no dependencies
npm run icons     # regenerate PNGs from icons/icon.svg (needs rsvg-convert)
```

The dashboard also renders when opened directly from disk (preview mode), but
saving and rule application only work when loaded as an extension.

## Limitations

- Headers are rewritten, not response bodies.
- Chrome's DNR does not affect responses generated entirely by a service worker
  or `CacheStorage`; responses that reach the network stack are covered.
- Some headers are controlled by the browser and cannot be overridden (for
  example `Content-Length` and certain `Sec-*`/pseudo headers).
- Up to 5,000 dynamic DNR rules and 1,000 regex rules, per Chrome's limits.
- Response header modification requires host permission, which is why the
  extension requests `<all_urls>`.

## Privacy

No analytics, no remote calls, no external scripts. Rules and header values
never leave your machine unless a rule you wrote sends them to a site.

## Licence

Since this was 100% written by Deepseek, I claim no ownership and release it under CC0 1.0 Universal (public domain dedication).

## Ultra AI Slop

It made this UI at first until I told it to fix it lmao
<img width="2037" height="1343" alt="Screenshot From 2026-10-31 04-18-37" src="https://github.com/user-attachments/assets/fe05ec80-528d-43de-8366-7cb14c9a6389" />
