// ---------------------------------------------------------------------------
// Fuzzy name matching utilities for healthcare organization names
// ---------------------------------------------------------------------------

// Common healthcare organization suffixes to strip during normalization
const STRIP_TERMS = [
  "llc", "inc", "corp", "corporation", "associates", "assoc",
  "group", "medical", "med", "center", "centre", "clinic",
  "pa", "pc", "md", "do", "dds", "dpm", "healthcare",
  "health", "services", "practice", "partners", "pllc", "ltd",
];

/**
 * Normalize a healthcare organization name for comparison.
 * - Lowercases
 * - Removes punctuation (periods, apostrophes, commas, hyphens, slashes, parens)
 * - Strips common healthcare suffixes (LLC, Inc, Associates, etc.)
 * - Collapses whitespace and trims
 *
 * If stripping all terms would result in an empty string, the original
 * tokens are preserved (so "LLC Medical" doesn't become "").
 */
export function normalizeName(name: string): string {
  let n = name.toLowerCase().replace(/[.'',\-\/\\()]/g, " ");
  const tokens = n.split(/\s+/).filter(Boolean);
  const filtered = tokens.filter((t) => !STRIP_TERMS.includes(t));
  return (filtered.length > 0 ? filtered : tokens).join(" ");
}

/**
 * Standard Levenshtein edit distance between two strings.
 * Returns the minimum number of single-character edits (insertions,
 * deletions, or substitutions) required to change one string into the other.
 */
export function levenshteinDistance(a: string, b: string): number {
  const m = a.length;
  const n = b.length;

  // Edge cases
  if (m === 0) return n;
  if (n === 0) return m;

  // Use a single-row DP approach for space efficiency
  let prev = new Array(n + 1);
  let curr = new Array(n + 1);

  for (let j = 0; j <= n; j++) {
    prev[j] = j;
  }

  for (let i = 1; i <= m; i++) {
    curr[0] = i;
    for (let j = 1; j <= n; j++) {
      if (a[i - 1] === b[j - 1]) {
        curr[j] = prev[j - 1];
      } else {
        curr[j] = 1 + Math.min(prev[j - 1], prev[j], curr[j - 1]);
      }
    }
    [prev, curr] = [curr, prev];
  }

  return prev[n];
}

/**
 * Jaccard similarity on token sets.
 * Returns |intersection| / |union| of the whitespace-split token sets.
 * Returns 0 if both sets are empty.
 */
export function tokenJaccard(a: string, b: string): number {
  const tokensA = a.split(/\s+/).filter(Boolean);
  const tokensB = b.split(/\s+/).filter(Boolean);
  const setA = new Set(tokensA);
  const setB = new Set(tokensB);

  if (setA.size === 0 && setB.size === 0) return 0;

  const intersection = new Set([...setA].filter((x) => setB.has(x)));
  const union = new Set([...setA, ...setB]);

  return union.size === 0 ? 0 : intersection.size / union.size;
}

/**
 * Fuzzy name match combining normalization, Jaccard token similarity,
 * and Levenshtein character similarity.
 *
 * Returns a score between 0.0 and 1.0 where 1.0 is a perfect match.
 *
 * Algorithm:
 * 1. Normalize both names (lowercase, strip punctuation & common suffixes)
 * 2. If normalized forms are identical, return 1.0
 * 3. Compute Jaccard similarity on token sets
 * 4. Compute Levenshtein similarity (1 - distance/maxLength)
 * 5. Return the maximum of Jaccard and Levenshtein
 */
export function fuzzyNameMatch(a: string, b: string): number {
  const na = normalizeName(a);
  const nb = normalizeName(b);

  if (na === nb) return 1.0;

  // Token Jaccard similarity
  const jaccard = tokenJaccard(na, nb);

  // Levenshtein similarity (normalized to 0-1)
  const maxLen = Math.max(na.length, nb.length);
  const levenSim = maxLen === 0 ? 1 : 1 - levenshteinDistance(na, nb) / maxLen;

  // Return the best of the two measures
  return Math.max(jaccard, levenSim);
}
