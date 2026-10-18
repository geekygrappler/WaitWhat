#!/usr/bin/env node
import { createReadStream, existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { createInterface } from "node:readline";
import { canonicalizeAnalysis } from "./card-name-resolution-core.mjs";

const args = parseArgs(process.argv.slice(2));
for (const required of ["analysis", "main-cards", "incidental-cards"]) if (!args[required]) throw new Error(`Missing --${required}.`);
const root = path.resolve(new URL("..", import.meta.url).pathname);
const cataloguePath = path.resolve(args.catalogue || path.join(root, ".cache", "scryfall", "default-cards.jsonl"));
const names = await loadNames(cataloguePath);
const analysisPath = path.resolve(args.analysis);
const analysis = canonicalizeAnalysis(JSON.parse(await readFile(analysisPath, "utf8")), names, Number(args.threshold || 0.78));
for (const target of [analysisPath, path.resolve(args["main-cards"]), path.resolve(args["incidental-cards"])]) await mkdir(path.dirname(target), { recursive: true });
await writeJson(analysisPath, analysis);
await writeJson(path.resolve(args["main-cards"]), analysis.mainCards);
await writeJson(path.resolve(args["incidental-cards"]), analysis.incidentalCards);
console.log(`Resolved ${analysis.mainCards.length} main and ${analysis.incidentalCards.length} incidental catalogue names; ${analysis.resolution.unresolvedMentions.length} occurrences remain unresolved.`);

async function loadNames(file) {
  if (!existsSync(file)) {
    const cachedCatalog = path.join(path.dirname(file), "card-names.json");
    if (existsSync(cachedCatalog)) return JSON.parse(await readFile(cachedCatalog, "utf8"));
    const response = await fetch("https://api.scryfall.com/catalog/card-names", { headers: { "user-agent": "WaitWhatPodcasts/0.2" }, signal: AbortSignal.timeout(60_000) });
    if (!response.ok) throw new Error(`Scryfall card-name catalogue failed: ${response.status}`);
    const names = (await response.json()).data;
    await mkdir(path.dirname(cachedCatalog), { recursive: true });
    await writeJson(cachedCatalog, names);
    return names;
  }
  if (file.endsWith(".jsonl")) {
    const names = new Set();
    const lines = createInterface({ input: createReadStream(file), crlfDelay: Infinity });
    for await (const line of lines) {
      if (!line) continue;
      const card = JSON.parse(line);
      if (card.lang === "en" && card.name) names.add(card.name);
    }
    return [...names];
  }
  const json = JSON.parse(await readFile(file, "utf8"));
  if (Array.isArray(json)) return [...new Set(json.filter((card) => card.lang === "en").map((card) => card.name).filter(Boolean))];
  return Object.keys(json.data || {});
}

async function writeJson(target, value) { await writeFile(target, `${JSON.stringify(value, null, 2)}\n`); }
function parseArgs(values) {
  const parsed = {};
  for (let index = 0; index < values.length; index += 1) {
    const raw = values[index];
    if (!raw.startsWith("--")) continue;
    const [name, inline] = raw.slice(2).split(/=(.*)/s, 2);
    parsed[name] = inline ?? (values[index + 1] && !values[index + 1].startsWith("--") ? values[++index] : true);
  }
  return parsed;
}
