import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { clipWindow, listReviewItems, parseSrt, resolveReviewItem } from "../scripts/review-server-core.mjs";

const sampleSrt = `1
00:00:05,000 --> 00:00:08,000
Before the card name.

2
00:00:08,000 --> 00:00:12,000
Mishra's Bauble is the card.

3
00:00:12,000 --> 00:00:16,000
After the card name.
`;

test("builds a ten-second window and extracts its transcript", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "review-server-test-"));
  await mkdir(path.join(directory, "reviews"));
  await mkdir(path.join(directory, "processing"));
  await writeFile(path.join(directory, "reviews", "episode.needs-review.json"), JSON.stringify([
    { transcriptName: "Mishra", start: 10, reason: "Ambiguous name." }
  ]));
  await writeFile(path.join(directory, "processing", "episode.srt"), sampleSrt);

  const [group] = await listReviewItems(directory);
  assert.equal(group.slug, "episode");
  assert.deepEqual(clipWindow(10), { start: 5, end: 15 });
  assert.deepEqual(group.items[0].occurrences[0].transcript.map((cue) => cue.text), [
    "Before the card name.", "Mishra's Bauble is the card.", "After the card name."
  ]);
  await rm(directory, { recursive: true, force: true });
});
test("parses Windows SRT timestamps", () => {
  const cues = parseSrt(sampleSrt.replaceAll("\n", "\r\n"));
  assert.equal(cues.length, 3);
  assert.equal(cues[1].start, 8);
});

test("saves a corrected name without discarding review context", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "review-save-test-"));
  await mkdir(path.join(directory, "reviews"));
  const file = path.join(directory, "reviews", "episode.needs-review.json");
  await writeFile(file, JSON.stringify([{ transcriptName: "Mishra", start: 10, reason: "Ambiguous." }]));

  const item = await resolveReviewItem(directory, { slug: "episode", index: 0, cardName: "  Mishra's Bauble  " });
  const [saved] = JSON.parse(await readFile(file, "utf8"));
  assert.equal(item.resolvedName, "Mishra's Bauble");
  assert.equal(saved.reason, "Ambiguous.");
  assert.match(saved.resolvedAt, /^\d{4}-\d{2}-\d{2}T/);
  await rm(directory, { recursive: true, force: true });
});
