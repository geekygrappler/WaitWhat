export const CARD_MENTION_SCHEMA = {
  type: "object",
  properties: {
    mentions: {
      type: "array",
      items: {
        type: "object",
        properties: {
          canonicalName: { type: "string" },
          spokenText: { type: "string" },
          role: { type: "string", enum: ["main", "incidental"] },
          startSeconds: { type: "number" },
          evidence: { type: "string" },
          confidence: { type: "number" }
        },
        required: ["canonicalName", "spokenText", "role", "startSeconds", "evidence", "confidence"],
        additionalProperties: false
      }
    }
  },
  required: ["mentions"],
  additionalProperties: false
};

export const CARD_ANALYSIS_INSTRUCTIONS = `You extract explicit Magic: The Gathering card mentions from podcast transcripts.

Return every occurrence, including two, three, four, or more cards spoken back to back. Never stop after finding one card in a transcript line.

Classify a card as "main" only when the episode is explicitly organized around reviewing individual cards, ranking cards, or examining one named card and this card is the current structured subject. In a general conversation, news, advice, or therapy-style episode that is not organized as a card-by-card review, classify every card as "incidental" even when the speakers discuss one for several minutes. Classify comparisons, synergy pieces, deck ingredients, and examples as "incidental" in every episode. A card can remain the main subject across many transcript lines; emit its occurrence when the speakers introduce or clearly name it, not once per line.

Use the canonical printed card name when the transcript is phonetic, misspelled, or separates a compound name, such as "skull clamp" for "Skullclamp". Do not convert ordinary speech into a similarly spelled card: for example, "brainstem" is ordinary anatomy, not "Brainstorm". Do not emit format names, mechanics, generic tokens, people, set names, or rules terms unless the words explicitly refer to a real card.

Copy startSeconds from the timestamp at the beginning of the transcript line containing the spoken mention. Keep evidence short and quote only the local phrase that establishes the card and its role. Confidence is between 0 and 1.`;

export function chunkTranscript(segments, { chunkSeconds = 1800, overlapSeconds = 20 } = {}) {
  if (!segments.length) return [];
  if (!(chunkSeconds > overlapSeconds && overlapSeconds >= 0)) throw new Error("chunkSeconds must be greater than overlapSeconds.");
  const firstStart = Number(segments[0].start) || 0;
  const finalEnd = Math.max(...segments.map((segment) => Number(segment.end) || Number(segment.start) || 0));
  const chunks = [];
  for (let start = firstStart; start <= finalEnd; start += chunkSeconds - overlapSeconds) {
    const end = start + chunkSeconds;
    const included = segments.filter((segment) => Number(segment.end) >= start && Number(segment.start) < end);
    if (!included.length) continue;
    chunks.push({
      start,
      end: Math.min(end, finalEnd),
      transcriptStart: Math.min(...included.map((segment) => Number(segment.start) || 0)),
      transcriptEnd: Math.max(...included.map((segment) => Number(segment.end) || Number(segment.start) || 0)),
      transcript: included.map((segment) => `[${timestamp(Number(segment.start))}-${timestamp(Number(segment.end))}] ${cleanText(segment.text)}`).join("\n")
    });
    if (end >= finalEnd) break;
  }
  return chunks;
}

export async function analyzeTranscriptCards({ title, segments, model, request, chunkSeconds = 1800, overlapSeconds = 20 }) {
  if (typeof request !== "function") throw new Error("A model request adapter is required.");
  const chunks = chunkTranscript(segments, { chunkSeconds, overlapSeconds });
  const collected = [];
  for (const [index, chunk] of chunks.entries()) {
    console.log(`Analyzing transcript chunk ${index + 1}/${chunks.length} (${timestamp(chunk.start)}-${timestamp(chunk.end)})...`);
    const result = await request({
      model,
      schema: CARD_MENTION_SCHEMA,
      instructions: CARD_ANALYSIS_INSTRUCTIONS,
      input: `Episode: ${title}\nTranscript chunk ${index + 1} of ${chunks.length} (${timestamp(chunk.start)}-${timestamp(chunk.end)}):\n\n${chunk.transcript}`
    });
    if (!Array.isArray(result?.mentions)) throw new Error(`Model response for chunk ${index + 1} did not contain a mentions array.`);
    for (const mention of result.mentions) collected.push(normalizeMention(mention, chunk, index));
  }
  const mentions = deduplicateMentions(collected);
  const { mainCards, incidentalCards } = deriveCardLists(mentions);
  return { model, title, chunks: chunks.length, mentions, mainCards, incidentalCards };
}

export function deriveCardLists(mentions) {
  const mainCards = uniqueSorted(mentions.filter((mention) => mention.role === "main").map((mention) => mention.canonicalName));
  const mainKeys = new Set(mainCards.map(normalizeName));
  const incidentalCards = uniqueSorted(mentions
    .filter((mention) => mention.role === "incidental" && !mainKeys.has(normalizeName(mention.canonicalName)))
    .map((mention) => mention.canonicalName));
  return { mainCards, incidentalCards };
}

function normalizeMention(mention, chunk, chunkIndex) {
  const canonicalName = cleanText(mention.canonicalName);
  const spokenText = cleanText(mention.spokenText);
  const evidence = cleanText(mention.evidence);
  const startSeconds = Number(mention.startSeconds);
  const confidence = Number(mention.confidence);
  if (!canonicalName || !spokenText || !evidence) throw new Error(`Chunk ${chunkIndex + 1} returned an empty required string.`);
  if (!Number.isFinite(startSeconds) || startSeconds < chunk.transcriptStart - 1 || startSeconds > chunk.transcriptEnd + 1) {
    throw new Error(`Chunk ${chunkIndex + 1} returned an out-of-range timestamp ${startSeconds} for ${canonicalName}.`);
  }
  if (!Number.isFinite(confidence) || confidence < 0 || confidence > 1) throw new Error(`Chunk ${chunkIndex + 1} returned invalid confidence for ${canonicalName}.`);
  if (mention.role !== "main" && mention.role !== "incidental") throw new Error(`Chunk ${chunkIndex + 1} returned an invalid role for ${canonicalName}.`);
  return { canonicalName, spokenText, role: mention.role, startSeconds, evidence, confidence };
}

function deduplicateMentions(mentions) {
  const result = [];
  for (const mention of mentions.sort((a, b) => a.startSeconds - b.startSeconds || a.canonicalName.localeCompare(b.canonicalName))) {
    const duplicate = result.find((current) =>
      normalizeName(current.canonicalName) === normalizeName(mention.canonicalName)
      && current.role === mention.role
      && Math.abs(current.startSeconds - mention.startSeconds) <= 1
    );
    if (!duplicate) result.push(mention);
    else if (mention.confidence > duplicate.confidence) Object.assign(duplicate, mention);
  }
  return result;
}

function uniqueSorted(names) {
  const byKey = new Map();
  for (const name of names) if (!byKey.has(normalizeName(name))) byKey.set(normalizeName(name), name);
  return [...byKey.values()].sort((a, b) => a.localeCompare(b));
}

function normalizeName(value) { return cleanText(value).toLowerCase().normalize("NFKD").replace(/[\u0300-\u036f]/g, ""); }
function cleanText(value) { return String(value || "").replace(/\s+/g, " ").trim(); }
function timestamp(seconds) {
  const whole = Math.max(0, Number(seconds) || 0);
  const hours = Math.floor(whole / 3600);
  const minutes = Math.floor((whole % 3600) / 60);
  const remainder = (whole % 60).toFixed(2).padStart(5, "0");
  return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}:${remainder}`;
}
