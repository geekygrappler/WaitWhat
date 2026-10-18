#!/usr/bin/env node
import { createWriteStream, existsSync } from "node:fs";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import { Readable } from "node:stream";
import { assertCodexSubscriptionLogin } from "./codex-subscription-analysis.mjs";

const root = path.resolve(new URL("..", import.meta.url).pathname);
const args = parseArgs(process.argv.slice(2));
const count = Number(args.count || 3);
const python = String(args.python || process.env.WAITWHAT_TRANSCRIBE_PYTHON || "python3");
const model = String(args.model || process.env.WAITWHAT_LLM_MODEL || "gpt-6-astra");
const forceAnalysis = Boolean(args["force-analysis"]);
const processingDirectory = path.join(root, "processing");
const reviewsDirectory = path.join(root, "reviews");
const dataDirectory = path.join(root, "dist", "data");

if (!Number.isInteger(count) || count < 1) throw new Error("--count must be a positive integer.");
await mkdir(processingDirectory, { recursive: true });
await mkdir(reviewsDirectory, { recursive: true });
await assertCodexSubscriptionLogin({ cwd: root });
await run(python, ["-c", "import mlx, mlx_whisper"]);

const shows = JSON.parse(await readFile(path.join(dataDirectory, "shows.json"), "utf8"));
const work = [];
for (const show of shows) {
  const episodesFilename = path.basename(show.episodesUrl);
  const episodesPath = path.join(dataDirectory, episodesFilename);
  const episodes = JSON.parse(await readFile(episodesPath, "utf8"));
  for (const episode of episodes.slice(0, count)) work.push({ show, episode, episodes, episodesPath });
}

const completed = [];
const failed = [];
for (const [index, item] of work.entries()) {
  const { show, episode } = item;
  console.log(`\n[${index + 1}/${work.length}] ${show.shortTitle}: ${episode.title}`);
  try {
    const transcriptPath = path.join(processingDirectory, `${episode.id}.mlx.json`);
    if (!existsSync(transcriptPath)) {
      const audioPath = path.join(processingDirectory, `${episode.id}.mp3`);
      await download(episode.audioUrl, audioPath);
      await run(python, [
        path.join(root, "scripts", "transcribe-episode-mlx.py"),
        "--root", root,
        "--audio", audioPath,
        "--slug", episode.id,
        "--title", episode.title,
        "--expected-duration", String(episode.duration),
      ]);
    }

    const analysisPath = path.join(reviewsDirectory, `${episode.id}.llm-card-analysis.json`);
    const mainCardsPath = path.join(reviewsDirectory, `${episode.id}.approved-cards.json`);
    const incidentalCardsPath = path.join(reviewsDirectory, `${episode.id}.incidental-cards.json`);
    const hasCompleteAnalysis = [analysisPath, mainCardsPath, incidentalCardsPath].every(existsSync);
    if (forceAnalysis || !hasCompleteAnalysis) {
      await run(process.execPath, [
        path.join(root, "scripts", "analyze-transcript-cards.mjs"),
        "--transcript", transcriptPath,
        "--title", episode.title,
        "--model", model,
        "--output", analysisPath,
        "--main-cards", mainCardsPath,
        "--incidental-cards", incidentalCardsPath,
      ]);
    } else {
      console.log("Reusing completed Codex card analysis.");
    }
    await run(process.execPath, [
      path.join(root, "scripts", "resolve-analysis-card-names.mjs"),
      "--analysis", analysisPath,
      "--main-cards", mainCardsPath,
      "--incidental-cards", incidentalCardsPath,
    ]);

    const cuePath = path.join(dataDirectory, `${episode.id}.cues.json`);
    const temporaryCuePath = `${cuePath}.new`;
    const processorArgs = [
      path.join(root, "scripts", "process-episode.mjs"),
      "--transcript", transcriptPath,
      "--sets", "all",
      "--threshold", "0.84",
      "--analysis", analysisPath,
      "--approved-cards", mainCardsPath,
      "--incidental-cards", incidentalCardsPath,
      "--one-word-allowlist", path.join(reviewsDirectory, "automation-one-word-cards.json"),
      "--blocked-cards", path.join(reviewsDirectory, "automation-card-blocklist.json"),
      "--output", temporaryCuePath,
    ];
    await run(process.execPath, processorArgs);

    const cues = JSON.parse(await readFile(temporaryCuePath, "utf8"));
    const analysis = JSON.parse(await readFile(analysisPath, "utf8"));
    const matchedMain = new Set(cues.filter((cue) => cue.track !== "mentioned").flatMap((cue) => cue.cards?.map((card) => card.cardName) || [cue.cardName]));
    const matchedIncidental = new Set(cues.filter((cue) => cue.track === "mentioned").flatMap((cue) => cue.cards?.map((card) => card.cardName) || [cue.cardName]));
    analysis.validation = {
      matchedMainCards: analysis.mainCards.filter((name) => matchedMain.has(name)),
      unmatchedMainCards: analysis.mainCards.filter((name) => !matchedMain.has(name)),
      matchedIncidentalCards: analysis.incidentalCards.filter((name) => matchedIncidental.has(name)),
      unmatchedIncidentalCards: analysis.incidentalCards.filter((name) => !matchedIncidental.has(name)),
    };
    await writeFile(analysisPath, `${JSON.stringify(analysis, null, 2)}\n`);
    await rename(temporaryCuePath, cuePath);

    const storedEpisode = item.episodes.find((candidate) => candidate.id === episode.id);
    storedEpisode.processed = true;
    storedEpisode.cueSheet = `./data/${episode.id}.cues.json`;
    await writeFile(item.episodesPath, `${JSON.stringify(item.episodes, null, 2)}\n`);
    completed.push({
      show: show.shortTitle,
      title: episode.title,
      cues: cues.filter((cue) => cue.track !== "mentioned").length,
      mentionCues: cues.filter((cue) => cue.track === "mentioned").length,
      main: analysis.mainCards.length,
      incidental: analysis.incidentalCards.length,
      unmatched: analysis.validation.unmatchedMainCards.length + analysis.validation.unmatchedIncidentalCards.length,
    });
  } catch (error) {
    failed.push({ show: show.shortTitle, title: episode.title, error: error.message });
    console.error(`Episode failed safely and can be retried: ${error.message}`);
  }
}

console.log("\nRecent episode reprocessing summary:");
for (const result of completed) console.log(`- ${result.show}: ${result.title} — ${result.cues} main cues, ${result.mentionCues} mentioned cues, ${result.main} main names, ${result.incidental} incidental names, ${result.unmatched} unmatched`);
for (const result of failed) console.log(`- FAILED ${result.show}: ${result.title} — ${result.error}`);
if (failed.length) process.exitCode = 1;

async function download(url, destination) {
  if (existsSync(destination)) return;
  const partial = `${destination}.part`;
  try {
    const response = await fetch(url, {
      headers: { "user-agent": "WaitWhatPodcasts/0.2" },
      redirect: "follow",
      signal: AbortSignal.timeout(120_000),
    });
    if (!response.ok || !response.body) throw new Error(`Audio download failed: ${response.status}`);
    await pipeline(Readable.fromWeb(response.body), createWriteStream(partial));
    await rename(partial, destination);
  } catch (error) {
    await rm(partial, { force: true });
    throw error;
  }
}

function run(command, commandArgs) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, commandArgs, { cwd: root, stdio: "inherit" });
    child.on("error", reject);
    child.on("exit", (code) => code === 0 ? resolve() : reject(new Error(`${command} exited with status ${code}`)));
  });
}

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
