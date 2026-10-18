import test from "node:test";
import assert from "node:assert/strict";
import {
  CARD_ANALYSIS_INSTRUCTIONS,
  analyzeTranscriptCards,
  chunkTranscript,
  deriveCardLists,
} from "../scripts/llm-card-analysis-core.mjs";
import {
  codexSubscriptionEnvironment,
  isChatGptLoginStatus,
} from "../scripts/codex-subscription-analysis.mjs";
import { canonicalizeAnalysis, resolveCardName } from "../scripts/card-name-resolution-core.mjs";

const segments = [
  { start: 0, end: 2, text: "Welcome to the show." },
  { start: 55, end: 57, text: "Our next review is Skullclamp." },
  { start: 100, end: 103, text: "It works well with Witch's Oven and Stridehangar Automaton." },
];

test("transcript chunking overlaps complete timestamped segments", () => {
  const chunks = chunkTranscript(segments, { chunkSeconds: 60, overlapSeconds: 10 });
  assert.equal(chunks.length, 2);
  assert.match(chunks[0].transcript, /Skullclamp/);
  assert.match(chunks[1].transcript, /Skullclamp/);
  assert.match(chunks[1].transcript, /Stridehangar Automaton/);
  assert.equal(chunks[1].transcriptStart, 55);
});

test("LLM card analysis keeps multiple mentions and deduplicates chunk overlap", async () => {
  const requests = [];
  const analysis = await analyzeTranscriptCards({
    title: "Test review",
    segments,
    model: "test-model",
    chunkSeconds: 60,
    overlapSeconds: 10,
    request: async (request) => {
      requests.push(request);
      const mentions = [];
      if (request.input.includes("Skullclamp")) mentions.push({
        canonicalName: "Skullclamp",
        spokenText: "Skullclamp",
        role: "main",
        startSeconds: 55,
        evidence: "Our next review is Skullclamp",
        confidence: 0.99,
      });
      if (request.input.includes("Witch's Oven")) mentions.push({
        canonicalName: "Witch's Oven",
        spokenText: "Witch's Oven",
        role: "incidental",
        startSeconds: 100,
        evidence: "works well with Witch's Oven",
        confidence: 0.98,
      }, {
        canonicalName: "Stridehangar Automaton",
        spokenText: "Stridehangar Automaton",
        role: "incidental",
        startSeconds: 100,
        evidence: "and Stridehangar Automaton",
        confidence: 0.97,
      });
      return { mentions };
    }
  });
  assert.equal(requests.length, 2);
  assert.equal(analysis.mentions.length, 3);
  assert.deepEqual(analysis.mainCards, ["Skullclamp"]);
  assert.deepEqual(analysis.incidentalCards, ["Stridehangar Automaton", "Witch's Oven"]);
  assert.match(requests[0].instructions, /Never stop after finding one card/);
});

test("main cards are not duplicated in the incidental output", () => {
  assert.deepEqual(deriveCardLists([
    { canonicalName: "Card A", role: "incidental" },
    { canonicalName: "Card A", role: "main" },
    { canonicalName: "Card B", role: "incidental" },
  ]), { mainCards: ["Card A"], incidentalCards: ["Card B"] });
});

test("Codex analysis forces cached ChatGPT subscription authentication", () => {
  const environment = codexSubscriptionEnvironment({
    PATH: "/bin",
    OPENAI_API_KEY: "api-key",
    CODEX_API_KEY: "codex-key",
    CODEX_ACCESS_TOKEN: "access-token",
  });
  assert.deepEqual(environment, { PATH: "/bin" });
  assert.equal(isChatGptLoginStatus("Logged in using ChatGPT"), true);
  assert.equal(isChatGptLoginStatus("Logged in using an API key"), false);
});

test("analysis prompt distinguishes ordinary speech from card names", () => {
  assert.match(CARD_ANALYSIS_INSTRUCTIONS, /brainstem.*not.*Brainstorm/i);
  assert.match(CARD_ANALYSIS_INSTRUCTIONS, /two, three, four, or more cards/);
});

test("model spellings resolve to canonical catalogue names without keeping unresolved guesses", () => {
  const catalogue = ["Aerid Konstrari", "Denzilore Fatehold", "Kwia Vigorbloom", "Uldaros Theorix"];
  assert.equal(resolveCardName("Arid Constrari", catalogue).name, "Aerid Konstrari");
  assert.equal(resolveCardName("Olderos Therix", catalogue).name, "Uldaros Theorix");
  const result = canonicalizeAnalysis({ mentions: [
    { canonicalName: "Denselor Fatehold", role: "main" },
    { canonicalName: "Quai Vigorbloom", role: "incidental" },
    { canonicalName: "Definitely Not A Card", role: "incidental" },
  ] }, catalogue);
  assert.deepEqual(result.mainCards, ["Denzilore Fatehold"]);
  assert.deepEqual(result.incidentalCards, ["Kwia Vigorbloom"]);
  assert.equal(result.resolution.unresolvedMentions.length, 1);
});
