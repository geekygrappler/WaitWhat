import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
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

test("processor prefers a card's original printing over alternate-art reprints", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "cardcast-printing-test-"));
  const output = path.join(directory, "cues.json");
  const transcript = path.join(directory, "transcript.srt");
  const catalogue = path.join(directory, "catalogue.json");
  await writeFile(transcript, "1\n00:00:01,000 --> 00:00:03,000\nKrark-Clan Ironworks\n");
  await writeFile(catalogue, JSON.stringify([
    {
      id: "secret-lair",
      name: "Krark-Clan Ironworks",
      lang: "en",
      set: "slc",
      released_at: "2025-11-03",
      reprint: true,
      full_art: true,
      border_color: "borderless",
      image_status: "highres_scan",
      image_uris: { normal: "https://cards.example/secret-lair.jpg" }
    },
    {
      id: "fifth-dawn",
      name: "Krark-Clan Ironworks",
      lang: "en",
      set: "5dn",
      released_at: "2004-06-04",
      reprint: false,
      full_art: false,
      border_color: "black",
      image_status: "highres_scan",
      image_uris: { normal: "https://cards.example/fifth-dawn.jpg" }
    }
  ]));
  const run = spawnSync(process.execPath, [
    "scripts/process-episode.mjs",
    "--transcript", transcript,
    "--catalogue", catalogue,
    "--sets", "all",
    "--exact-only",
    "--output", output
  ], { cwd: process.cwd(), encoding: "utf8" });
  assert.equal(run.status, 0, run.stderr);
  const cues = JSON.parse(await readFile(output, "utf8"));
  assert.equal(cues[0].cardId, "fifth-dawn");
  assert.equal(cues[0].card.image, "https://cards.example/fifth-dawn.jpg");
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

test("processor keeps exact incidental cards in a distinct timestamped track", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "cardcast-mentions-test-"));
  const output = path.join(directory, "cues.json");
  const approved = path.join(directory, "approved.json");
  const oneWord = path.join(directory, "one-word.json");
  await writeFile(approved, JSON.stringify(["Gavi, Nest Warden"]));
  await writeFile(oneWord, JSON.stringify(["Forest"]));
  const run = spawnSync(process.execPath, [
    "scripts/process-episode.mjs",
    "--transcript", "fixtures/matcher-word-timestamps.json",
    "--catalogue", "fixtures/matcher-mtgjson.json",
    "--sets", "all",
    "--exact-only",
    "--approved-cards", approved,
    "--one-word-allowlist", oneWord,
    "--output", output
  ], { cwd: process.cwd(), encoding: "utf8" });
  assert.equal(run.status, 0, run.stderr);
  const cues = JSON.parse(await readFile(output, "utf8"));
  assert.equal(cues.length, 2);
  const main = cues.find((cue) => cue.track !== "mentioned");
  const mentioned = cues.find((cue) => cue.track === "mentioned");
  assert.equal(main.cardName, "Gavi, Nest Warden");
  assert.equal(main.mentions[0].start, 13.4);
  assert.deepEqual(main.mentions[0].cards.map((option) => option.cardName), ["Arcane Signet", "Forest"]);
  assert.equal(mentioned.start, 13.4);
  assert.deepEqual(mentioned.cards.map((option) => option.cardName), ["Arcane Signet", "Forest"]);
  await rm(directory, { recursive: true, force: true });
});

test("processor uses classified analysis timestamps instead of every repeated transcript match", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "cardcast-analysis-track-test-"));
  const output = path.join(directory, "cues.json");
  const approved = path.join(directory, "approved.json");
  const incidental = path.join(directory, "incidental.json");
  const analysis = path.join(directory, "analysis.json");
  const oneWord = path.join(directory, "one-word.json");
  await writeFile(approved, JSON.stringify(["Gavi, Nest Warden"]));
  await writeFile(incidental, JSON.stringify(["Arcane Signet", "Forest", "Opt"]));
  await writeFile(oneWord, JSON.stringify([]));
  await writeFile(analysis, JSON.stringify({ mentions: [
    { canonicalName: "Gavi, Nest Warden", role: "main", startSeconds: 9.5, confidence: 0.99, catalogueConfidence: 1 },
    { canonicalName: "Arcane Signet", role: "incidental", startSeconds: 13.4, confidence: 0.98, catalogueConfidence: 1 },
    { canonicalName: "Forest", role: "incidental", startSeconds: 13.4, confidence: 0.97, catalogueConfidence: 1 },
    { canonicalName: "Opt", role: "incidental", startSeconds: 13.4, confidence: 0.96, catalogueConfidence: 1 },
  ] }));
  const run = spawnSync(process.execPath, [
    "scripts/process-episode.mjs",
    "--transcript", "fixtures/matcher-word-timestamps.json",
    "--catalogue", "fixtures/matcher-mtgjson.json",
    "--sets", "all",
    "--analysis", analysis,
    "--approved-cards", approved,
    "--incidental-cards", incidental,
    "--one-word-allowlist", oneWord,
    "--output", output,
  ], { cwd: process.cwd(), encoding: "utf8" });
  assert.equal(run.status, 0, run.stderr);
  const cues = JSON.parse(await readFile(output, "utf8"));
  assert.deepEqual(cues.map((cue) => [cue.track || "main", cue.cardName, cue.start]), [
    ["main", "Gavi, Nest Warden", 9.5],
    ["mentioned", "Arcane Signet", 13.4],
  ]);
  assert.deepEqual(cues[1].cards.map((card) => card.cardName), ["Arcane Signet", "Forest", "Opt"]);
  await rm(directory, { recursive: true, force: true });
});

test("processor enriches a reviewed base cue sheet without changing its main timeline", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "cardcast-base-cues-test-"));
  const output = path.join(directory, "cues.json");
  const baseCues = path.join(directory, "base-cues.json");
  const incidental = path.join(directory, "incidental.json");
  const original = [{
    start: 8,
    cardId: "primary-id",
    cardName: "Reviewed Primary",
    confidence: 1,
    needsReview: false,
    card: { name: "Reviewed Primary", oracleText: "Keep me unchanged." },
    mentions: [{ start: 9, cards: [{ cardId: "stale", cardName: "Stale" }] }]
  }];
  await writeFile(baseCues, JSON.stringify(original));
  await writeFile(incidental, JSON.stringify(["Arcane Signet", "Forest"]));
  const run = spawnSync(process.execPath, [
    "scripts/process-episode.mjs",
    "--transcript", "fixtures/matcher-word-timestamps.json",
    "--catalogue", "fixtures/matcher-mtgjson.json",
    "--sets", "all",
    "--base-cues", baseCues,
    "--incidental-cards", incidental,
    "--output", output
  ], { cwd: process.cwd(), encoding: "utf8" });
  assert.equal(run.status, 0, run.stderr);
  const cues = JSON.parse(await readFile(output, "utf8"));
  assert.deepEqual({ ...cues[0], mentions: undefined }, { ...original[0], mentions: undefined });
  assert.equal(cues[0].mentions[0].start, 13.4);
  assert.deepEqual(cues[0].mentions[0].cards.map((option) => option.cardName), ["Arcane Signet", "Forest"]);
  await rm(directory, { recursive: true, force: true });
});

test("processor keeps multiple fuzzy incidental matches alongside an exact match in one segment", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "cardcast-many-mentions-test-"));
  const output = path.join(directory, "cues.json");
  const baseCues = path.join(directory, "base-cues.json");
  const incidental = path.join(directory, "incidental.json");
  const transcript = path.join(directory, "transcript.json");
  const catalogue = path.join(directory, "catalogue.json");
  await writeFile(baseCues, JSON.stringify([{ start: 0, cardId: "primary", cardName: "Primary", card: { name: "Primary" } }]));
  await writeFile(incidental, JSON.stringify(["Skullclamp", "Witch's Oven", "Stridehangar Automaton", "Brainstorm"]));
  await writeFile(transcript, JSON.stringify({ segments: [{
    start: 10,
    end: 15,
    text: "one skull clamp, one witch's oven, one stride hanger automaton",
    words: [
      { word: "one", start: 10 }, { word: "skull", start: 10.2 }, { word: "clamp", start: 10.6 },
      { word: "one", start: 11.2 }, { word: "witch's", start: 11.4 }, { word: "oven", start: 11.9 },
      { word: "one", start: 12.2 }, { word: "stride", start: 12.4 }, { word: "hanger", start: 12.8 },
      { word: "automaton", start: 13.2 }
    ]
  }, {
    start: 20,
    end: 22,
    text: "hook the search into your brainstem",
    words: [
      { word: "hook", start: 20 }, { word: "the", start: 20.2 }, { word: "search", start: 20.4 },
      { word: "into", start: 20.8 }, { word: "your", start: 21 }, { word: "brainstem", start: 21.2 }
    ]
  }] }));
  await writeFile(catalogue, JSON.stringify([
    { id: "skullclamp", name: "Skullclamp", lang: "en", set: "tst", oracle_text: "Draw cards." },
    { id: "oven", name: "Witch's Oven", lang: "en", set: "tst", oracle_text: "Bake." },
    { id: "automaton", name: "Stridehangar Automaton", lang: "en", set: "tst", oracle_text: "Make blockers." },
    { id: "brainstorm", name: "Brainstorm", lang: "en", set: "tst", oracle_text: "Draw three cards." }
  ]));
  const run = spawnSync(process.execPath, [
    "scripts/process-episode.mjs",
    "--transcript", transcript,
    "--catalogue", catalogue,
    "--sets", "all",
    "--base-cues", baseCues,
    "--incidental-cards", incidental,
    "--output", output
  ], { cwd: process.cwd(), encoding: "utf8" });
  assert.equal(run.status, 0, run.stderr);
  const cues = JSON.parse(await readFile(output, "utf8"));
  assert.deepEqual(cues[0].mentions[0].cards.map((option) => option.cardName), [
    "Skullclamp",
    "Witch's Oven",
    "Stridehangar Automaton"
  ]);
  assert.equal(cues[0].mentions[0].cards[0].confidence, 0.909);
  assert.equal(cues[0].mentions[0].cards[1].confidence, 1);
  assert.equal(cues[0].mentions[0].cards[2].confidence, 0.913);
  assert.equal(cues[0].mentions.length, 1);
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
  assert.deepEqual(cues[0].cards.map((option) => option.cardName), ["Gavi, Nest Warden", "Arcane Signet", "Forest"]);
  await rm(directory, { recursive: true, force: true });
});

test("processor can restrict ambiguous one-word card names to an allowlist", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "cardcast-one-word-test-"));
  const output = path.join(directory, "cues.json");
  const allowlist = path.join(directory, "one-word.json");
  await writeFile(allowlist, JSON.stringify(["Arcane Signet"]));
  const run = spawnSync(process.execPath, [
    "scripts/process-episode.mjs",
    "--transcript", "fixtures/matcher-word-timestamps.json",
    "--catalogue", "fixtures/matcher-mtgjson.json",
    "--sets", "all",
    "--exact-only",
    "--one-word-allowlist", allowlist,
    "--output", output
  ], { cwd: process.cwd(), encoding: "utf8" });
  assert.equal(run.status, 0, run.stderr);
  const cues = JSON.parse(await readFile(output, "utf8"));
  assert.deepEqual(cues[0].cards.map((option) => option.cardName), ["Gavi, Nest Warden", "Arcane Signet"]);
  await rm(directory, { recursive: true, force: true });
});

test("processor can block card names that are common speech", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "cardcast-blocklist-test-"));
  const output = path.join(directory, "cues.json");
  const blocklist = path.join(directory, "blocked.json");
  await writeFile(blocklist, JSON.stringify(["Arcane Signet"]));
  const run = spawnSync(process.execPath, [
    "scripts/process-episode.mjs",
    "--transcript", "fixtures/matcher-word-timestamps.json",
    "--catalogue", "fixtures/matcher-mtgjson.json",
    "--sets", "all",
    "--exact-only",
    "--blocked-cards", blocklist,
    "--output", output
  ], { cwd: process.cwd(), encoding: "utf8" });
  assert.equal(run.status, 0, run.stderr);
  const cues = JSON.parse(await readFile(output, "utf8"));
  assert.deepEqual(cues[0].cards.map((option) => option.cardName), ["Gavi, Nest Warden", "Forest"]);
  await rm(directory, { recursive: true, force: true });
});
