#!/usr/bin/env node
import { readFile, writeFile } from "node:fs/promises";

const SHOWS_URL = new URL("../dist/data/shows.json", import.meta.url);
const shows = JSON.parse(await readFile(SHOWS_URL, "utf8"));
const requestedShow = process.argv.find((argument) => argument.startsWith("--show="))?.split("=")[1];
const selectedShows = requestedShow ? shows.filter((show) => show.id === requestedShow) : shows;

if (!selectedShows.length) throw new Error(`Unknown show: ${requestedShow}`);

for (const show of selectedShows) {
  const output = new URL(`../dist/data/${show.id === "legendary-creature" ? "episodes" : `${show.id}.episodes`}.json`, import.meta.url);
  const response = await fetch(show.feedUrl, { headers: { "user-agent": "CardcastCompanion/0.2" } });
  if (!response.ok) throw new Error(`${show.title} RSS request failed: ${response.status}`);
  const xml = await response.text();
  const existing = JSON.parse(await readFile(output, "utf8").catch(() => "[]"));
  const cueSheets = new Map(existing.filter((item) => item.cueSheet).map((item) => [item.audioUrl, item.cueSheet]));
  const channelArtwork = attribute(xml.match(/<channel>([\s\S]*)<\/channel>/)?.[1] || xml, "itunes:image", "href");

  const episodes = [...xml.matchAll(/<item>([\s\S]*?)<\/item>/g)].map(([, item]) => {
    const title = value(item, "title");
    const audioUrl = attribute(item, "enclosure", "url");
    const cueSheet = cueSheets.get(audioUrl);
    return {
      id: slug(title),
      title,
      published: date(value(item, "pubDate")),
      duration: durationSeconds(value(item, "itunes:duration")),
      audioUrl,
      episodeUrl: value(item, "link"),
      artwork: attribute(item, "itunes:image", "href") || channelArtwork || show.artwork,
      ...(cueSheet ? { cueSheet, processed: true } : { processed: false }),
      source: `${show.title} RSS`
    };
  }).filter((episode) => episode.audioUrl).slice(0, 20);

  await writeFile(output, `${JSON.stringify(episodes, null, 2)}\n`);
  console.log(`Saved ${episodes.length} ${show.title} episodes to ${output.pathname}`);
}

function value(xmlText, tag) {
  const escaped = tag.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = xmlText.match(new RegExp(`<${escaped}(?:\\s[^>]*)?>(?:<!\\[CDATA\\[)?([\\s\\S]*?)(?:\\]\\]>)?<\\/${escaped}>`));
  return decode((match?.[1] || "").trim());
}

function attribute(xmlText, tag, name) {
  const escaped = tag.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = xmlText.match(new RegExp(`<${escaped}[^>]*\\s${name}=["']([^"']+)["'][^>]*>`));
  return decode(match?.[1] || "");
}

function decode(text) {
  return text.replaceAll("&amp;", "&").replaceAll("&quot;", '"').replaceAll("&#39;", "'").replaceAll("&apos;", "'").replaceAll("&lt;", "<").replaceAll("&gt;", ">");
}
function slug(text) { return text.toLowerCase().normalize("NFKD").replace(/[\u0300-\u036f]/g, "").replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, ""); }
function date(text) { const parsed = new Date(text); return Number.isNaN(parsed.getTime()) ? "" : parsed.toISOString(); }
function durationSeconds(text) {
  if (/^\d+$/.test(text)) return Number(text);
  const parts = text.split(":").map(Number);
  return parts.every(Number.isFinite) ? parts.reduce((total, part) => total * 60 + part, 0) : 0;
}
