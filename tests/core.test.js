import test from "node:test";
import assert from "node:assert/strict";
import { cueAtTime, recentCues, upcomingCues, cardImage, cardsForCue, mentionedCardsAtTime, mentionedCues, primaryCues, formatTime, resumablePosition } from "../dist/core.js";

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
  assert.deepEqual(recentCues(cues, 22).map((cue) => cue.cardId), ["a"]);
});

test("returns upcoming distinct cards in chronological order", () => {
  const repeated = [...cues, { start: 41, end: 45, cardId: "b", card: {} }];
  assert.deepEqual(upcomingCues(repeated, 22).map((cue) => cue.cardId), ["c", "b"]);
  assert.deepEqual(upcomingCues(cues, 0, 2).map((cue) => cue.cardId), ["a", "b"]);
});

test("falls back to a face image and formats long time", () => {
  assert.equal(cardImage(cues[2].card), "c.jpg");
  assert.equal(formatTime(9721), "2:42:01");
});

test("exposes grouped and legacy cue cards through one interface", () => {
  assert.deepEqual(cardsForCue(cues[0]).map((option) => option.cardId), ["a"]);
  assert.deepEqual(cardsForCue({ cards: [{ cardId: "a" }, { cardId: "b" }] }).map((option) => option.cardId), ["a", "b"]);
});

test("offers incidental mentions for 30 seconds without changing the primary cue", () => {
  const mentioned = [{
    start: 10,
    end: 80,
    cardId: "a",
    card: {},
    mentions: [
      { start: 20, cards: [{ cardId: "y", cardName: "Y", card: {} }] },
      { start: 24, cards: [{ cardId: "z", cardName: "Z", card: {} }] }
    ]
  }];
  assert.deepEqual(mentionedCardsAtTime(mentioned, 19).map((card) => card.cardId), []);
  assert.deepEqual(mentionedCardsAtTime(mentioned, 24).map((card) => card.cardId), ["y", "z"]);
  assert.deepEqual(mentionedCardsAtTime(mentioned, 49.9).map((card) => card.cardId), ["y", "z"]);
  assert.deepEqual(mentionedCardsAtTime(mentioned, 50).map((card) => card.cardId), ["z"]);
  assert.deepEqual(mentionedCardsAtTime(mentioned, 54).map((card) => card.cardId), []);
  assert.equal(cueAtTime(mentioned, 24).cardId, "a");
  assert.deepEqual(mentionedCardsAtTime(mentioned, 24).map((card) => card.mentionedAt), [20, 24]);
});

test("deduplicates repeated mentions, extends their availability, and excludes the primary card", () => {
  const mentioned = [{
    start: 10,
    end: 100,
    cardId: "a",
    card: {},
    mentions: [
      { start: 20, cards: [{ cardId: "a", cardName: "A", card: {} }, { cardId: "y", cardName: "Y", card: {} }] },
      { start: 40, cards: [{ cardId: "y", cardName: "Y", card: {} }] }
    ]
  }];
  assert.deepEqual(mentionedCardsAtTime(mentioned, 45).map((card) => [card.cardId, card.mentionedAt]), [["y", 40]]);
  assert.deepEqual(mentionedCardsAtTime(mentioned, 70), []);
});

test("keeps main and also-mentioned timelines independent", () => {
  const tracked = [
    { start: 10, end: 50, cardId: "main", card: {} },
    { track: "mentioned", start: 20, end: 50, cardId: "side", cardName: "Side", card: {} },
  ];
  assert.deepEqual(primaryCues(tracked).map((cue) => cue.cardId), ["main"]);
  assert.deepEqual(mentionedCues(tracked).map((cue) => cue.cardId), ["side"]);
  assert.equal(cueAtTime(tracked, 25)?.cardId, "main");
  assert.deepEqual(mentionedCardsAtTime(tracked, 25).map((card) => card.cardId), ["side"]);
});

test("keeps useful playback positions and resets completed episodes", () => {
  assert.equal(resumablePosition(123.8, 3600), 123.8);
  assert.equal(resumablePosition(3590, 3600), 0);
  assert.equal(resumablePosition(59, 60), 0);
  assert.equal(resumablePosition(-2, 3600), 0);
  assert.equal(resumablePosition(42, Number.NaN), 42);
});
