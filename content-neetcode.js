// content-neetcode.js — NeetCode DOM Scraper

// Guard against double-injection (programmatic inject on already-loaded tabs)
if (window.__dsaCoachNC) throw new Error("DSA Coach: already loaded");
window.__dsaCoachNC = true;

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
  const h1 = document.querySelector("h1.problem-title");
  if (h1) data.title = h1.textContent.trim();
  if (!data.title) {
    const match = location.pathname.match(/\/problems\/([^/]+)/);
    if (match) data.title = slugToTitle(match[1]);
  }

  // --- Difficulty ---
  // Class is e.g. "difficulty-pill medium ng-star-inserted"
  const diffPill = document.querySelector("span[class*='difficulty-pill']");
  if (diffPill) {
    const cls = diffPill.className.toLowerCase();
    if (cls.includes("easy")) data.difficulty = "Easy";
    else if (cls.includes("medium")) data.difficulty = "Medium";
    else if (cls.includes("hard")) data.difficulty = "Hard";
  }

  // --- Description ---
  // app-article is the Angular component that renders the problem statement
  const article = document.querySelector(".tab-content-padding app-article");
  if (article) {
    data.description = (article.innerText || "").trim();
  }

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
