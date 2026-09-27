import test from "node:test";
import assert from "node:assert/strict";
import { applyResolvedCard, compactScryfallCard, scryfallApiUrl } from "../scripts/review-resolution-core.mjs";

const card = {
  id: "printing-id",
  oracle_id: "oracle-id",
  name: "Mishra's Bauble",
  mana_cost: "{0}",
  type_line: "Artifact",
  oracle_text: "Look at the top card.",
  image_uris: { normal: "https://cards.example/bauble.jpg" }
};

test("converts Scryfall page links to card API links", () => {
  assert.equal(
    scryfallApiUrl("https://scryfall.com/card/2xm/274/mishras-bauble"),
    "https://api.scryfall.com/cards/2xm/274"
  );
});
test("inserts resolved cards and recalculates cue bounds", () => {
  const cues = [
    { start: 10, cardId: "a", cardName: "Alpha", confidence: 1, needsReview: false, card: {} },
    { start: 30, cardId: "b", cardName: "Beta", confidence: 1, needsReview: false, card: {} }
  ];
  applyResolvedCard(cues, card, [20]);
  assert.deepEqual(cues.map((cue) => [cue.start, cue.end, cue.cardName]), [
    [10, 20, "Alpha"], [20, 30, "Mishra's Bauble"], [30, undefined, "Beta"]
  ]);
  assert.equal(cues[1].card.image, "https://cards.example/bauble.jpg");
});

test("groups simultaneous cards and coalesces repeat mentions", () => {
  const cues = [{ start: 20, cardId: "a", cardName: "Alpha", confidence: 1, needsReview: false, card: {} }];
  applyResolvedCard(cues, card, [20, 25, 55]);
  assert.equal(cues.length, 2);
  assert.deepEqual(cues[0].cards.map((option) => option.cardName), ["Alpha", "Mishra's Bauble"]);
  assert.equal(cues[1].start, 55);
  assert.equal(compactScryfallCard(card).cardId, "oracle-id");
});
