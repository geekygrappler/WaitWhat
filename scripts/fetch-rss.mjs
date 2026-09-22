#!/usr/bin/env node
import { writeFile } from "node:fs/promises";

const FEED_URL = process.env.PODCAST_RSS_URL || "https://legendarycreaturepocast.libsyn.com/rss";
const OUTPUT = new URL("../dist/data/episodes.json", import.meta.url);

const response = await fetch(FEED_URL, { headers: { "user-agent": "CardcastCompanion/0.1" } });
if (!response.ok) throw new Error(`RSS request failed: ${response.status}`);
const xml = await response.text();
const existing = await import(OUTPUT, { with: { type: "json" } }).then((module) => module.default).catch(() => []);
const cueSheets = new Map(existing.filter((item) => item.cueSheet).map((item) => [item.audioUrl, item.cueSheet]));

const episodes = [...xml.matchAll(/<item>([\s\S]*?)<\/item>/g)].map(([, item]) => {
  const title = value(item, "title");
  const audioUrl = attribute(item, "enclosure", "url");
  const cueSheet = cueSheets.get(audioUrl);
  return {
    id: slug(title),
    title,
    published: new Date(value(item, "pubDate")).toISOString(),
    duration: durationSeconds(value(item, "itunes:duration")),
    audioUrl,
    episodeUrl: value(item, "link"),
    artwork: attribute(item, "itunes:image", "href"),
    ...(cueSheet ? { cueSheet, processed: true } : { processed: false }),
    source: "Legendary Creature Podcast RSS"
  };
}).filter((episode) => episode.audioUrl).slice(0, 20);

await writeFile(OUTPUT, `${JSON.stringify(episodes, null, 2)}\n`);
console.log(`Saved ${episodes.length} RSS episodes to ${OUTPUT.pathname}`);

function value(xmlText, tag) {
  const escaped = tag.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = xmlText.match(new RegExp(`<${escaped}(?:\\s[^>]*)?>(?:<!\\[CDATA\\[)?([\\s\\S]*?)(?:\\]\\]>)?<\\/${escaped}>`));
  return decode((match?.[1] || "").trim());
}

function attribute(xmlText, tag, name) {
  const escaped = tag.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = xmlText.match(new RegExp(`<${escaped}[^>]*\\s${name}="([^"]+)"[^>]*>`));
  return decode(match?.[1] || "");
}

function decode(text) { return text.replaceAll("&amp;", "&").replaceAll("&quot;", '"').replaceAll("&#39;", "'").replaceAll("&lt;", "<").replaceAll("&gt;", ">"); }
function slug(text) { return text.toLowerCase().normalize("NFKD").replace(/[\u0300-\u036f]/g, "").replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, ""); }
function durationSeconds(text) { const parts = text.split(":").map(Number); return parts.reduce((total, value) => total * 60 + value, 0); }
