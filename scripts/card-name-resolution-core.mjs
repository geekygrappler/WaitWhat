export function normalizeCardName(value) {
  return String(value || "").toLowerCase().normalize("NFKD").replace(/[\u0300-\u036f]/g, "").replace(/[^a-z0-9]+/g, " ").trim();
}

export function resolveCardName(name, catalogueNames, threshold = 0.78) {
  const target = normalizeCardName(name);
  if (!target) return null;
  const exact = catalogueNames.find((candidate) => normalizeCardName(candidate) === target);
  if (exact) return { name: exact, confidence: 1 };

  let best = null;
  for (const candidate of catalogueNames) {
    const normalized = normalizeCardName(candidate);
    if (!normalized || Math.min(normalized.length, target.length) / Math.max(normalized.length, target.length) < 0.65) continue;
    const score = Math.max(normalizedEditSimilarity(target, normalized), jaroWinkler(target, normalized));
    if (!best || score > best.confidence) best = { name: candidate, confidence: score };
  }
  return best && best.confidence >= threshold ? best : null;
}

export function canonicalizeAnalysis(analysis, catalogueNames, threshold = 0.78) {
  const cache = new Map();
  const unresolved = [];
  const mentions = [];
  for (const mention of analysis.mentions || []) {
    const key = normalizeCardName(mention.canonicalName);
    if (!cache.has(key)) cache.set(key, resolveCardName(mention.canonicalName, catalogueNames, threshold));
    const resolution = cache.get(key);
    if (!resolution) {
      unresolved.push(mention);
      continue;
    }
    mentions.push({
      ...mention,
      ...(resolution.name !== mention.canonicalName ? { modelName: mention.canonicalName } : {}),
      canonicalName: resolution.name,
      catalogueConfidence: Number(resolution.confidence.toFixed(3)),
    });
  }
  const mainCards = unique(mentions.filter((mention) => mention.role === "main").map((mention) => mention.canonicalName));
  const mainKeys = new Set(mainCards.map(normalizeCardName));
  const incidentalCards = unique(mentions.filter((mention) => mention.role === "incidental" && !mainKeys.has(normalizeCardName(mention.canonicalName))).map((mention) => mention.canonicalName));
  return {
    ...analysis,
    mentions,
    mainCards,
    incidentalCards,
    resolution: {
      catalogueNames: catalogueNames.length,
      correctedMentions: mentions.filter((mention) => mention.modelName).length,
      unresolvedMentions: unresolved,
    },
  };
}

function unique(values) {
  const result = new Map();
  for (const value of values) if (!result.has(normalizeCardName(value))) result.set(normalizeCardName(value), value);
  return [...result.values()].sort((a, b) => a.localeCompare(b));
}

function normalizedEditSimilarity(a, b) {
  const row = Array.from({ length: b.length + 1 }, (_, index) => index);
  for (let i = 1; i <= a.length; i += 1) {
    let previous = row[0];
    row[0] = i;
    for (let j = 1; j <= b.length; j += 1) {
      const saved = row[j];
      row[j] = Math.min(row[j] + 1, row[j - 1] + 1, previous + (a[i - 1] === b[j - 1] ? 0 : 1));
      previous = saved;
    }
  }
  return 1 - row[b.length] / Math.max(a.length, b.length, 1);
}

function jaroWinkler(a, b) {
  if (a === b) return 1;
  const distance = Math.max(0, Math.floor(Math.max(a.length, b.length) / 2) - 1);
  const aMatches = Array(a.length).fill(false);
  const bMatches = Array(b.length).fill(false);
  let matches = 0;
  for (let i = 0; i < a.length; i += 1) {
    for (let j = Math.max(0, i - distance); j < Math.min(i + distance + 1, b.length); j += 1) {
      if (bMatches[j] || a[i] !== b[j]) continue;
      aMatches[i] = true;
      bMatches[j] = true;
      matches += 1;
      break;
    }
  }
  if (!matches) return 0;
  const aOrder = [...a].filter((_, index) => aMatches[index]);
  const bOrder = [...b].filter((_, index) => bMatches[index]);
  const transpositions = aOrder.filter((char, index) => char !== bOrder[index]).length / 2;
  const jaro = (matches / a.length + matches / b.length + (matches - transpositions) / matches) / 3;
  let prefix = 0;
  while (prefix < 4 && prefix < a.length && prefix < b.length && a[prefix] === b[prefix]) prefix += 1;
  return jaro + prefix * 0.1 * (1 - jaro);
}
