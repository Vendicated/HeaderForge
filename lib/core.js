/**
 * Header Forge — shared core.
 *
 * Pure logic used by the service worker, the dashboard and the unit tests.
 * Nothing in this file touches chrome.* so it can run under Node.
 */

export const STORAGE_KEY = "state";
export const STATE_VERSION = 1;

export const HEADER_KEY_MATCHES = ["exact", "glob", "regex"];
export const HEADER_OPERATIONS = ["set", "append", "remove"];

/** Every resource type a modifyHeaders rule should touch. */
export const ALL_RESOURCE_TYPES = [
  "main_frame",
  "sub_frame",
  "stylesheet",
  "script",
  "image",
  "font",
  "object",
  "xmlhttprequest",
  "ping",
  "csp_report",
  "media",
  "websocket",
  "webtransport",
  "webbundle",
  "other",
];

/* ------------------------------------------------------------------ */
/* Small helpers                                                       */
/* ------------------------------------------------------------------ */

export function uid() {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return `r_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
}

export function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function isPlainObject(value) {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

/** Header names are tokens: visible ASCII, no separators. */
export function isValidHeaderName(name) {
  return /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/.test(String(name || "").trim());
}

export function isHttpUrl(url) {
  return /^https?:\/\//i.test(String(url || ""));
}

/* ------------------------------------------------------------------ */
/* State                                                               */
/* ------------------------------------------------------------------ */

export function defaultState() {
  return {
    version: STATE_VERSION,
    enabled: true,
    advancedEngine: false,
    rules: [],
  };
}

function sanitizeHeader(raw) {
  if (!isPlainObject(raw)) return null;
  return {
    id: String(raw.id || uid()),
    key: String(raw.key ?? ""),
    value: String(raw.value ?? ""),
    keyMatch: HEADER_KEY_MATCHES.includes(raw.keyMatch) ? raw.keyMatch : "exact",
    operation: HEADER_OPERATIONS.includes(raw.operation) ? raw.operation : "set",
  };
}

export function sanitizeRule(raw) {
  if (!isPlainObject(raw)) return null;
  const match = isPlainObject(raw.match) ? raw.match : {};
  const requestHeaders = Array.isArray(raw.requestHeaders)
    ? raw.requestHeaders.map(sanitizeHeader).filter(Boolean)
    : [];
  const responseHeaders = Array.isArray(raw.responseHeaders)
    ? raw.responseHeaders.map(sanitizeHeader).filter(Boolean)
    : [];
  return {
    id: String(raw.id || uid()),
    name: String(raw.name || "Untitled rule"),
    enabled: raw.enabled !== false,
    collapsed: raw.collapsed === true,
    match: {
      pattern: String(match.pattern || ""),
      mode: match.mode === "regex" ? "regex" : "glob",
      caseSensitive: match.caseSensitive === true,
    },
    requestHeaders,
    responseHeaders,
  };
}

export function sanitizeState(raw) {
  const state = defaultState();
  if (!isPlainObject(raw)) return state;
  state.enabled = raw.enabled !== false;
  state.advancedEngine = raw.advancedEngine === true;
  if (Array.isArray(raw.rules)) {
    state.rules = raw.rules.map(sanitizeRule).filter(Boolean);
  }
  return state;
}

export function createRule(overrides = {}) {
  return sanitizeRule({
    id: uid(),
    name: "New rule",
    enabled: true,
    match: { pattern: "", mode: "glob", caseSensitive: false },
    requestHeaders: [],
    responseHeaders: [],
    ...overrides,
  });
}

export function createHeader(overrides = {}) {
  return sanitizeHeader({
    id: uid(),
    key: "",
    value: "",
    keyMatch: "exact",
    operation: "set",
    ...overrides,
  });
}

export function hasAdvancedKeys(rule) {
  if (!rule) return false;
  return [...(rule.requestHeaders || []), ...(rule.responseHeaders || [])].some(
    (header) => header && header.key && header.keyMatch && header.keyMatch !== "exact",
  );
}

export function countHeaders(rule) {
  return {
    request: (rule?.requestHeaders || []).filter((header) => header.key).length,
    response: (rule?.responseHeaders || []).filter((header) => header.key).length,
  };
}

/* ------------------------------------------------------------------ */
/* URL pattern matching                                                */
/* ------------------------------------------------------------------ */

/**
 * Turn a friendly pattern into an absolute one.
 *
 *   example.com              -> *://example.com/*
 *   example.com/api/*        -> *://example.com/api/*
 *   https://example.com      -> https://example.com/*
 *   /api/*                   -> path-only, any host
 *   *://*                    -> any http(s) URL
 */
export function normalizePattern(pattern) {
  let value = String(pattern || "").trim();
  if (!value) return "";

  // Path-only patterns are matched against any origin.
  if (value.startsWith("/")) return value;

  // Add a scheme when the user omitted one.
  if (!/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(value) && !value.startsWith("*://")) {
    value = `*://${value}`;
  }

  // Add a path wildcard when the pattern stops after the host.
  const schemeEnd = value.indexOf("://");
  if (schemeEnd !== -1 && !value.slice(schemeEnd + 3).includes("/")) {
    value += "/*";
  }
  return value;
}

/**
 * Convert a glob into an anchored RegExp source.
 * Only `*` is special. In the host section it stays on one label boundary,
 * everywhere else it crosses slashes (so paths and query strings work).
 */
export function globToRegexSource(glob) {
  const pattern = normalizePattern(glob);
  if (!pattern) return "";

  let source = "";
  let rest = pattern;

  const scheme = /^([a-zA-Z][a-zA-Z0-9+.-]*|\*):\/\//.exec(pattern);
  if (scheme) {
    // `*://` is shorthand for http + https, which is what the extension can touch.
    source += scheme[1] === "*" ? "https?" : escapeRegExp(scheme[1]);
    source += "://";
    rest = pattern.slice(scheme[0].length);

    const slash = rest.indexOf("/");
    const host = slash === -1 ? rest : rest.slice(0, slash);
    const tail = slash === -1 ? "" : rest.slice(slash);
    source += convertGlobPart(host, true);
    source += convertGlobPart(tail, false);
  } else if (pattern.startsWith("/")) {
    source += "[a-z][a-z0-9+.-]*://[^/]*";
    source += convertGlobPart(pattern, false);
  } else {
    source += convertGlobPart(pattern, false);
  }

  return `^${source}$`;
}

function convertGlobPart(value, inHost) {
  let out = "";
  for (const char of value) {
    if (char === "*") out += inHost ? "[^/]*" : ".*";
    else out += escapeRegExp(char);
  }
  return out;
}

const matcherCache = new Map();

/** Compile a rule's match block into a RegExp (cached). */
export function compileMatcher(match) {
  const pattern = String(match?.pattern || "").trim();
  if (!pattern) return null;

  const mode = match?.mode === "regex" ? "regex" : "glob";
  const flags = match?.caseSensitive ? "" : "i";
  const source = mode === "regex" ? pattern : globToRegexSource(pattern);
  const cacheKey = `${flags}\u0000${source}`;

  if (matcherCache.has(cacheKey)) return matcherCache.get(cacheKey);

  let compiled = null;
  try {
    compiled = new RegExp(source, flags);
  } catch {
    compiled = null;
  }
  if (matcherCache.size > 500) matcherCache.clear();
  matcherCache.set(cacheKey, compiled);
  return compiled;
}

export function validateMatch(match) {
  const pattern = String(match?.pattern || "").trim();
  if (!pattern) return { ok: false, error: "URL pattern is empty." };

  if (match?.mode === "regex") {
    try {
      // DNR uses RE2; JS rejects most invalid RE2 patterns too. The service
      // worker additionally asks Chrome whether RE2 accepts it.
      new RegExp(pattern);
    } catch (error) {
      return { ok: false, error: `Invalid regex: ${error.message}` };
    }
    if (/[^\x00-\x7F]/.test(pattern)) {
      return { ok: false, error: "Regex patterns must be ASCII (use punycode for IDNs)." };
    }
    return { ok: true };
  }

  const source = globToRegexSource(pattern);
  if (/[^\x00-\x7F]/.test(source)) {
    return { ok: false, error: "Pattern contains non-ASCII characters." };
  }
  try {
    new RegExp(source);
  } catch (error) {
    return { ok: false, error: `Invalid pattern: ${error.message}` };
  }
  return { ok: true };
}

/** Does `url` match a rule's match block? */
export function urlMatchesRule(url, match) {
  const matcher = compileMatcher(match);
  if (!matcher) return false;
  return matcher.test(String(url || "").split("#")[0]);
}

/** Does a URL match a full rule (enabled rules only)? */
export function ruleMatchesUrl(rule, url) {
  return Boolean(rule?.enabled) && urlMatchesRule(url, rule.match);
}

/**
 * Chrome 156 sometimes omits `requestStage` from Fetch.requestPaused events.
 * Infer the pause point from response-only fields so request pauses are not
 * mistaken for response pauses.
 */
export function isResponsePause(params) {
  if (!params) return false;
  if (params.requestStage === "Response") return true;
  if (params.requestStage === "Request") return false;
  return (
    typeof params.responseStatusCode === "number" ||
    Boolean(params.responseErrorReason) ||
    Array.isArray(params.responseHeaders)
  );
}

/* ------------------------------------------------------------------ */
/* Header key matching                                                 */
/* ------------------------------------------------------------------ */

const keyMatcherCache = new Map();

/** Compile a header-key matcher. Header names are always case-insensitive. */
export function compileKeyMatcher(header) {
  const key = String(header?.key || "").trim();
  if (!key) return null;

  const type = HEADER_KEY_MATCHES.includes(header?.keyMatch) ? header.keyMatch : "exact";
  const cacheKey = `${type}\u0000${key}`;
  if (keyMatcherCache.has(cacheKey)) return keyMatcherCache.get(cacheKey);

  let source;
  if (type === "regex") source = key;
  else if (type === "glob") source = `^${key.split("*").map(escapeRegExp).join(".*")}$`;
  else source = `^${escapeRegExp(key)}$`;

  let compiled = null;
  try {
    compiled = new RegExp(source, "i");
  } catch {
    compiled = null;
  }
  if (keyMatcherCache.size > 500) keyMatcherCache.clear();
  keyMatcherCache.set(cacheKey, compiled);
  return compiled;
}

/**
 * Apply header operations to a list of `{ name, value }` entries.
 * Used by the debugger engine (and tests) — DNR has its own implementation.
 */
export function applyHeaderOps(headers, operations) {
  let result = (headers || []).map((header) => ({ ...header }));

  for (const operation of operations || []) {
    const matcher = compileKeyMatcher(operation);
    if (!matcher) continue;

    const value = String(operation.value ?? "");
    const matches = result.filter(
      (header) => typeof header.name === "string" && matcher.test(header.name),
    );

    if (operation.operation === "remove") {
      result = result.filter(
        (header) => !(typeof header.name === "string" && matcher.test(header.name)),
      );
      continue;
    }

    if (matches.length === 0) {
      // A wildcard/regex key can't invent a concrete header name.
      if (operation.keyMatch === "exact" && isValidHeaderName(operation.key)) {
        result.push({ name: operation.key.trim(), value });
      }
      continue;
    }

    for (const header of matches) {
      if (operation.operation === "append") {
        header.value = header.value == null ? value : `${header.value}, ${value}`;
      } else {
        header.value = value;
      }
      delete header.binaryValue;
    }
  }

  return result;
}

/* ------------------------------------------------------------------ */
/* declarativeNetRequest rule building                                 */
/* ------------------------------------------------------------------ */

function toDnrHeaders(headers) {
  const byName = new Map();

  for (const header of headers || []) {
    if (!header || header.keyMatch !== "exact") continue;
    const name = String(header.key || "").trim();
    if (!isValidHeaderName(name)) continue;

    const operation = header.operation || "set";
    const entry = { header: name, operation };
    if (operation !== "remove") entry.value = String(header.value ?? "");

    // Last entry for a name wins, matching the dashboard's visual order.
    byName.set(name.toLowerCase(), entry);
  }

  return [...byName.values()];
}

function buildCondition(rule) {
  const match = rule.match || {};
  const validation = validateMatch(match);
  if (!validation.ok) return { error: validation.error };

  const condition = {
    resourceTypes: ALL_RESOURCE_TYPES,
    isUrlFilterCaseSensitive: match.caseSensitive === true,
  };

  if (match.mode === "regex") {
    condition.regexFilter = String(match.pattern).trim();
  } else {
    condition.regexFilter = globToRegexSource(match.pattern);
  }

  return { condition };
}

/**
 * Build the dynamic DNR ruleset for a whole state object.
 * Only exact-key header entries are handled here; wildcard/regex keys are
 * handled by the optional debugger engine.
 *
 * Later rules get a higher priority so they win when two rules set the same
 * header (DNR applies higher-priority rules first).
 */
export function buildDnrRules(state) {
  const rules = [];
  const problems = [];
  const meta = new Map();

  if (!state?.enabled) return { rules, problems, meta };

  (state.rules || []).forEach((rule, index) => {
    if (!rule.enabled) return;

    const requestHeaders = toDnrHeaders(rule.requestHeaders);
    const responseHeaders = toDnrHeaders(rule.responseHeaders);

    if (requestHeaders.length === 0 && responseHeaders.length === 0) return;

    const built = buildCondition(rule);
    if (built.error) {
      problems.push({ ruleId: rule.id, ruleName: rule.name, message: built.error });
      return;
    }

    const id = rules.length + 1;
    const action = { type: "modifyHeaders" };
    if (requestHeaders.length) action.requestHeaders = requestHeaders;
    if (responseHeaders.length) action.responseHeaders = responseHeaders;

    rules.push({
      id,
      priority: index + 1,
      action,
      condition: built.condition,
    });
    meta.set(id, { ruleId: rule.id, ruleName: rule.name });
  });

  return { rules, problems, meta };
}

/* ------------------------------------------------------------------ */
/* Misc                                                                */
/* ------------------------------------------------------------------ */

export function patternHint(pattern, mode = "glob") {
  if (!String(pattern || "").trim()) return "Add a URL pattern to activate this rule.";
  if (mode === "regex") return "Regex is matched against the full URL (case-insensitive by default).";
  const normalized = normalizePattern(pattern);
  if (normalized.startsWith("/")) return `Matches ${normalized} on any host.`;
  return `Matches ${normalized}`;
}

export function summarizeState(state) {
  const rules = (state?.rules || []).filter((rule) => rule.enabled);
  const headers = rules.reduce(
    (total, rule) => {
      const count = countHeaders(rule);
      total.request += count.request;
      total.response += count.response;
      return total;
    },
    { request: 0, response: 0 },
  );
  return {
    rules: rules.length,
    total: (state?.rules || []).length,
    ...headers,
    advanced: rules.some(hasAdvancedKeys),
  };
}
