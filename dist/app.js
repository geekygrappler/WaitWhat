import { cardImage, cueAtTime, formatTime, recentCues } from "./core.js";

const $ = (id) => document.getElementById(id);
const audio = $("audio");
const timeline = $("timeline");
const playButton = $("play");
const playIcon = $("play-icon");
const state = { episodes: [], episode: null, cues: [], activeCueId: null, scrubbing: false, toastTimer: null };

async function init() {
  const response = await fetch("./data/episodes.json");
  state.episodes = await response.json();
  renderEpisodeOptions();
  await loadEpisode(state.episodes.find((episode) => episode.processed));
  bindControls();
  reconcileFromAudio();

  if ("serviceWorker" in navigator) navigator.serviceWorker.register("./sw.js");
}

function renderEpisodeOptions() {
  $("episode-select").innerHTML = state.episodes.map((episode) =>
    `<option value="${escapeHtml(episode.id)}" ${episode.processed ? "" : "disabled"}>${escapeHtml(episode.title)}${episode.processed ? "" : " · processing pending"}</option>`
  ).join("");
}

async function loadEpisode(episode) {
  if (!episode?.processed) return;
  state.episode = episode;
  state.cues = await fetch(episode.cueSheet).then((response) => response.json());
  state.activeCueId = null;
  audio.src = episode.audioUrl;
  timeline.max = episode.duration;
  $("duration").textContent = formatTime(episode.duration);
  $("episode-title").textContent = episode.title;
  $("episode-art").src = episode.artwork;
  $("episode-art").alt = `${episode.title} artwork`;
  $("episode-status").textContent = "Hand-verified opening cue sheet";
  $("episode-select").value = episode.id;
  setupMediaSession(episode);
}

function bindControls() {
  playButton.addEventListener("click", togglePlayback);
  $("rewind").addEventListener("click", () => seekBy(-15));
  $("forward").addEventListener("click", () => seekBy(15));
  $("jump-first").addEventListener("click", () => seekTo(state.cues[0]?.start || 0, true));
  $("speed").addEventListener("change", (event) => { audio.playbackRate = Number(event.target.value); });
  $("episode-select").addEventListener("change", (event) => loadEpisode(state.episodes.find((item) => item.id === event.target.value)));

  timeline.addEventListener("pointerdown", () => { state.scrubbing = true; });
  timeline.addEventListener("input", () => {
    $("elapsed").textContent = formatTime(Number(timeline.value));
    renderAtTime(Number(timeline.value));
  });
  timeline.addEventListener("change", () => {
    audio.currentTime = Number(timeline.value);
    state.scrubbing = false;
    reconcileFromAudio();
  });

  ["loadedmetadata", "durationchange", "timeupdate", "seeking", "seeked", "play", "playing", "pause", "ratechange"].forEach((eventName) => {
    audio.addEventListener(eventName, reconcileFromAudio);
  });
  audio.addEventListener("ended", reconcileFromAudio);
  audio.addEventListener("error", () => showToast("Audio could not be loaded. Check your connection."));

  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") reconcileFromAudio();
  });
  window.addEventListener("pageshow", reconcileFromAudio);
  window.addEventListener("focus", reconcileFromAudio);
}

function togglePlayback() {
  if (audio.paused) {
    audio.play().catch(() => showToast("Tap play again to allow audio."));
  } else {
    audio.pause();
  }
}

function seekBy(delta) { seekTo((audio.currentTime || 0) + delta, !audio.paused); }

function seekTo(time, resume = false) {
  audio.currentTime = Math.max(0, Math.min(time, audio.duration || state.episode.duration));
  reconcileFromAudio();
  if (resume) audio.play().catch(() => {});
}

function reconcileFromAudio() {
  const time = Number.isFinite(audio.currentTime) ? audio.currentTime : 0;
  if (!state.scrubbing) timeline.value = time;
  $("elapsed").textContent = formatTime(time);
  if (Number.isFinite(audio.duration)) {
    timeline.max = audio.duration;
    $("duration").textContent = formatTime(audio.duration);
  }
  playIcon.textContent = audio.paused ? "▶" : "❚❚";
  playButton.setAttribute("aria-label", audio.paused ? "Play" : "Pause");
  renderAtTime(time);
  updatePositionState();
}

function renderAtTime(time) {
  const cue = cueAtTime(state.cues, time);
  const cueId = cue?.cardId || `empty-${Math.floor(time)}`;
  if (state.activeCueId !== cueId) {
    state.activeCueId = cueId;
    renderCard(cue);
  }
  renderRecent(time);
}

function renderCard(cue) {
  if (!cue) {
    $("card-stage").innerHTML = `<div class="empty-card"><div class="empty-card-glyph">⌁</div><h1 id="card-title">Between card mentions</h1><p>The verified milestone covers the opening review. Move to 1:33–30:19 to try the synced card experience.</p><button id="jump-first" class="text-button" type="button">Jump to first card · 1:33</button></div>`;
    $("jump-first").addEventListener("click", () => seekTo(state.cues[0]?.start || 0, true));
    return;
  }

  const card = cue.card;
  const rules = card.faces?.length
    ? card.faces.map((face) => `<div class="face"><h3>${escapeHtml(face.name)} <span class="mana">${escapeHtml(face.manaCost || "")}</span></h3><div class="face-meta">${escapeHtml(face.typeLine || "")}</div><p>${escapeHtml(face.oracleText || "")}</p></div>`).join("")
    : `<p class="oracle">${escapeHtml(card.oracleText || "")}</p>`;
  $("card-stage").innerHTML = `<article class="card-detail"><div class="card-image-wrap"><img class="card-image" src="${escapeHtml(cardImage(card))}" alt="${escapeHtml(card.name)} card image" /><span class="verified-badge">✓ Verified cue</span></div><div class="card-copy"><div class="card-title-row"><h1 id="card-title">${escapeHtml(card.name)}</h1><span class="mana">${escapeHtml(card.manaCost || "")}</span></div><p class="type-line">${escapeHtml(card.typeLine || "")}</p>${rules}</div></article>`;
}

function renderRecent(time) {
  const recent = recentCues(state.cues, time, 5);
  $("recent-list").innerHTML = recent.map((cue) => `<li class="recent-item"><button type="button" data-start="${cue.start}" aria-label="Jump to ${escapeHtml(cue.cardName)} at ${formatTime(cue.start)}"><img src="${escapeHtml(cardImage(cue.card))}" alt="" loading="lazy" /><span class="recent-name">${escapeHtml(shortName(cue.cardName))}</span><span class="recent-time">${formatTime(cue.start)}</span></button></li>`).join("");
  $("recent-empty").hidden = recent.length > 0;
  $("recent-list").querySelectorAll("button").forEach((button) => button.addEventListener("click", () => seekTo(Number(button.dataset.start), true)));
}

function setupMediaSession(episode) {
  if (!("mediaSession" in navigator)) return;
  navigator.mediaSession.metadata = new MediaMetadata({ title: episode.title, artist: "Legendary Creature Podcast", album: "Cardcast Companion" });
  navigator.mediaSession.setActionHandler("play", () => audio.play());
  navigator.mediaSession.setActionHandler("pause", () => audio.pause());
  navigator.mediaSession.setActionHandler("seekbackward", (details) => seekBy(-(details.seekOffset || 15)));
  navigator.mediaSession.setActionHandler("seekforward", (details) => seekBy(details.seekOffset || 15));
  navigator.mediaSession.setActionHandler("seekto", (details) => seekTo(details.seekTime || 0, !audio.paused));
}

function updatePositionState() {
  if (!("mediaSession" in navigator) || !Number.isFinite(audio.duration) || audio.duration <= 0) return;
  try { navigator.mediaSession.setPositionState({ duration: audio.duration, playbackRate: audio.playbackRate, position: Math.min(audio.currentTime, audio.duration) }); } catch {}
}

function showToast(message) {
  clearTimeout(state.toastTimer);
  $("toast").textContent = message;
  $("toast").classList.add("show");
  state.toastTimer = setTimeout(() => $("toast").classList.remove("show"), 2600);
}

function shortName(name) { return name.split(" // ")[0]; }
function escapeHtml(value = "") { return String(value).replace(/[&<>'"]/g, (char) => ({"&":"&amp;","<":"&lt;",">":"&gt;","'":"&#39;",'"':"&quot;"})[char]); }

init().catch((error) => {
  console.error(error);
  $("episode-status").textContent = "Could not load episode data";
});
