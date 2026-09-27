import { readFile, readdir, rename, writeFile } from "node:fs/promises";
import path from "node:path";

const REVIEW_SUFFIX = ".needs-review.json";

export function parseSrt(source) {
  return source
    .replaceAll("\r\n", "\n")
    .trim()
    .split(/\n{2,}/)
    .map((block) => {
      const lines = block.split("\n");
      const timingIndex = lines.findIndex((line) => line.includes("-->"));
      if (timingIndex < 0) return null;
      const [start, end] = lines[timingIndex].split("-->").map((value) => srtTime(value.trim()));
      return {
        start,
        end,
        text: lines.slice(timingIndex + 1).join(" ").replace(/<[^>]+>/g, "").trim()
      };
    })
    .filter((cue) => cue && Number.isFinite(cue.start) && Number.isFinite(cue.end) && cue.text);
}
function srtTime(value) {
  const match = value.match(/^(\d+):(\d+):(\d+)[,.](\d+)$/);
  if (!match) return Number.NaN;
  return Number(match[1]) * 3600 + Number(match[2]) * 60 + Number(match[3]) + Number(match[4]) / 1000;
}

export function clipWindow(center, duration = 10) {
  const start = Math.max(0, Number(center) - duration / 2);
  return { start, end: start + duration };
}

export function transcriptForWindow(cues, start, end) {
  return cues
    .filter((cue) => cue.end >= start && cue.start <= end)
    .map((cue) => ({ ...cue, active: cue.end >= start + 4.75 && cue.start <= start + 5.25 }));
}

export function reviewStarts(review) {
  const values = Array.isArray(review.starts) ? review.starts : [review.start];
  return values.map(Number).filter(Number.isFinite);
}

export async function listReviewItems(projectRoot) {
  const reviewsDirectory = path.join(projectRoot, "reviews");
  const names = (await readdir(reviewsDirectory)).filter((name) => name.endsWith(REVIEW_SUFFIX)).sort();
  const groups = [];

  for (const name of names) {
    const slug = name.slice(0, -REVIEW_SUFFIX.length);
    const [reviewsSource, transcriptSource] = await Promise.all([
      readFile(path.join(reviewsDirectory, name), "utf8"),
      readFile(path.join(projectRoot, "processing", `${slug}.srt`), "utf8")
    ]);
    const reviews = JSON.parse(reviewsSource);
    const cues = parseSrt(transcriptSource);
    groups.push({
      slug,
      audioUrl: `/reviews/audio/${encodeURIComponent(slug)}.mp3`,
      items: reviews.map((review, index) => ({
        ...review,
        index,
        occurrences: reviewStarts(review).map((center) => {
          const window = clipWindow(center);
          return { center, ...window, transcript: transcriptForWindow(cues, window.start, window.end) };
        })
      }))
    });
  }

  return groups;
}

export async function resolveReviewItem(projectRoot, { slug, index, cardName }) {
  if (!/^[a-z0-9-]+$/.test(slug || "")) throw new Error("Invalid episode slug.");
  if (!Number.isInteger(index) || index < 0) throw new Error("Invalid review index.");
  const resolvedName = String(cardName || "").trim();
  if (!resolvedName || resolvedName.length > 200) throw new Error("Enter a card name between 1 and 200 characters.");

  const file = path.join(projectRoot, "reviews", `${slug}${REVIEW_SUFFIX}`);
  const reviews = JSON.parse(await readFile(file, "utf8"));
  if (!reviews[index]) throw new Error("Review item not found.");
  reviews[index] = { ...reviews[index], resolvedName, resolvedAt: new Date().toISOString() };

  const temporary = `${file}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify(reviews, null, 2)}\n`, "utf8");
  await rename(temporary, file);
  return reviews[index];
}
