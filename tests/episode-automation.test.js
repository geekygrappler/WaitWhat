import test from "node:test";
import assert from "node:assert/strict";
import { episodeFilename, markEpisodeProcessed, newlyPublishedEpisodes } from "../scripts/episode-automation-core.mjs";

test("episode filenames match the public feed layout", () => {
  assert.equal(episodeFilename("legendary-creature"), "episodes.json");
  assert.equal(episodeFilename("mtggoldfish"), "mtggoldfish.episodes.json");
});

test("only episodes newer than the current feed head are treated as new", () => {
  const previous = [
    { audioUrl: "known", published: "2026-10-10T00:00:00.000Z" },
    { audioUrl: "older", published: "2026-10-01T00:00:00.000Z" },
  ];
  const refreshed = [
    { audioUrl: "new", published: "2026-10-11T00:00:00.000Z" },
    { audioUrl: "known", published: "2026-10-10T00:00:00.000Z" },
    { audioUrl: "backfill", published: "2026-09-01T00:00:00.000Z" },
  ];
  assert.deepEqual(newlyPublishedEpisodes(previous, refreshed).map((episode) => episode.audioUrl), ["new"]);
  assert.deepEqual(newlyPublishedEpisodes([], refreshed), []);
});

test("processed metadata points at the generated cue sheet", () => {
  const episodes = [{ audioUrl: "new", processed: false }, { audioUrl: "other", processed: false }];
  assert.deepEqual(markEpisodeProcessed(episodes, episodes[0], "./data/new.cues.json"), [
    { audioUrl: "new", processed: true, cueSheet: "./data/new.cues.json" },
    { audioUrl: "other", processed: false },
  ]);
});
