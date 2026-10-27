/** Expand `{a,b}` alternatives into separate patterns. */
export function expandBraces(pattern: string, limit = 64): string[] {
  const group = /\{([^{}]*)\}/.exec(pattern);
  if (!group) return [pattern];
  const expanded = group[1]!
    .split(',')
    .flatMap((part) =>
      expandBraces(
        pattern.slice(0, group.index) + part + pattern.slice(group.index + group[0].length),
        limit,
      ),
    );
  if (expanded.length > limit) throw new Error('Glob pattern has too many alternatives.');
  return [...new Set(expanded)];
}

/**
 * One glob pattern without braces as a regular expression over `/`-separated paths: `**`
 * crosses directories, `*` and `?` stay within one, and `[...]` is a character class.
 */
export function globRegExp(pattern: string): RegExp {
  let source = '';
  for (let index = 0; index < pattern.length; index++) {
    const character = pattern[index]!;
    if (character === '*' && pattern[index + 1] === '*') {
      const slash = pattern[index + 2] === '/';
      source += slash ? '(?:.*/)?' : '.*';
      index += slash ? 2 : 1;
    } else if (character === '*') source += '[^/]*';
    else if (character === '?') source += '[^/]';
    else if (character === '[' && pattern.indexOf(']', index + 2) > index) {
      const end = pattern.indexOf(']', index + 2);
      const inner = pattern.slice(index + 1, end).replace(/\\/g, '\\\\');
      source += `[${inner.startsWith('!') ? `^${inner.slice(1)}` : inner}]`;
      index = end;
    } else source += character.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${source}$`);
}

/** Whether a relative path matches a glob pattern, braces included. */
export function globMatcher(pattern: string): (relative: string) => boolean {
  const expressions = expandBraces(pattern).map(globRegExp);
  return (relative) => expressions.some((expression) => expression.test(relative));
}
