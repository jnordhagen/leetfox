import { parseAnthropicStream } from "./stream.js";

// ---------- Constants ----------

export const ANTHROPIC_API = "https://api.anthropic.com/v1/messages";
export const MODEL = "claude-sonnet-4-6";
export const MAX_TOKENS = 1024;

// ---------- Storage ----------

export async function getStoredKeys() {
  return chrome.storage.local.get(["anthropicKey", "notionToken", "notionDbId", "intervalClean", "intervalHints", "intervalFailed"]);
}

// ---------- Anthropic API ----------

export async function callAnthropicStream(messages, systemPrompt, onDelta, onComplete, onError) {
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

export async function callAnthropicOnce(messages, systemPrompt) {
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
