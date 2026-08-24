/**
 * Finding the passages in a tender pack that bear on a question.
 *
 * A bid manager asks specific things of a 200-page pack — what insurance is
 * required, when the clarification deadline is, whether a site visit is
 * mandatory — and today reads the PDF to find out.
 *
 * Keyword and heading retrieval rather than embeddings: a tender pack is a few
 * hundred pages, the vocabulary is the buyer's own, and the questions quote it
 * almost verbatim. A vector database would be a second system to run for a
 * problem this size. Revisit if it proves weak.
 */

export type Chunk = {
  documentName: string;
  /** The nearest heading above this text, when the pack has one. */
  heading: string;
  text: string;
};

export type RankedChunk = Chunk & { score: number };

/** Words worth matching on: the rest are noise at pack scale. */
const STOP = new Set([
  "the", "and", "for", "with", "from", "that", "this", "are", "was", "will", "shall",
  "must", "any", "all", "not", "have", "has", "been", "its", "our", "your", "their",
  "what", "when", "where", "which", "who", "how", "does", "did", "is", "of", "in", "to", "a", "an",
]);

export function terms(text: string) {
  return [...new Set(
    text.toLowerCase().replace(/[^a-z0-9€%.\s]/g, " ").split(/\s+/)
      .filter((word) => word.length > 2 && !STOP.has(word)),
  )];
}

/** A line that reads as a heading: short, and not a sentence. */
function isHeading(line: string) {
  const trimmed = line.trim();
  if (trimmed.length === 0 || trimmed.length > 90) return false;
  if (/[.;:]$/.test(trimmed) && !/^\d+(\.\d+)*\.?\s/.test(trimmed)) return false;
  return /^\d+(\.\d+)*\.?\s+\S/.test(trimmed) || trimmed === trimmed.toUpperCase() && /[A-Z]/.test(trimmed);
}

/**
 * Splits one document into passages, keeping the heading each sits under.
 *
 * Paragraph-sized chunks rather than fixed windows: a requirement is usually
 * one paragraph, and a fixed window cuts sentences in half — which then get
 * quoted back to the user mid-clause.
 */
export function chunkDocument(documentName: string, text: string, maxChars = 1200): Chunk[] {
  const chunks: Chunk[] = [];
  let heading = "";
  let buffer: string[] = [];

  const flush = () => {
    const body = buffer.join("\n").trim();
    buffer = [];
    if (body.length === 0) return;
    // A very long paragraph is split on sentence ends, never mid-sentence.
    if (body.length <= maxChars) { chunks.push({ documentName, heading, text: body }); return; }
    let current = "";
    for (const sentence of body.split(/(?<=[.!?])\s+/)) {
      if (current.length + sentence.length > maxChars && current) {
        chunks.push({ documentName, heading, text: current.trim() });
        current = "";
      }
      current += `${sentence} `;
    }
    if (current.trim()) chunks.push({ documentName, heading, text: current.trim() });
  };

  for (const line of text.split(/\r?\n/)) {
    if (isHeading(line)) {
      flush();
      heading = line.trim();
      continue;
    }
    if (line.trim() === "") { flush(); continue; }
    buffer.push(line);
  }
  flush();
  return chunks;
}

/**
 * Ranks passages against a question.
 *
 * A term in the heading counts double: a buyer who puts "Insurance" as a
 * heading has told us where the insurance requirement lives, and that signal is
 * stronger than the same word appearing once in a paragraph about something
 * else.
 */
export function rankChunks(question: string, chunks: Chunk[], limit = 6): RankedChunk[] {
  const wanted = terms(question);
  if (wanted.length === 0) return [];

  const ranked = chunks.map((chunk) => {
    const body = chunk.text.toLowerCase();
    const head = chunk.heading.toLowerCase();
    let score = 0;
    for (const term of wanted) {
      if (head.includes(term)) score += 2;
      const occurrences = body.split(term).length - 1;
      if (occurrences > 0) score += 1 + Math.min(occurrences - 1, 2) * 0.25;
    }
    return { ...chunk, score };
  });

  return ranked
    .filter((chunk) => chunk.score > 0)
    .sort((a, b) => b.score - a.score || a.text.length - b.text.length)
    .slice(0, limit);
}

/** Nothing matched, so there is nothing to answer from. */
export const NO_ANSWER = "The tender pack does not state this";
