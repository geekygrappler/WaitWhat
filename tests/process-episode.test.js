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
