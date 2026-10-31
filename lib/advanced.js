/**
 * Header Forge — optional "advanced key matching" engine.
 *
 * declarativeNetRequest can only modify headers with literal names. To support
 * wildcard / regex header keys we attach Chrome's debugger to tabs and use the
 * CDP Fetch domain, which lets us rewrite arbitrary request/response headers.
 *
 * This is opt-in because Chrome displays a "debugging this browser" banner on
 * attached tabs.
 */

import {
  applyHeaderOps,
  hasAdvancedKeys,
  isHttpUrl,
  isResponsePause,
  urlMatchesRule,
} from "./core.js";

const PROTOCOL_VERSION = "1.3";

const FETCH_PATTERNS = [
  { urlPattern: "*", requestStage: "Request" },
  { urlPattern: "*", requestStage: "Response" },
];

export class AdvancedEngine {
  constructor(getState) {
    this.getState = getState;
    this.attached = new Set();
    this.pending = new Map();
    this.lastError = "";
    this.bound = false;
    this.bind();
  }

  get attachedCount() {
    return this.attached.size;
  }

  bind() {
    if (this.bound) return;
    this.bound = true;

    chrome.debugger.onEvent.addListener((source, method, params) => {
      if (source.tabId == null) return;
      this.handleEvent(source.tabId, method, params).catch((error) => {
        this.lastError = error?.message || String(error);
      });
    });

    chrome.debugger.onDetach.addListener((source, reason) => {
      if (source.tabId == null) return;
      this.attached.delete(source.tabId);
      if (reason && reason !== "target_closed") {
        this.lastError = `Debugger detached: ${reason}`;
      }
    });

    chrome.tabs.onRemoved.addListener((tabId) => {
      this.attached.delete(tabId);
      this.pending.delete(tabId);
    });

    chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
      if (!changeInfo.url) return;
      if (!this.getState()?.advancedEngine) return;
      if (isHttpUrl(tab.url)) this.attachTab(tabId).catch(() => {});
      else this.detachTab(tabId).catch(() => {});
    });

    chrome.tabs.onCreated.addListener((tab) => {
      if (!this.getState()?.advancedEngine) return;
      if (isHttpUrl(tab.url) && tab.id != null) this.attachTab(tab.id).catch(() => {});
    });
  }

  /** Attach / detach every tab so the current setting is respected. */
  async sync() {
    const state = this.getState();
    if (!state?.advancedEngine) {
      await this.detachAll();
      return;
    }

    let tabs = [];
    try {
      tabs = await chrome.tabs.query({});
    } catch {
      return;
    }

    const keep = new Set();
    for (const tab of tabs) {
      if (tab.id == null || tab.id < 0) continue;
      if (!isHttpUrl(tab.url)) continue;
      keep.add(tab.id);
      if (!this.attached.has(tab.id) && !this.pending.has(tab.id)) {
        this.attachTab(tab.id).catch(() => {});
      }
    }

    for (const tabId of [...this.attached]) {
      if (!keep.has(tabId)) {
        this.detachTab(tabId).catch(() => {});
      }
    }
  }

  async attachTab(tabId) {
    if (this.attached.has(tabId)) return;
    if (this.pending.has(tabId)) return this.pending.get(tabId);

    const promise = (async () => {
      let attachedHere = false;
      try {
        await chrome.debugger.attach({ tabId }, PROTOCOL_VERSION);
        attachedHere = true;
      } catch (error) {
        const message = String(error?.message || error);
        // After a service-worker restart the session may still be ours.
        if (!/already attached/i.test(message)) {
          this.lastError = message;
          throw error;
        }
      }

      try {
        await chrome.debugger.sendCommand({ tabId }, "Fetch.enable", {
          patterns: FETCH_PATTERNS,
        });
        this.attached.add(tabId);
        this.lastError = "";
      } catch (error) {
        this.lastError = String(error?.message || error);
        if (attachedHere) {
          try {
            await chrome.debugger.detach({ tabId });
          } catch {
            /* already gone */
          }
        }
        throw error;
      }
    })();

    this.pending.set(tabId, promise);
    try {
      await promise;
    } finally {
      this.pending.delete(tabId);
    }
  }

  async detachTab(tabId) {
    if (!this.attached.has(tabId)) return;
    this.attached.delete(tabId);
    try {
      await chrome.debugger.detach({ tabId });
    } catch {
      /* already detached */
    }
  }

  async detachAll() {
    for (const tabId of [...this.attached]) {
      await this.detachTab(tabId);
    }
  }

  async handleEvent(tabId, method, params) {
    if (method !== "Fetch.requestPaused") return;

    const state = this.getState();
    // Chrome 156 doesn't always populate requestStage, so fall back to the
    // presence of response fields to tell the two pause points apart.
    const isRequest = !isResponsePause(params);

    const continueUnchanged = () => this.continueUnmodified(tabId, params, isRequest);

    if (!state?.enabled || !state.advancedEngine) {
      return continueUnchanged();
    }

    const url = params.request?.url || "";
    const matchingRules = (state.rules || []).filter(
      (rule) =>
        rule.enabled &&
        hasAdvancedKeys(rule) &&
        urlMatchesRule(url, rule.match),
    );

    if (matchingRules.length === 0) return continueUnchanged();

    const operations = [];
    for (const rule of matchingRules) {
      const list = isRequest ? rule.requestHeaders : rule.responseHeaders;
      for (const header of list || []) {
        if (header.key && header.keyMatch && header.keyMatch !== "exact") {
          operations.push(header);
        }
      }
    }
    if (operations.length === 0) return continueUnchanged();

    try {
      if (isRequest) {
        const headers = applyHeaderOps(headersToArray(params.request?.headers), operations);
        await this.send(tabId, "Fetch.continueRequest", {
          requestId: params.requestId,
          headers,
        });
      } else {
        // CDP requires status and headers to be overridden together.
        if (typeof params.responseStatusCode !== "number") {
          return continueUnchanged();
        }
        const headers = applyHeaderOps(params.responseHeaders || [], operations);
        const command = {
          requestId: params.requestId,
          responseCode: params.responseStatusCode,
          responseHeaders: headers,
        };
        if (params.responseStatusText) {
          command.responsePhrase = params.responseStatusText;
        }
        await this.send(tabId, "Fetch.continueResponse", command);
      }
    } catch (error) {
      this.lastError = String(error?.message || error);
      // Never leave a request hanging because a header was rejected.
      await continueUnchanged().catch(() => {});
      // A failed header rewrite usually means the tab is in a bad state.
      await this.detachTab(tabId);
    }
  }

  async continueUnmodified(tabId, params, isRequest) {
    // Passing only requestId leaves status and headers untouched. Supplying
    // just one of responseCode / responseHeaders makes CDP reject the call.
    await this.send(
      tabId,
      isRequest ? "Fetch.continueRequest" : "Fetch.continueResponse",
      { requestId: params.requestId },
    );
  }

  send(tabId, method, params) {
    return chrome.debugger.sendCommand({ tabId }, method, params);
  }
}

function headersToArray(headers) {
  if (!headers) return [];
  if (Array.isArray(headers)) return headers.map((header) => ({ ...header }));
  return Object.entries(headers).map(([name, value]) => ({ name, value: String(value) }));
}
