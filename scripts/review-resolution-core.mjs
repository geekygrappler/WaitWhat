export function reviewStarts(review) {
  return (Array.isArray(review.starts) ? review.starts : [review.start]).map(Number).filter(Number.isFinite);
}
export function compactScryfallCard(card) {
  return {
    cardId: card.oracle_id || card.id,
    cardName: card.name,
    confidence: 1,
    needsReview: false,
    card: {
      name: card.name,
      manaCost: card.mana_cost,
      typeLine: card.type_line,
      oracleText: card.oracle_text,
      image: card.image_uris?.normal,
      faces: card.card_faces?.map((face) => ({
        name: face.name,
        manaCost: face.mana_cost,
        typeLine: face.type_line,
        oracleText: face.oracle_text,
        image: face.image_uris?.normal
      }))
    }
  };
}

function optionsForCue(cue) {
  return cue.cards || [{
    cardId: cue.cardId,
    cardName: cue.cardName,
    confidence: cue.confidence,
    needsReview: cue.needsReview,
    card: cue.card
  }];
}

export function applyResolvedCard(cues, card, starts) {
  const option = compactScryfallCard(card);

  for (const start of starts) {
    const nearby = cues.find((cue) =>
      optionsForCue(cue).some((candidate) => candidate.cardId === option.cardId) &&
      Math.abs(cue.start - start) < 30
    );
    if (nearby) {
      nearby.start = Math.min(nearby.start, start);
      continue;
    }

    const simultaneous = cues.find((cue) => Math.abs(cue.start - start) < 0.01);
    if (simultaneous) {
      const options = optionsForCue(simultaneous);
      if (!options.some((candidate) => candidate.cardId === option.cardId)) simultaneous.cards = [...options, option];
      continue;
    }

    cues.push({ start, ...option });
  }

  cues.sort((left, right) => left.start - right.start);
  cues.forEach((cue, index) => {
    const end = cues[index + 1]?.start;
    if (end === undefined) delete cue.end;
    else cue.end = end;
  });
  return cues;
}

export function scryfallApiUrl(pageUrl) {
  const url = new URL(pageUrl);
  if (url.hostname !== "scryfall.com") throw new Error(`Not a Scryfall card link: ${pageUrl}`);
  const match = url.pathname.match(/^\/card\/([^/]+)\/([^/]+)/);
  if (!match) throw new Error(`Unrecognized Scryfall card link: ${pageUrl}`);
  return `https://api.scryfall.com/cards/${encodeURIComponent(match[1])}/${encodeURIComponent(match[2])}`;
}
