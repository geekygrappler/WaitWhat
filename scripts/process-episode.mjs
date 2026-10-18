#!/usr/bin/env node
import { existsSync } from "node:fs";
import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { createInterface } from "node:readline";
import { pipeline } from "node:stream/promises";
import { Readable } from "node:stream";
import { createGunzip } from "node:zlib";

const args = parseArgs(process.argv.slice(2));
if (!args.audio && !args.url && !args.transcript) usage();

const processingDir = path.resolve(args.workdir || "processing");
const cacheDir = path.resolve(args.cache || ".cache/scryfall");
await mkdir(processingDir, { recursive: true });
await mkdir(cacheDir, { recursive: true });

const audioPath = args.audio ? path.resolve(args.audio) : args.url ? await downloadAudio(args.url, processingDir) : null;
const transcriptPath = args.transcript ? path.resolve(args.transcript) : await transcribe(audioPath, processingDir, args.model || "turbo");
const segments = await loadSegments(transcriptPath);
const requestedSets = args.sets ?? "hob,hoc";
const setFilter = new Set(/^(all|\*)$/i.test(requestedSets) ? [] : requestedSets.split(",").map((set) => set.trim().toLowerCase()).filter(Boolean));
const approvedCards = args["approved-cards"]
  ? new Set(JSON.parse(await readFile(path.resolve(args["approved-cards"]), "utf8")))
  : null;
const incidentalCards = args["incidental-cards"]
  ? new Set(JSON.parse(await readFile(path.resolve(args["incidental-cards"]), "utf8")))
  : null;
const oneWordAllowlist = args["one-word-allowlist"]
  ? new Set(JSON.parse(await readFile(path.resolve(args["one-word-allowlist"]), "utf8")))
  : null;
const blockedCards = args["blocked-cards"]
  ? new Set(JSON.parse(await readFile(path.resolve(args["blocked-cards"]), "utf8")))
  : null;
const analysis = args.analysis ? JSON.parse(await readFile(path.resolve(args.analysis), "utf8")) : null;
const catalogueNames = analysis
  ? new Set((analysis.mentions || []).map((mention) => mention.canonicalName))
  : args["base-cues"] && incidentalCards ? incidentalCards : null;
const catalogue = normalizeCatalogue(await loadCatalogue(cacheDir, args.catalogue, catalogueNames));
const cards = preferredCards(catalogue.filter((card) => card.lang === "en" && (!setFilter.size || setFilter.has(card.set))), Boolean(analysis))
  .filter((card) => analysis
    || !oneWordAllowlist
    || normalize(card.name.split(" // ")[0]).includes(" ")
    || oneWordAllowlist.has(card.name)
    || approvedCards?.has(card.name)
    || incidentalCards?.has(card.name))
  .filter((card) => !blockedCards || !blockedCards.has(card.name));
const primaryCards = approvedCards ? cards.filter((card) => approvedCards.has(card.name)) : cards;
const threshold = Number(args.threshold || 0.84);
let cues;
if (analysis) {
  const mainMatches = analysisMatches(analysis, cards, "main");
  cues = groupMatches(mainMatches).map((group) => {
    const [{ segment, card, confidence }] = group;
    const options = uniqueOptions(group);
    return {
      start: segment.start,
      cardId: card.id,
      cardName: card.name,
      confidence: Number(confidence.toFixed(3)),
      needsReview: confidence < 0.94,
      card: compactCard(card),
      ...(options.length > 1 ? { cards: options } : {})
    };
  });
  cues.forEach((cue, index) => { cue.end = cues[index + 1]?.start; });
} else if (args["base-cues"]) {
  cues = JSON.parse(await readFile(path.resolve(args["base-cues"]), "utf8")).filter((cue) => cue.track !== "mentioned");
  for (const cue of cues) delete cue.mentions;
} else {
  const matches = matchSegments(segments, primaryCards, threshold, Boolean(args["exact-only"]));
  cues = groupMatches(collapseMatches(matches)).map((group) => {
    const [{ segment, card, confidence }] = group;
    const cards = uniqueOptions(group);
    return {
      start: segment.start,
      cardId: card.id,
      cardName: card.name,
      confidence: Number(confidence.toFixed(3)),
      needsReview: confidence < 0.94,
      card: compactCard(card),
      ...(cards.length > 1 ? { cards } : {})
    };
  });
  cues.forEach((cue, index) => { cue.end = cues[index + 1]?.start; });
}
let mentionCues = [];
if (incidentalCards) {
  const incidentalThreshold = Number(args["incidental-threshold"] || Math.max(threshold, 0.9));
  const incidentalMatches = analysis
    ? analysisMatches(analysis, cards, "incidental")
    : matchAllSegments(segments, cards.filter((card) => incidentalCards.has(card.name)), incidentalThreshold);
  mentionCues = attachIncidentalMentions(cues, incidentalMatches);
} else if (approvedCards) {
  mentionCues = attachIncidentalMentions(cues, exactMatches(segments, matchableCards(cards.filter((card) => !approvedCards.has(card.name)))));
}

const output = path.resolve(args.output || "dist/data/generated.cues.json");
const outputCues = [...cues, ...mentionCues].sort((a, b) => a.start - b.start || (a.track === "mentioned" ? 1 : -1));
await writeFile(output, `${JSON.stringify(outputCues, null, 2)}\n`);
console.log(`Wrote ${cues.length} main cues and ${mentionCues.length} mentioned cues to ${output}`);
console.log(`${cues.filter((cue) => cue.needsReview).length} low-confidence cues require review`);

async function transcribe(audioPath, outputDir, model) {
  const command = args.whisper || "whisper";
  const run = spawnSync(command, [audioPath, "--model", model, "--output_dir", outputDir, "--output_format", "json", "--word_timestamps", "True"], { stdio: "inherit" });
  if (run.error?.code === "ENOENT") throw new Error("Whisper CLI was not found. Install openai-whisper, or pass --transcript path/to/file.srt.");
  if (run.status !== 0) throw new Error(`Whisper exited with status ${run.status}`);
  return path.join(outputDir, `${path.basename(audioPath, path.extname(audioPath))}.json`);
}

async function downloadAudio(url, outputDir) {
  const filename = decodeURIComponent(new URL(url).pathname.split("/").at(-1) || "episode.mp3").replace(/[^a-zA-Z0-9._-]/g, "-");
  const destination = path.join(outputDir, filename);
  if (existsSync(destination)) return destination;
  const response = await fetch(url, { headers: { "user-agent": "CardcastCompanion/0.1" }, redirect: "follow" });
  if (!response.ok || !response.body) throw new Error(`Audio download failed: ${response.status}`);
  await pipeline(Readable.fromWeb(response.body), createWriteStream(destination));
  return destination;
}

async function loadSegments(filePath) {
  const text = await readFile(filePath, "utf8");
  if (filePath.endsWith(".srt")) {
    return text.replace(/^\uFEFF/, "").split(/\r?\n\r?\n/).map((block, sourceIndex) => {
      const lines = block.split(/\r?\n/);
      const timing = lines.find((line) => line.includes(" --> "));
      if (!timing) return null;
      const [start, end] = timing.split(" --> ").map(srtTime);
      return { start, end, text: lines.slice(lines.indexOf(timing) + 1).join(" "), sourceIndex };
    }).filter(Boolean);
  }
  const json = JSON.parse(text);
  return (json.segments || json).map((segment, sourceIndex) => ({
    start: Number(segment.start),
    end: Number(segment.end),
    text: segment.text || "",
    sourceIndex,
    words: segment.words?.map((word) => ({ text: word.word || word.text || "", start: Number(word.start), end: Number(word.end) }))
  }));
}

async function loadCatalogue(cache, suppliedPath, selectedNames = null) {
  if (suppliedPath) return JSON.parse(await readFile(path.resolve(suppliedPath), "utf8"));
  const jsonDestination = path.join(cache, "default-cards.json");
  const jsonlDestination = path.join(cache, "default-cards.jsonl");
  if (!existsSync(jsonDestination) && !existsSync(jsonlDestination)) {
    const metadataResponse = await fetch("https://api.scryfall.com/bulk-data/default-cards", { headers: { "user-agent": "CardcastCompanion/0.1" } });
    if (!metadataResponse.ok) throw new Error(`Scryfall metadata failed: ${metadataResponse.status}`);
    const metadata = await metadataResponse.json();
    const downloadUri = metadata.download_uri || metadata.jsonl_download_uri;
    if (!downloadUri) throw new Error("Scryfall bulk metadata did not include a supported download URI");
    const dataResponse = await fetch(downloadUri, { headers: { "user-agent": "CardcastCompanion/0.1" } });
    if (!dataResponse.ok) throw new Error(`Scryfall bulk download failed: ${dataResponse.status}`);
    if (metadata.jsonl_download_uri && downloadUri === metadata.jsonl_download_uri) {
      await pipeline(Readable.fromWeb(dataResponse.body), createGunzip(), createWriteStream(jsonlDestination));
    } else {
      await writeFile(jsonDestination, Buffer.from(await dataResponse.arrayBuffer()));
    }
  }
  if (existsSync(jsonDestination)) return JSON.parse(await readFile(jsonDestination, "utf8"));
  const catalogue = [];
  const lines = createInterface({ input: createReadStream(jsonlDestination), crlfDelay: Infinity });
  for await (const line of lines) {
    if (!line) continue;
    const card = JSON.parse(line);
    if (!selectedNames || selectedNames.has(card.name)) catalogue.push(card);
  }
  return catalogue;
}

function normalizeCatalogue(catalogue) {
  if (Array.isArray(catalogue)) return catalogue;
  if (!catalogue?.data || Array.isArray(catalogue.data) || typeof catalogue.data !== "object") {
    throw new Error("Catalogue must be a Scryfall array or an MTGJSON AtomicCards data object");
  }
  return Object.entries(catalogue.data).flatMap(([canonicalName, entries]) => (entries || []).map((entry) => {
    const name = entry.name || canonicalName;
    const oracleId = entry.identifiers?.scryfallOracleId;
    return {
      id: oracleId || `mtgjson:${normalize(name)}`,
      name,
      lang: "en",
      set: entry.printings?.[0]?.toLowerCase(),
      mana_cost: entry.manaCost,
      type_line: entry.type,
      oracle_text: entry.text,
      image_uris: { normal: `https://api.scryfall.com/cards/named?exact=${encodeURIComponent(name)}&format=image&version=normal` },
      card_faces: entry.faceName ? [{
        name: entry.faceName,
        mana_cost: entry.manaCost,
        type_line: entry.type,
        oracle_text: entry.text
      }] : undefined
    };
  }));
}

function preferredCards(cards, allowShortNames = false) {
  const byName = new Map();
  for (const card of cards) {
    const current = byName.get(card.name);
    if (!current || comparePrintingPreference(card, current) < 0) byName.set(card.name, card);
  }
  return [...byName.values()].filter((card) => allowShortNames || normalize(card.name.split(" // ")[0]).length >= 4);
}

function comparePrintingPreference(left, right) {
  const leftRank = printingPreference(left);
  const rightRank = printingPreference(right);
  for (let index = 0; index < leftRank.length; index += 1) {
    if (leftRank[index] < rightRank[index]) return -1;
    if (leftRank[index] > rightRank[index]) return 1;
  }
  return 0;
}

function printingPreference(card) {
  return [
    card.reprint === false ? 0 : 1,
    card.variation ? 1 : 0,
    card.promo ? 1 : 0,
    card.full_art || card.border_color === "borderless" ? 1 : 0,
    card.games?.includes("paper") === false ? 1 : 0,
    card.image_status === "highres_scan" ? 0 : 1,
    card.released_at || "9999-99-99",
    card.set || "",
    card.collector_number || ""
  ];
}

function matchSegments(segments, cards, threshold, exactOnly = false) {
  const candidates = matchableCards(cards);
  const results = exactMatches(segments, candidates);
  if (exactOnly) return results;
  const exactSegments = new Set(results.map((result) => result.segment));
  const cardsByPhoneticKey = new Map();
  for (const candidate of candidates) {
    for (const key of candidate.phoneticKeys) {
      const matches = cardsByPhoneticKey.get(key) || [];
      matches.push(candidate);
      cardsByPhoneticKey.set(key, matches);
    }
  }
  for (let index = 0; index < segments.length; index += 1) {
    if (exactSegments.has(segments[index])) continue;
    const windowText = normalize(segments[index].text);
    let best = null;
    const candidates = new Set();
    for (const word of windowText.split(" ")) {
      for (const candidate of cardsByPhoneticKey.get(soundex(word)) || []) candidates.add(candidate);
    }
    for (const candidate of candidates) {
      const score = bestWindowScore(windowText, candidate.primary);
      if (score >= threshold && (!best || score > best.confidence)) best = { ...candidate, confidence: score };
    }
    if (best) results.push({ segment: segments[index], card: best.card, confidence: best.confidence });
  }
  return results.sort((a, b) => a.segment.start - b.segment.start);
}

function matchAllSegments(segments, cards, threshold) {
  const candidates = matchableCards(cards);
  const exact = exactMatches(segments, candidates);
  const exactCardsBySegment = new Map();
  for (const match of exact) {
    const cardIds = exactCardsBySegment.get(match.segment.sourceIndex) || new Set();
    cardIds.add(match.card.id);
    exactCardsBySegment.set(match.segment.sourceIndex, cardIds);
  }

  const fuzzy = [];
  for (const segment of segments) {
    const tokens = segmentTokens(segment);
    const exactCardIds = exactCardsBySegment.get(segment.sourceIndex) || new Set();
    const possibilities = [];
    for (const candidate of candidates) {
      if (exactCardIds.has(candidate.card.id)) continue;
      const match = bestTokenWindow(tokens, candidate.primary);
      if (match.score >= threshold) possibilities.push({ ...match, candidate });
    }

    possibilities.sort((a, b) => b.score - a.score || b.candidate.words.length - a.candidate.words.length);
    const occupied = [];
    for (const possibility of possibilities) {
      if (occupied.some((span) => possibility.startIndex < span.endIndex && span.startIndex < possibility.endIndex)) continue;
      occupied.push({ startIndex: possibility.startIndex, endIndex: possibility.endIndex });
      fuzzy.push({
        segment: { ...segment, start: tokens[possibility.startIndex].start },
        card: possibility.candidate.card,
        confidence: possibility.score
      });
    }
  }

  return [...exact, ...fuzzy].sort((a, b) => a.segment.start - b.segment.start || b.confidence - a.confidence);
}

function matchableCards(cards) {
  return cards.map((card) => {
    const primary = normalize(card.name.split(" // ")[0]);
    return { card, primary, words: primary.split(" "), phoneticKeys: new Set(primary.split(" ").map(soundex)) };
  });
}

function exactMatches(segments, cards) {
  const byFirstWord = new Map();
  for (const candidate of cards) {
    const matches = byFirstWord.get(candidate.words[0]) || [];
    matches.push(candidate);
    byFirstWord.set(candidate.words[0], matches);
  }
  for (const matches of byFirstWord.values()) matches.sort((a, b) => b.words.length - a.words.length);

  const tokens = segments.flatMap((segment, segmentIndex) => segment.words?.length
    ? segment.words.flatMap((timedWord) => normalize(timedWord.text).split(" ").filter(Boolean).map((word) => ({ word, start: timedWord.start, segment, segmentIndex })))
    : normalize(segment.text).split(" ").filter(Boolean).map((word) => ({ word, start: segment.start, segment, segmentIndex })));
  const results = [];
  for (let index = 0; index < tokens.length; index += 1) {
    const candidates = byFirstWord.get(tokens[index].word) || [];
    for (const candidate of candidates) {
      const slice = tokens.slice(index, index + candidate.words.length);
      if (slice.length !== candidate.words.length || slice.at(-1).segmentIndex - slice[0].segmentIndex > 2) continue;
      if (candidate.words.every((word, wordIndex) => slice[wordIndex].word === word)) {
        results.push({ segment: { ...tokens[index].segment, start: tokens[index].start }, card: candidate.card, confidence: 1 });
        break;
      }
    }
  }
  return results;
}

function segmentTokens(segment) {
  return segment.words?.length
    ? segment.words.flatMap((timedWord) => normalize(timedWord.text).split(" ").filter(Boolean).map((word) => ({ word, start: timedWord.start })))
    : normalize(segment.text).split(" ").filter(Boolean).map((word) => ({ word, start: segment.start }));
}

function bestTokenWindow(tokens, target) {
  const size = target.split(" ").length;
  let best = { score: 0, startIndex: 0, endIndex: 0 };
  for (let length = Math.max(1, size - 1); length <= size + 1; length += 1) {
    for (let index = 0; index <= tokens.length - length; index += 1) {
      const score = similarity(tokens.slice(index, index + length).map((token) => token.word).join(" "), target);
      if (score > best.score) best = { score, startIndex: index, endIndex: index + length };
    }
  }
  return best;
}

function bestWindowScore(text, target) {
  const words = text.split(" ");
  const size = target.split(" ").length;
  let best = 0;
  for (let length = Math.max(1, size - 1); length <= size + 1; length += 1) {
    for (let index = 0; index <= words.length - length; index += 1) best = Math.max(best, similarity(words.slice(index, index + length).join(" "), target));
  }
  return best;
}

function similarity(a, b) {
  const rows = Array.from({ length: b.length + 1 }, (_, index) => index);
  for (let i = 1; i <= a.length; i += 1) {
    let previous = rows[0];
    rows[0] = i;
    for (let j = 1; j <= b.length; j += 1) {
      const saved = rows[j];
      rows[j] = Math.min(rows[j] + 1, rows[j - 1] + 1, previous + (a[i - 1] === b[j - 1] ? 0 : 1));
      previous = saved;
    }
  }
  const editScore = 1 - rows[b.length] / Math.max(a.length, b.length, 1);
  const aWords = a.split(" ");
  const bWords = b.split(" ");
  const phoneticMatches = bWords.filter((word, index) => soundex(word) === soundex(aWords[index] || "")).length;
  const phoneticScore = phoneticMatches / Math.max(aWords.length, bWords.length, 1);
  return Math.max(editScore, editScore * 0.65 + phoneticScore * 0.35);
}

function soundex(word) {
  if (!word) return "";
  const map = { b: 1, f: 1, p: 1, v: 1, c: 2, g: 2, j: 2, k: 2, q: 2, s: 2, x: 2, z: 2, d: 3, t: 3, l: 4, m: 5, n: 5, r: 6 };
  const first = word[0];
  let previous = map[first] || 0;
  let code = first;
  for (const char of word.slice(1)) {
    const digit = map[char] || 0;
    if (digit && digit !== previous) code += digit;
    previous = digit;
  }
  return `${code}000`.slice(0, 4);
}

function collapseMatches(matches) {
  const result = [];
  for (const match of matches) {
    const previous = result.at(-1);
    if (previous?.card.id === match.card.id && match.segment.start - previous.segment.start < 30) {
      if (match.confidence > previous.confidence) previous.confidence = match.confidence;
    } else result.push(match);
  }
  return result;
}

function groupMatches(matches, maximumSpan = 8) {
  const groups = [];
  for (const match of matches) {
    const current = groups.at(-1);
    const first = current?.[0];
    if (first && first.segment.sourceIndex === match.segment.sourceIndex && match.segment.start - first.segment.start <= maximumSpan) current.push(match);
    else groups.push([match]);
  }
  return groups;
}

function uniqueOptions(matches) {
  const byId = new Map();
  for (const match of matches) {
    const current = byId.get(match.card.id);
    if (!current || match.confidence > current.confidence) byId.set(match.card.id, match);
  }
  return [...byId.values()].map((match) => ({
    cardId: match.card.id,
    cardName: match.card.name,
    confidence: Number(match.confidence.toFixed(3)),
    needsReview: match.confidence < 0.94,
    card: compactCard(match.card)
  }));
}

function attachIncidentalMentions(cues, matches) {
  const mentionCues = [];
  for (const group of groupMatches(matches)) {
    const start = group[0].segment.start;
    const cue = cues.find((candidate) => candidate.start <= start && (candidate.end == null || start < candidate.end));
    const cards = uniqueOptions(group);
    if (!cards.length) continue;
    if (cue) {
      cue.mentions ||= [];
      cue.mentions.push({ start, cards });
    }
    const [first] = cards;
    mentionCues.push({
      track: "mentioned",
      start,
      end: start + 30,
      cardId: first.cardId,
      cardName: first.cardName,
      confidence: first.confidence,
      needsReview: first.needsReview,
      card: first.card,
      ...(cards.length > 1 ? { cards } : {})
    });
  }
  return mentionCues;
}

function analysisMatches(analysis, cards, role) {
  const byName = new Map(cards.map((card) => [normalize(card.name), card]));
  const matches = (analysis.mentions || []).filter((mention) => mention.role === role).flatMap((mention) => {
    const card = byName.get(normalize(mention.canonicalName));
    const start = Number(mention.startSeconds);
    if (!card || !Number.isFinite(start)) return [];
    return [{
      segment: { start, end: start, text: mention.evidence || mention.spokenText || mention.canonicalName, sourceIndex: start },
      card,
      confidence: Math.min(Number(mention.confidence) || 0, Number(mention.catalogueConfidence) || 1),
    }];
  }).sort((a, b) => a.segment.start - b.segment.start);
  if (role !== "main") return matches;
  const transitions = [];
  let previousCardId = null;
  for (const match of matches) {
    if (match.card.id === previousCardId) continue;
    transitions.push(match);
    previousCardId = match.card.id;
  }
  return transitions;
}

function compactCard(card) {
  return {
    name: card.name,
    manaCost: card.mana_cost,
    typeLine: card.type_line,
    oracleText: card.oracle_text,
    image: card.image_uris?.normal,
    faces: card.card_faces?.map((face) => ({ name: face.name, manaCost: face.mana_cost, typeLine: face.type_line, oracleText: face.oracle_text, image: face.image_uris?.normal }))
  };
}

function normalize(text) { return text.toLowerCase().normalize("NFKD").replace(/[\u0300-\u036f]/g, "").replace(/[^a-z0-9]+/g, " ").trim(); }
function srtTime(value) { const [clock, ms] = value.trim().split(","); const [hours, minutes, seconds] = clock.split(":").map(Number); return hours * 3600 + minutes * 60 + seconds + Number(ms) / 1000; }
function parseArgs(values) { const parsed = {}; for (let index = 0; index < values.length; index += 1) { const key = values[index]; if (key.startsWith("--")) parsed[key.slice(2)] = values[index + 1]?.startsWith("--") ? true : values[++index]; } return parsed; }
function usage() { console.error("Usage: npm run process-episode -- --url AUDIO_URL --output dist/data/episode.cues.json [--sets hob,hoc]\n   or: npm run process-episode -- --audio episode.mp3 --output dist/data/episode.cues.json\n   or: npm run process-episode -- --transcript episode.srt --catalogue AtomicCards.json --sets all --exact-only [--approved-cards review.json] --output dist/data/episode.cues.json\n   or: npm run process-episode -- --transcript episode.json --analysis reviews/episode.llm-card-analysis.json --sets all --approved-cards reviewed.json --incidental-cards mentions.json --output cues.json\n   or: npm run process-episode -- --transcript episode.json --sets all --base-cues existing.cues.json --incidental-cards reviewed-side-cards.json --output enriched.cues.json"); process.exit(1); }
