export function cueAtTime(cues, time) {
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

export function formatTime(value) {
  if (!Number.isFinite(value)) return "0:00";
  const seconds = Math.max(0, Math.floor(value));
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const rest = String(seconds % 60).padStart(2, "0");
  return hours ? `${hours}:${String(minutes).padStart(2, "0")}:${rest}` : `${minutes}:${rest}`;
}
