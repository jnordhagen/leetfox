// background.js — Service Worker

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
      const tabId = tabs[0].id;
      chrome.tabs.sendMessage(tabId, { type: "GET_PROBLEM_DATA" }, (response) => {
        if (chrome.runtime.lastError) {
          // Content script not injected on this tab (not a LeetCode problem page)
          sendResponse(null);
        } else {
          sendResponse(response);
        }
      });
    });
    // Return true to keep the message channel open for async sendResponse
    return true;
  }
});
