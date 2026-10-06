import type { PageWithContent } from '../types';

/**
 * Page content helpers for partial page editing
 *
 * The BookStack API only supports full replacement of page content
 * (`PUT /api/pages/{id}` with a complete `html` or `markdown` field).
 * These pure functions let the MCP server perform the read-modify-write
 * cycle itself, so callers only ever send the changed fragment.
 */

export type PageWriteField = 'html' | 'markdown';

export interface PageSource {
  /** Field to send back to the API when writing */
  writeField: PageWriteField;
  /** Content to patch against */
  source: string;
  /** Editor type reported by BookStack */
  editor: string;
}

export interface PageEdit {
  old_string: string;
  new_string: string;
  replace_all?: boolean;
}

export interface AppliedEdit {
  index: number;
  occurrences_replaced: number;
  context: string;
}

export interface Heading {
  level: number;
  text: string;
  offset: number;
  length: number;
}

export interface GrepMatch {
  offset: number;
  match: string;
  /** Exact stored source around the match, usable verbatim as an `old_string` anchor. */
  context: string;
  /** Whether the page continues before / after `context`. */
  context_truncated_start: boolean;
  context_truncated_end: boolean;
}

/**
 * Error carrying actionable detail back to the caller without
 * dumping the whole page content into the response.
 */
export class PageContentError extends Error {
  constructor(
    message: string,
    public readonly details?: Record<string, unknown>
  ) {
    super(message);
    this.name = 'PageContentError';
  }
}

/**
 * The page changed between the read the caller based its anchor on and this write.
 *
 * Separate from PageContentError because it maps to a different MCP error code: the caller's
 * parameters were fine, the world moved. A client should re-read and retry, not rewrite its
 * arguments. See ErrorHandler.handleError().
 */
export class PageStaleError extends Error {
  constructor(
    message: string,
    public readonly details?: Record<string, unknown>
  ) {
    super(message);
    this.name = 'PageStaleError';
  }
}

const CONTEXT_RADIUS = 120;
const MAX_DIAGNOSTIC_LENGTH = 300;
/** Longest anchor, in words, the whitespace-tolerant search runs for: its cost is page words x anchor words. */
const MAX_TOLERANT_MATCH_WORDS = 256;

/** Escape literal text for a regular expression that must retain literal semantics. */
function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Decide which field to patch and which one to write back.
 *
 * Markdown pages must be patched and written as `markdown`, otherwise
 * BookStack may switch the page editor type. HTML pages must be patched
 * against `raw_html` (the stored source) rather than `html` (the rendered
 * output), otherwise page include tags get expanded permanently.
 */
export function selectSource(page: PageWithContent): PageSource {
  const editor = page.editor || '';
  const rawHtml = typeof page.raw_html === 'string' ? page.raw_html : '';

  if (editor === 'markdown' && typeof page.markdown === 'string') {
    // Stay on the markdown path even when the page is still empty, otherwise
    // the first append to a fresh markdown page would switch its editor type.
    // Only an inconsistent page (no markdown but stored HTML) falls back.
    if (page.markdown.trim().length > 0 || rawHtml.trim().length === 0) {
      return { writeField: 'markdown', source: page.markdown, editor };
    }
  }

  const source = rawHtml.length > 0 ? rawHtml : page.html || '';

  return { writeField: 'html', source, editor };
}

/**
 * Count literal (non-regex) occurrences of a needle.
 */
export function countOccurrences(haystack: string, needle: string): number {
  if (needle.length === 0) {
    return 0;
  }
  return haystack.split(needle).length - 1;
}

/**
 * Build a short excerpt around a position, with ellipses where truncated.
 */
export function contextAround(
  text: string,
  offset: number,
  radius: number = CONTEXT_RADIUS
): string {
  const start = Math.max(0, offset - radius);
  const end = Math.min(text.length, offset + radius);
  return `${start > 0 ? '…' : ''}${text.slice(start, end)}${end < text.length ? '…' : ''}`;
}

/**
 * When an exact match fails, look for the same text with different
 * whitespace. HTML stored by BookStack often differs from what a caller
 * copied out of a rendered view only by line breaks and indentation.
 */
function findWhitespaceTolerantMatch(source: string, needle: string): string | null {
  const trimmed = needle.trim();
  if (trimmed.length === 0) {
    return null;
  }

  const words = trimmed.split(/\s+/);
  if (words.length > MAX_TOLERANT_MATCH_WORDS) {
    return null;
  }

  const match = new RegExp(words.map(escapeRegExp).join('\\s+')).exec(source);
  if (!match) {
    return null;
  }

  return match[0].length > MAX_DIAGNOSTIC_LENGTH
    ? `${match[0].slice(0, MAX_DIAGNOSTIC_LENGTH)}…`
    : match[0];
}

/**
 * Apply a list of literal string edits in order.
 *
 * Each `old_string` must appear exactly once unless `replace_all` is set,
 * so an ambiguous anchor can never silently patch the wrong place.
 */
export function applyEdits(
  source: string,
  edits: PageEdit[]
): { result: string; applied: AppliedEdit[] } {
  if (!Array.isArray(edits) || edits.length === 0) {
    throw new PageContentError('At least one edit is required');
  }

  let current = source;
  const applied: AppliedEdit[] = [];

  edits.forEach((edit, index) => {
    const { old_string: oldString, new_string: newString, replace_all: replaceAll } = edit;

    if (typeof oldString !== 'string' || oldString.length === 0) {
      throw new PageContentError(`Edit ${index}: old_string must be a non-empty string`, {
        edit_index: index,
      });
    }

    if (oldString === newString) {
      throw new PageContentError(`Edit ${index}: old_string and new_string are identical`, {
        edit_index: index,
      });
    }

    const occurrences = countOccurrences(current, oldString);

    if (occurrences === 0) {
      const whitespaceMatch = findWhitespaceTolerantMatch(current, oldString);
      throw new PageContentError(`Edit ${index}: old_string not found in page content`, {
        edit_index: index,
        occurrences: 0,
        found_with_different_whitespace: whitespaceMatch,
        hint: whitespaceMatch
          ? 'The text exists but with different whitespace. Retry with the exact text shown in found_with_different_whitespace.'
          : 'Use bookstack_pages_read with the grep parameter to obtain an exact anchor string.',
      });
    }

    if (occurrences > 1 && !replaceAll) {
      const contexts: string[] = [];
      let searchFrom = 0;
      while (contexts.length < 3) {
        const at = current.indexOf(oldString, searchFrom);
        if (at === -1) {
          break;
        }
        contexts.push(contextAround(current, at));
        searchFrom = at + oldString.length;
      }

      throw new PageContentError(
        `Edit ${index}: old_string is not unique (${occurrences} occurrences)`,
        {
          edit_index: index,
          occurrences,
          first_occurrences: contexts,
          hint: 'Extend old_string with surrounding text to make it unique, or set replace_all to true.',
        }
      );
    }

    const firstOffset = current.indexOf(oldString);
    current = replaceAll
      ? current.split(oldString).join(newString)
      : `${current.slice(0, firstOffset)}${newString}${current.slice(firstOffset + oldString.length)}`;

    applied.push({
      index,
      occurrences_replaced: replaceAll ? occurrences : 1,
      context: contextAround(current, firstOffset),
    });
  });

  return { result: current, applied };
}

/**
 * Strip tags and decode the handful of entities BookStack emits in headings.
 *
 * A tag is `<[^<>]*>`, not `<[^>]*>`: the latter is quadratic on a run of unmatched '<'.
 */
function htmlToText(html: string): string {
  return html
    .replace(/<[^<>]*>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Reduce content to comparable text.
 *
 * BookStack rewrites stored HTML on save (heading anchors, `id` attributes),
 * so written content is verified on its text, not byte for byte.
 */
export function normalizeForComparison(value: string, writeField: PageWriteField): string {
  const text = writeField === 'markdown' ? value : htmlToText(value);
  return text.replace(/\s+/g, ' ').trim();
}

/**
 * Check whether a fragment is present, ignoring markup normalisation.
 */
export function containsNormalized(
  haystack: string,
  needle: string,
  writeField: PageWriteField
): boolean {
  const normalizedNeedle = normalizeForComparison(needle, writeField);
  if (normalizedNeedle.length === 0) {
    return true;
  }
  return normalizeForComparison(haystack, writeField).includes(normalizedNeedle);
}

/** What `^`, `$` and `.` treat as a line break in a multiline JavaScript regex. */
const LINE_TERMINATOR = /[\n\r\u2028\u2029]/;

function isBlank(char: string | undefined): boolean {
  return char === ' ' || char === '\t';
}

/** Read one line as a markdown heading, in linear time; the equivalent regex backtracked quadratically. */
function markdownHeading(line: string): { level: number; text: string } | undefined {
  let level = 0;
  while (line[level] === '#') {
    level += 1;
  }
  if (level === 0 || level > 6) {
    return undefined;
  }

  let start = level;
  while (isBlank(line[start])) {
    start += 1;
  }
  if (start === level) {
    return undefined;
  }
  if (start === line.length) {
    // Blanks only: the lazy title takes the last blank, so a second one is needed.
    return start - level > 1 ? { level, text: '' } : undefined;
  }

  // Drop closing hashes, then the blanks before them, keeping at least one character.
  let end = line.length;
  while (end > start && line[end - 1] === '#') {
    end -= 1;
  }
  while (end > start && isBlank(line[end - 1])) {
    end -= 1;
  }
  return { level, text: line.slice(start, Math.max(end, start + 1)).trim() };
}

interface CodeFence {
  char: string;
  length: number;
  rest: string;
}

/** Read one line as a code fence: up to three spaces, then three or more ` or ~. */
function codeFence(line: string): CodeFence | undefined {
  let indent = 0;
  while (indent < 4 && line[indent] === ' ') {
    indent += 1;
  }
  const char = line[indent];
  if (indent > 3 || (char !== '`' && char !== '~')) {
    return undefined;
  }

  let end = indent;
  while (line[end] === char) {
    end += 1;
  }
  return end - indent >= 3 ? { char, length: end - indent, rest: line.slice(end) } : undefined;
}

function markdownHeadings(source: string): Omit<Heading, 'length'>[] {
  const headings: Omit<Heading, 'length'>[] = [];
  let openFence: CodeFence | undefined;
  let offset = 0;
  for (const line of source.split(LINE_TERMINATOR)) {
    const fence = codeFence(line);
    if (openFence) {
      // Closed only by the same character, at least as long, with nothing after it.
      const closes =
        fence?.char === openFence.char &&
        fence.length >= openFence.length &&
        fence.rest.trim() === '';
      if (closes) {
        openFence = undefined;
      }
    } else if (fence && !(fence.char === '`' && fence.rest.includes('`'))) {
      openFence = fence;
    } else {
      const heading = markdownHeading(line);
      if (heading) {
        headings.push({ ...heading, offset });
      }
    }
    offset += line.length + 1;
  }
  return headings;
}

/** First match of global `pattern` at or after a never-decreasing `from`, so all calls scan `text` once. */
function forwardSearch(text: string, pattern: RegExp): (from: number) => number {
  let found: number | undefined;
  return (from) => {
    if (found !== undefined && (found === -1 || found >= from)) {
      return found;
    }
    pattern.lastIndex = from;
    found = pattern.exec(text)?.index ?? -1;
    return found;
  };
}

/** Every html heading in one forward pass; the equivalent regex was quadratic on unterminated tags. */
function htmlHeadings(source: string): Omit<Heading, 'length'>[] {
  const headings: Omit<Heading, 'length'>[] = [];
  const opening = /<h([1-6])\b/gi;
  const nextTagEnd = forwardSearch(source, />/g);
  const nextClosing = [1, 2, 3, 4, 5, 6].map((level) =>
    forwardSearch(source, new RegExp(`</h${level}>`, 'gi'))
  );

  for (let open = opening.exec(source); open; open = opening.exec(source)) {
    const tagEnd = nextTagEnd(opening.lastIndex);
    if (tagEnd === -1) {
      // No later `<hN` can be terminated either.
      break;
    }

    const level = Number(open[1]);
    const closeAt = nextClosing[level - 1](tagEnd + 1);
    if (closeAt === -1) {
      continue;
    }

    headings.push({
      level,
      text: htmlToText(source.slice(tagEnd + 1, closeAt)),
      offset: open.index,
    });
    opening.lastIndex = closeAt + `</h${level}>`.length;
  }

  return headings;
}

/**
 * Map the heading structure of a page, so a large page can be navigated
 * without loading its content.
 */
export function buildOutline(source: string, writeField: PageWriteField): Heading[] {
  const headings: Heading[] = (
    writeField === 'markdown' ? markdownHeadings(source) : htmlHeadings(source)
  ).map((heading) => ({ ...heading, length: source.length - heading.offset }));

  // A section runs to the next heading of the same or a higher level, subsections included.
  const open: Heading[] = [];
  for (const heading of headings) {
    while (open.length > 0 && (open.at(-1) as Heading).level >= heading.level) {
      const closed = open.pop() as Heading;
      closed.length = heading.offset - closed.offset;
    }
    open.push(heading);
  }
  return headings;
}

/** The heading a section name addresses: exact (trimmed, case-insensitive) first, else the one containing it. */
export function findSection(source: string, section: string, writeField: PageWriteField): Heading {
  const headings = buildOutline(source, writeField);
  const wanted = section.trim().toLowerCase();
  const exact = headings.filter((h) => h.text.trim().toLowerCase() === wanted);
  const matches =
    exact.length > 0 ? exact : headings.filter((h) => h.text.toLowerCase().includes(wanted));

  if (matches.length === 0) {
    throw new PageContentError(`Section not found: ${section}`, {
      available_sections: headings.map((h) => h.text),
      hint: 'Use bookstack_pages_outline to list the exact heading texts.',
    });
  }
  if (matches.length > 1) {
    throw new PageContentError(`Section is ambiguous: ${matches.length} headings match`, {
      matching_sections: matches.map((h) => h.text),
      hint: 'Pass the full text of exactly one heading. Headings with identical text cannot be told apart; anchor a bookstack_pages_edit on the text instead.',
    });
  }
  return matches[0];
}

/** Whether cutting `text` at `index` would split a surrogate pair. */
function splitsSurrogatePair(text: string, index: number): boolean {
  const high = text.charCodeAt(index - 1);
  const low = text.charCodeAt(index);
  return high >= 0xd800 && high <= 0xdbff && low >= 0xdc00 && low <= 0xdfff;
}

/**
 * Search inside page content and return exact matches with surrounding
 * context, suitable for building an `old_string` anchor.
 *
 * `context` is an exact slice of the source with no ellipses; the flags say where it was cut.
 */
export function grepContent(
  source: string,
  query: string,
  options: { caseInsensitive?: boolean; contextChars?: number; maxMatches?: number } = {}
): { matches: GrepMatch[]; total: number; truncated: boolean } {
  const { caseInsensitive = true, contextChars = 200, maxMatches = 10 } = options;

  if (query.length === 0) {
    throw new PageContentError('Search text must be non-empty');
  }

  // The caller controls only literal text: escaping it before compiling preserves literal
  // semantics and prevents backtracking or a whole-page match. RegExp also returns offsets in
  // the original source, unlike lowercasing the full source (which can change its UTF-16 length).
  const regex = new RegExp(escapeRegExp(query), caseInsensitive ? 'gi' : 'g');
  const matches: GrepMatch[] = [];
  let total = 0;

  // `total` counts EVERY match while only `maxMatches` are collected: a truncated result that
  // under-reported the total would read as "this anchor is unique" and a caller would edit on
  // that basis.
  for (const match of source.matchAll(regex)) {
    total += 1;
    if (matches.length < maxMatches) {
      const matchEnd = match.index + match[0].length;
      let start = Math.max(0, match.index - contextChars);
      let end = Math.min(source.length, matchEnd + contextChars);
      // Half a surrogate pair cannot be sent back as an anchor.
      if (start < match.index && splitsSurrogatePair(source, start)) {
        start += 1;
      }
      if (end > matchEnd && splitsSurrogatePair(source, end)) {
        end -= 1;
      }
      matches.push({
        offset: match.index,
        match: match[0],
        context: source.slice(start, end),
        context_truncated_start: start > 0,
        context_truncated_end: end < source.length,
      });
    }
  }

  return { matches, total, truncated: total > matches.length };
}

/**
 * Insert content at the start or end of a page, or of a named section.
 *
 * Returns the new source and, when a section was named, the heading it resolved to.
 */
export function insertContent(
  source: string,
  content: string,
  options: {
    position?: 'start' | 'end';
    section?: string;
    separator?: string;
    writeField: PageWriteField;
  }
): { result: string; heading: Heading | undefined } {
  const { position = 'end', section, writeField } = options;
  const separator = options.separator ?? (writeField === 'markdown' ? '\n\n' : '\n');

  let rangeStart = 0;
  let rangeEnd = source.length;
  let found: Heading | undefined;

  if (section) {
    found = findSection(source, section, writeField);

    // "start" means directly after the heading itself, not before it
    const headingBlock = source.slice(found.offset, found.offset + found.length);
    let headingEnd: number;
    if (writeField === 'markdown') {
      const lineBreak = headingBlock.indexOf('\n');
      headingEnd = found.offset + (lineBreak === -1 ? headingBlock.length : lineBreak);
    } else {
      const closing = /<\/h[1-6]>/i.exec(headingBlock);
      headingEnd =
        found.offset + (closing ? closing.index + closing[0].length : headingBlock.length);
    }

    rangeStart = headingEnd;
    rangeEnd = found.offset + found.length;
  }

  let insertAt = rangeStart;
  if (position === 'end') {
    // Step back over trailing whitespace so the inserted text stays inside
    // the section instead of being pushed against the next heading
    insertAt = rangeEnd;
    while (insertAt > rangeStart && /\s/.test(source[insertAt - 1])) {
      insertAt -= 1;
    }
  }

  const result =
    insertAt > 0
      ? `${source.slice(0, insertAt)}${separator}${content}${source.slice(insertAt)}`
      : `${content}${separator}${source.slice(insertAt)}`;
  return { result, heading: found };
}

/**
 * Refuse writes that would drop a large part of the page, unless the
 * caller explicitly opted in. Guards against an anchor that accidentally
 * swallows most of a document.
 */
export function assertNoUnexpectedShrink(before: string, after: string, allowShrink = false): void {
  if (allowShrink || before.length === 0) {
    return;
  }

  if (after.length < before.length * 0.5) {
    throw new PageContentError('Refusing to write: result is less than half the original size', {
      chars_before: before.length,
      chars_after: after.length,
      hint: 'Set allow_shrink to true if this reduction is intended.',
    });
  }
}

/**
 * Extract a character window from page content.
 */
export function sliceContent(
  source: string,
  offset = 0,
  length?: number
): {
  content: string;
  offset: number;
  length: number;
  total_chars: number;
  truncated: boolean;
} {
  const start = Math.max(0, Math.min(offset, source.length));
  const end = length === undefined ? source.length : Math.min(source.length, start + length);
  const content = source.slice(start, end);

  return {
    content,
    offset: start,
    length: content.length,
    total_chars: source.length,
    truncated: end < source.length,
  };
}
