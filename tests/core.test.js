import test from "node:test";
import assert from "node:assert/strict";
import { cueAtTime, recentCues, cardImage, formatTime } from "../dist/core.js";

const cues = [
  { start: 10, end: 20, cardId: "a", card: { image: "a.jpg" } },
  { start: 20, end: 30, cardId: "b", card: { image: "b.jpg" } },
  { start: 35, end: 40, cardId: "c", card: { faces: [{ image: "c.jpg" }] } }
];

test("selects cues at boundaries and respects gaps", () => {
  assert.equal(cueAtTime(cues, 9), null);
  assert.equal(cueAtTime(cues, 10)?.cardId, "a");
  assert.equal(cueAtTime(cues, 20)?.cardId, "b");
  assert.equal(cueAtTime(cues, 32), null);
  assert.equal(cueAtTime(cues, 35)?.cardId, "c");
  assert.equal(cueAtTime(cues, 40), null);
});

test("returns the five most recent distinct cards", () => {
  const repeated = [...cues, { start: 41, end: 45, cardId: "b", card: {} }];
  assert.deepEqual(recentCues(repeated, 50).map((cue) => cue.cardId), ["b", "c", "a"]);
});

test("falls back to a face image and formats long time", () => {
  assert.equal(cardImage(cues[2].card), "c.jpg");
  assert.equal(formatTime(9721), "2:42:01");
});
