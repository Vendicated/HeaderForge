import test from "node:test";
import assert from "node:assert/strict";

import {
  ALL_RESOURCE_TYPES,
  applyHeaderOps,
  buildDnrRules,
  compileKeyMatcher,
  createHeader,
  createRule,
  globToRegexSource,
  hasAdvancedKeys,
  isResponsePause,
  normalizePattern,
  sanitizeState,
  urlMatchesRule,
  validateMatch,
} from "../lib/core.js";

/* ------------------------------------------------------------------ */
/* URL patterns                                                        */
/* ------------------------------------------------------------------ */

test("normalizePattern adds schemes and trailing wildcards", () => {
  assert.equal(normalizePattern("example.com"), "*://example.com/*");
  assert.equal(normalizePattern("example.com/api/*"), "*://example.com/api/*");
  assert.equal(normalizePattern("https://example.com"), "https://example.com/*");
  assert.equal(normalizePattern("https://example.com:8443"), "https://example.com:8443/*");
  assert.equal(normalizePattern("/api/*"), "/api/*");
  assert.equal(normalizePattern("*://*/*"), "*://*/*");
  assert.equal(normalizePattern(""), "");
});

test("globToRegexSource keeps wildcards inside the host", () => {
  const source = globToRegexSource("https://*.example.com/api/*");
  assert.equal(source, "^https://[^/]*\\.example\\.com/api/.*$");
});

test("wildcard URL matching across scheme, subdomain and path", () => {
  const match = { pattern: "https://*.example.com/api/*", mode: "glob" };

  assert.equal(urlMatchesRule("https://api.example.com/api/v1/users", match), true);
  assert.equal(urlMatchesRule("https://a.b.example.com/api/x?y=1", match), true);
  assert.equal(urlMatchesRule("http://api.example.com/api/v1/users", match), false);
  assert.equal(urlMatchesRule("https://example.com/api/v1", match), false);
  assert.equal(urlMatchesRule("https://api.example.com/other", match), false);
});

test("host wildcard cannot be tricked by a query string", () => {
  const match = { pattern: "https://*.example.com/api/*", mode: "glob" };
  assert.equal(urlMatchesRule("https://evil.test/?x=.example.com/api/y", match), false);
});

test("domain-only patterns match every path", () => {
  const match = { pattern: "example.com", mode: "glob" };
  assert.equal(urlMatchesRule("https://example.com/", match), true);
  assert.equal(urlMatchesRule("https://example.com/deep/path?q=1", match), true);
  assert.equal(urlMatchesRule("https://notexample.com/", match), false);
  assert.equal(urlMatchesRule("https://sub.example.com/", match), false);
});

test("path-only patterns match any origin", () => {
  const match = { pattern: "/api/*", mode: "glob" };
  assert.equal(urlMatchesRule("https://example.com/api/users", match), true);
  assert.equal(urlMatchesRule("http://localhost:3000/api/users", match), true);
  assert.equal(urlMatchesRule("https://example.com/portal", match), false);
});

test("match-all wildcard works for http and https", () => {
  const match = { pattern: "*://*/*", mode: "glob" };
  assert.equal(urlMatchesRule("https://example.com/", match), true);
  assert.equal(urlMatchesRule("http://localhost:8080/a/b", match), true);
  assert.equal(urlMatchesRule("ftp://example.com/file", match), false);
});

test("regex patterns match the full URL without anchors", () => {
  const match = { pattern: "^https://api\\.example\\.com/v[12]/", mode: "regex" };
  assert.equal(urlMatchesRule("https://api.example.com/v2/users", match), true);
  assert.equal(urlMatchesRule("https://api.example.com/v3/users", match), false);
  assert.equal(urlMatchesRule("https://example.com/?x=https://api.example.com/v2/", match), false);
});

test("matching is case-insensitive by default and configurable", () => {
  assert.equal(
    urlMatchesRule("HTTPS://API.EXAMPLE.COM/A", { pattern: "https://api.example.com/a", mode: "glob" }),
    true,
  );
  assert.equal(
    urlMatchesRule("HTTPS://API.EXAMPLE.COM/A", {
      pattern: "https://api.example.com/a",
      mode: "glob",
      caseSensitive: true,
    }),
    false,
  );
});

test("invalid patterns are reported, not thrown", () => {
  assert.equal(validateMatch({ pattern: "(", mode: "regex" }).ok, false);
  assert.equal(validateMatch({ pattern: "", mode: "glob" }).ok, false);
  assert.equal(validateMatch({ pattern: "example.com", mode: "glob" }).ok, true);
  assert.equal(validateMatch({ pattern: "^https://example\\.com/", mode: "regex" }).ok, true);
});

test("pause stage detection tolerates a missing requestStage", () => {
  assert.equal(isResponsePause({ requestStage: "Request" }), false);
  assert.equal(isResponsePause({ requestStage: "Response" }), true);
  assert.equal(isResponsePause({ request: {} }), false);
  assert.equal(isResponsePause({ responseStatusCode: 200 }), true);
  assert.equal(isResponsePause({ responseErrorReason: "Failed" }), true);
  assert.equal(isResponsePause({ responseHeaders: [] }), true);
});

/* ------------------------------------------------------------------ */
/* Header key matching                                                 */
/* ------------------------------------------------------------------ */

test("exact header keys are case-insensitive", () => {
  const matcher = compileKeyMatcher({ key: "X-Debug", keyMatch: "exact" });
  assert.equal(matcher.test("x-debug"), true);
  assert.equal(matcher.test("x-debug-extra"), false);
});

test("wildcard header keys match with *", () => {
  const matcher = compileKeyMatcher({ key: "x-debug-*", keyMatch: "glob" });
  assert.equal(matcher.test("X-Debug-Mode"), true);
  assert.equal(matcher.test("x-debug-"), true);
  assert.equal(matcher.test("x-other"), false);
});

test("regex header keys match with *", () => {
  const matcher = compileKeyMatcher({ key: "^x-(trace|span)-id$", keyMatch: "regex" });
  assert.equal(matcher.test("X-Trace-Id"), true);
  assert.equal(matcher.test("x-span-id"), true);
  assert.equal(matcher.test("x-trace-id-extra"), false);
});

test("applyHeaderOps sets, appends and removes headers", () => {
  const headers = [
    { name: "Accept", value: "text/html" },
    { name: "X-Debug-Mode", value: "1" },
    { name: "X-Debug-Span", value: "abc" },
  ];

  const set = applyHeaderOps(headers, [
    { key: "x-debug-*", keyMatch: "glob", operation: "set", value: "on" },
  ]);
  assert.deepEqual(
    set.map((header) => header.value),
    ["text/html", "on", "on"],
  );

  const appended = applyHeaderOps(headers, [
    { key: "accept", keyMatch: "exact", operation: "append", value: "application/json" },
  ]);
  assert.equal(appended[0].value, "text/html, application/json");

  const removed = applyHeaderOps(headers, [
    { key: "x-debug-*", keyMatch: "glob", operation: "remove" },
  ]);
  assert.deepEqual(removed, [{ name: "Accept", value: "text/html" }]);
});

test("applyHeaderOps creates missing exact headers but not wildcard ones", () => {
  const added = applyHeaderOps([], [
    { key: "X-New", keyMatch: "exact", operation: "set", value: "yes" },
  ]);
  assert.deepEqual(added, [{ name: "X-New", value: "yes" }]);

  const wildcard = applyHeaderOps([], [
    { key: "x-new-*", keyMatch: "glob", operation: "set", value: "yes" },
  ]);
  assert.deepEqual(wildcard, []);
});

test("applyHeaderOps keeps duplicates and untouched headers intact", () => {
  const headers = [
    { name: "Set-Cookie", value: "a=1" },
    { name: "Set-Cookie", value: "b=2" },
    { name: "Content-Type", value: "text/plain" },
  ];
  const result = applyHeaderOps(headers, [
    { key: "set-cookie", keyMatch: "exact", operation: "remove" },
  ]);
  assert.deepEqual(result, [{ name: "Content-Type", value: "text/plain" }]);
});

/* ------------------------------------------------------------------ */
/* State and DNR rules                                                 */
/* ------------------------------------------------------------------ */

test("sanitizeState repairs malformed input", () => {
  const state = sanitizeState({
    enabled: false,
    rules: [
      { name: "A", match: { pattern: "example.com" }, requestHeaders: [{ key: "x-a" }], extra: 1 },
      null,
      42,
    ],
  });

  assert.equal(state.enabled, false);
  assert.equal(state.rules.length, 1);
  assert.equal(state.rules[0].match.mode, "glob");
  assert.equal(state.rules[0].requestHeaders[0].operation, "set");
  assert.equal(state.rules[0].enabled, true);
});

test("hasAdvancedKeys detects wildcard and regex keys", () => {
  assert.equal(hasAdvancedKeys(createRule({ requestHeaders: [createHeader({ key: "x" })] })), false);
  assert.equal(
    hasAdvancedKeys(createRule({ requestHeaders: [createHeader({ key: "x-*", keyMatch: "glob" })] })),
    true,
  );
  assert.equal(
    hasAdvancedKeys(createRule({ responseHeaders: [createHeader({ key: "^x-", keyMatch: "regex" })] })),
    true,
  );
});

test("buildDnrRules creates one rule per user rule with later priority", () => {
  const state = sanitizeState({
    rules: [
      createRule({
        name: "A",
        match: { pattern: "example.com", mode: "glob" },
        requestHeaders: [createHeader({ key: "x-a", value: "1" })],
      }),
      createRule({
        name: "B",
        match: { pattern: "https://example.com/api/*", mode: "glob" },
        responseHeaders: [createHeader({ key: "x-b", value: "2" })],
      }),
    ],
  });

  const { rules, problems } = buildDnrRules(state);
  assert.equal(problems.length, 0);
  assert.equal(rules.length, 2);

  assert.equal(rules[0].id, 1);
  assert.equal(rules[0].priority, 1);
  assert.deepEqual(rules[0].action.requestHeaders, [{ header: "x-a", operation: "set", value: "1" }]);
  assert.equal(rules[1].id, 2);
  assert.equal(rules[1].priority, 2);
  assert.deepEqual(rules[1].action.responseHeaders, [
    { header: "x-b", operation: "set", value: "2" },
  ]);

  assert.deepEqual(rules[0].condition.resourceTypes, ALL_RESOURCE_TYPES);
  assert.match(rules[0].condition.regexFilter, /example/);
});

test("buildDnrRules skips paused, disabled and advanced-only rules", () => {
  const paused = buildDnrRules(
    sanitizeState({
      enabled: false,
      rules: [
        createRule({
          match: { pattern: "example.com", mode: "glob" },
          requestHeaders: [createHeader({ key: "x-a", value: "1" })],
        }),
      ],
    }),
  );
  assert.equal(paused.rules.length, 0);

  const disabled = buildDnrRules(
    sanitizeState({
      rules: [
        createRule({
          enabled: false,
          match: { pattern: "example.com", mode: "glob" },
          requestHeaders: [createHeader({ key: "x-a", value: "1" })],
        }),
      ],
    }),
  );
  assert.equal(disabled.rules.length, 0);

  const advancedOnly = buildDnrRules(
    sanitizeState({
      rules: [
        createRule({
          match: { pattern: "example.com", mode: "glob" },
          requestHeaders: [createHeader({ key: "x-*", keyMatch: "glob", value: "1" })],
        }),
      ],
    }),
  );
  assert.equal(advancedOnly.rules.length, 0);
  assert.equal(advancedOnly.problems.length, 0);
});

test("buildDnrRules mixes exact and advanced keys", () => {
  const state = sanitizeState({
    rules: [
      createRule({
        match: { pattern: "example.com", mode: "glob" },
        requestHeaders: [
          createHeader({ key: "x-exact", value: "1" }),
          createHeader({ key: "x-*", keyMatch: "glob", value: "2" }),
        ],
      }),
    ],
  });

  const { rules } = buildDnrRules(state);
  assert.equal(rules.length, 1);
  assert.deepEqual(rules[0].action.requestHeaders, [
    { header: "x-exact", operation: "set", value: "1" },
  ]);
});

test("buildDnrRules deduplicates header names with the last entry winning", () => {
  const state = sanitizeState({
    rules: [
      createRule({
        match: { pattern: "example.com", mode: "glob" },
        responseHeaders: [
          createHeader({ key: "X-Test", value: "first" }),
          createHeader({ key: "x-test", value: "second" }),
        ],
      }),
    ],
  });

  const { rules } = buildDnrRules(state);
  assert.deepEqual(rules[0].action.responseHeaders, [
    { header: "x-test", operation: "set", value: "second" },
  ]);
});

test("buildDnrRules reports bad patterns", () => {
  const state = sanitizeState({
    rules: [
      createRule({
        name: "Broken",
        match: { pattern: "(", mode: "regex" },
        requestHeaders: [createHeader({ key: "x-a", value: "1" })],
      }),
      createRule({
        match: { pattern: "", mode: "glob" },
        responseHeaders: [createHeader({ key: "x-b", value: "1" })],
      }),
    ],
  });

  const { rules, problems } = buildDnrRules(state);
  assert.equal(rules.length, 0);
  assert.equal(problems.length, 2);
  assert.equal(problems[0].ruleName, "Broken");
});

test("buildDnrRules rejects invalid header names", () => {
  const state = sanitizeState({
    rules: [
      createRule({
        match: { pattern: "example.com", mode: "glob" },
        requestHeaders: [createHeader({ key: "bad header", value: "1" })],
      }),
    ],
  });
  assert.equal(buildDnrRules(state).rules.length, 0);
});

test("remove operations carry no value", () => {
  const state = sanitizeState({
    rules: [
      createRule({
        match: { pattern: "example.com", mode: "glob" },
        responseHeaders: [createHeader({ key: "content-security-policy", operation: "remove" })],
      }),
    ],
  });
  assert.deepEqual(buildDnrRules(state).rules[0].action.responseHeaders, [
    { header: "content-security-policy", operation: "remove" },
  ]);
});
