import { buildSystemPrompt } from "./prompt.js";
import { callAnthropicStream, callAnthropicOnce, getStoredKeys } from "./api.js";
import { validateNotionSchema, inferType, createNotionPage, SCORE_LABELS, SCORE_INTERVALS } from "./notion.js";

// ---------- Constants ----------

const TAG_REGEX = /\[(HINT|PATTERN:\s*[^\]]+)\]/g;

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
  score: null,
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

  showState("state-summary");
  renderSummaryUI();
  await saveState();

  // Generate summary + score non-blocking
  generateSummaryAndScore().then(async ({ score, summary }) => {
    state.score = score;
    state.summary = summary;
    const notesEl = document.getElementById("summary-notes");
    if (notesEl) notesEl.textContent = summary || "No summary available.";
    renderScoreBadge(score);
    await saveState();
  }).catch(async () => {
    state.score = null;
    state.summary = null;
    const notesEl = document.getElementById("summary-notes");
    if (notesEl) notesEl.textContent = "Summary generation failed — review conversation history.";
    renderScoreBadge(null);
    await saveState();
  });
}

async function generateSummaryAndScore() {
  const prompt = [
    "Analyze this problem-solving session and return a JSON object with exactly two fields:",
    '- "score": integer 1–5 where 1=couldn\'t start, 2=needed major hints, 3=needed minor hints, 4=small nudge only, 5=completely clean',
    '- "summary": exactly 2 sentences: (1) the key insight or technique for solving this problem, (2) any common trap or gotcha to remember.',
    "Return only the JSON object, no other text.",
  ].join("\n");

  const messages = [...state.messages, { role: "user", content: prompt }];
  const raw = await callAnthropicOnce(messages, buildSystemPrompt(state.problem));

  // Parse JSON, stripping any markdown fences the model might add
  const json = raw.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "").trim();
  const parsed = JSON.parse(json);
  const score = Math.min(5, Math.max(1, Math.round(Number(parsed.score))));
  return { score, summary: String(parsed.summary) };
}

const SCORE_COLORS = { 5: "easy", 4: "easy", 3: "medium", 2: "hard", 1: "hard" };

function renderScoreBadge(score) {
  const el = document.getElementById("summary-score");
  if (!el) return;
  if (!score) {
    el.textContent = "Scoring…";
    el.className = "score-badge scoring";
    return;
  }
  const labels = { 5: "5 — Clean", 4: "4 — Good", 3: "3 — Hints", 2: "2 — Struggled", 1: "1 — Failed" };
  el.textContent = labels[score];
  el.className = `score-badge score-${SCORE_COLORS[score]}`;
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

  // Score badge (updated async when AI finishes)
  renderScoreBadge(state.score ?? null);

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

  const problem = state.problem || {};
  const summaryText =
    state.summary ||
    "Session completed. Summary generation failed — review conversation history.";
  const inferredType = inferType(problem.tags);

  // Map score (1-5) to interval, falling back to user-configured overrides for the 3 tiers
  const score = state.score ?? 3;
  const defaultIntervals = SCORE_INTERVALS;
  const overrideIntervals = {
    5: intervalClean  ?? defaultIntervals[5],
    4: intervalClean  ?? defaultIntervals[4],
    3: intervalHints  ?? defaultIntervals[3],
    2: intervalFailed ?? defaultIntervals[2],
    1: intervalFailed ?? defaultIntervals[1],
  };
  const computedInterval = overrideIntervals[score] ?? 7;
  const resultLabel = SCORE_LABELS[score] ?? SCORE_LABELS[3];

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
    await createNotionPage(payload, notionToken, notionDbId);
    statusEl.innerHTML = `<span class="inline-success">&#10003; Logged to Notion</span>`;
    logBtn.disabled = true;
  } catch (err) {
    statusEl.innerHTML = `<span class="inline-error">${escapeHtml(err.message)}<br>Use "Copy Session Data" to save your work.</span>`;
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
    score: state.score,
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
