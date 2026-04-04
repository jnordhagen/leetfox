// content-neetcode.js — NeetCode DOM Scraper

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
    source: "neetcode",
  };

  // --- Title ---
  // NeetCode Angular pages: try h1 first, then page <title>, then URL slug
  const h1 = document.querySelector("h1");
  if (h1) {
    const text = h1.textContent.trim();
    if (text && text.length < 120) data.title = text;
  }
  if (!data.title) {
    const titleTag = document.querySelector("title");
    if (titleTag) {
      // Typical format: "Problem Name - NeetCode" or "NeetCode - Problem Name"
      const raw = titleTag.textContent
        .replace(/[-|]\s*NeetCode\s*$/i, "")
        .replace(/^NeetCode\s*[-|]\s*/i, "")
        .trim();
      if (raw && raw.toLowerCase() !== "neetcode") data.title = raw;
    }
  }
  if (!data.title) {
    const match = location.pathname.match(/\/problems\/([^/]+)/);
    if (match) data.title = slugToTitle(match[1]);
  }

  // --- Difficulty ---
  const difficulties = ["Easy", "Medium", "Hard"];
  for (const el of document.querySelectorAll("span, div, button, p")) {
    const rect = el.getBoundingClientRect();
    if (rect.top > 600) continue;
    const text = el.textContent.trim();
    if (difficulties.includes(text)) {
      data.difficulty = text;
      break;
    }
  }

  // --- Description ---
  // NeetCode renders problem descriptions in a prose/markdown section.
  // Try known Angular component patterns, then fall back to heuristics.
  const descSelectors = [
    "[class*='description']",
    "[class*='problem-detail']",
    "[class*='problem-content']",
    "[class*='markdown']",
    "[class*='prose']",
    "article",
  ];
  for (const sel of descSelectors) {
    const el = document.querySelector(sel);
    if (el) {
      const text = (el.innerText || "").trim();
      if (text.length > 80) {
        data.description = text;
        break;
      }
    }
  }
  // Broader fallback: find the longest substantial <div> or <section>
  if (!data.description) {
    let best = null;
    for (const el of document.querySelectorAll("div, section")) {
      const text = el.innerText || "";
      if (text.length > 150 && (!best || text.length > best.length)) {
        // Skip containers that include nav/sidebar noise
        const tag = el.tagName.toLowerCase();
        if (tag === "body" || tag === "html") continue;
        best = text;
      }
    }
    if (best) data.description = best.trim().slice(0, 3000);
  }

  // --- Tags ---
  const tagCandidates = document.querySelectorAll(
    "a[href*='/tag/'], a[href*='/topics/'], [class*='tag'], [class*='topic'], [class*='chip']"
  );
  const tagSet = new Set();
  for (const el of tagCandidates) {
    const text = el.textContent.trim();
    if (text && text.length < 40) tagSet.add(text);
  }
  data.tags = Array.from(tagSet);

  return data;
}

function isCompleteEnough(data) {
  return !!(data.title && data.description);
}

// --- Messaging ---

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

observer = new MutationObserver(() => {
  attemptScrape();
});

observer.observe(document.body, { subtree: true, childList: true });

timeoutId = setTimeout(() => {
  if (!scrapeComplete) {
    const data = scrapeProblem();
    sendData(data);
  }
}, 10000);

attemptScrape();

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === "GET_PROBLEM_DATA") {
    const data = scrapeProblem();
    sendResponse({ type: "PROBLEM_DATA", data });
    return false;
  }
});
