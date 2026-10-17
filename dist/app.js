import { cardImage, cardsForCue, cueAtTime, formatTime, recentCues, resumablePosition, upcomingCues } from "./core.js?v=14";

const $ = (id) => document.getElementById(id);
const audio = $("audio");
const timeline = $("timeline");
const playButton = $("play");
const playIcon = $("play-icon");
const PLAYBACK_STORAGE_KEY = "wait-what-playback-v1";
const POSITION_SAVE_INTERVAL = 2000;
const state = { shows: [], show: null, episodes: [], episode: null, cues: [], activeCueId: null, activeCue: null, focusedCue: null, focusedFromPlaybackCueKey: null, cardOptionIndex: 0, recentSignature: "", upcomingSignature: "", scrubbing: false, toastTimer: null, restoringEpisodeId: null, lastPositionWriteAt: 0, lastPositionWritten: null };

async function init() {
  state.shows = await fetch("./data/shows.json").then(checkResponse).then((response) => response.json());
  renderShowNavigation();
  renderLanding();
  bindControls();

  const requestedShow = new URLSearchParams(location.search).get("show");
  if (state.shows.some((show) => show.id === requestedShow)) await openShow(requestedShow, { updateUrl: false });
  else showLanding({ updateUrl: false });

  if ("serviceWorker" in navigator) navigator.serviceWorker.register("./sw.js");
}

function renderShowNavigation() {
  $("show-select").innerHTML = `<option value="">All podcasts</option>${state.shows.map((show) => `<option value="${escapeHtml(show.id)}">${escapeHtml(show.shortTitle)}</option>`).join("")}`;
}

function renderLanding() {
  $("show-grid").innerHTML = state.shows.map((show) => `
    <a class="show-card" href="?show=${encodeURIComponent(show.id)}" data-show="${escapeHtml(show.id)}">
      <div class="show-card-mark" aria-hidden="true">${initials(show.shortTitle)}</div>
      <div><span class="show-card-label">Podcast feed</span><h2>${escapeHtml(show.title)}</h2><p>${escapeHtml(show.description)}</p><span class="show-card-action">Open show <span aria-hidden="true">→</span></span></div>
    </a>`).join("");
  $("show-grid").querySelectorAll("[data-show]").forEach((link) => link.addEventListener("click", (event) => {
    event.preventDefault();
    openShow(link.dataset.show);
  }));
}

async function openShow(showId, { updateUrl = true } = {}) {
  const show = state.shows.find((item) => item.id === showId);
  if (!show) return showLanding({ updateUrl });
  audio.pause();
  state.show = show;
  state.episodes = await fetch(show.episodesUrl).then(checkResponse).then((response) => response.json());
  $("landing").hidden = true;
  $("app-shell").hidden = false;
  $("player").hidden = false;
  $("episode-picker").hidden = false;
  $("show-select").value = show.id;
  $("brand-edition").textContent = show.shortTitle;
  document.title = `Wait, What? ${show.shortTitle}`;
  renderEpisodeOptions();
  const savedEpisodeId = savedEpisodeForShow(show.id);
  const initialEpisode = state.episodes.find((episode) => episode.id === savedEpisodeId) || state.episodes.find((episode) => episode.processed) || state.episodes[0];
  await loadEpisode(initialEpisode);
  if (updateUrl) history.pushState({ show: show.id }, "", `?show=${encodeURIComponent(show.id)}`);
}

function showLanding({ updateUrl = true } = {}) {
  audio.pause();
  audio.removeAttribute("src");
  state.show = null;
  state.episode = null;
  state.episodes = [];
  state.cues = [];
  $("landing").hidden = false;
  $("app-shell").hidden = true;
  $("player").hidden = true;
  $("episode-picker").hidden = true;
  $("show-select").value = "";
  $("brand-edition").textContent = "Magic podcast companion";
  document.title = "Wait, What? Magic Podcast Companion";
  if (updateUrl) history.pushState({}, "", location.pathname);
}

function renderEpisodeOptions() {
  $("episode-select").innerHTML = state.episodes.map((episode) =>
    `<option value="${escapeHtml(episode.id)}">${escapeHtml(episode.title)}${episode.processed ? "" : " · cards pending"}</option>`
  ).join("");
}

async function loadEpisode(episode) {
  if (!episode) return;
  audio.pause();
  state.episode = episode;
  rememberEpisode(episode.id);
  const resumePosition = savedPositionForEpisode(episode);
  state.restoringEpisodeId = resumePosition > 0 ? episode.id : null;
  state.lastPositionWriteAt = 0;
  state.lastPositionWritten = null;
  state.cues = episode.cueSheet ? await fetch(episode.cueSheet).then(checkResponse).then((response) => response.json()) : [];
  state.activeCueId = null;
  state.activeCue = null;
  state.focusedCue = null;
  state.focusedFromPlaybackCueKey = null;
  state.recentSignature = "";
  state.upcomingSignature = "";
  if (resumePosition > 0) {
    audio.addEventListener("loadedmetadata", () => restoreEpisodePosition(episode, resumePosition), { once: true });
  }
  audio.src = episode.audioUrl;
  timeline.max = episode.duration || 0;
  timeline.value = resumePosition;
  $("elapsed").textContent = formatTime(resumePosition);
  $("duration").textContent = formatTime(episode.duration);
  setEpisodeTitle(episode.title);
  $("episode-art").src = episode.artwork || state.show.artwork;
  $("episode-art").alt = `${episode.title} artwork`;
  $("episode-status").textContent = episode.processed ? "Reviewed full-episode cue sheet" : `${state.show.title} · card syncing pending`;
  $("episode-select").value = episode.id;
  $("app-shell").classList.toggle("cards-pending", !episode.processed);
  $("recent-panel").hidden = !episode.processed;
  renderAtTime(resumePosition);
  setupMediaSession(episode);
}

function bindControls() {
  playButton.addEventListener("click", togglePlayback);
  $("rewind").addEventListener("click", () => seekBy(-15));
  $("forward").addEventListener("click", () => seekBy(15));
  $("return-current").addEventListener("click", returnToCurrentCue);
  $("speed").addEventListener("change", (event) => { audio.playbackRate = Number(event.target.value); });
  $("episode-select").addEventListener("change", (event) => loadEpisode(state.episodes.find((item) => item.id === event.target.value)));
  $("show-select").addEventListener("change", (event) => event.target.value ? openShow(event.target.value) : showLanding());
  $("brand-link").addEventListener("click", (event) => { event.preventDefault(); showLanding(); });
  window.addEventListener("popstate", () => {
    const showId = new URLSearchParams(location.search).get("show");
    if (showId) openShow(showId, { updateUrl: false }); else showLanding({ updateUrl: false });
  });

  timeline.addEventListener("pointerdown", () => { state.scrubbing = true; });
  timeline.addEventListener("input", () => {
    clearFocusedCue();
    $("elapsed").textContent = formatTime(Number(timeline.value));
    renderAtTime(Number(timeline.value));
  });
  timeline.addEventListener("change", () => {
    audio.currentTime = Number(timeline.value);
    state.scrubbing = false;
    reconcileFromAudio();
  });

  ["loadedmetadata", "durationchange", "timeupdate", "seeking", "seeked", "play", "playing", "pause", "ratechange"].forEach((eventName) => audio.addEventListener(eventName, reconcileFromAudio));
  ["pause", "seeked", "ended"].forEach((eventName) => audio.addEventListener(eventName, () => persistPlaybackPosition(true)));
  audio.addEventListener("ended", reconcileFromAudio);
  audio.addEventListener("error", () => state.episode && showToast("Audio could not be loaded. Check your connection."));
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") persistPlaybackPosition(true);
    else reconcileFromAudio();
  });
  window.addEventListener("pagehide", () => persistPlaybackPosition(true));
  window.addEventListener("pageshow", reconcileFromAudio);
  window.addEventListener("focus", reconcileFromAudio);
  window.addEventListener("resize", () => state.episode && setEpisodeTitle(state.episode.title));
}

function togglePlayback() {
  if (audio.paused) audio.play().catch(() => showToast("Tap play again to allow audio."));
  else audio.pause();
}

function seekBy(delta) { seekTo((audio.currentTime || 0) + delta, !audio.paused); }
function seekTo(time, resume = false) {
  if (!state.episode) return;
  clearFocusedCue();
  audio.currentTime = Math.max(0, Math.min(time, audio.duration || state.episode.duration));
  reconcileFromAudio();
  if (resume) audio.play().catch(() => {});
}

function reconcileFromAudio() {
  if (!state.episode) return;
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
  persistPlaybackPosition();
}

function restoreEpisodePosition(episode, position) {
  if (state.episode?.id !== episode.id || state.restoringEpisodeId !== episode.id) return;
  const restored = resumablePosition(position, audio.duration || episode.duration);
  state.restoringEpisodeId = null;
  if (restored <= 0) return;
  audio.currentTime = restored;
  reconcileFromAudio();
  showToast(`Resumed at ${formatTime(restored)}`);
}

function readPlaybackState() {
  try {
    const saved = JSON.parse(localStorage.getItem(PLAYBACK_STORAGE_KEY));
    return saved && typeof saved === "object" && saved.shows && typeof saved.shows === "object" ? saved : { shows: {} };
  } catch {
    return { shows: {} };
  }
}

function writePlaybackState(saved) {
  try { localStorage.setItem(PLAYBACK_STORAGE_KEY, JSON.stringify(saved)); } catch {}
}

function savedEpisodeForShow(showId) {
  return readPlaybackState().shows[showId]?.episodeId || null;
}

function savedPositionForEpisode(episode) {
  const saved = readPlaybackState().shows[state.show.id]?.episodes?.[episode.id];
  return resumablePosition(Number(saved?.position), Number(saved?.duration) || Number(episode.duration));
}

function rememberEpisode(episodeId) {
  if (!state.show) return;
  const saved = readPlaybackState();
  const show = saved.shows[state.show.id] || { episodes: {} };
  show.episodeId = episodeId;
  show.episodes ||= {};
  saved.shows[state.show.id] = show;
  writePlaybackState(saved);
}

function persistPlaybackPosition(force = false) {
  if (!state.show || !state.episode || state.restoringEpisodeId === state.episode.id) return;
  const position = Number.isFinite(audio.currentTime) ? audio.currentTime : 0;
  const now = Date.now();
  if (!force && now - state.lastPositionWriteAt < POSITION_SAVE_INTERVAL && Math.abs(position - (state.lastPositionWritten ?? 0)) < 2) return;
  const duration = Number.isFinite(audio.duration) && audio.duration > 0 ? audio.duration : Number(state.episode.duration);
  const saved = readPlaybackState();
  const show = saved.shows[state.show.id] || { episodes: {} };
  show.episodeId = state.episode.id;
  show.episodes ||= {};
  show.episodes[state.episode.id] = {
    position: Math.floor(resumablePosition(position, duration)),
    duration: Number.isFinite(duration) ? duration : null,
    updatedAt: new Date(now).toISOString()
  };
  saved.shows[state.show.id] = show;
  writePlaybackState(saved);
  state.lastPositionWriteAt = now;
  state.lastPositionWritten = position;
}

function renderAtTime(time) {
  if (!state.episode?.processed) {
    if (state.activeCueId !== "pending") {
      state.activeCueId = "pending";
      renderPendingEpisode();
    }
    updateCardContext();
    return;
  }
  const cue = cueAtTime(state.cues, time);
  if (state.focusedCue && playbackCueKey(cue) !== state.focusedFromPlaybackCueKey) clearFocusedCue();
  if (!state.focusedCue) {
    const cueId = cue?.cardId || `empty-${Math.floor(time)}`;
    if (state.activeCueId !== cueId) {
      state.activeCueId = cueId;
      state.activeCue = cue;
      state.cardOptionIndex = 0;
      renderCard(cue);
    }
  }
  renderRecent(time);
  renderUpcoming(time);
  updateCardContext();
  syncCueListSelection();
}

function renderPendingEpisode() {
  $("card-stage").innerHTML = `<div class="pending-episode"><img src="${escapeHtml(state.episode.artwork || state.show.artwork)}" alt="" /><div><p class="section-kicker">Available to listen</p><h1 id="card-title">${escapeHtml(state.episode.title)}</h1><p>This episode is in the feed and ready to play. Its card cue sheet has not been processed yet, so synced cards will appear here later.</p></div></div>`;
}

function renderCard(cue) {
  const stage = $("card-stage");
  stage.onpointerdown = null;
  stage.onpointerup = null;
  stage.onpointercancel = null;
  if (!cue) {
    const firstCue = state.cues[0];
    stage.innerHTML = `<div class="empty-card"><div class="empty-card-glyph">⌁</div><h1 id="card-title">Between card mentions</h1><p>The reviewed cue sheet covers the full episode. Jump to the first card to try the synced experience.</p><button id="jump-first" class="text-button" type="button">Jump to first card · ${formatTime(firstCue?.start || 0)}</button></div>`;
    $("jump-first").addEventListener("click", () => seekTo(firstCue?.start || 0, true));
    return;
  }
  const options = cardsForCue(cue);
  state.cardOptionIndex = Math.max(0, Math.min(state.cardOptionIndex, options.length - 1));
  const selected = options[state.cardOptionIndex];
  const card = selected.card;
  const rules = card.faces?.length
    ? card.faces.map((face) => `<div class="face"><h3>${escapeHtml(face.name)} <span class="mana">${escapeHtml(face.manaCost || "")}</span></h3><div class="face-meta">${escapeHtml(face.typeLine || "")}</div><p>${escapeHtml(face.oracleText || "")}</p></div>`).join("")
    : `<p class="oracle">${escapeHtml(card.oracleText || "")}</p>`;
  const switcher = options.length > 1 ? `<div class="card-switcher" aria-label="Cards mentioned together"><button id="previous-card" type="button" aria-label="Show previous mentioned card">←</button><span aria-live="polite">${state.cardOptionIndex + 1} of ${options.length}</span><button id="next-card" type="button" aria-label="Show next mentioned card">→</button></div><p class="swipe-hint">Swipe left or right to switch cards</p>` : "";
  stage.innerHTML = `<article class="card-detail"><div class="card-image-wrap"><img class="card-image" src="${escapeHtml(cardImage(card))}" alt="${escapeHtml(card.name)} card image" /><span class="verified-badge">✓ Verified cue</span></div><div class="card-copy">${switcher}<div class="card-title-row"><h1 id="card-title">${escapeHtml(card.name)}</h1><span class="mana">${escapeHtml(card.manaCost || "")}</span></div><p class="type-line">${escapeHtml(card.typeLine || "")}</p>${rules}</div></article>`;
  if (options.length > 1) bindCardSwitcher(options.length);
}

function bindCardSwitcher(optionCount) {
  const stage = $("card-stage");
  const select = (delta) => {
    state.cardOptionIndex = (state.cardOptionIndex + delta + optionCount) % optionCount;
    renderCard(state.activeCue);
  };
  $("previous-card").addEventListener("click", () => select(-1));
  $("next-card").addEventListener("click", () => select(1));
  let swipeStart = null;
  stage.onpointerdown = (event) => {
    if (event.target.closest("button")) return;
    if (event.pointerType !== "mouse" || event.button === 0) {
      swipeStart = { x: event.clientX, y: event.clientY };
      try { stage.setPointerCapture(event.pointerId); } catch {}
    }
  };
  stage.onpointerup = (event) => {
    if (!swipeStart) return;
    const horizontal = event.clientX - swipeStart.x;
    const vertical = event.clientY - swipeStart.y;
    swipeStart = null;
    if (Math.abs(horizontal) < 48 || Math.abs(horizontal) <= Math.abs(vertical)) return;
    select(horizontal < 0 ? 1 : -1);
  };
  stage.onpointercancel = () => { swipeStart = null; };
}

function renderRecent(time) {
  const recent = recentCues(state.cues, time, 5);
  const signature = recent.map((cue) => `${cue.start}:${cue.cardId}`).join("|");
  if (signature === state.recentSignature) return;
  state.recentSignature = signature;
  renderCueList("recent-list", recent);
  $("recent-empty").hidden = recent.length > 0;
}
function renderUpcoming(time) {
  const upcoming = upcomingCues(state.cues, time, 5);
  const signature = upcoming.map((cue) => `${cue.start}:${cue.cardId}`).join("|");
  if (signature === state.upcomingSignature) return;
  state.upcomingSignature = signature;
  renderCueList("upcoming-list", upcoming);
  $("upcoming-empty").hidden = upcoming.length > 0;
}
function renderCueList(listId, cues) {
  const list = $(listId);
  list.innerHTML = cues.map((cue) => `<li class="recent-item"><button class="cue-preview" type="button" data-start="${cue.start}" aria-label="Show ${escapeHtml(cue.cardName)} without changing playback" aria-pressed="false"><img src="${escapeHtml(cardImage(cue.card))}" alt="" loading="lazy" /><span class="recent-name">${escapeHtml(shortName(cue.cardName))}${cardsForCue(cue).length > 1 ? ` <small>+${cardsForCue(cue).length - 1}</small>` : ""}</span></button><button class="cue-jump" type="button" aria-label="Skip to the mention of ${escapeHtml(cue.cardName)} at ${formatTime(cue.start)}"><span>Skip to</span><span class="recent-time">${formatTime(cue.start)}</span></button></li>`).join("");
  list.querySelectorAll(".cue-preview").forEach((button, index) => button.addEventListener("click", () => focusCue(cues[index])));
  list.querySelectorAll(".cue-jump").forEach((button, index) => button.addEventListener("click", () => seekTo(cues[index].start, true)));
}

function focusCue(cue) {
  state.focusedCue = cue;
  state.focusedFromPlaybackCueKey = playbackCueKey(cueAtTime(state.cues, Number(audio.currentTime) || 0));
  state.activeCueId = `focused-${cue.start}-${cue.cardId}`;
  state.activeCue = cue;
  state.cardOptionIndex = 0;
  renderCard(cue);
  updateCardContext();
  syncCueListSelection();
}

function returnToCurrentCue() {
  clearFocusedCue();
  renderAtTime(Number(audio.currentTime) || 0);
  $("card-stage").focus({ preventScroll: true });
}

function clearFocusedCue() {
  state.focusedCue = null;
  state.focusedFromPlaybackCueKey = null;
}

function playbackCueKey(cue) {
  return cue ? `${cue.start}:${cue.cardId}` : null;
}

function updateCardContext() {
  $("card-context").textContent = state.focusedCue ? "Card preview" : "Now discussing";
  $("return-current").hidden = !state.focusedCue;
}

function syncCueListSelection() {
  document.querySelectorAll(".cue-preview").forEach((button) => {
    button.setAttribute("aria-pressed", String(Boolean(state.focusedCue) && Number(button.dataset.start) === state.focusedCue.start));
  });
}

function setupMediaSession(episode) {
  if (!("mediaSession" in navigator)) return;
  navigator.mediaSession.metadata = new MediaMetadata({ title: episode.title, artist: state.show.title, album: "Wait, What? Magic Podcast Companion" });
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

function setEpisodeTitle(title) {
  const container = $("episode-title");
  const titleText = container.querySelector("span");
  titleText.textContent = title;
  container.classList.remove("scrolling");
  container.style.removeProperty("--title-shift");
  requestAnimationFrame(() => {
    if (container.scrollHeight <= container.clientHeight + 1) return;
    container.classList.add("scrolling");
    requestAnimationFrame(() => container.style.setProperty("--title-shift", `${Math.max(0, titleText.scrollWidth - container.clientWidth)}px`));
  });
}
function showToast(message) {
  clearTimeout(state.toastTimer);
  $("toast").textContent = message;
  $("toast").classList.add("show");
  state.toastTimer = setTimeout(() => $("toast").classList.remove("show"), 2600);
}
function checkResponse(response) { if (!response.ok) throw new Error(`Request failed: ${response.status}`); return response; }
function initials(value) { return value.split(/\s+/).map((word) => word[0]).join("").slice(0, 3).toUpperCase(); }
function shortName(name) { return name.split(" // ")[0]; }
function escapeHtml(value = "") { return String(value).replace(/[&<>'"]/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" })[char]); }

init().catch((error) => {
  console.error(error);
  $("episode-status").textContent = "Could not load podcast data";
  showToast("Could not load podcast data.");
});
