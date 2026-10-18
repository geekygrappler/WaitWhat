#!/usr/bin/env node
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { analyzeTranscriptCards } from "./llm-card-analysis-core.mjs";
import { assertCodexSubscriptionLogin, requestCodexStructuredAnalysis } from "./codex-subscription-analysis.mjs";

const args = parseArgs(process.argv.slice(2));
for (const required of ["transcript", "title", "output", "main-cards", "incidental-cards"]) {
  if (!args[required]) usage(`Missing --${required}.`);
}
const model = String(args.model || process.env.WAITWHAT_LLM_MODEL || "gpt-6-astra");
const transcript = JSON.parse(await readFile(path.resolve(args.transcript), "utf8"));
const segments = transcript.segments || transcript;
if (!Array.isArray(segments)) throw new Error("Transcript must contain a segments array.");

await assertCodexSubscriptionLogin();

const analysis = await analyzeTranscriptCards({
  title: String(args.title),
  segments,
  model,
  chunkSeconds: Number(args["chunk-seconds"] || 1800),
  overlapSeconds: Number(args["overlap-seconds"] || 20),
  request: requestCodexStructuredAnalysis
});
analysis.runtime = "local-codex-cli";
analysis.authentication = "chatgpt-subscription";

for (const target of [args.output, args["main-cards"], args["incidental-cards"]]) {
  await mkdir(path.dirname(path.resolve(target)), { recursive: true });
}
await writeJson(path.resolve(args.output), analysis);
await writeJson(path.resolve(args["main-cards"]), analysis.mainCards);
await writeJson(path.resolve(args["incidental-cards"]), analysis.incidentalCards);
console.log(`Codex subscription analysis found ${analysis.mainCards.length} main cards and ${analysis.incidentalCards.length} incidental cards across ${analysis.mentions.length} occurrences.`);

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
function usage(message) {
  if (message) console.error(message);
  console.error("Usage: node scripts/analyze-transcript-cards.mjs --transcript processing/episode.mlx.json --title 'Episode title' --output reviews/episode.llm-card-analysis.json --main-cards reviews/episode.approved-cards.json --incidental-cards reviews/episode.incidental-cards.json [--model gpt-6-astra]");
  process.exit(1);
}
