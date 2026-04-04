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
          if (
            event.type === "content_block_delta" &&
            event.delta?.type === "text_delta"
          ) {
            onDelta(event.delta.text);
          } else if (event.type === "message_stop") {
            onComplete();
            return;
          } else if (event.type === "error") {
            onError(new Error(event.error?.message || "Stream error"));
            return;
          }
        } catch (e) {
          // Partial JSON from chunk boundary — expected, skip and continue
        }
      }
    }
    onComplete();
  } catch (err) {
    onError(err);
  }
}
