import { parseAnthropicStream } from "./stream.js";

// ---------- Constants ----------

const ANTHROPIC_API = "https://api.anthropic.com/v1/messages";
const NOTION_API_BASE = "https://api.notion.com/v1";
const NOTION_VERSION = "2022-06-28";
const MODEL = "claude-sonnet-4-6";
const MAX_TOKENS = 1024;

const TAG_REGEX = /\[(HINT|PATTERN:\s*[^\]]+)\]/g;

const DB_SCHEMA = {
  "Problem":         "title",
  "LC #":            "number",
  "Type":            "select",
  "Pattern":         "multi_select",
  "Difficulty":      "select",
  "Last Result":     "select",
  "Last Done":       "date",
  "Interval (days)": "number",
  "Times Reviewed":  "number",
  "Notes":           "rich_text",
};

const RESULT_LABELS = {
  clean:  "Clean 🟢",
  hints:  "Hints 🟡",
  failed: "Failed 🔴",
};

// ---------- State ----------

const DEFAULT_STATE = {
  problem: null,
  messages: [],
  displayMessages: [],
  startTime: null,
  hintCount: 0,
  detectedPatterns: [],
  sessionActive: false,
  sessionComplete: false,
  result: null,
  summary: null,
  schemaValidated: false,
};

let state = { ...DEFAULT_STATE };

// ---------- Persistence ----------

async function saveState() {
  await chrome.storage.session.set({ coachState: state });
}

async function loadState() {
  const stored = await chrome.storage.session.get("coachState");
  if (stored.coachState) {
    state = { ...DEFAULT_STATE, ...stored.coachState };
  }
}

// ---------- Markdown Renderer ----------

function renderMarkdown(text) {
  // Fenced code blocks
  text = text.replace(/```(\w*)\n?([\s\S]*?)```/g, (_, lang, code) => {
    return `<pre><code>${escapeHtml(code.trim())}</code></pre>`;
  });
  // Inline code
  text = text.replace(/`([^`\n]+)`/g, (_, code) => `<code>${escapeHtml(code)}</code>`);
  // Bold
  text = text.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
  // Line breaks / paragraphs
  text = text
    .split("\n\n")
    .map((para) => `<p>${para.replace(/\n/g, "<br>")}</p>`)
    .join("");
  return text;
}

function escapeHtml(str) {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

// ---------- System Prompt ----------

function buildSystemPrompt(problem) {
  const tagsStr = (problem.tags || []).join(", ") || "none";
  const site = problem.source === "neetcode" ? "NeetCode" : "LeetCode";
  return `You are a Socratic DSA interview coach. The user is practicing on ${site}.

Problem context:
- Title: ${problem.title}
- Difficulty: ${problem.difficulty || "Unknown"}
- Description: ${problem.description || "Not available"}
- Tags: ${tagsStr}

Your role:
- Never give away the solution or name the algorithm directly unless the user has been stuck for many exchanges
- Ask questions that guide the user toward the insight (e.g. "What's the bottleneck in your current approach?", "What data structure would let you look that up in O(1)?")
- If the user is on the right track, affirm it and push them to the next step
- If the user is going in the wrong direction, ask a question that reveals the flaw without stating it
- Keep responses concise — this is a coaching session, not a lecture
- When the user has the correct approach and has coded it, ask about time and space complexity
- Use code blocks sparingly and only when the user asks to see something specific

Self-tagging rules (IMPORTANT — follow these exactly):
- When you give a substantive hint that meaningfully narrows the solution space (not just a generic guiding question, but something that reveals a key constraint, data structure choice, or algorithmic direction), include [HINT] at the very beginning of your message.
- When you introduce, confirm, or discuss a specific algorithmic pattern or technique, include [PATTERN: <name>] at the beginning of your message. Use lowercase canonical names: "sliding window", "two pointers", "bfs", "dfs", "dynamic programming", "backtracking", "binary search", "heap", "trie", "union find", "topological sort", "monotonic stack", "greedy", "divide and conquer".
- A message can have both tags. Example: "[HINT][PATTERN: sliding window] What if you maintained..."
- Most of your messages should have NO tags. Only tag when genuinely narrowing the search space.

Start by asking the user what their initial thoughts are on the problem.`;
}

// ---------- API Calls ----------

async function getStoredKeys() {
  return chrome.storage.local.get(["anthropicKey", "notionToken", "notionDbId", "intervalClean", "intervalHints", "intervalFailed"]);
}

async function callAnthropicStream(messages, systemPrompt, onDelta, onComplete, onError) {
  const { anthropicKey } = await getStoredKeys();
  if (!anthropicKey) {
    onError(new Error("NO_API_KEY"));
    return;
  }

  let response;
  try {
    response = await fetch(ANTHROPIC_API, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": anthropicKey,
        "anthropic-version": "2023-06-01",
        "anthropic-dangerous-direct-browser-access": "true",
      },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: MAX_TOKENS,
        system: systemPrompt,
        messages,
        stream: true,
      }),
    });
  } catch (err) {
    onError(err);
    return;
  }

  if (!response.ok) {
    let errMsg = `API error ${response.status}`;
    try {
      const body = await response.json();
      errMsg = body.error?.message || errMsg;
    } catch (_) {}
    if (response.status === 401) errMsg = "Invalid API key — check Settings.";
    if (response.status === 429) errMsg = "Rate limited — wait a moment and try again.";
    onError(new Error(errMsg));
    return;
  }

  await parseAnthropicStream(response, onDelta, onComplete, onError);
}

async function callAnthropicOnce(messages, systemPrompt) {
  const { anthropicKey } = await getStoredKeys();
  if (!anthropicKey) throw new Error("NO_API_KEY");

  const response = await fetch(ANTHROPIC_API, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": anthropicKey,
      "anthropic-version": "2023-06-01",
      "anthropic-dangerous-direct-browser-access": "true",
    },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: 512,
      system: systemPrompt,
      messages,
    }),
  });

  if (!response.ok) throw new Error(`API error ${response.status}`);
  const data = await response.json();
  return data.content?.[0]?.text || "";
}

// ---------- Tag Processing ----------

function processAssistantText(rawText) {
  // Extract tags before stripping
  const hintMatches = rawText.match(/\[HINT\]/g) || [];
  const patternMatches = [...rawText.matchAll(/\[PATTERN:\s*([^\]]+)\]/g)];

  const newHints = hintMatches.length;
  const newPatterns = patternMatches.map((m) => m[1].trim().toLowerCase());

  // Strip tags from display text
  const displayText = rawText.replace(TAG_REGEX, "").trim();

  return { displayText, newHints, newPatterns };
}

// ---------- DOM Helpers ----------

function showState(id) {
  document.querySelectorAll(".state").forEach((el) => el.classList.remove("active"));
  const el = document.getElementById(id);
  if (el) el.classList.add("active");
}

function setHidden(id, hidden) {
  document.getElementById(id)?.classList.toggle("hidden", hidden);
}

function difficultyClass(diff) {
  if (!diff) return "";
  return diff.toLowerCase(); // "easy" | "medium" | "hard"
}

function renderDifficultyBadge(el, difficulty) {
  if (!el) return;
  el.textContent = difficulty || "";
  el.className = "difficulty-badge " + difficultyClass(difficulty);
}

function renderTagChips(container, tags) {
  if (!container) return;
  container.innerHTML = "";
  (tags || []).slice(0, 5).forEach((tag) => {
    const span = document.createElement("span");
    span.className = "tag-chip";
    span.textContent = tag;
    container.appendChild(span);
  });
}

function appendMessage(role, htmlContent, interrupted = false) {
  const messages = document.getElementById("messages");
  const wrapper = document.createElement("div");
  wrapper.className = `message ${role}`;

  const bubble = document.createElement("div");
  bubble.className = "message-bubble";
  bubble.innerHTML = htmlContent;
  wrapper.appendChild(bubble);

  if (interrupted) {
    const indicator = document.createElement("div");
    indicator.className = "interrupted-indicator";
    indicator.textContent = "(response interrupted)";
    wrapper.appendChild(indicator);
  }

  messages.appendChild(wrapper);
  messages.scrollTop = messages.scrollHeight;
  return bubble;
}

function appendThinkingIndicator() {
  const messages = document.getElementById("messages");
  const wrapper = document.createElement("div");
  wrapper.className = "message assistant";
  wrapper.id = "thinking-indicator";

  const bubble = document.createElement("div");
  bubble.className = "message-bubble thinking";
  bubble.innerHTML = `<div class="thinking-dot"></div><div class="thinking-dot"></div><div class="thinking-dot"></div>`;
  wrapper.appendChild(bubble);
  messages.appendChild(wrapper);
  messages.scrollTop = messages.scrollHeight;
  return wrapper;
}

function removeThinkingIndicator() {
  document.getElementById("thinking-indicator")?.remove();
}

function showBanner(type, html) {
  const banner = document.getElementById("no-key-banner");
  banner.className = `banner ${type}`;
  banner.innerHTML = html;
  banner.classList.remove("hidden");
}

function hideBanner() {
  document.getElementById("no-key-banner")?.classList.add("hidden");
}

// ---------- Problem Display ----------

function applyProblemToUI(problem) {
  // State 2
  const readyTitle = document.getElementById("ready-title");
  if (readyTitle) readyTitle.textContent = problem.title || "Unknown Problem";

  renderDifficultyBadge(document.getElementById("ready-difficulty-badge"), problem.difficulty);
  renderTagChips(document.getElementById("ready-tags"), problem.tags);

  // State 3 header
  const chatTitle = document.getElementById("chat-problem-title");
  if (chatTitle) chatTitle.textContent = problem.title || "Unknown Problem";
  renderDifficultyBadge(document.getElementById("chat-difficulty-badge"), problem.difficulty);
  renderTagChips(document.getElementById("chat-tags"), problem.tags);

  // Session header
  const headerTitle = document.getElementById("header-problem-title");
  if (headerTitle) {
    const num = problem.lcNumber ? `#${problem.lcNumber} ` : "";
    headerTitle.textContent = num + (problem.title || "DSA Coach");
  }
}

// ---------- Session Start ----------

async function startSession() {
  if (!state.problem) return;

  state = {
    ...DEFAULT_STATE,
    problem: state.problem,
    sessionActive: true,
    startTime: Date.now(),
    messages: [],
    displayMessages: [],
  };

  setHidden("session-header", false);
  showState("state-chat");
  document.getElementById("messages").innerHTML = "";

  const systemPrompt = buildSystemPrompt(state.problem);
  const primingMessage = { role: "user", content: "I'm ready to start." };
  state.messages.push(primingMessage);

  await saveState();

  // Stream opening assistant message
  await streamAssistantReply(systemPrompt);
}

// ---------- Streaming Reply ----------

async function streamAssistantReply(systemPrompt) {
  const thinkingEl = appendThinkingIndicator();
  let bubble = null;
  let rawText = "";
  let interrupted = false;
  let completed = false;

  setSendDisabled(true);

  await callAnthropicStream(
    state.messages,
    systemPrompt || buildSystemPrompt(state.problem),
    (delta) => {
      rawText += delta;
      if (!bubble) {
        removeThinkingIndicator();
        bubble = appendMessage("assistant", "");
      }
      // Render partial markdown (strip tags for display)
      const displayText = rawText.replace(TAG_REGEX, "").trim();
      bubble.innerHTML = renderMarkdown(displayText);
      document.getElementById("messages").scrollTop = document.getElementById("messages").scrollHeight;
    },
    async () => {
      completed = true;
      removeThinkingIndicator();
      if (!bubble) bubble = appendMessage("assistant", "");

      const { displayText, newHints, newPatterns } = processAssistantText(rawText);
      bubble.innerHTML = renderMarkdown(displayText);

      // Update state
      state.messages.push({ role: "assistant", content: rawText });
      state.displayMessages.push({ role: "assistant", content: displayText });
      state.hintCount += newHints;
      newPatterns.forEach((p) => {
        if (!state.detectedPatterns.includes(p)) state.detectedPatterns.push(p);
      });

      await saveState();
      setSendDisabled(false);
    },
    async (err) => {
      removeThinkingIndicator();
      if (err.message === "NO_API_KEY") {
        showBanner("error", `Add your API key in <a id="settings-link" href="#">Settings</a>`);
        bindSettingsLink();
        setSendDisabled(false);
        return;
      }
      if (rawText) {
        // Partial response received
        interrupted = true;
        if (!bubble) bubble = appendMessage("assistant", "");
        const { displayText } = processAssistantText(rawText);
        bubble.innerHTML = renderMarkdown(displayText);
        // Add interrupted indicator
        const indicator = document.createElement("div");
        indicator.className = "interrupted-indicator";
        indicator.textContent = "(response interrupted)";
        bubble.parentElement?.appendChild(indicator);

        state.messages.push({ role: "assistant", content: rawText });
        state.displayMessages.push({ role: "assistant", content: rawText.replace(TAG_REGEX, "").trim() });
        await saveState();
      } else {
        appendMessage("assistant", `<span style="color:var(--hard)">Error: ${escapeHtml(err.message)}</span>`);
      }
      setSendDisabled(false);
    }
  );
}

// ---------- Send Message ----------

async function sendMessage() {
  const input = document.getElementById("chat-input");
  const text = input.value.trim();
  if (!text || !state.sessionActive) return;

  input.value = "";
  input.style.height = "36px";

  appendMessage("user", escapeHtml(text).replace(/\n/g, "<br>"));
  state.messages.push({ role: "user", content: text });
  state.displayMessages.push({ role: "user", content: text });
  await saveState();

  await streamAssistantReply();
}

function setSendDisabled(disabled) {
  const btn = document.getElementById("send-btn");
  const input = document.getElementById("chat-input");
  if (btn) btn.disabled = disabled;
  if (input) input.disabled = disabled;
}

// ---------- End Session ----------

async function endSession() {
  if (!state.sessionActive) return;
  state.sessionActive = false;
  state.sessionComplete = true;

  setHidden("end-session-btn", true);
  setHidden("session-header", false);

  // Pre-select result
  let result = "clean";
  if (state.hintCount >= 3) result = "failed";
  else if (state.hintCount >= 1) result = "hints";
  state.result = result;

  showState("state-summary");
  renderSummaryUI();
  await saveState();

  // Generate summary non-blocking
  generateSummary().then(async (summary) => {
    state.summary = summary;
    const notesEl = document.getElementById("summary-notes");
    if (notesEl) notesEl.textContent = summary || "No summary available.";
    await saveState();
  }).catch(async () => {
    state.summary = null;
    const notesEl = document.getElementById("summary-notes");
    if (notesEl) notesEl.textContent = "Summary generation failed — review conversation history.";
    await saveState();
  });
}

async function generateSummary() {
  const summaryMessages = [
    ...state.messages,
    {
      role: "user",
      content: "Summarize this session in exactly 2 sentences: (1) the key insight or technique for solving this problem, (2) any common trap or gotcha to remember.",
    },
  ];
  const systemPrompt = buildSystemPrompt(state.problem);
  return await callAnthropicOnce(summaryMessages, systemPrompt);
}

function renderSummaryUI() {
  // Duration
  const durationMs = Date.now() - state.startTime;
  const minutes = Math.floor(durationMs / 60000);
  const seconds = Math.floor((durationMs % 60000) / 1000);
  document.getElementById("summary-duration").textContent =
    minutes > 0 ? `${minutes}m ${seconds}s` : `${seconds}s`;

  document.getElementById("summary-hints").textContent = state.hintCount;

  // Patterns
  const patternList = document.getElementById("summary-patterns");
  patternList.innerHTML = "";
  if (state.detectedPatterns.length) {
    state.detectedPatterns.forEach((p) => {
      const chip = document.createElement("span");
      chip.className = "pattern-chip";
      chip.textContent = p;
      patternList.appendChild(chip);
    });
    setHidden("summary-patterns-section", false);
  } else {
    setHidden("summary-patterns-section", true);
  }

  // Result selector
  document.querySelectorAll(".result-btn").forEach((btn) => {
    btn.classList.remove("selected-clean", "selected-hints", "selected-failed");
    if (btn.dataset.result === state.result) {
      btn.classList.add(`selected-${state.result}`);
    }
  });

  // Summary text placeholder (will be updated when summary arrives)
  const notesEl = document.getElementById("summary-notes");
  if (state.summary) {
    notesEl.textContent = state.summary;
  } else {
    notesEl.textContent = "Generating summary…";
  }

  // Notion log status reset
  document.getElementById("notion-log-status").innerHTML = "";
}

// ---------- Notion Integration ----------

async function validateNotionSchema(notionToken, notionDbId) {
  const resp = await fetch(`${NOTION_API_BASE}/databases/${notionDbId}`, {
    headers: {
      Authorization: `Bearer ${notionToken}`,
      "Notion-Version": NOTION_VERSION,
    },
  });
  if (!resp.ok) {
    const body = await resp.json().catch(() => ({}));
    throw new Error(body.message || `Notion API error: ${resp.status}`);
  }
  const db = await resp.json();

  const errors = [];
  for (const [name, expectedType] of Object.entries(DB_SCHEMA)) {
    const prop = db.properties[name];
    if (!prop) {
      errors.push(`Missing property: "${name}" (expected type: ${expectedType})`);
    } else if (prop.type !== expectedType) {
      errors.push(`"${name}" has type "${prop.type}", expected "${expectedType}"`);
    }
  }
  return errors;
}

function inferType(tags) {
  const designKeywords = ["design", "system", "architecture"];
  if ((tags || []).some((t) => designKeywords.some((k) => t.toLowerCase().includes(k)))) {
    return "System Design";
  }
  return "DSA";
}

async function logToNotion() {
  const statusEl = document.getElementById("notion-log-status");
  const logBtn = document.getElementById("log-notion-btn");
  logBtn.disabled = true;
  statusEl.innerHTML = "Logging…";

  const { notionToken, notionDbId, intervalClean, intervalHints, intervalFailed } =
    await getStoredKeys();

  if (!notionToken || !notionDbId) {
    statusEl.innerHTML = `<span class="inline-error">Add your Notion token in <a href="#" id="notion-settings-link">Settings</a></span>`;
    document.getElementById("notion-settings-link")?.addEventListener("click", openSettings);
    logBtn.disabled = false;
    return;
  }

  // Schema validation (once per session)
  if (!state.schemaValidated) {
    try {
      const errors = await validateNotionSchema(notionToken, notionDbId);
      if (errors.length) {
        statusEl.innerHTML = `<span class="inline-error">Database schema issues:<br>${errors.map((e) => `• ${escapeHtml(e)}`).join("<br>")}<br>Fix your Notion database and try again.</span>`;
        logBtn.disabled = false;
        return;
      }
      state.schemaValidated = true;
      await saveState();
    } catch (err) {
      statusEl.innerHTML = `<span class="inline-error">Schema validation failed: ${escapeHtml(err.message)}</span>`;
      logBtn.disabled = false;
      return;
    }
  }

  const intervals = {
    clean:  intervalClean  ?? 14,
    hints:  intervalHints  ?? 7,
    failed: intervalFailed ?? 3,
  };

  const problem = state.problem || {};
  const summaryText =
    state.summary ||
    "Session completed. Summary generation failed — review conversation history.";
  const inferredType = inferType(problem.tags);
  const computedInterval = intervals[state.result] ?? 7;
  const resultLabel = RESULT_LABELS[state.result] || RESULT_LABELS.hints;

  const payload = {
    parent: { database_id: notionDbId },
    properties: {
      Problem:          { title: [{ text: { content: problem.title || "Unknown" } }] },
      "LC #":           { number: problem.lcNumber || null },
      Type:             { select: { name: inferredType } },
      Pattern:          { multi_select: (state.detectedPatterns || []).map((p) => ({ name: p })) },
      Difficulty:       { select: { name: problem.difficulty || "Unknown" } },
      "Last Result":    { select: { name: resultLabel } },
      "Last Done":      { date: { start: new Date().toISOString().split("T")[0] } },
      "Interval (days)":{ number: computedInterval },
      "Times Reviewed": { number: 1 },
      Notes:            { rich_text: [{ text: { content: summaryText.slice(0, 2000) } }] },
    },
  };

  try {
    const resp = await fetch(`${NOTION_API_BASE}/pages`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${notionToken}`,
        "Content-Type": "application/json",
        "Notion-Version": NOTION_VERSION,
      },
      body: JSON.stringify(payload),
    });

    if (!resp.ok) {
      const body = await resp.json().catch(() => ({}));
      const errMsg = body.message || `Notion error ${resp.status}`;
      statusEl.innerHTML = `<span class="inline-error">${escapeHtml(errMsg)}<br>Use "Copy Session Data" to save your work.</span>`;
      logBtn.disabled = false;
      return;
    }

    statusEl.innerHTML = `<span class="inline-success">&#10003; Logged to Notion</span>`;
    logBtn.disabled = true;
  } catch (err) {
    statusEl.innerHTML = `<span class="inline-error">Network error: ${escapeHtml(err.message)}<br>Use "Copy Session Data" to save your work.</span>`;
    logBtn.disabled = false;
  }
}

// ---------- Copy Session Data ----------

async function copySessionData() {
  const data = {
    problem: state.problem,
    startTime: state.startTime,
    endTime: Date.now(),
    hintCount: state.hintCount,
    detectedPatterns: state.detectedPatterns,
    result: state.result,
    summary: state.summary,
    conversation: state.displayMessages,
  };
  try {
    await navigator.clipboard.writeText(JSON.stringify(data, null, 2));
    const btn = document.getElementById("copy-session-btn");
    const orig = btn.textContent;
    btn.textContent = "Copied!";
    setTimeout(() => { btn.textContent = orig; }, 2000);
  } catch (err) {
    alert("Could not copy to clipboard: " + err.message);
  }
}

// ---------- Options / Settings ----------

function openSettings() {
  chrome.runtime.openOptionsPage();
}

function bindSettingsLink() {
  document.getElementById("settings-link")?.addEventListener("click", (e) => {
    e.preventDefault();
    openSettings();
  });
}

// ---------- Restore UI from State ----------

function restoreChatUI() {
  const messages = document.getElementById("messages");
  messages.innerHTML = "";
  for (const msg of state.displayMessages) {
    if (msg.role === "user") {
      appendMessage("user", escapeHtml(msg.content).replace(/\n/g, "<br>"));
    } else {
      appendMessage("assistant", renderMarkdown(msg.content));
    }
  }
}

// ---------- Initialization ----------

async function init() {
  await loadState();

  // Check for API key
  const { anthropicKey } = await getStoredKeys();
  if (!anthropicKey) {
    showBanner(
      "error",
      `Add your API key in <a id="settings-link" href="#">Settings</a>`
    );
    bindSettingsLink();
  } else {
    hideBanner();
  }

  // Restore session state if active
  if (state.sessionComplete) {
    setHidden("session-header", false);
    setHidden("end-session-btn", true);
    showState("state-summary");
    renderSummaryUI();
    return;
  }

  if (state.sessionActive) {
    applyProblemToUI(state.problem);
    setHidden("session-header", false);
    showState("state-chat");
    restoreChatUI();
    return;
  }

  // Try to get problem data
  showState("state-loading");
  document.getElementById("loading-message").textContent = "Reading problem…";

  chrome.runtime.sendMessage({ type: "GET_PROBLEM_DATA" }, (response) => {
    if (chrome.runtime.lastError || !response) {
      handleNoProblem();
      return;
    }
    const data = response.data || response;
    if (!data || !data.title) {
      handleNoProblem();
      return;
    }
    handleProblemData(data);
  });
}

function handleProblemData(data) {
  state.problem = data;
  applyProblemToUI(data);
  showState("state-ready");
}

function handleNoProblem() {
  document.getElementById("loading-message").textContent = "Couldn't read problem data";
  document.getElementById("manual-entry").classList.add("visible");
  document.getElementById("loading-message").style.marginBottom = "8px";
}

// ---------- Event Listeners ----------

// Listen for pushed PROBLEM_DATA from content script
chrome.runtime.onMessage.addListener((message) => {
  if (message.type === "PROBLEM_DATA" && !state.sessionActive && !state.sessionComplete) {
    handleProblemData(message.data);
  }
});

document.addEventListener("DOMContentLoaded", () => {
  // Start session
  document.getElementById("start-session-btn")?.addEventListener("click", startSession);

  // End session
  document.getElementById("end-session-btn")?.addEventListener("click", endSession);

  // Send message
  document.getElementById("send-btn")?.addEventListener("click", sendMessage);

  // Chat input keyboard
  document.getElementById("chat-input")?.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      sendMessage();
    }
  });

  // Auto-resize textarea
  document.getElementById("chat-input")?.addEventListener("input", (e) => {
    const el = e.target;
    el.style.height = "36px";
    el.style.height = Math.min(el.scrollHeight, 120) + "px";
  });

  // Result selector
  document.querySelectorAll(".result-btn").forEach((btn) => {
    btn.addEventListener("click", async () => {
      state.result = btn.dataset.result;
      document.querySelectorAll(".result-btn").forEach((b) => {
        b.classList.remove("selected-clean", "selected-hints", "selected-failed");
      });
      btn.classList.add(`selected-${state.result}`);
      await saveState();
    });
  });

  // Log to Notion
  document.getElementById("log-notion-btn")?.addEventListener("click", logToNotion);

  // Copy session data
  document.getElementById("copy-session-btn")?.addEventListener("click", copySessionData);

  // New session
  document.getElementById("new-session-btn")?.addEventListener("click", async () => {
    state = { ...DEFAULT_STATE };
    await chrome.storage.session.remove("coachState");
    setHidden("session-header", true);
    hideBanner();
    init();
  });

  // Manual start
  document.getElementById("manual-start-btn")?.addEventListener("click", () => {
    const title = document.getElementById("manual-title").value.trim();
    const difficulty = document.getElementById("manual-difficulty").value;
    if (!title) {
      document.getElementById("manual-title").style.borderColor = "var(--hard)";
      return;
    }
    handleProblemData({
      title,
      lcNumber: null,
      difficulty: difficulty || null,
      description: "",
      tags: [],
      scrapedAt: Date.now(),
    });
  });

  // Settings link in banner
  bindSettingsLink();

  // Run init
  init();
});
