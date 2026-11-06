const literal = (c) => c.replace(/[\\^$.*+?()[\]{}|]/g, '\\$&');

// tar excludes are unanchored globs and '*' may cross directory separators.
// POSIX character classes depend on the tar process locale; conservatively match
// any character for those classes instead of risking a plaintext ZIP disclosure.
export function matchesRedaction(rel, pattern) {
  let source = '';
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i];
    if (c === '*') source += '[\\s\\S]*';
    else if (c === '?') source += '[\\s\\S]';
    else if (c === '\\' && i + 1 < pattern.length) source += literal(pattern[++i]);
    else if (c === '[') {
      let end = i + 1;
      if (pattern[end] === '!' || pattern[end] === '^') end++;
      if (pattern[end] === ']') end++;
      while (end < pattern.length && pattern[end] !== ']') {
        if (pattern[end] === '[' && ':=.'.includes(pattern[end + 1] ?? ' ')) {
          const innerEnd = pattern.indexOf(`${pattern[end + 1]}]`, end + 2);
          if (innerEnd !== -1) { end = innerEnd + 2; continue; }
        }
        end++;
      }
      if (end === pattern.length) { source += '\\['; continue; }
      const body = pattern.slice(i + 1, end);
      const negated = body.startsWith('!') || body.startsWith('^');
      const chars = (negated ? body.slice(1) : body).replace(/\\/g, '\\\\').replace(/\]/g, '\\]');
      const bracket = `[${negated ? '^' : ''}${chars}]`;
      try {
        new RegExp(bracket);
        source += body.includes('[') ? '[\\s\\S]' : bracket;
      } catch { source += '[\\s\\S]'; }
      i = end;
    } else source += literal(c);
  }
  return new RegExp(`(?:^|/)${source}(?:/|$)`).test(rel);
}
