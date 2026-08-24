/**
 * Reading prose out of a tool call that has not finished arriving.
 *
 * Drafting uses forced tool use, so what streams back is not text but the JSON
 * of a tool input, one fragment at a time. The answer a person wants to watch
 * appear is a string field inside that half-written JSON, and showing it means
 * decoding a string whose closing quote has not been sent yet.
 *
 * This is the fiddly part, so it lives on its own and is tested on its own.
 */

/**
 * The value of a top-level string field in a partial JSON document.
 *
 * Returns as much of the string as has arrived, with escapes decoded and any
 * trailing half-escape (`…\` or `…\u00`) dropped rather than shown as
 * gibberish. Returns null when the field has not started arriving yet.
 */
export function partialJsonString(buffer: string, key: string): string | null {
  const marker = `"${key}"`;
  const at = buffer.indexOf(marker);
  if (at === -1) return null;

  // Step over the key, its colon and any whitespace, to the opening quote.
  let index = at + marker.length;
  while (index < buffer.length && /\s/.test(buffer[index])) index += 1;
  if (buffer[index] !== ":") return null;
  index += 1;
  while (index < buffer.length && /\s/.test(buffer[index])) index += 1;
  if (buffer[index] !== '"') return null;
  index += 1;

  let out = "";
  while (index < buffer.length) {
    const char = buffer[index];
    if (char === '"') return out;            // the string is complete
    if (char !== "\\") { out += char; index += 1; continue; }

    const escape = buffer[index + 1];
    if (escape === undefined) return out;    // a backslash and nothing yet
    if (escape === "u") {
      const hex = buffer.slice(index + 2, index + 6);
      if (hex.length < 4) return out;        // half a code point
      out += String.fromCharCode(parseInt(hex, 16));
      index += 6;
      continue;
    }
    const simple: Record<string, string> = {
      '"': '"', "\\": "\\", "/": "/", b: "\b", f: "\f", n: "\n", r: "\r", t: "\t",
    };
    out += simple[escape] ?? escape;
    index += 2;
  }
  return out;
}

/**
 * One server-sent event.
 *
 * Newlines inside the payload would end the event early, so the data is JSON —
 * which has none — and each event ends with the blank line the protocol needs.
 */
export function sseEvent(event: string, data: unknown) {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

/** The headers that stop a proxy buffering a stream into a single response. */
export const SSE_HEADERS = {
  "content-type": "text/event-stream; charset=utf-8",
  "cache-control": "no-cache, no-transform",
  connection: "keep-alive",
  // Render sits behind nginx, which buffers by default and would hold the whole
  // draft back until it finished — exactly the wait this feature removes.
  "x-accel-buffering": "no",
} as const;
