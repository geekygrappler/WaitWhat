export function cueAtTime(cues, time) {
  cues = primaryCues(cues);
  let lo = 0;
  let hi = cues.length - 1;
  let candidate = null;
  while (lo <= hi) {
    const mid = Math.floor((lo + hi) / 2);
    if (cues[mid].start <= time) {
      candidate = cues[mid];
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  if (!candidate) return null;
  return candidate.end == null || time < candidate.end ? candidate : null;
}

export function primaryCues(cues) {
  return (cues || []).filter((cue) => cue.track !== "mentioned");
}

export function mentionedCues(cues) {
  const result = [];
  const seen = new Set();
  const add = (cue) => {
    const key = `${cue.start}:${cardsForCue(cue).map((card) => card.cardId).join(",")}`;
    if (!seen.has(key)) {
      seen.add(key);
      result.push(cue);
    }
  };
  for (const cue of cues || []) {
    if (cue.track === "mentioned") add(cue);
    for (const mention of cue.mentions || []) {
      const [first] = mention.cards || [];
      if (!first) continue;
      add({ track: "mentioned", start: mention.start, end: mention.start + 30, cardId: first.cardId, cardName: first.cardName, card: first.card, ...(mention.cards.length > 1 ? { cards: mention.cards } : {}) });
    }
  }
  return result.sort((a, b) => a.start - b.start);
}

export function recentCues(cues, time, limit = 5) {
  const seen = new Set();
  const result = [];
  for (let i = cues.length - 1; i >= 0; i -= 1) {
    const cue = cues[i];
    if (cue.start >= time || cue.end == null || cue.end > time || seen.has(cue.cardId)) continue;
    seen.add(cue.cardId);
    result.push(cue);
    if (result.length === limit) break;
  }
  return result;
}

export function upcomingCues(cues, time, limit = 5) {
  const seen = new Set();
  const result = [];
  for (const cue of cues) {
    if (cue.start <= time || seen.has(cue.cardId)) continue;
    seen.add(cue.cardId);
    result.push(cue);
    if (result.length === limit) break;
  }
  return result;
}

export function cardImage(card) {
  return card?.image || card?.faces?.find((face) => face.image)?.image || "";
}

export function cardsForCue(cue) {
  if (!cue) return [];
  return cue.cards?.length ? cue.cards : [{ cardId: cue.cardId, cardName: cue.cardName, card: cue.card }];
}

export function mentionedCardsAtTime(cues, time, windowSeconds = 30) {
  if (!Number.isFinite(time) || !Number.isFinite(windowSeconds) || windowSeconds <= 0) return [];
  const primaryIds = new Set(cardsForCue(cueAtTime(cues, time)).map((option) => option.cardId));
  const latestByCard = new Map();
  for (const cue of mentionedCues(cues)) {
    if (cue.start > time || time >= cue.start + windowSeconds) continue;
    for (const option of cardsForCue(cue)) {
      if (!option?.cardId || primaryIds.has(option.cardId)) continue;
      const current = latestByCard.get(option.cardId);
      if (!current || current.mentionedAt <= cue.start) latestByCard.set(option.cardId, { ...option, mentionedAt: cue.start });
    }
  }
  return [...latestByCard.values()].sort((a, b) => a.mentionedAt - b.mentionedAt);
}

export function formatTime(value) {
  if (!Number.isFinite(value)) return "0:00";
  const seconds = Math.max(0, Math.floor(value));
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const rest = String(seconds % 60).padStart(2, "0");
  return hours ? `${hours}:${String(minutes).padStart(2, "0")}:${rest}` : `${minutes}:${rest}`;
}

export function resumablePosition(position, duration) {
  if (!Number.isFinite(position) || position <= 0) return 0;
  if (!Number.isFinite(duration) || duration <= 0) return position;
  const bounded = Math.min(position, duration);
  const completionWindow = Math.min(15, duration * 0.02);
  return duration - bounded <= completionWindow ? 0 : bounded;
}
