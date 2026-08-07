import { describe, expect, it } from 'vitest';
import { extractHeadings, renderMarkdown, slugify } from './markdown.js';

describe('rendering', () => {
  it('escapes HTML in the source instead of passing it through', () => {
    const html = renderMarkdown('<script>alert(1)</script>\n\nplain **text**');
    expect(html).not.toContain('<script>');
    expect(html).toContain('&lt;script&gt;');
    expect(html).toContain('<strong>text</strong>');
  });

  it('escapes inline HTML and attribute injection too', () => {
    const html = renderMarkdown('a <img src=x onerror="alert(1)"> b');
    expect(html).not.toContain('onerror="');
    expect(html).toContain('&lt;img');
  });

  it('renders tables and code fences', () => {
    const html = renderMarkdown('| a | b |\n| --- | --- |\n| 1 | 2 |\n\n```yaml\ncpu_shares: 10\n```');
    expect(html).toContain('<table>');
    expect(html).toContain('<code');
  });
});

describe('heading anchors', () => {
  it('gives every heading an id so a finding can deep-link to its evidence', () => {
    const html = renderMarkdown('# Yundera/AppStore — OpenClaw\n\n## Tech & Documentation\n');
    expect(html).toContain('id="yundera-appstore-openclaw"');
    expect(html).toContain('id="tech-documentation"');
    expect(html).toContain('href="#tech-documentation"');
  });

  it('slugifies the same way the web side will', () => {
    expect(slugify('Tech & Documentation')).toBe('tech-documentation');
    expect(slugify('D2 — root + user dir, no rationale.md')).toBe('d2-root-user-dir-no-rationale-md');
    expect(slugify('!!!')).toBe('section');
  });

  it('disambiguates duplicate headings, and reports the ids it really emitted', () => {
    const source = '## Findings\n\ntext\n\n## Findings\n';
    const headings = extractHeadings(source);
    expect(headings.map((h) => h.slug)).toEqual(['findings', 'findings-1']);
    expect(headings.map((h) => h.text)).toEqual(['Findings', 'Findings']);
    const html = renderMarkdown(source);
    for (const heading of headings) expect(html).toContain(`id="${heading.slug}"`);
  });
});
