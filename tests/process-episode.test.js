import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

test("processor resolves fuzzy transcript text only to catalogue cards", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "cardcast-test-"));
  const output = path.join(directory, "cues.json");
  const run = spawnSync(process.execPath, [
    "scripts/process-episode.mjs",
    "--transcript", "fixtures/matcher-sample.srt",
    "--catalogue", "fixtures/matcher-catalogue.json",
    "--output", output,
    "--threshold", "0.84"
  ], { cwd: process.cwd(), encoding: "utf8" });
  assert.equal(run.status, 0, run.stderr);
  const cues = JSON.parse(await readFile(output, "utf8"));
  assert.deepEqual(cues.map((cue) => cue.cardName), ["Belladonna Took", "Kíli the Resourceful"]);
  assert.equal(cues[0].confidence, 1);
  assert.equal(cues[1].needsReview, true);
  await rm(directory, { recursive: true, force: true });
});

test("processor reads MTGJSON and timestamps a name split across captions at its first word", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "cardcast-mtgjson-test-"));
  const output = path.join(directory, "cues.json");
  const run = spawnSync(process.execPath, [
    "scripts/process-episode.mjs",
    "--transcript", "fixtures/matcher-split-name.srt",
    "--catalogue", "fixtures/matcher-mtgjson.json",
    "--sets", "all",
    "--exact-only",
    "--output", output
  ], { cwd: process.cwd(), encoding: "utf8" });
  assert.equal(run.status, 0, run.stderr);
  const cues = JSON.parse(await readFile(output, "utf8"));
  assert.equal(cues.length, 1);
  assert.equal(cues[0].cardName, "Gavi, Nest Warden");
  assert.equal(cues[0].start, 8);
  assert.match(cues[0].card.image, /api\.scryfall\.com\/cards\/named/);
  await rm(directory, { recursive: true, force: true });
});

test("processor limits matching to a reviewed card-name list", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "cardcast-approved-test-"));
  const output = path.join(directory, "cues.json");
  const run = spawnSync(process.execPath, [
    "scripts/process-episode.mjs",
    "--transcript", "fixtures/matcher-sample.srt",
    "--catalogue", "fixtures/matcher-catalogue.json",
    "--approved-cards", "fixtures/matcher-approved-cards.json",
    "--output", output
  ], { cwd: process.cwd(), encoding: "utf8" });
  assert.equal(run.status, 0, run.stderr);
  const cues = JSON.parse(await readFile(output, "utf8"));
  assert.deepEqual(cues.map((cue) => cue.cardName), ["Belladonna Took"]);
  await rm(directory, { recursive: true, force: true });
});

test("processor uses word timestamps when Whisper JSON provides them", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "cardcast-word-time-test-"));
  const output = path.join(directory, "cues.json");
  const run = spawnSync(process.execPath, [
    "scripts/process-episode.mjs",
    "--transcript", "fixtures/matcher-word-timestamps.json",
    "--catalogue", "fixtures/matcher-mtgjson.json",
    "--sets", "all",
    "--exact-only",
    "--output", output
  ], { cwd: process.cwd(), encoding: "utf8" });
  assert.equal(run.status, 0, run.stderr);
  const cues = JSON.parse(await readFile(output, "utf8"));
  assert.equal(cues[0].start, 12);
  assert.deepEqual(cues[0].cards.map((option) => option.cardName), ["Gavi, Nest Warden", "Arcane Signet"]);
  await rm(directory, { recursive: true, force: true });
});
