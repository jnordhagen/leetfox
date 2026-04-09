// content.js — LeetCode DOM Scraper

// Guard against double-injection (programmatic inject on already-loaded tabs)
if (window.__dsaCoachLC) throw new Error("DSA Coach: already loaded");
window.__dsaCoachLC = true;

let scrapeComplete = false;

function slugToTitle(slug) {
  return slug
    .split("-")
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");
}

function scrapeProblem() {
  const data = {
    title: null,
    lcNumber: null,
    difficulty: null,
    description: "",
    tags: [],
    scrapedAt: Date.now(),
  };

  // --- Title ---
  const titleEl = document.querySelector('[data-cy="question-title"]');
  if (titleEl) {
    data.title = titleEl.textContent.trim();
  }
  if (!data.title) {
    const titleTag = document.querySelector("title");
    if (titleTag) {
      const raw = titleTag.textContent.replace(" - LeetCode", "").trim();
      if (raw) data.title = raw;
    }
  }
  if (!data.title) {
    const match = location.pathname.match(/\/problems\/([^/]+)/);
    if (match) data.title = slugToTitle(match[1]);
  }

  // --- LC Number ---
  // Look for a span/div near the title containing # + digits
  const allText = document.querySelectorAll("span, div, a");
  for (const el of allText) {
    const text = el.textContent.trim();
    const m = text.match(/^#?(\d+)\.\s/);
    if (m) {
      data.lcNumber = parseInt(m[1], 10);
      break;
    }
    // Also try standalone "#123" pattern
    const m2 = text.match(/^#(\d+)$/);
    if (m2) {
      data.lcNumber = parseInt(m2[1], 10);
      break;
    }
  }

  // --- Difficulty ---
  const difficulties = ["Easy", "Medium", "Hard"];
  // Look within the first 500px of the page
  for (const el of document.querySelectorAll("span, div, button")) {
    const rect = el.getBoundingClientRect();
    if (rect.top > 500) continue;
    const text = el.textContent.trim();
    if (difficulties.includes(text)) {
      data.difficulty = text;
      break;
    }
  }

  // --- Description ---
  const descSelectors = [
    '[data-cy="question-content"]',
    '[class*="question-content"]',
    '[class*="description__"]',
    '[data-track-load="description_content"]',
    '[class*="content__"]',
  ];
  for (const sel of descSelectors) {
    const el = document.querySelector(sel);
    if (el) {
      const text = el.innerText.trim();
      if (text.length > 100) {
        data.description = text;
        break;
      }
    }
  }
  // Heuristic: find the shallowest div containing problem markers
  if (!data.description) {
    let best = null;
    for (const el of document.querySelectorAll("div")) {
      const text = el.innerText || "";
      if (
        text.length > 100 &&
        text.length < 8000 &&
        (text.includes("Example 1") || text.includes("Example:")) &&
        (text.includes("Constraints") || text.includes("Input:"))
      ) {
        if (!best || text.length < best.length) {
          best = text;
        }
      }
    }
    if (best) data.description = best.trim();
  }

  // --- Tags ---
  // Look for anchor elements or chips in the tag section
  const tagCandidates = document.querySelectorAll("a[href*='/tag/'], [class*='tag'], [class*='topic']");
  const tagSet = new Set();
  for (const el of tagCandidates) {
    const text = el.textContent.trim();
    if (text && text.length < 40) tagSet.add(text);
  }
  data.tags = Array.from(tagSet);

  return data;
}

function isCompleteEnough(data) {
  return !!(data.title && (data.description || data.lcNumber));
}

// --- MutationObserver approach ---
let observer = null;
let timeoutId = null;

function sendData(data) {
  if (scrapeComplete) return;
  scrapeComplete = true;

  if (observer) observer.disconnect();
  if (timeoutId) clearTimeout(timeoutId);

  chrome.runtime.sendMessage({ type: "PROBLEM_DATA", data });
}

function attemptScrape() {
  const data = scrapeProblem();
  if (isCompleteEnough(data)) {
    sendData(data);
  }
  return data;
}

// Start observing
observer = new MutationObserver(() => {
  attemptScrape();
});

observer.observe(document.body, { subtree: true, childList: true });

// 10-second fallback: send whatever we have
timeoutId = setTimeout(() => {
  if (!scrapeComplete) {
    const data = scrapeProblem();
    sendData(data);
  }
}, 10000);

// Initial attempt in case content is already loaded
attemptScrape();

// Respond to on-demand pull requests from the side panel (via background)
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === "GET_PROBLEM_DATA") {
    const data = scrapeProblem();
    sendResponse({ type: "PROBLEM_DATA", data });
    return false;
  }
});
