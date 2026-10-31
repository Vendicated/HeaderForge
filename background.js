/**
 * Header Forge — service worker.
 *
 * Keeps the declarativeNetRequest dynamic ruleset in sync with the dashboard
 * state and drives the optional debugger engine for wildcard/regex keys.
 */

import {
  STORAGE_KEY,
  buildDnrRules,
  hasAdvancedKeys,
  sanitizeState,
  summarizeState,
} from "./lib/core.js";
import { AdvancedEngine } from "./lib/advanced.js";

let state = sanitizeState(undefined);
let ready = null;

const status = {
  dnrRules: 0,
  advancedTabs: 0,
  problems: [],
  lastError: "",
};

const engine = new AdvancedEngine(() => state);

engine.bind();

function loadState() {
  if (ready) return ready;
  ready = (async () => {
    const stored = await chrome.storage.local.get(STORAGE_KEY);
    if (stored?.[STORAGE_KEY] === undefined) {
      state = sanitizeState(undefined);
      await chrome.storage.local.set({ [STORAGE_KEY]: state });
    } else {
      state = sanitizeState(stored[STORAGE_KEY]);
    }
    return state;
  })();
  return ready;
}

async function syncAll() {
  await loadState();

  const { rules, problems, meta } = buildDnrRules(state);
  const accepted = [];

  for (const rule of rules) {
    if (!rule.condition.regexFilter) {
      accepted.push(rule);
      continue;
    }
    try {
      const result = await chrome.declarativeNetRequest.isRegexSupported({
        regex: rule.condition.regexFilter,
        isCaseSensitive: rule.condition.isUrlFilterCaseSensitive === true,
      });
      if (result.isSupported) {
        accepted.push(rule);
      } else {
        const info = meta.get(rule.id);
        problems.push({
          ruleId: info?.ruleId || "",
          ruleName: info?.ruleName || `Rule ${rule.id}`,
          message: `Chrome rejected the URL regex${result.reason ? ` (${result.reason})` : ""}.`,
        });
      }
    } catch (error) {
      const info = meta.get(rule.id);
      problems.push({
        ruleId: info?.ruleId || "",
        ruleName: info?.ruleName || `Rule ${rule.id}`,
        message: String(error?.message || error),
      });
    }
  }

  try {
    const existing = await chrome.declarativeNetRequest.getDynamicRules();
    await chrome.declarativeNetRequest.updateDynamicRules({
      removeRuleIds: existing.map((rule) => rule.id),
      addRules: accepted,
    });
    status.dnrRules = accepted.length;
    status.lastError = "";
  } catch (error) {
    status.lastError = String(error?.message || error);
    status.dnrRules = 0;
    // A single bad rule shouldn't take the whole extension down: retry empty.
    try {
      const existing = await chrome.declarativeNetRequest.getDynamicRules();
      await chrome.declarativeNetRequest.updateDynamicRules({
        removeRuleIds: existing.map((rule) => rule.id),
      });
    } catch {
      /* ignore */
    }
  }

  status.problems = problems;

  try {
    await engine.sync();
  } catch (error) {
    status.lastError = String(error?.message || error);
  }
  status.advancedTabs = engine.attachedCount;

  await updateBadge();
}

async function updateBadge() {
  const summary = summarizeState(state);
  try {
    if (!state.enabled) {
      await chrome.action.setBadgeText({ text: "off" });
      await chrome.action.setBadgeBackgroundColor({ color: "#8b8f9e" });
      return;
    }
    await chrome.action.setBadgeBackgroundColor({ color: "#4f46e5" });
    await chrome.action.setBadgeText({
      text: summary.rules > 0 ? String(summary.rules) : "",
    });
  } catch {
    /* action may not be ready yet */
  }
}

function currentStatus() {
  return {
    ...status,
    advancedTabs: engine.attachedCount,
    lastError: status.lastError || engine.lastError,
    enabled: state.enabled,
    advancedEngine: state.advancedEngine,
    summary: summarizeState(state),
  };
}

/* ------------------------------------------------------------------ */
/* Lifecycle                                                           */
/* ------------------------------------------------------------------ */

chrome.runtime.onInstalled.addListener(() => {
  ready = null;
  syncAll();
});

chrome.runtime.onStartup.addListener(() => {
  ready = null;
  syncAll();
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "local" || !changes[STORAGE_KEY]) return;
  state = sanitizeState(changes[STORAGE_KEY].newValue);
  syncAll();
});

chrome.action.onClicked.addListener(() => {
  chrome.runtime.openOptionsPage();
});

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type === "status") {
    loadState()
      .then(() => sendResponse(currentStatus()))
      .catch((error) => sendResponse({ ...currentStatus(), lastError: String(error) }));
    return true;
  }

  if (message?.type === "resync") {
    syncAll()
      .then(() => sendResponse(currentStatus()))
      .catch((error) => sendResponse({ ...currentStatus(), lastError: String(error) }));
    return true;
  }

  if (message?.type === "open-dashboard") {
    chrome.runtime.openOptionsPage();
    sendResponse({ ok: true });
    return false;
  }

  return false;
});

// Warm up as soon as the worker starts so rules survive browser restarts even
// if the startup event was missed.
loadState()
  .then(() => syncAll())
  .catch(() => {});
