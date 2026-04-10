// background.js — Service Worker

const NOTION_API_BASE = "https://api.notion.com/v1";
const NOTION_VERSION = "2022-06-28";

function cleanNotionDbId(id) {
  // Strip query params Notion appends to shared URLs (e.g. ?v=<view-id>)
  return (id || "").split("?")[0].trim();
}

// Open side panel on extension icon click
chrome.action.onClicked.addListener((tab) => {
  chrome.sidePanel.open({ tabId: tab.id });
});

// Message brokering between content script and side panel
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  // Content script → Side panel (push)
  if (message.type === "PROBLEM_DATA") {
    // Forward to all extension pages (side panel listens here)
    chrome.runtime.sendMessage(message).catch(() => {
      // Side panel may not be open — ignore
    });
    return false;
  }

  // Side panel → Content script (pull)
  if (message.type === "GET_PROBLEM_DATA") {
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      if (!tabs.length) {
        sendResponse(null);
        return;
      }
      const tab = tabs[0];
      const tabId = tab.id;
      const url = tab.url || "";
      const isLC = url.includes("leetcode.com/problems/");
      const isNC = url.includes("neetcode.io/problems/");

      chrome.tabs.sendMessage(tabId, { type: "GET_PROBLEM_DATA" }, (response) => {
        if (!chrome.runtime.lastError) {
          sendResponse(response);
          return;
        }
        // Content script not responding — inject it programmatically (handles
        // tabs that were already open before the extension loaded).
        if (!isLC && !isNC) {
          sendResponse(null);
          return;
        }
        const file = isLC ? "content.js" : "content-neetcode.js";
        chrome.scripting.executeScript({ target: { tabId }, files: [file] }, () => {
          if (chrome.runtime.lastError) {
            sendResponse(null);
            return;
          }
          chrome.tabs.sendMessage(tabId, { type: "GET_PROBLEM_DATA" }, (response2) => {
            if (chrome.runtime.lastError) {
              sendResponse(null);
            } else {
              sendResponse(response2);
            }
          });
        });
      });
    });
    // Return true to keep the message channel open for async sendResponse
    return true;
  }

  if (message.type === "GET_PAGE_THEME") {
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      const tab = tabs?.[0];
      if (!tab) { sendResponse({ theme: null }); return; }
      const url = tab.url || "";
      if (!url.includes("leetcode.com") && !url.includes("neetcode.io")) {
        sendResponse({ theme: null }); return;
      }
      chrome.scripting.executeScript(
        {
          target: { tabId: tab.id },
          func: () => {
            const html = document.documentElement;
            if (html.classList.contains("dark")) return "dark";
            if (html.classList.contains("light")) return "light";
            const dt = html.getAttribute("data-theme") || html.getAttribute("data-color-scheme");
            if (dt === "dark" || dt === "light") return dt;
            // Luminance fallback
            const bg = getComputedStyle(html).backgroundColor;
            const m = bg.match(/\d+/g);
            if (m) {
              const [r, g, b] = m.map(Number);
              return (0.299 * r + 0.587 * g + 0.114 * b) < 128 ? "dark" : "light";
            }
            return null;
          },
        },
        (results) => {
          if (chrome.runtime.lastError || !results?.[0]) {
            sendResponse({ theme: null });
          } else {
            sendResponse({ theme: results[0].result });
          }
        }
      );
    });
    return true;
  }

  if (message.type === "NOTION_VALIDATE") {
    fetch(`${NOTION_API_BASE}/databases/${cleanNotionDbId(message.notionDbId)}`, {
      headers: {
        Authorization: `Bearer ${message.notionToken}`,
        "Notion-Version": NOTION_VERSION,
      },
    })
      .then((r) => r.json().then((data) => ({ ok: r.ok, data })))
      .then(({ ok, data }) => sendResponse({ ok, data }))
      .catch((err) => sendResponse({ ok: false, error: err.message }));
    return true;
  }

  if (message.type === "NOTION_CREATE_PAGE") {
    const payload = {
      ...message.payload,
      parent: { database_id: cleanNotionDbId(message.payload.parent.database_id) },
    };
    fetch(`${NOTION_API_BASE}/pages`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${message.notionToken}`,
        "Content-Type": "application/json",
        "Notion-Version": NOTION_VERSION,
      },
      body: JSON.stringify(payload),
    })
      .then((r) => r.json().then((data) => ({ ok: r.ok, data })))
      .then(({ ok, data }) => sendResponse({ ok, data }))
      .catch((err) => sendResponse({ ok: false, error: err.message }));
    return true;
  }
});
