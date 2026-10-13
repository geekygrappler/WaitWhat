export function episodeFilename(showId) {
  return showId === "legendary-creature" ? "episodes.json" : `${showId}.episodes.json`;
}

export function newlyPublishedEpisodes(previous, refreshed) {
  if (!previous.length) return [];
  const knownAudio = new Set(previous.map((episode) => episode.audioUrl));
  const newestKnown = Math.max(...previous.map((episode) => Date.parse(episode.published) || 0));
  return refreshed.filter((episode) =>
    !knownAudio.has(episode.audioUrl)
    && (Date.parse(episode.published) || 0) > newestKnown
  );
}

export function markEpisodeProcessed(episodes, target, cueSheet) {
  return episodes.map((episode) => episode.audioUrl === target.audioUrl
    ? { ...episode, cueSheet, processed: true }
    : episode);
}
