const root = document.querySelector("#reviews");
let activeAudio = null;

const time = (seconds) => {
  const whole = Math.floor(seconds);
  const hours = Math.floor(whole / 3600);
  const minutes = Math.floor((whole % 3600) / 60);
  const tail = String(whole % 60).padStart(2, "0");
  return hours ? `${hours}:${String(minutes).padStart(2, "0")}:${tail}` : `${minutes}:${tail}`;
};

function element(tag, attributes = {}, children = []) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attributes)) {
    if (key === "class") node.className = value;
    else if (key === "text") node.textContent = value;
    else node.setAttribute(key, value);
  }
  node.append(...children);
  return node;
}

function renderTranscript(container, occurrence) {
  container.replaceChildren(...occurrence.transcript.map((cue, index) => {
    const span = element("span", { class: cue.active ? "active" : "", text: cue.text });
    if (index < occurrence.transcript.length - 1) span.append(" ");
    return span;
  }));
}

function reviewCard(group, item) {
  const card = element("article", { class: `review${item.resolvedName ? " resolved" : ""}` });
  const title = element("h3", { text: item.transcriptName });
  const heading = element("div", { class: "review-head" }, [title]);
  if (item.resolvedName) heading.append(element("span", { class: "badge", text: "Saved" }));
  const reason = element("p", { class: "reason", text: item.reason });
  const tabs = element("div", { class: "timestamp-tabs", role: "tablist", "aria-label": "Occurrences" });
  const play = element("button", { class: "play", type: "button", text: "▶ Play 10 sec" });
  const audio = element("audio", { controls: "", preload: "metadata", src: group.audioUrl });
  const transcript = element("p", { class: "transcript" });
  const label = element("label", { for: `${group.slug}-${item.index}`, text: "Correct card name" });
  const input = element("input", {
    id: `${group.slug}-${item.index}`,
    name: "cardName",
    required: "",
    autocomplete: "off",
    value: item.resolvedName || "",
    placeholder: "Type the canonical name"
  });
  const save = element("button", { type: "submit", text: item.resolvedName ? "Update" : "Save" });
  const form = element("form", {}, [label, input, save]);
  const status = element("p", { class: "status", role: "status" });
  let selected = 0;
  let stopAt = null;

  const selectOccurrence = (index) => {
    selected = index;
    [...tabs.children].forEach((tab, tabIndex) => tab.classList.toggle("active", tabIndex === index));
    renderTranscript(transcript, item.occurrences[index]);
  };

  item.occurrences.forEach((occurrence, index) => {
    const tab = element("button", { type: "button", role: "tab", text: time(occurrence.center) });
    tab.addEventListener("click", () => selectOccurrence(index));
    tabs.append(tab);
  });
  selectOccurrence(0);

  play.addEventListener("click", async () => {
    if (activeAudio && activeAudio !== audio) activeAudio.pause();
    activeAudio = audio;
    const occurrence = item.occurrences[selected];
    audio.currentTime = occurrence.start;
    stopAt = occurrence.end;
    await audio.play();
  });
  audio.addEventListener("timeupdate", () => {
    if (stopAt !== null && audio.currentTime >= stopAt) {
      audio.pause();
      stopAt = null;
    }
  });
  audio.addEventListener("play", () => { activeAudio = audio; });

  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    save.disabled = true;
    status.textContent = "Saving…";
    try {
      const response = await fetch("/reviews/api/items", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ slug: group.slug, index: item.index, cardName: input.value })
      });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || "Could not save the name.");
      item.resolvedName = result.item.resolvedName;
      input.value = result.item.resolvedName;
      card.classList.add("resolved");
      if (!heading.querySelector(".badge")) heading.append(element("span", { class: "badge", text: "Saved" }));
      save.textContent = "Update";
      status.textContent = `Saved “${result.item.resolvedName}” to the review file.`;
    } catch (error) {
      status.textContent = error.message;
    } finally {
      save.disabled = false;
    }
  });

  card.append(heading, reason, tabs, element("div", { class: "clip" }, [play, audio]), transcript, form, status);
  return card;
}

async function load() {
  try {
    const response = await fetch("/reviews/api/items");
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || "Could not load reviews.");
    if (!result.groups.some((group) => group.items.length)) {
      root.replaceChildren(document.querySelector("#empty-state").content.cloneNode(true));
      return;
    }
    root.replaceChildren(...result.groups.map((group) => {
      const section = element("section", { class: "episode" });
      section.append(element("h2", { text: group.slug.replaceAll("-", " ") }));
      section.append(...group.items.map((item) => reviewCard(group, item)));
      return section;
    }));
  } catch (error) {
    root.replaceChildren(element("p", { class: "loading", text: error.message }));
  }
}

load();
