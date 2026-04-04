# DSA Coach Chrome Extension — Build Spec

## Overview

A Chrome extension that provides a Socratic DSA/system design coaching session in a side panel while the user is on a LeetCode problem page, then logs the completed session to a Notion database via the Notion API.

**Security notice:** This extension stores API keys client-side in Chrome storage. It is designed for personal use only and must never be published to the Chrome Web Store or distributed without first moving key management behind a backend proxy.

---

## Tech Stack

- Vanilla JS + HTML/CSS (no framework — keep the extension lightweight)
- Chrome Extension Manifest V3
- Chrome Side Panel API (`chrome.sidePanel`)
- Anthropic Messages API (`claude-sonnet-4-6`) for coaching chat
- Notion API for session logging

---

## Project Structure

```
dsa-coach/
├── manifest.json
├── background.js
├── content.js
├── sidepanel/
│   ├── sidepanel.html
│   ├── sidepanel.js
│   ├── sidepanel.css
│   └── stream.js          # SSE stream parser (isolated module)
├── options/
│   ├── options.html
│   └── options.js
└── icons/
    └── icon128.png
```

---

## manifest.json

- Manifest version: 3
- Permissions: `sidePanel`, `storage`, `activeTab`, `scripting`
- Host permissions: `https://leetcode.com/*`
- Background service worker: `background.js`
- Content scripts: inject `content.js` on `https://leetcode.com/problems/*`
- Side panel: `sidepanel/sidepanel.html`
- Options page: `options/options.html`
- Action: clicking the extension icon opens the side panel

---

## content.js — LeetCode DOM Scraper

Runs on `https://leetcode.com/problems/*`.

### Scraping Strategy

LeetCode is React-rendered and lazy-loads content. The scraper must **not** attempt a single scrape on DOMContentLoaded. Instead, use a `MutationObserver` with a timeout-based fallback:

```
1. On page load, start a MutationObserver on document.body (subtree, childList)
2. On each mutation batch, attempt to scrape all fields
3. If all required fields are found (at minimum: title + description), disconnect the observer and send the data
4. If 10 seconds pass without a successful scrape, disconnect the observer and send whatever partial data was collected
5. Set a flag so repeated scrapes don't fire multiple messages
```

### Selector Cascade (try each in order, use first match)

**Problem title:**
1. `[data-cy="question-title"]` text content
2. `<title>` tag, parsed: strip " - LeetCode" suffix
3. URL slug, formatted: `/problems/two-sum/` → "Two Sum"

**LC problem number:**
1. Look for a span/div near the title containing a `#` followed by digits
2. Fall back to `null` (non-critical field)

**Difficulty:**
1. Look for an element whose text content is exactly "Easy", "Medium", or "Hard" within the first 500px of the problem area
2. Fall back to `null`

**Problem description:**
1. `div[data-cy="question-content"]` inner text
2. First div with class containing `"description"` or `"content"` that has >100 chars of text
3. Fall back to empty string

**Tags:**
1. Look for anchor elements or chips in the tag section below the problem
2. Fall back to empty array

### Message Format

```js
{
  type: "PROBLEM_DATA",
  data: {
    title: string,
    lcNumber: number | null,
    difficulty: "Easy" | "Medium" | "Hard" | null,
    description: string,
    tags: string[],
    scrapedAt: number  // Date.now(), so the panel can tell if data is stale
  }
}
```

Also listen for a `GET_PROBLEM_DATA` message and respond with the same payload (re-runs the scrape cascade for on-demand fetches when the panel opens after page load).

---

## background.js — Service Worker

### Icon Click Handler
On extension icon click, open the side panel for the current tab using `chrome.sidePanel.open()`.

### Message Brokering

The background script is the **only** bridge between the content script and the side panel. The exact message flow:

**Content script → Side panel (push):**
1. Content script calls `chrome.runtime.sendMessage({ type: "PROBLEM_DATA", data })`.
2. Background listener receives it, identifies the originating tab, and forwards to the side panel via `chrome.runtime.sendMessage()` (the side panel is an extension page and can receive runtime messages).

**Side panel → Content script (pull):**
1. Side panel calls `chrome.runtime.sendMessage({ type: "GET_PROBLEM_DATA" })`.
2. Background listener receives it, calls `chrome.tabs.query({ active: true, currentWindow: true })` to get the active tab.
3. Background calls `chrome.tabs.sendMessage(tabId, { type: "GET_PROBLEM_DATA" })`.
4. Content script's `onMessage` listener runs the scraper and calls `sendResponse(data)`.
5. Background forwards the response back to the side panel via the original `sendResponse` callback.

**Important:** The background `onMessage` handler for `GET_PROBLEM_DATA` must `return true` to indicate an async `sendResponse`, since it waits for the content script round-trip.

---

## sidepanel/sidepanel.html + sidepanel.css

A clean, minimal chat UI with four states:

### State 1 — Loading / No Problem Detected
- Show a spinner or message: "Open a LeetCode problem to begin"
- If content script fails to scrape: show "Couldn't read problem data" with a text input where the user can manually type a problem name + difficulty selector, and a "Start with manual entry" button

### State 2 — Problem Loaded, Not Started
- Show problem title, difficulty badge, tags
- "Start Session" button

### State 3 — Active Session
- Problem metadata pinned at the top (title, difficulty)
- Chat message list (scrollable, auto-scrolls to bottom on new messages)
- Markdown rendering in assistant messages: render `**bold**`, `` `inline code` ``, and fenced code blocks with a monospace background. Use a lightweight regex-based renderer — no need for a full markdown library.
- Text input + Send button at the bottom (also send on Enter, Shift+Enter for newline)
- "End Session" button in the header

### State 4 — Session Complete
- Summary panel showing: problem info, session duration, hint count, auto-detected patterns
- Result selector: Clean 🟢 / Hints 🟡 / Failed 🔴
- "Log to Notion" button
- "Copy Session Data" button (always visible as a fallback)
- "Start New Session" button

### Style
- Dark background (`#1a1a1a`)
- Monospace font for code snippets (`'Fira Code', 'Cascadia Code', 'Consolas', monospace`)
- Difficulty badge colors matching LeetCode: Easy = `#00b8a3`, Medium = `#ffc01e`, Hard = `#ff375f`
- Keep it compact — it lives in a ~380px wide panel
- Messages: user messages right-aligned with a subtle accent background, assistant messages left-aligned

---

## sidepanel/stream.js — SSE Stream Parser

Isolated module for parsing the Anthropic streaming response. This is non-trivial in vanilla JS and deserves its own file.

### Implementation

```js
/**
 * Parses an Anthropic SSE stream and yields text deltas.
 * 
 * The stream format is:
 *   event: content_block_delta
 *   data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Hello"}}
 *   
 *   event: message_stop
 *   data: {"type":"message_stop"}
 *
 * @param {Response} response - fetch Response with readable body stream
 * @param {function(string): void} onDelta - called with each text chunk
 * @param {function(): void} onComplete - called when stream ends
 * @param {function(Error): void} onError - called on parse or network error
 */
export async function parseAnthropicStream(response, onDelta, onComplete, onError) {
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop(); // keep incomplete last line in buffer

      for (const line of lines) {
        if (!line.startsWith("data: ")) continue;
        const jsonStr = line.slice(6);
        if (jsonStr === "[DONE]") continue;

        try {
          const event = JSON.parse(jsonStr);
          if (event.type === "content_block_delta" && event.delta?.type === "text_delta") {
            onDelta(event.delta.text);
          } else if (event.type === "message_stop") {
            onComplete();
            return;
          } else if (event.type === "error") {
            onError(new Error(event.error?.message || "Stream error"));
            return;
          }
        } catch (e) {
          // Partial JSON from chunk boundary — this is expected, skip and continue
        }
      }
    }
    onComplete();
  } catch (err) {
    onError(err);
  }
}
```

---

## sidepanel/sidepanel.js — Core Logic

### On Load
1. Send `GET_PROBLEM_DATA` to background → content script
2. Populate problem metadata or show "no problem" state
3. Listen for `PROBLEM_DATA` messages (for when content script fires after panel opens)

### Session State

Use `chrome.storage.session` (MV3 in-memory storage that survives panel close/reopen within a browser session) for all session state. This prevents data loss if the user accidentally closes the side panel mid-session.

```js
// State shape stored in chrome.storage.session
{
  problem: { title, lcNumber, difficulty, description, tags },
  messages: [],          // full conversation history for API calls
  displayMessages: [],   // messages for rendering (excludes priming message)
  startTime: null,
  hintCount: 0,
  detectedPatterns: [],
  sessionActive: false,
  sessionComplete: false,
  result: null           // "clean" | "hints" | "failed"
}
```

On panel open, always check `chrome.storage.session` first and restore state if a session is in progress.

### "Start Session" Click
1. Set `sessionActive = true`, record `startTime`
2. Build the system prompt (see below)
3. Send the first API call with a priming user message: `"I'm ready to start."`
4. **Do not add the priming message to `displayMessages`** — it's only in `messages` (the API history). The user should see the assistant's opening message as the first thing in the chat.
5. Render the assistant's opening message in the chat via streaming

### Chat Send
1. Append user message to both `messages` and `displayMessages`, render it
2. Persist updated state to `chrome.storage.session`
3. Call Anthropic API with full `messages` history
4. Stream the response using `parseAnthropicStream` from `stream.js`
5. Render assistant response tokens as they arrive
6. After response completes, run hint/pattern detection (see below)
7. Persist updated state to `chrome.storage.session`

### Hint and Pattern Detection

**Do not use regex heuristics on the assistant's output.** The Socratic coaching style intentionally uses guiding questions, and regex matching on phrases like "think about" or "consider" would produce constant false positives.

Instead, **instruct Claude to self-tag its messages** via the system prompt. After each assistant message completes, scan for these tags:

- `[HINT]` — Claude includes this when giving a substantive hint that narrows the solution space. Increment `hintCount`.
- `[PATTERN: <name>]` — Claude includes this when introducing or confirming a pattern. Add `<name>` to `detectedPatterns` (deduplicated).

These tags should be **stripped from the rendered output** before display. Use a simple regex to remove them: `/\[(HINT|PATTERN:\s*[^\]]+)\]/g`

### "End Session" Click
1. Set `sessionActive = false`
2. Calculate session duration from `startTime`
3. **Generate session summary** (non-blocking):
   - Make a final API call with the conversation history + a user message: "Summarize this session in exactly 2 sentences: (1) the key insight or technique for solving this problem, (2) any common trap or gotcha to remember."
   - If the summary call **succeeds**: store the summary text
   - If the summary call **fails**: set summary to `null` and proceed — do not block the end-session flow. The "Log to Notion" step will use a fallback: `"Session completed. Summary generation failed — review conversation history."`
4. Transition to State 4 (summary panel)
5. Pre-select result based on `hintCount`: 0 → Clean, 1-2 → Hints, 3+ → Failed (user can override)

### "Log to Notion" Click
1. Read `notionToken` + `notionDbId` from `chrome.storage.sync`
2. If missing, show inline error: "Add your Notion token in Settings" with a link to the options page
3. **Validate the database schema first:**
   - `GET https://api.notion.com/v1/databases/{notionDbId}` with the auth header
   - Check that required properties exist with correct types (see Notion Schema section below)
   - If validation fails: show a clear error listing which properties are missing or have wrong types, and link to setup instructions
4. Compute interval: Clean → 14, Hints → 7, Failed → 3 (these values come from options, see below)
5. Build the page payload and `POST` to `https://api.notion.com/v1/pages`
6. On success: show green checkmark + "Logged to Notion" message
7. On failure: show the **raw Notion error message** (Notion's 400 errors are specific and helpful), and ensure the "Copy Session Data" button is prominent so the user doesn't lose their work

### "Copy Session Data" Button
Always available in State 4. Copies a JSON blob to clipboard containing all session metadata + the full conversation, so the user has a fallback if Notion logging fails.

---

## Notion Schema

### Required Database Properties

| Property Name | Notion Type | Description |
|---|---|---|
| Problem | Title | Problem name |
| LC # | Number | LeetCode problem number |
| Type | Select | "DSA" or "System Design" |
| Pattern | Multi-select | Detected patterns (e.g. "sliding window", "BFS") |
| Difficulty | Select | "Easy", "Medium", "Hard" |
| Last Result | Select | "Clean 🟢", "Hints 🟡", or "Failed 🔴" |
| Last Done | Date | Today's date (ISO format) |
| Interval (days) | Number | Spaced repetition interval |
| Times Reviewed | Number | Set to 1 for new entries |
| Notes | Rich text | Auto-generated 2-sentence summary |

### Schema Validation

On the first "Log to Notion" attempt per browser session, fetch the database schema and validate:

```js
const DB_SCHEMA = {
  "Problem":        "title",
  "LC #":           "number",
  "Type":           "select",
  "Pattern":        "multi_select",
  "Difficulty":     "select",
  "Last Result":    "select",
  "Last Done":      "date",
  "Interval (days)":"number",
  "Times Reviewed": "number",
  "Notes":          "rich_text"
};

async function validateNotionSchema(notionToken, notionDbId) {
  const resp = await fetch(`https://api.notion.com/v1/databases/${notionDbId}`, {
    headers: {
      "Authorization": `Bearer ${notionToken}`,
      "Notion-Version": "2022-06-28"
    }
  });
  if (!resp.ok) throw new Error(`Notion API error: ${resp.status}`);
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
  return errors; // empty array = valid
}
```

Cache the validation result in `chrome.storage.session` so it's only checked once per browser session.

### Type Inference
- If `tags` array contains any of: "design", "system", "architecture" → Type = "System Design"
- Otherwise → Type = "DSA"

---

## System Prompt

```
You are a Socratic DSA interview coach. The user is practicing on LeetCode.

Problem context:
- Title: {title}
- Difficulty: {difficulty}
- Description: {description}
- Tags: {tags}

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

Start by asking the user what their initial thoughts are on the problem.
```

---

## options/options.html + options.js

Settings page with these fields:

### API Keys
- **Anthropic API Key** — password-type input, saved to `chrome.storage.sync` under key `anthropicKey`
- **Notion Integration Token** — password-type input, saved under `notionToken`
- **Notion Database ID** — text input, saved under `notionDbId`

### Spaced Repetition Intervals
- **Clean solve interval** — number input, default 14, saved under `intervalClean`
- **Hints needed interval** — number input, default 7, saved under `intervalHints`
- **Failed interval** — number input, default 3, saved under `intervalFailed`

### UI
- "Save" button that writes all values to `chrome.storage.sync`
- On save, show brief green "Saved!" confirmation that fades after 2 seconds
- On load, populate all fields from storage

### Inline Setup Guide
Display below the form:
```
Setup:
1. Get your Anthropic API key from console.anthropic.com
2. Get your Notion integration token from notion.so/my-integrations
3. Create an integration, then share your DSA database with it
4. Your DB ID is the 32-character string in the database URL:
   notion.so/username/{DB_ID}?v=...
5. Make sure your Notion database has these columns:
   Problem (title), LC # (number), Type (select), Pattern (multi-select),
   Difficulty (select), Last Result (select), Last Done (date),
   Interval (days) (number), Times Reviewed (number), Notes (rich text)
```

---

## API Call Pattern (Anthropic)

```js
const response = await fetch("https://api.anthropic.com/v1/messages", {
  method: "POST",
  headers: {
    "Content-Type": "application/json",
    "x-api-key": anthropicKey,
    "anthropic-version": "2023-06-01",
    "anthropic-dangerous-direct-browser-access": "true"  // required for direct browser calls
  },
  body: JSON.stringify({
    model: "claude-sonnet-4-6",
    max_tokens: 1024,
    system: SYSTEM_PROMPT,
    messages: sessionMessages,
    stream: true
  })
});

// Use parseAnthropicStream from stream.js to process the response
```

---

## Notion API Call Pattern

```js
// Schema validation (once per session)
await fetch(`https://api.notion.com/v1/databases/${notionDbId}`, {
  method: "GET",
  headers: {
    "Authorization": `Bearer ${notionToken}`,
    "Notion-Version": "2022-06-28"
  }
});

// Page creation
await fetch("https://api.notion.com/v1/pages", {
  method: "POST",
  headers: {
    "Authorization": `Bearer ${notionToken}`,
    "Content-Type": "application/json",
    "Notion-Version": "2022-06-28"
  },
  body: JSON.stringify({
    parent: { database_id: notionDbId },
    properties: {
      "Problem":        { title: [{ text: { content: problem.title } }] },
      "LC #":           { number: problem.lcNumber },
      "Type":           { select: { name: inferredType } },
      "Pattern":        { multi_select: detectedPatterns.map(p => ({ name: p })) },
      "Difficulty":     { select: { name: problem.difficulty } },
      "Last Result":    { select: { name: resultLabel } },
      "Last Done":      { date: { start: new Date().toISOString().split("T")[0] } },
      "Interval (days)":{ number: computedInterval },
      "Times Reviewed": { number: 1 },
      "Notes":          { rich_text: [{ text: { content: summaryText } }] }
    }
  })
});
```

---

## Error Handling

| Scenario | Behavior |
|---|---|
| No API key set | Persistent banner: "Add your API key in Settings" with a link to `chrome-extension://.../options/options.html` |
| Content script fails to scrape | Show "Couldn't read problem data" + manual entry fallback (title text input + difficulty dropdown) |
| Anthropic API call fails (non-stream) | Show error inline in chat with the status code and message. If 401: "Invalid API key — check Settings." If 429: "Rate limited — wait a moment and try again." |
| Anthropic stream breaks mid-response | Append whatever was streamed so far, show "(response interrupted)" indicator, keep the send button enabled so the user can continue |
| Summary generation fails at end of session | Proceed to State 4 with a null summary. Use fallback text when logging to Notion. |
| Notion schema validation fails | Show the list of mismatched/missing properties inline with instructions to fix them |
| Notion page creation fails | Show the raw Notion error message. Ensure "Copy Session Data" button is prominently visible. |
| Network errors (any) | Surface inline with the raw error. Never swallow silently. |
| Side panel closed mid-session | Session state is in `chrome.storage.session` and auto-restores on reopen |

---

## Known LeetCode DOM Notes (as of early 2026)

LeetCode's DOM is React-rendered and changes periodically. **All scraping is best-effort and must degrade gracefully.** The selector cascades in the content.js section are ordered by reliability. If all selectors fail, the extension still works — the user just types the problem name manually.

Specific gotcha: LeetCode lazy-renders the problem description after the initial page shell loads. The `MutationObserver` approach in content.js handles this. Do not rely on `DOMContentLoaded` or a simple `setTimeout`.

---

## What's Out of Scope for MVP

- Detecting duplicate problems and incrementing `Times Reviewed` (always creates a new row)
- Syncing the review queue back from Notion into the extension
- System design-specific coaching mode (different system prompt)
- Auth flow for Notion (use manual token paste)
- Backend proxy for API keys (personal use only)
- Conversation export to markdown

---

## Dev Setup Instructions (include in README)

1. Clone the repo
2. Go to `chrome://extensions`, enable Developer Mode
3. Click "Load unpacked", select the `dsa-coach/` directory
4. Click the extension icon on any LeetCode problem page
5. Open Settings (right-click extension icon → Options) and add:
   - Anthropic API key (from console.anthropic.com)
   - Notion integration token (from notion.so/my-integrations)
   - Notion Database ID (32-char string from your database URL)
6. Make sure your Notion database has the required schema (see Options page for column list)
7. Share the Notion database with your integration
