// Edit matching adapted from OpenCode's edit tool (packages/core/src/tool/plugin/edit.ts,
// commit 6b1bc48), Copyright (c) 2025 opencode, MIT License. See THIRD_PARTY_NOTICES.md.

const CRLF = '\r\n';

export interface Match {
  start: number;
  end: number;
}

/** How a match was found: exact text, typographic variants, or ignoring trailing whitespace. */
export type MatchTier = 'exact' | 'typography' | 'trailing-whitespace';

const normalizeForMatch = (value: string) =>
  value
    .replace(/[\u2018\u2019\u201A\u201B]/g, "'")
    .replace(/[\u201C\u201D\u201E\u201F]/g, '"')
    .replace(/[\u2010-\u2015\u2212]/g, '-')
    .replace(/[\u00A0\u2002-\u200A\u202F\u205F\u3000]/g, ' ');

export function findOccurrences(content: string, search: string): Match[] {
  const result: Match[] = [];
  let offset = 0;
  while ((offset = content.indexOf(search, offset)) !== -1) {
    result.push({ start: offset, end: offset + search.length });
    offset += search.length;
  }
  return result;
}

function findLineOccurrences(content: string, search: string): Match[] {
  const trailingNewline = search.endsWith('\n');
  const expected = search.split('\n');
  if (trailingNewline) expected.pop();
  const lines = [...content.matchAll(/[^\n]*(?:\n|$)/g)]
    .filter((match) => match[0] !== '')
    .map((match) => {
      const newline = match[0].endsWith('\n');
      const text = newline ? match[0].slice(0, -1) : match[0];
      return {
        start: match.index,
        end: match.index + match[0].length,
        text,
        contentEnd: match.index + text.length - (text.endsWith('\r') ? 1 : 0),
        newline,
      };
    });
  const candidates = lines.flatMap((line, index) => {
    const actual = lines.slice(index, index + expected.length);
    if (actual.length !== expected.length) return [];
    if (
      !actual.every(
        (item, lineIndex) =>
          normalizeForMatch(item.text.trimEnd()) ===
          normalizeForMatch(expected[lineIndex]!.trimEnd()),
      )
    )
      return [];
    const last = actual.at(-1)!;
    if (trailingNewline && !last.newline) return [];
    return [{ start: line.start, end: trailingNewline ? last.end : last.contentEnd }];
  });
  return candidates.reduce<Match[]>((result, candidate) => {
    if (result.some((match) => match.end > candidate.start && match.start < candidate.end))
      return result;
    result.push(candidate);
    return result;
  }, []);
}

/** The dominant line ending in text, or fallback when there is none. */
function lineEnding(text: string, fallback: string): string {
  const crlfCount = text.split(CRLF).length - 1;
  const lfCount = text.split('\n').length - 1 - crlfCount;
  if (crlfCount === lfCount) return fallback;
  return crlfCount > lfCount ? CRLF : '\n';
}

/**
 * For each line of `after`, the index of the `before` line it keeps (longest common subsequence)
 * or, between kept lines, the line it replaces; undefined for lines with no counterpart.
 */
function alignLines(before: string[], after: string[]): (number | undefined)[] {
  const width = after.length + 1;
  const table = new Uint32Array((before.length + 1) * width);
  for (let i = before.length - 1; i >= 0; i--)
    for (let j = after.length - 1; j >= 0; j--)
      table[i * width + j] =
        before[i] === after[j]
          ? table[(i + 1) * width + j + 1]! + 1
          : Math.max(table[(i + 1) * width + j]!, table[i * width + j + 1]!);
  const result: (number | undefined)[] = [];
  let gapBefore: number[] = [];
  let gapAfter: number[] = [];
  const flush = () => {
    gapAfter.forEach((j, k) => (result[j] = gapBefore[k]));
    gapBefore = [];
    gapAfter = [];
  };
  let i = 0;
  let j = 0;
  while (i < before.length && j < after.length) {
    if (before[i] === after[j]) {
      flush();
      result[j++] = i++;
      continue;
    }
    if (table[(i + 1) * width + j]! >= table[i * width + j + 1]!) gapBefore.push(i++);
    else gapAfter.push(j++);
  }
  while (i < before.length) gapBefore.push(i++);
  while (j < after.length) gapAfter.push(j++);
  flush();
  return result;
}

/**
 * Join the replacement's lines with endings taken from the matched region, so unchanged lines
 * keep their bytes even in files with mixed line endings.
 */
function withRegionEndings(region: string, replacement: string, fallback: string): string {
  const before = region.split(/\r?\n/);
  const endings = [...region.matchAll(/\r?\n/g)].map((match) => match[0]);
  const after = replacement.split('\n');
  const key = (line: string) => normalizeForMatch(line.trimEnd());
  const source = alignLines(before.map(key), after.map(key));
  return after
    .map((line, index) =>
      index === after.length - 1 ? line : line + (endings[source[index]!] ?? fallback),
    )
    .join('');
}

/** Number of sorted positions strictly before offset. */
function countBefore(positions: number[], offset: number): number {
  let low = 0;
  let high = positions.length;
  while (low < high) {
    const middle = (low + high) >> 1;
    if (positions[middle]! < offset) low = middle + 1;
    else high = middle;
  }
  return low;
}

/**
 * Find `oldString` in the LF view of `source` (the view `read_file` shows), trying exact text,
 * then typographic variants, then trailing whitespace; offsets map back to the original bytes.
 */
export function matchEdit(
  source: string,
  oldString: string,
  newString: string,
): { matches: Match[]; tier: MatchTier; replace(match: Match): string } {
  // Strings that differ only in \r change line endings themselves, so they apply to exact bytes.
  if (oldString.replaceAll('\r', '') === newString.replaceAll('\r', ''))
    return { matches: findOccurrences(source, oldString), tier: 'exact', replace: () => newString };
  const view = source.replaceAll(CRLF, '\n');
  const removed = [...source.matchAll(/\r\n/g)].map((match, index) => match.index - index);
  const fileEnding = lineEnding(source, '\n');
  const search = oldString.replaceAll(CRLF, '\n');
  const replacement = newString.replaceAll(CRLF, '\n');
  let tier: MatchTier = 'exact';
  let found = findOccurrences(view, search);
  if (!found.length) {
    // One-to-one character mappings keep offsets into the LF view valid.
    tier = 'typography';
    found = findOccurrences(normalizeForMatch(view), normalizeForMatch(search));
  }
  if (!found.length) {
    tier = 'trailing-whitespace';
    found = findLineOccurrences(view, search);
  }
  return {
    matches: found.map((match) => ({
      start: match.start + countBefore(removed, match.start),
      end: match.end + countBefore(removed, match.end),
    })),
    tier,
    replace: (match) => {
      const region = source.slice(match.start, match.end);
      return withRegionEndings(region, replacement, lineEnding(region, fileEnding));
    },
  };
}

const OMISSION =
  /^\s*(?:\/\/|#|--|\/\*|<!--)?\s*[([]?\s*(?:\.\.\.\s*)?(?:rest of(?: the)? (?:code|file|method|methods|function|functions|class|implementation)|unchanged (?:code|lines|method|methods)|existing code(?: here)?|remaining (?:code|methods))\s*(?:\.\.\.|…)/i;

/** Lines such as `// rest of code ...` that stand in for text the model left out. */
export function omissionPlaceholders(text: string): string[] {
  return text
    .split(/\r?\n/)
    .filter((line) => OMISSION.test(line))
    .map((line) => line.trim());
}

/** Line numbers where the first meaningful line of a failed search appears, for a hint. */
export function nearbyLines(source: string, search: string): number[] {
  const first = search
    .split(/\r?\n/)
    .map((line) => normalizeForMatch(line.trim()))
    .find((line) => line.length >= 4);
  if (!first) return [];
  return source
    .split(/\r?\n/)
    .flatMap((line, index) => (normalizeForMatch(line.trim()) === first ? [index + 1] : []))
    .slice(0, 5);
}
