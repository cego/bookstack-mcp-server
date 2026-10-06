/**
 * Unit tests for the partial-page-editing helpers.
 *
 * These are pure functions - no client, no HTTP, no BookStack. What they encode is the two
 * invariants the whole feature rests on, so they are asserted directly rather than through a
 * tool handler:
 *
 *  - a markdown page is patched and written through `markdown`, because writing `html` to one
 *    switches its editor type;
 *  - every other page is patched against `raw_html`, the STORED source, never against `html`,
 *    the rendered output - patching the rendered output writes back expanded page-include
 *    tags and destroys the includes permanently.
 *
 * The diagnostics are under test as much as the results: an anchor that does not match is the
 * normal case for a model driving these tools, and what it gets back - the same text found
 * with different whitespace, the first few ambiguous matches, the list of real section names -
 * is what lets it fix its own call instead of guessing.
 */

import { describe, expect, it } from 'bun:test';
import type { PageWithContent } from '../../src/types';
import {
  applyEdits,
  assertNoUnexpectedShrink,
  buildOutline,
  containsNormalized,
  countOccurrences,
  findSection,
  grepContent,
  insertContent,
  PageContentError,
  selectSource,
  sliceContent,
} from '../../src/utils/page-content';

const basePage: PageWithContent = {
  id: 1,
  book_id: 2,
  chapter_id: null,
  name: 'Test page',
  slug: 'test-page',
  priority: 0,
  draft: false,
  template: false,
  created_at: '2026-01-01T00:00:00.000000Z',
  updated_at: '2026-01-02T00:00:00.000000Z',
  created_by: 1,
  updated_by: 1,
  owned_by: 1,
  revision_count: 3,
  editor: 'wysiwyg',
  tags: [],
  html: '<p>rendered</p>',
  raw_html: '<p>stored</p>',
};

/** Capture the error a thunk throws, without depending on a `fail()` helper. */
function thrownBy(run: () => unknown): unknown {
  try {
    run();
  } catch (error) {
    return error;
  }
  return undefined;
}

describe('selectSource', () => {
  it('patches the stored html, not the rendered html', () => {
    // THE INVARIANT. `html` is what BookStack renders, with page includes resolved;
    // `raw_html` is what it stores. Patching the rendered output and writing it back would
    // replace every `{{@42}}` include with a frozen copy of its target, irreversibly.
    const result = selectSource(basePage);

    expect(result.writeField).toBe('html');
    expect(result.source).toBe('<p>stored</p>');
  });

  it('patches and writes markdown for markdown pages', () => {
    const result = selectSource({
      ...basePage,
      editor: 'markdown',
      markdown: '# Heading\n\nBody',
    });

    expect(result.writeField).toBe('markdown');
    expect(result.source).toBe('# Heading\n\nBody');
  });

  it('falls back to the rendered html when raw_html is absent', () => {
    const { raw_html: _omitted, ...withoutRaw } = basePage;
    const result = selectSource(withoutRaw as PageWithContent);

    expect(result.source).toBe('<p>rendered</p>');
  });

  it('ignores a blank markdown field on a markdown page that has stored html', () => {
    const result = selectSource({ ...basePage, editor: 'markdown', markdown: '   ' });

    expect(result.writeField).toBe('html');
  });

  it('keeps writing markdown on an empty markdown page', () => {
    // Falling back to html here would flip the editor type on the very first append to a
    // freshly created markdown page - the one case where there is no content to judge by.
    const result = selectSource({
      ...basePage,
      editor: 'markdown',
      markdown: '',
      raw_html: '',
      html: '',
    });

    expect(result.writeField).toBe('markdown');
    expect(result.source).toBe('');
  });
});

describe('countOccurrences', () => {
  it('counts literally, without regex interpretation', () => {
    // '.' as a regex would match every character. Anchors are caller-supplied prose full of
    // dots, brackets and parentheses, so the match has to be literal.
    expect(countOccurrences('a.b.c', '.')).toBe(2);
    // Non-overlapping, which is what a sequence of replacements will actually do.
    expect(countOccurrences('aaa', 'aa')).toBe(1);
    expect(countOccurrences('abc', '')).toBe(0);
  });
});

describe('applyEdits', () => {
  const source = 'Intro paragraph.\n\nData is transferred on request.\n\nOutro.';

  it('replaces a unique anchor', () => {
    const { result, applied } = applyEdits(source, [
      {
        old_string: 'Data is transferred on request.',
        new_string: 'Data is transferred only with consent.',
      },
    ]);

    expect(result).toContain('only with consent');
    expect(result).not.toContain('on request.');
    expect(applied[0].occurrences_replaced).toBe(1);
  });

  it('applies multiple edits in order, each to the previous result', () => {
    const { result, applied } = applyEdits(source, [
      { old_string: 'Intro paragraph.', new_string: 'Introduction.' },
      { old_string: 'Outro.', new_string: 'Conclusion.' },
    ]);

    expect(result).toContain('Introduction.');
    expect(result).toContain('Conclusion.');
    expect(applied).toHaveLength(2);
  });

  it('rejects an anchor that is not present', () => {
    expect(() => applyEdits(source, [{ old_string: 'missing text', new_string: 'x' }])).toThrow(
      PageContentError
    );
  });

  it('reports the exact text when only the whitespace differs', () => {
    // The most common near-miss by far: a model reproduces an anchor with collapsed
    // whitespace, because that is how the text reads. Saying "not found" and stopping there
    // would leave it with no way forward, so the diagnostic carries the real bytes.
    const error = thrownBy(() =>
      applyEdits('<p>One  long\nsentence</p>', [
        { old_string: 'One long sentence', new_string: 'x' },
      ])
    );

    expect(error).toBeInstanceOf(PageContentError);
    expect((error as PageContentError).details?.found_with_different_whitespace).toBe(
      'One  long\nsentence'
    );
  });

  it('refuses an ambiguous anchor, and reports where the matches are', () => {
    const repeated = 'yes. yes. yes.';

    const error = thrownBy(() => applyEdits(repeated, [{ old_string: 'yes.', new_string: 'no.' }]));
    expect((error as PageContentError).message).toMatch(/not unique \(3 occurrences\)/);
    expect((error as PageContentError).details?.first_occurrences).toBeArray();

    // replace_all is the explicit opt-in for a rename that legitimately repeats.
    const { result, applied } = applyEdits(repeated, [
      { old_string: 'yes.', new_string: 'no.', replace_all: true },
    ]);
    expect(result).toBe('no. no. no.');
    expect(applied[0].occurrences_replaced).toBe(3);
  });

  it('rejects empty, no-op and absent edits', () => {
    expect(() => applyEdits(source, [{ old_string: '', new_string: 'x' }])).toThrow(
      PageContentError
    );
    expect(() => applyEdits(source, [{ old_string: 'Outro.', new_string: 'Outro.' }])).toThrow(
      PageContentError
    );
    expect(() => applyEdits(source, [])).toThrow(PageContentError);
  });

  it('replaces only the first occurrence once the anchor is unique', () => {
    const { result } = applyEdits('one two one', [
      { old_string: 'one two', new_string: 'ONE TWO' },
    ]);

    expect(result).toBe('ONE TWO one');
  });
});

describe('buildOutline', () => {
  it('maps markdown headings with offsets and section sizes', () => {
    const markdown = '# Title\n\nText\n\n## Section A\n\nMore text\n\n## Section B\n\nEnd';
    const headings = buildOutline(markdown, 'markdown');

    expect(headings.map((heading) => heading.text)).toEqual(['Title', 'Section A', 'Section B']);
    expect(headings[0].level).toBe(1);
    expect(headings[1].level).toBe(2);
    expect(headings[0].offset).toBe(0);
    // A heading's `length` is its SECTION's size, so the last one has to reach the end of
    // the document - that is what makes the offsets usable as insertion ranges.
    expect(headings[2].offset + headings[2].length).toBe(markdown.length);
  });

  it('maps html headings, stripping the markup and entities BookStack emits', () => {
    // `id="bkmrk-…"` is injected by BookStack on save, and `&amp;` is how it stores an
    // ampersand. A section name a caller can actually type has to survive both.
    const html =
      '<h1 id="bkmrk-a">Title &amp; more</h1><p>Text</p><h2>Section <em>A</em></h2><p>End</p>';
    const headings = buildOutline(html, 'html');

    expect(headings.map((heading) => heading.text)).toEqual(['Title & more', 'Section A']);
    expect(headings[1].level).toBe(2);
  });

  it('returns an empty outline for a page without headings', () => {
    expect(buildOutline('<p>Just a paragraph</p>', 'html')).toEqual([]);
  });

  it('keeps the markdown heading rules for closing hashes, blank titles and line breaks', () => {
    const markdown = [
      '# Title ##',
      '## ###',
      '####### seven',
      '#nospace',
      '#  ',
      '# ',
      '# a #b',
      '#\tTab title\t#',
      '### foo# ',
    ].join('\n');

    expect(
      buildOutline(markdown, 'markdown').map(({ level, text, offset }) => [level, text, offset])
    ).toEqual([
      [1, 'Title', 0],
      [2, '#', 11],
      [1, '', 41],
      [1, 'a #b', 48],
      [1, 'Tab title', 55],
      [3, 'foo#', 69],
    ]);
    expect(
      buildOutline('a\r# CR heading\r\n## CRLF\u2028### LS', 'markdown').map(({ text, offset }) => [
        text,
        offset,
      ])
    ).toEqual([
      ['CR heading', 2],
      ['CRLF', 16],
      ['LS', 24],
    ]);
  });

  it('ignores heading-like lines inside fenced code blocks', () => {
    const markdown = [
      '# Install',
      '```bash',
      '# not a heading',
      '```',
      '  ~~~~',
      '## inside a tilde fence',
      '~~~',
      '```',
      '~~~~',
      '## Usage',
      '````',
      '```',
      '# a shorter fence does not close it',
      '````',
      '    ```',
      '## After an indented fence-lookalike',
      '``` a`b',
      '## After a backtick fence with a backtick in its info string',
      '~~~',
      '# an unclosed fence runs to the end',
    ].join('\n');

    expect(buildOutline(markdown, 'markdown').map(({ text }) => text)).toEqual([
      'Install',
      'Usage',
      'After an indented fence-lookalike',
      'After a backtick fence with a backtick in its info string',
    ]);
  });

  it('only maps html headings closed by their own level', () => {
    const html = '<h1>One</h2><h2 class="x">Two</H2><h3>never closed<h12>no</h12><H4>Four</h4>';

    expect(
      buildOutline(html, 'html').map(({ level, text, offset }) => [level, text, offset])
    ).toEqual([
      [2, 'Two', 12],
      [4, 'Four', 63],
    ]);
  });
});

/**
 * Inputs that each blocked the event loop for seconds when outlining and comparison used
 * backtracking regular expressions. Every case must now finish well inside the budget.
 */
describe('pathological page content', () => {
  const BUDGET_MS = 200;

  function elapsedMs(work: () => unknown): number {
    const startedAt = performance.now();
    work();
    return performance.now() - startedAt;
  }

  it('outlines a markdown heading padded with tens of thousands of blanks', () => {
    for (const source of [`# a${' '.repeat(40_000)}x`, `# a${' \t'.repeat(20_000)}x\n## b`]) {
      expect(elapsedMs(() => buildOutline(source, 'markdown'))).toBeLessThan(BUDGET_MS);
    }
  });

  it('outlines markdown made of long fence runs', () => {
    for (const source of ['`'.repeat(80_000), '```\n'.repeat(20_000), `~~~${'`'.repeat(80_000)}`]) {
      expect(elapsedMs(() => buildOutline(source, 'markdown'))).toBeLessThan(BUDGET_MS);
    }
  });

  it('outlines html made of unterminated heading tags', () => {
    for (const source of ['<h1'.repeat(20_000), '<h1>'.repeat(20_000), '<h1 '.repeat(20_000)]) {
      expect(elapsedMs(() => buildOutline(source, 'html'))).toBeLessThan(BUDGET_MS);
    }
  });

  it('normalises a long run of unmatched "<" for comparison', () => {
    const stray = '<'.repeat(80_000);

    expect(elapsedMs(() => containsNormalized(stray, 'x', 'html'))).toBeLessThan(BUDGET_MS);
  });

  it('bounds the whitespace-tolerant search for a long anchor', () => {
    const page = 'word '.repeat(20_000);
    const anchor = `${'word  '.repeat(10_000)}missing`;

    let error: unknown;
    const ms = elapsedMs(() => {
      error = thrownBy(() => applyEdits(page, [{ old_string: anchor, new_string: 'x' }]));
    });

    expect(ms).toBeLessThan(BUDGET_MS);
    expect((error as PageContentError).details?.found_with_different_whitespace).toBeNull();
  });

  it('still finds an anchor of up to 256 words with different whitespace', () => {
    const words = (count: number) => Array.from({ length: count }, (_, i) => `w${i}`);
    const report = (count: number) =>
      (
        thrownBy(() =>
          applyEdits(words(count).join('\n  '), [
            { old_string: words(count).join(' '), new_string: 'x' },
          ])
        ) as PageContentError
      ).details?.found_with_different_whitespace;

    expect(report(256)).toStartWith('w0\n  w1\n  w2');
    expect(report(257)).toBeNull();
  });
});

describe('grepContent', () => {
  const source = 'Line one\nLine two\nLine three';

  it('returns literal matches with their offsets, matched text and context', () => {
    const { matches, total, truncated } = grepContent(source, 'Line one', { contextChars: 5 });

    expect(total).toBe(1);
    expect(truncated).toBe(false);
    expect(matches[0].match).toBe('Line one');
    expect(matches[0].offset).toBe(source.indexOf('Line one'));
  });

  it('returns an exact context, bounded on each side of the match, with truncation flags', () => {
    const page = `${'a'.repeat(50)}<p>retention period of 6 months</p>${'z'.repeat(50)}`;

    const [clipped] = grepContent(page, 'retention period of 6 months', {
      contextChars: 5,
    }).matches;
    const [whole] = grepContent(page, 'retention period', { contextChars: 500 }).matches;

    // No ellipses: the excerpt must be pasteable as an old_string anchor.
    expect(clipped).toMatchObject({
      context: 'aa<p>retention period of 6 months</p>z',
      context_truncated_start: true,
      context_truncated_end: true,
    });
    expect(whole).toMatchObject({
      context: page,
      context_truncated_start: false,
      context_truncated_end: false,
    });
  });

  it('never cuts a surrogate pair at the edge of the context', () => {
    const source = '\u{1F600}x\u{1F600}';

    expect(grepContent(source, 'x', { contextChars: 1 }).matches[0].context).toBe('x');
    expect(grepContent(source, 'x', { contextChars: 2 }).matches[0].context).toBe(source);
  });

  it('honours maxMatches while still reporting the true total', () => {
    // A truncated result that under-reported the total would read as "there is one match",
    // and a caller would anchor on it believing it unique.
    const { matches, total, truncated } = grepContent(source, 'Line', { maxMatches: 1 });

    expect(matches).toHaveLength(1);
    expect(total).toBe(3);
    expect(truncated).toBe(true);
  });

  it('is case insensitive by default and case sensitive on request', () => {
    expect(grepContent(source, 'line').total).toBe(3);
    expect(grepContent(source, 'line', { caseInsensitive: false }).total).toBe(0);
  });

  it('keeps offsets and excerpts aligned when case folding expands an earlier character', () => {
    const unicodeSource = 'İretention period';
    const result = grepContent(unicodeSource, 'retention period');

    expect(result.matches).toEqual([
      {
        offset: 1,
        match: 'retention period',
        context: unicodeSource,
        context_truncated_start: false,
        context_truncated_end: false,
      },
    ]);
  });

  it('treats regex syntax literally so it cannot return the whole page as one match', () => {
    const wholePagePattern = '[\\s\\S]*';

    expect(
      grepContent('All of this content must stay out of the response', wholePagePattern)
    ).toEqual({
      matches: [],
      total: 0,
      truncated: false,
    });
  });
});

describe('insertContent', () => {
  const markdown = '# Title\n\nIntro\n\n## Measures\n\nExisting text\n\n## Other\n\nEnd';

  it('appends at the end of the page', () => {
    const { result } = insertContent(markdown, 'New sentence', { writeField: 'markdown' });

    expect(result.endsWith('End\n\nNew sentence')).toBe(true);
  });

  it('appends at the end of a named section, before the next heading', () => {
    // Section targeting only works if the text lands inside the section it was addressed to,
    // instead of being pushed past its boundary into the following one.
    const { result } = insertContent(markdown, 'New sentence', {
      writeField: 'markdown',
      section: 'Measures',
    });

    expect(result).toContain('Existing text\n\nNew sentence\n\n## Other');
  });

  it('inserts directly after a section heading with position: start', () => {
    const { result } = insertContent(markdown, 'New sentence', {
      writeField: 'markdown',
      section: 'Measures',
      position: 'start',
    });

    expect(result).toContain('## Measures\n\nNew sentence');
  });

  it('inserts after an html section heading', () => {
    const html = '<h2 id="bkmrk-m">Measures</h2><p>Old</p><h2>Other</h2><p>End</p>';
    const { result } = insertContent(html, '<p>New</p>', {
      writeField: 'html',
      section: 'Measures',
      position: 'start',
      separator: '',
    });

    expect(result).toContain('<h2 id="bkmrk-m">Measures</h2><p>New</p><p>Old</p>');
  });

  it('matches a section name case-insensitively', () => {
    const { result } = insertContent(markdown, 'New sentence', {
      writeField: 'markdown',
      section: 'measures',
    });

    expect(result).toContain('Existing text\n\nNew sentence');
  });

  it('appends to a section after its code block, not inside it', () => {
    const source = '# Install\n\n```bash\n# comment\nnpm install\n```\n\n# Usage\n\nRun it';

    const { result } = insertContent(source, 'Then restart.', {
      writeField: 'markdown',
      section: 'Install',
    });

    expect(result).toBe(
      '# Install\n\n```bash\n# comment\nnpm install\n```\n\nThen restart.\n\n# Usage\n\nRun it'
    );
  });

  describe('section boundaries and matching', () => {
    const changelog = [
      '# Doc',
      '## Changelog',
      'Intro',
      '### 2026',
      'Entry A',
      '### 2025',
      'Entry B',
      '## Other',
      'End',
    ].join('\n');

    it('ends a section at the next heading of the same or higher level', () => {
      const { result } = insertContent(changelog, 'Entry C', {
        writeField: 'markdown',
        section: 'Changelog',
        separator: '\n',
      });

      expect(result).toContain('### 2025\nEntry B\nEntry C\n## Other');
    });

    it('sizes an outline section to include its subsections', () => {
      const headings = buildOutline(changelog, 'markdown');
      const section = headings.find((heading) => heading.text === 'Changelog');
      const other = headings.find((heading) => heading.text === 'Other');

      expect((section?.offset ?? 0) + (section?.length ?? 0)).toBe(other?.offset ?? -1);
      expect(headings.at(-1)?.text).toBe('Other');
      expect(headings[0].length).toBe(changelog.length);
    });

    it('prefers an exact heading over headings that merely contain the name', () => {
      const source = '# Setup notes\n\nA\n\n# Setup\n\nB';

      expect(findSection(source, ' setup ', 'markdown').text).toBe('Setup');
    });

    it('accepts a substring that matches exactly one heading', () => {
      const source = '# Setup notes\n\nA\n\n# Usage\n\nB';

      expect(findSection(source, 'notes', 'markdown').text).toBe('Setup notes');
    });

    it('refuses a name several headings match, and lists them', () => {
      const source = '# Install on Linux\n\nA\n\n# Install on macOS\n\nB\n\n# Usage\n\nC';

      const error = thrownBy(() => findSection(source, 'install', 'markdown'));

      expect(error).toBeInstanceOf(PageContentError);
      expect((error as PageContentError).details?.matching_sections).toEqual([
        'Install on Linux',
        'Install on macOS',
      ]);
    });

    it('refuses a name two identical headings share', () => {
      const error = thrownBy(() =>
        insertContent('## Notes\n\nA\n\n## Notes\n\nB', 'x', {
          writeField: 'markdown',
          section: 'notes',
        })
      );

      expect((error as PageContentError).details?.matching_sections).toEqual(['Notes', 'Notes']);
    });
  });

  it('lists the real section names when the section is unknown', () => {
    const error = thrownBy(() =>
      insertContent(markdown, 'x', { writeField: 'markdown', section: 'Absent' })
    );

    expect(error).toBeInstanceOf(PageContentError);
    expect((error as PageContentError).details?.available_sections).toEqual([
      'Title',
      'Measures',
      'Other',
    ]);
  });
});

describe('assertNoUnexpectedShrink', () => {
  it('allows an ordinary edit', () => {
    expect(() => assertNoUnexpectedShrink('a'.repeat(100), 'a'.repeat(80))).not.toThrow();
  });

  it('blocks a drastic reduction unless it was asked for', () => {
    // The failure this guards: an anchor whose closing text appears far earlier than the
    // author meant, so the replacement swallows most of the document. The write is refused
    // rather than applied, because BookStack's revision history is the only way back.
    expect(() => assertNoUnexpectedShrink('a'.repeat(100), 'a'.repeat(10))).toThrow(
      PageContentError
    );
    expect(() => assertNoUnexpectedShrink('a'.repeat(100), 'a'.repeat(10), true)).not.toThrow();
  });
});

describe('containsNormalized', () => {
  it('recognises written content after BookStack rewrote the markup', () => {
    // BookStack re-generates heading anchors and injects `id` attributes on save, so the
    // bytes that come back are not the bytes that were sent. Verifying byte-for-byte would
    // report every successful write as unverified.
    const stored = '<p id="bkmrk-new">Data is transferred only with consent.</p>';

    expect(
      containsNormalized(stored, '<p>Data is transferred only with consent.</p>', 'html')
    ).toBe(true);
    expect(containsNormalized(stored, '<p>Something else entirely</p>', 'html')).toBe(false);
  });

  it('compares markdown on collapsed whitespace', () => {
    expect(containsNormalized('# Title\n\nOne  sentence', 'One sentence', 'markdown')).toBe(true);
  });
});

describe('sliceContent', () => {
  it('returns a window and reports whether more follows', () => {
    const result = sliceContent('0123456789', 2, 3);

    expect(result.content).toBe('234');
    expect(result.offset).toBe(2);
    expect(result.total_chars).toBe(10);
    expect(result.truncated).toBe(true);
  });

  it('clamps an out-of-range offset instead of throwing', () => {
    expect(sliceContent('abc', 99).content).toBe('');
  });
});
