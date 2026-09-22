#!/usr/bin/env node
import { existsSync } from "node:fs";
import { createWriteStream } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import { Readable } from "node:stream";

const args = parseArgs(process.argv.slice(2));
if (!args.audio && !args.url && !args.transcript) usage();

const processingDir = path.resolve(args.workdir || "processing");
const cacheDir = path.resolve(args.cache || ".cache/scryfall");
await mkdir(processingDir, { recursive: true });
await mkdir(cacheDir, { recursive: true });

const audioPath = args.audio ? path.resolve(args.audio) : args.url ? await downloadAudio(args.url, processingDir) : null;
const transcriptPath = args.transcript ? path.resolve(args.transcript) : await transcribe(audioPath, processingDir, args.model || "turbo");
const segments = await loadSegments(transcriptPath);
const catalogue = await loadCatalogue(cacheDir, args.catalogue);
const setFilter = new Set((args.sets || "hob,hoc").split(",").map((set) => set.trim().toLowerCase()).filter(Boolean));
const cards = preferredCards(catalogue.filter((card) => card.lang === "en" && (!setFilter.size || setFilter.has(card.set))));
const threshold = Number(args.threshold || 0.84);
const matches = matchSegments(segments, cards, threshold);
const cues = collapseMatches(matches).map(({ segment, card, confidence }) => ({
  start: segment.start,
  cardId: card.id,
  cardName: card.name,
  confidence: Number(confidence.toFixed(3)),
  needsReview: confidence < 0.94,
  card: compactCard(card)
}));
cues.forEach((cue, index) => { cue.end = cues[index + 1]?.start; });

const output = path.resolve(args.output || "dist/data/generated.cues.json");
await writeFile(output, `${JSON.stringify(cues, null, 2)}\n`);
console.log(`Wrote ${cues.length} real-card cues to ${output}`);
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
    return text.replace(/^\uFEFF/, "").split(/\r?\n\r?\n/).map((block) => {
      const lines = block.split(/\r?\n/);
      const timing = lines.find((line) => line.includes(" --> "));
      if (!timing) return null;
      const [start, end] = timing.split(" --> ").map(srtTime);
      return { start, end, text: lines.slice(lines.indexOf(timing) + 1).join(" ") };
    }).filter(Boolean);
  }
  const json = JSON.parse(text);
  return (json.segments || json).map((segment) => ({ start: Number(segment.start), end: Number(segment.end), text: segment.text || "" }));
}

async function loadCatalogue(cache, suppliedPath) {
  if (suppliedPath) return JSON.parse(await readFile(path.resolve(suppliedPath), "utf8"));
  const destination = path.join(cache, "default-cards.json");
  if (!existsSync(destination)) {
    const metadataResponse = await fetch("https://api.scryfall.com/bulk-data/default-cards", { headers: { "user-agent": "CardcastCompanion/0.1" } });
    if (!metadataResponse.ok) throw new Error(`Scryfall metadata failed: ${metadataResponse.status}`);
    const metadata = await metadataResponse.json();
    const dataResponse = await fetch(metadata.download_uri, { headers: { "user-agent": "CardcastCompanion/0.1" } });
    if (!dataResponse.ok) throw new Error(`Scryfall bulk download failed: ${dataResponse.status}`);
    await writeFile(destination, Buffer.from(await dataResponse.arrayBuffer()));
  }
  return JSON.parse(await readFile(destination, "utf8"));
}

function preferredCards(cards) {
  const byName = new Map();
  for (const card of cards) {
    const current = byName.get(card.name);
    if (!current || (card.image_status === "highres_scan" && current.image_status !== "highres_scan")) byName.set(card.name, card);
  }
  return [...byName.values()].filter((card) => normalize(card.name.split(" // ")[0]).length >= 4);
}

function matchSegments(segments, cards, threshold) {
  const results = [];
  const matchableCards = cards.map((card) => {
    const primary = normalize(card.name.split(" // ")[0]);
    return { card, primary, phoneticKeys: new Set(primary.split(" ").map(soundex)) };
  });
  const cardsByPhoneticKey = new Map();
  for (const candidate of matchableCards) {
    for (const key of candidate.phoneticKeys) {
      const matches = cardsByPhoneticKey.get(key) || [];
      matches.push(candidate);
      cardsByPhoneticKey.set(key, matches);
    }
  }
  for (let index = 0; index < segments.length; index += 1) {
    const windowText = normalize(segments.slice(index, index + 3).map((segment) => segment.text).join(" "));
    let best = null;
    for (const candidate of matchableCards) {
      if (windowText.includes(candidate.primary) && (!best || candidate.primary.length > best.primary.length)) best = candidate;
    }
    if (best) {
      results.push({ segment: segments[index], card: best.card, confidence: 1 });
      continue;
    }
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
  return results;
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
function usage() { console.error("Usage: npm run process-episode -- --url AUDIO_URL --output dist/data/episode.cues.json [--sets hob,hoc]\n   or: npm run process-episode -- --audio episode.mp3 --output dist/data/episode.cues.json\n   or: npm run process-episode -- --transcript episode.srt --output dist/data/episode.cues.json"); process.exit(1); }
