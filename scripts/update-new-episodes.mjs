#!/usr/bin/env node
import { createWriteStream, existsSync } from "node:fs";
import { copyFile, mkdtemp, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import { Readable } from "node:stream";
import { episodeFilename, markEpisodeProcessed, newlyPublishedEpisodes } from "./episode-automation-core.mjs";

const root = path.resolve(new URL("..", import.meta.url).pathname);
const args = parseArgs(process.argv.slice(2));
const publish = Boolean(args.publish);
const branch = String(args.branch || "main");
const python = String(args.python || process.env.WAITWHAT_TRANSCRIBE_PYTHON || "python3");
const dataDirectory = path.join(root, "dist", "data");
const processingDirectory = path.join(root, "processing");
const temporaryDirectory = await mkdtemp(path.join(tmpdir(), "waitwhat-feeds-"));
const shows = JSON.parse(await readFile(path.join(dataDirectory, "shows.json"), "utf8"));

try {
  if (publish) {
    await requireCleanWorktree();
    const currentBranch = (await capture("git", ["branch", "--show-current"])).trim();
    if (currentBranch !== branch) throw new Error(`Publishing requires branch ${branch}; current branch is ${currentBranch || "detached HEAD"}.`);
    await run("git", ["pull", "--ff-only", "origin", branch]);
    if (Number((await capture("git", ["rev-list", "--count", `origin/${branch}..HEAD`])).trim())) {
      console.log("Pushing commits left by an earlier interrupted run.");
      await run("git", ["push", "origin", branch]);
    }
  }

  await run(process.execPath, [path.join(root, "scripts", "fetch-rss.mjs"), `--output-dir=${temporaryDirectory}`]);

  const feedStates = [];
  const work = [];
  for (const show of shows) {
    const filename = episodeFilename(show.id);
    const previous = JSON.parse(await readFile(path.join(dataDirectory, filename), "utf8"));
    const refreshedPath = path.join(temporaryDirectory, filename);
    const refreshed = JSON.parse(await readFile(refreshedPath, "utf8"));
    const discovered = newlyPublishedEpisodes(previous, refreshed);
    feedStates.push({ show, filename, refreshedPath, episodes: refreshed });
    for (const episode of discovered) work.push({ show, filename, episode });
  }

  if (!work.length) {
    console.log("No newly published episodes were found.");
    process.exitCode = 0;
  } else {
    await mkdir(processingDirectory, { recursive: true });
    await validateTranscriber(python);
    await run("npm", ["test"]);

    const completed = [];
    for (const [index, item] of work.entries()) {
      const { episode, show } = item;
      console.log(`[${index + 1}/${work.length}] Processing ${show.shortTitle}: ${episode.title}`);
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

      const cueFilename = `${episode.id}.cues.json`;
      const temporaryCue = path.join(temporaryDirectory, cueFilename);
      const processorArguments = [
        path.join(root, "scripts", "process-episode.mjs"),
        "--transcript", path.join(processingDirectory, `${episode.id}.mlx.json`),
        "--sets", "all",
        "--exact-only",
        "--threshold", "0.94",
        "--one-word-allowlist", path.join(root, "reviews", "automation-one-word-cards.json"),
        "--blocked-cards", path.join(root, "reviews", "automation-card-blocklist.json"),
        "--output", temporaryCue,
      ];
      const localCatalogue = path.join(root, "catalog", "AtomicCards.json");
      if (existsSync(localCatalogue)) processorArguments.push("--catalogue", localCatalogue);
      await run(process.execPath, processorArguments);
      const cues = JSON.parse(await readFile(temporaryCue, "utf8"));
      if (!Array.isArray(cues)) throw new Error(`Processor returned an invalid cue sheet for ${episode.id}.`);
      completed.push({ ...item, cueFilename, temporaryCue, cueCount: cues.length });
    }

    for (const result of completed) {
      const state = feedStates.find((entry) => entry.filename === result.filename);
      state.episodes = markEpisodeProcessed(state.episodes, result.episode, `./data/${result.cueFilename}`);
      await copyFile(result.temporaryCue, path.join(dataDirectory, result.cueFilename));
    }
    for (const state of feedStates) {
      await writeFile(path.join(dataDirectory, state.filename), `${JSON.stringify(state.episodes, null, 2)}\n`);
    }

    if (publish) {
      const paths = [
        ...new Set(feedStates.map((state) => path.join("dist", "data", state.filename))),
        ...completed.map((result) => path.join("dist", "data", result.cueFilename)),
      ];
      await run("git", ["add", "--", ...paths]);
      const title = completed.length === 1
        ? `feat: add ${completed[0].episode.title}`
        : `feat: add ${completed.length} new podcast episodes`;
      await run("git", ["commit", "-m", title]);
      await run("git", ["push", "origin", branch]);
      console.log("Published the episode update; GitHub Pages deployment is now queued.");
    } else {
      console.log("Episode files are ready locally. Re-run with --publish to commit and push them.");
    }

    for (const result of completed) console.log(`- ${result.show.shortTitle}: ${result.episode.title} (${result.cueCount} cues)`);
  }
} finally {
  await rm(temporaryDirectory, { recursive: true, force: true });
}

async function requireCleanWorktree() {
  const status = await capture("git", ["status", "--porcelain"]);
  if (status.trim()) throw new Error("Refusing to publish from a dirty worktree. Commit or stash existing changes first.");
}

async function validateTranscriber(command) {
  await run(command, ["-c", "import mlx, mlx_whisper"]);
}

async function download(url, destination) {
  if (existsSync(destination)) return;
  const partial = `${destination}.part`;
  let lastError;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      const response = await fetch(url, {
        headers: { "user-agent": "WaitWhatLCReviewHelper/0.2" },
        redirect: "follow",
        signal: AbortSignal.timeout(60_000),
      });
      if (!response.ok || !response.body) throw new Error(`Audio download failed: ${response.status}`);
      await pipeline(Readable.fromWeb(response.body), createWriteStream(partial));
      await rename(partial, destination);
      return;
    } catch (error) {
      lastError = error;
      await rm(partial, { force: true });
      console.warn(`Audio download attempt ${attempt}/3 failed for ${path.basename(destination)}: ${error.message}`);
    }
  }
  throw lastError;
}

function run(command, commandArgs, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, commandArgs, { cwd: root, stdio: "inherit", ...options });
    child.on("error", reject);
    child.on("exit", (code) => code === 0 ? resolve() : reject(new Error(`${command} exited with status ${code}`)));
  });
}

function capture(command, commandArgs) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, commandArgs, { cwd: root, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", reject);
    child.on("exit", (code) => code === 0 ? resolve(stdout) : reject(new Error(`${command} exited with status ${code}: ${stderr.trim()}`)));
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
