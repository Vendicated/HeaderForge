/**
 * Header Forge — dashboard.
 */

import {
  STORAGE_KEY,
  createHeader,
  createRule,
  hasAdvancedKeys,
  isValidHeaderName,
  patternHint,
  sanitizeState,
  validateMatch,
} from "./lib/core.js";

const hasChrome = typeof chrome !== "undefined" && Boolean(chrome.storage?.local);

const rulesEl = document.getElementById("rules");
const emptyEl = document.getElementById("empty");
const masterToggle = document.getElementById("master-toggle");
const advancedToggle = document.getElementById("advanced-toggle");
const advancedMeta = document.getElementById("advanced-meta");
const footStatus = document.getElementById("foot-status");
const problemsEl = document.getElementById("problems");
const problemList = document.getElementById("problem-list");
const toastEl = document.getElementById("toast");
const importFile = document.getElementById("import-file");

let state = sanitizeState(undefined);
let status = null;
let saveTimer = null;
let statusTimer = null;
let toastTimer = null;

/* ------------------------------------------------------------------ */
/* Icons                                                               */
/* ------------------------------------------------------------------ */

const icons = {
  chevron: `<svg viewBox="0 0 24 24" fill="none"><path d="m9 6 6 6-6 6" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>`,
  x: `<svg viewBox="0 0 24 24" fill="none"><path d="M6 6l12 12M18 6 6 18" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>`,
};

/* ------------------------------------------------------------------ */
/* Helpers                                                             */
/* ------------------------------------------------------------------ */

function esc(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function findRule(ruleId) {
  return state.rules.find((rule) => rule.id === ruleId) || null;
}

function findHeader(rule, section, headerId) {
  return (rule?.[section] || []).find((header) => header.id === headerId) || null;
}

function isRegexValid(source) {
  try {
    new RegExp(source);
    return true;
  } catch {
    return false;
  }
}

function headerKeyInvalid(header) {
  if (!header.key) return false;
  if (header.keyMatch === "exact") return !isValidHeaderName(header.key);
  if (header.keyMatch === "regex") return !isRegexValid(header.key);
  return false;
}

function toast(message, kind = "info") {
  toastEl.textContent = message;
  toastEl.dataset.kind = kind;
  toastEl.dataset.show = "true";
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    toastEl.dataset.show = "false";
  }, 2600);
}

/* ------------------------------------------------------------------ */
/* Rendering                                                           */
/* ------------------------------------------------------------------ */

function headerRow(rule, section, header) {
  const removing = header.operation === "remove";
  return `
    <div class="hrow" data-header="${esc(header.id)}">
      <input class="hkey" data-field="key" value="${esc(header.key)}" placeholder="Header name" spellcheck="false" autocomplete="off" aria-label="Header name" data-invalid="${headerKeyInvalid(header)}" />
      <input class="hvalue" data-field="value" value="${esc(header.value)}" placeholder="Value" spellcheck="false" autocomplete="off" aria-label="Header value" ${removing ? "disabled" : ""} />
      <select class="hop" data-field="operation" title="What to do with matching headers" aria-label="Header operation">
        <option value="set" ${header.operation === "set" ? "selected" : ""}>Set</option>
        <option value="append" ${header.operation === "append" ? "selected" : ""}>Append</option>
        <option value="remove" ${header.operation === "remove" ? "selected" : ""}>Remove</option>
      </select>
      <select class="key-mode" data-field="keyMatch" title="Header name matching" aria-label="Header name matching">
        <option value="exact" ${header.keyMatch === "exact" ? "selected" : ""}>Exact</option>
        <option value="glob" ${header.keyMatch === "glob" ? "selected" : ""}>Wildcard</option>
        <option value="regex" ${header.keyMatch === "regex" ? "selected" : ""}>Regex</option>
      </select>
      <button class="hdel" data-act="delete-header" type="button" title="Delete header" aria-label="Delete header">${icons.x}</button>
    </div>`;
}

function panel(rule, section) {
  const isRequest = section === "requestHeaders";
  const headers = rule[section] || [];
  const title = isRequest ? "Request headers" : "Response headers";

  return `
    <section class="panel" data-section="${section}">
      <div class="panel-head">
        <h3>${title}</h3>
        <button class="text-btn" data-act="add-header" data-section="${section}" type="button">Add header</button>
      </div>
      <div class="panel-body">
        ${
          headers.length
            ? `<div class="hrow hrow-legend" aria-hidden="true"><span>Header name</span><span>Value</span><span>Action</span><span>Key match</span><span></span></div>`
            : ""
        }
        ${headers.map((header) => headerRow(rule, section, header)).join("")}
        ${headers.length === 0 ? `<p class="panel-empty">None</p>` : ""}
      </div>
    </section>`;
}

function ruleCard(rule) {
  const advanced = hasAdvancedKeys(rule);
  return `
    <article class="rule" data-rule="${esc(rule.id)}" data-enabled="${rule.enabled}" data-collapsed="${rule.collapsed}">
      <div class="rule-head">
        <button class="chevron" data-act="collapse" type="button" title="${rule.collapsed ? "Expand rule" : "Collapse rule"}" aria-label="${rule.collapsed ? "Expand rule" : "Collapse rule"}">${icons.chevron}</button>
        <input class="rule-name" data-field="name" value="${esc(rule.name)}" spellcheck="false" autocomplete="off" aria-label="Rule name" />
        <div class="rule-actions">
          <label class="rule-enabled" title="${rule.enabled ? "Disable rule" : "Enable rule"}">
            <input type="checkbox" data-field="enabled" ${rule.enabled ? "checked" : ""} aria-label="Enable rule" />
            <span>Enabled</span>
          </label>
          <button class="btn small" data-act="duplicate" type="button">Duplicate</button>
          <button class="btn small danger" data-act="delete" type="button">Delete</button>
        </div>
      </div>

      <div class="rule-body">
        <div class="match-row">
          <span class="match-label">URL</span>
          <input class="match-input" data-field="pattern" value="${esc(rule.match.pattern)}" placeholder="https://*.example.com/api/*" spellcheck="false" autocomplete="off" aria-label="URL match pattern" data-invalid="false" />
          <select data-field="mode" aria-label="URL pattern type">
            <option value="glob" ${rule.match.mode === "glob" ? "selected" : ""}>Wildcard</option>
            <option value="regex" ${rule.match.mode === "regex" ? "selected" : ""}>Regex</option>
          </select>
        </div>
        <p class="match-hint" data-hint></p>

        <div class="panels">
          ${panel(rule, "requestHeaders")}
          ${panel(rule, "responseHeaders")}
        </div>

        <p class="rule-warn" data-rule-warn ${advanced && !state.advancedEngine ? "" : "hidden"}>
          This rule uses wildcard or regex header names. Enable Advanced key matching above.
        </p>
      </div>
    </article>`;
}

function render() {
  rulesEl.innerHTML = state.rules.map(ruleCard).join("");
  emptyEl.hidden = state.rules.length > 0;
  masterToggle.checked = state.enabled;
  advancedToggle.checked = state.advancedEngine;

  for (const card of rulesEl.querySelectorAll(".rule")) {
    refreshRuleCard(card);
  }
  refreshMeta();
}

function refreshRuleCard(card) {
  const rule = findRule(card.dataset.rule);
  if (!rule) return;

  const validation = validateMatch(rule.match);
  const patternInput = card.querySelector('[data-field="pattern"]');
  const hint = card.querySelector("[data-hint]");
  if (patternInput) {
    patternInput.dataset.invalid = String(!validation.ok && Boolean(rule.match.pattern));
  }
  if (hint) {
    hint.textContent = validation.ok
      ? patternHint(rule.match.pattern, rule.match.mode)
      : validation.error;
    hint.dataset.invalid = String(!validation.ok);
  }

  const warn = card.querySelector("[data-rule-warn]");
  if (warn) warn.hidden = !hasAdvancedKeys(rule) || state.advancedEngine;

  for (const row of card.querySelectorAll("[data-header]")) {
    const section = row.closest("[data-section]")?.dataset.section;
    const header = findHeader(rule, section, row.dataset.header);
    if (!header) continue;
    const keyInput = row.querySelector(".hkey");
    if (keyInput) keyInput.dataset.invalid = String(headerKeyInvalid(header));
    const valueInput = row.querySelector(".hvalue");
    if (valueInput) valueInput.disabled = header.operation === "remove";
  }
}

function refreshMeta() {
  advancedToggle.checked = state.advancedEngine;
  advancedMeta.textContent = state.advancedEngine
    ? "Uses Chrome's debugger. Chrome shows a debugging banner on attached tabs."
    : "Wildcard and regex header names are ignored.";

  const problems = status?.problems || [];
  problemsEl.hidden = problems.length === 0;
  problemList.innerHTML = problems
    .map((problem) => `<li><strong>${esc(problem.ruleName || "Rule")}</strong>: ${esc(problem.message)}</li>`)
    .join("");

  if (status?.lastError) {
    footStatus.textContent = `Error: ${status.lastError}`;
    return;
  }

  if (!status) {
    footStatus.textContent = "";
    return;
  }

  const parts = [];
  if (!state.enabled) parts.push("All rules paused");
  parts.push(`${status.dnrRules} DNR ${status.dnrRules === 1 ? "rule" : "rules"}`);
  parts.push(`${status.advancedTabs} debugger ${status.advancedTabs === 1 ? "tab" : "tabs"}`);
  parts.push(`${problems.length} ${problems.length === 1 ? "issue" : "issues"}`);
  footStatus.textContent = parts.join(" · ");
}

/* ------------------------------------------------------------------ */
/* Persistence + status                                                */
/* ------------------------------------------------------------------ */

function save({ immediate = false } = {}) {
  if (!hasChrome) return;
  clearTimeout(saveTimer);

  const persist = async () => {
    try {
      await chrome.storage.local.set({ [STORAGE_KEY]: state });
      queueStatus();
    } catch (error) {
      toast(`Could not save: ${error.message}`, "error");
    }
  };

  if (immediate) persist();
  else saveTimer = setTimeout(persist, 200);
}

function queueStatus() {
  clearTimeout(statusTimer);
  statusTimer = setTimeout(refreshStatus, 320);
}

async function refreshStatus() {
  if (!hasChrome) return;
  try {
    status = await chrome.runtime.sendMessage({ type: "status" });
    refreshMeta();
  } catch {
    /* service worker restarting — keep the last known status */
  }
}

/* ------------------------------------------------------------------ */
/* Mutations                                                           */
/* ------------------------------------------------------------------ */

function addRule(overrides = {}) {
  const rule = createRule(overrides);
  state.rules.unshift(rule);
  save();
  render();

  const card = rulesEl.querySelector(`[data-rule="${CSS.escape(rule.id)}"]`);
  card?.scrollIntoView({ behavior: "smooth", block: "center" });
  requestAnimationFrame(() => {
    card?.querySelector('[data-field="pattern"]')?.focus();
  });
  return rule;
}

function addHeader(rule, section) {
  const header = createHeader();
  rule[section].push(header);
  save();
  render();

  const row = rulesEl.querySelector(
    `[data-rule="${CSS.escape(rule.id)}"] [data-section="${section}"] [data-header="${CSS.escape(header.id)}"]`,
  );
  row?.querySelector(".hkey")?.focus();
  row?.scrollIntoView({ behavior: "smooth", block: "nearest" });
}

function deleteHeader(rule, section, headerId) {
  rule[section] = rule[section].filter((header) => header.id !== headerId);
  save();
  render();
}

/* ------------------------------------------------------------------ */
/* Events                                                              */
/* ------------------------------------------------------------------ */

rulesEl.addEventListener("input", (event) => {
  const target = event.target;
  const field = target.dataset?.field;
  if (!field) return;

  const card = target.closest(".rule");
  const rule = findRule(card?.dataset.rule);
  if (!rule) return;

  if (field === "name") {
    rule.name = target.value;
    save();
    return;
  }

  if (field === "pattern") {
    rule.match.pattern = target.value;
    save();
    refreshRuleCard(card);
    return;
  }

  if (field === "key" || field === "value") {
    const row = target.closest("[data-header]");
    const section = row?.closest("[data-section]")?.dataset.section;
    const header = findHeader(rule, section, row?.dataset.header);
    if (!header) return;
    header[field] = target.value;
    save();
    refreshRuleCard(card);
  }
});

rulesEl.addEventListener("change", (event) => {
  const target = event.target;
  const field = target.dataset?.field;
  if (!field) return;

  const card = target.closest(".rule");
  const rule = findRule(card?.dataset.rule);
  if (!rule) return;

  if (field === "enabled") {
    rule.enabled = target.checked;
    save();
    render();
    return;
  }

  if (field === "mode") {
    rule.match.mode = target.value === "regex" ? "regex" : "glob";
    save();
    render();
    return;
  }

  if (field === "keyMatch" || field === "operation") {
    const row = target.closest("[data-header]");
    const section = row?.closest("[data-section]")?.dataset.section;
    const header = findHeader(rule, section, row?.dataset.header);
    if (!header) return;
    header[field] = target.value;
    save();
    render();
  }
});

rulesEl.addEventListener("click", async (event) => {
  const button = event.target.closest("[data-act]");
  if (!button) return;

  const action = button.dataset.act;
  const card = button.closest(".rule");
  const rule = findRule(card?.dataset.rule);
  if (!rule) return;

  if (action === "collapse") {
    rule.collapsed = !rule.collapsed;
    save();
    render();
    return;
  }

  if (action === "add-header") {
    addHeader(rule, button.dataset.section === "responseHeaders" ? "responseHeaders" : "requestHeaders");
    return;
  }

  if (action === "delete-header") {
    const row = button.closest("[data-header]");
    const section = row?.closest("[data-section]")?.dataset.section;
    if (section) deleteHeader(rule, section, row.dataset.header);
    return;
  }

  if (action === "duplicate") {
    const copy = structuredClone(rule);
    copy.id = crypto.randomUUID();
    copy.name = `${rule.name} copy`;
    copy.requestHeaders = copy.requestHeaders.map((header) => ({ ...header, id: crypto.randomUUID() }));
    copy.responseHeaders = copy.responseHeaders.map((header) => ({ ...header, id: crypto.randomUUID() }));
    const index = state.rules.findIndex((candidate) => candidate.id === rule.id);
    state.rules.splice(index + 1, 0, copy);
    save();
    render();
    toast("Rule duplicated");
    return;
  }

  if (action === "delete") {
    const name = rule.name || "this rule";
    if (!confirm(`Delete “${name}”?`)) return;
    state.rules = state.rules.filter((candidate) => candidate.id !== rule.id);
    save();
    render();
    toast("Rule deleted");
  }
});

document.getElementById("add-rule").addEventListener("click", () => addRule());

masterToggle.addEventListener("change", () => {
  state.enabled = masterToggle.checked;
  save();
  render();
  toast(state.enabled ? "Rules enabled" : "All rules paused");
});

advancedToggle.addEventListener("change", () => {
  state.advancedEngine = advancedToggle.checked;
  save();
  render();
  toast(state.advancedEngine ? "Advanced key matching enabled" : "Advanced key matching disabled");
});

document.getElementById("export-btn").addEventListener("click", () => {
  const payload = {
    app: "header-forge",
    version: 1,
    exportedAt: new Date().toISOString(),
    state,
  };
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  const stamp = new Date().toISOString().slice(0, 10);
  anchor.href = url;
  anchor.download = `header-forge-${stamp}.json`;
  anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  toast("Rules exported");
});

document.getElementById("import-btn").addEventListener("click", () => {
  importFile.value = "";
  importFile.click();
});

importFile.addEventListener("change", async () => {
  const file = importFile.files?.[0];
  if (!file) return;

  try {
    const text = await file.text();
    const parsed = JSON.parse(text);
    const incoming = sanitizeState(parsed?.state ?? parsed);

    if (!incoming.rules.length) {
      toast("That file has no rules", "error");
      return;
    }

    if (
      state.rules.length > 0 &&
      !confirm(
        `Replace your ${state.rules.length} existing rule(s) with ${incoming.rules.length} imported rule(s)?`,
      )
    ) {
      return;
    }

    state = incoming;
    save({ immediate: true });
    render();
    toast(`Imported ${incoming.rules.length} rule(s)`);
  } catch (error) {
    toast(`Import failed: ${error.message}`, "error");
  }
});

/* ------------------------------------------------------------------ */
/* Boot                                                                */
/* ------------------------------------------------------------------ */

async function init() {
  if (hasChrome) {
    try {
      const stored = await chrome.storage.local.get(STORAGE_KEY);
      if (stored?.[STORAGE_KEY] === undefined) {
        await chrome.storage.local.set({ [STORAGE_KEY]: state });
      } else {
        state = sanitizeState(stored[STORAGE_KEY]);
      }
    } catch (error) {
      toast(`Could not load rules: ${error.message}`, "error");
    }
  }

  render();
  refreshStatus();
  setInterval(refreshStatus, 5000);
}

init();
