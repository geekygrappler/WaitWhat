#!/usr/bin/env node
import { readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { applyResolvedCard, reviewStarts, scryfallApiUrl } from "./review-resolution-core.mjs";

const root = path.resolve(new URL("..", import.meta.url).pathname);
const reviewDirectory = path.join(root, "reviews");
const reviewFiles = (await readdir(reviewDirectory)).filter((name) => name.endsWith(".needs-review.json")).sort();
const cardCache = new Map();
let applied = 0;

for (const reviewFile of reviewFiles) {
  const slug = reviewFile.slice(0, -".needs-review.json".length);
  const reviews = JSON.parse(await readFile(path.join(reviewDirectory, reviewFile), "utf8"));
  const resolved = reviews.filter((review) => review.resolvedName);
  if (!resolved.length) continue;

  const cueFile = path.join(root, "dist", "data", `${slug}.cues.json`);
  const approvedFile = path.join(reviewDirectory, `${slug}.approved-cards.json`);
  const cues = JSON.parse(await readFile(cueFile, "utf8"));
  const approved = new Set(JSON.parse(await readFile(approvedFile, "utf8")));

  for (const review of resolved) {
    const card = await fetchCard(review.resolvedName);
    applyResolvedCard(cues, card, reviewStarts(review));
    approved.add(card.name);
    review.resolvedCardName = card.name;
    review.resolvedCardId = card.oracle_id || card.id;
    applied += 1;
  }

  await Promise.all([
    writeFile(cueFile, `${JSON.stringify(cues, null, 2)}\n`),
    writeFile(approvedFile, `${JSON.stringify([...approved].sort((a, b) => a.localeCompare(b)), null, 2)}\n`),
    writeFile(path.join(reviewDirectory, reviewFile), `${JSON.stringify(reviews, null, 2)}\n`)
  ]);
  console.log(`${slug}: applied ${resolved.length} resolved review${resolved.length === 1 ? "" : "s"}`);
}
console.log(`Applied ${applied} resolved reviews.`);

async function fetchCard(pageUrl) {
  if (cardCache.has(pageUrl)) return cardCache.get(pageUrl);
  const response = await fetch(scryfallApiUrl(pageUrl), {
    headers: { "user-agent": "WaitWhatReviewHelper/0.1", accept: "application/json" }
  });
  if (!response.ok) throw new Error(`Scryfall lookup failed for ${pageUrl}: ${response.status}`);
  const card = await response.json();
  cardCache.set(pageUrl, card);
  return card;
}
