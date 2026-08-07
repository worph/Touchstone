/**
 * Report body → HTML.
 *
 * Two requirements, both from MVP.md §6:
 *   - HTML in the source is **escaped, not passed through** (`html: false`). Report bodies
 *     are written by an agent and arrive over MCP from Docmost; they are not trusted
 *     markup and there is no auth in front of this app.
 *   - Headings carry anchors, so a finding in the left pane can deep-link to the section
 *     of the report that evidences it (UX.md §2.2).
 */

import MarkdownIt from 'markdown-it';
import anchor from 'markdown-it-anchor';

/**
 * Heading text → anchor id. Deterministic and stable: the web side computes the same slug
 * from a finding's rule code or title to build the link target, without asking the server.
 */
export function slugify(text: string): string {
  return (
    text
      .normalize('NFKD')
      // strip combining marks left by the decomposition
      .replace(/[\u0300-\u036f]/g, '')
      .toLowerCase()
      .replace(/[^\p{L}\p{N}]+/gu, '-')
      .replace(/^-+|-+$/g, '') || 'section'
  );
}

function createRenderer(): MarkdownIt {
  const md = new MarkdownIt({
    html: false, // source HTML is escaped, never rendered
    linkify: true,
    breaks: false,
    typographer: false,
  });

  md.use(anchor, {
    level: [1, 2, 3, 4, 5, 6],
    slugify,
    tabIndex: false,
    permalink: anchor.permalink.linkInsideHeader({
      symbol: '#',
      class: 'heading-anchor',
      placement: 'after',
      ariaHidden: true,
    }),
  });

  return md;
}

const renderer = createRenderer();

/** Render a report body. The frontmatter block must already have been stripped. */
export function renderMarkdown(source: string): string {
  return renderer.render(source ?? '');
}

export interface Heading {
  level: number;
  text: string;
  /** The `id` actually emitted, duplicates disambiguated exactly as in the HTML. */
  slug: string;
}

/**
 * The headings of a report, with the ids the renderer really produced — read back off the
 * token stream rather than re-derived, so duplicate-heading suffixes always agree.
 */
export function extractHeadings(source: string): Heading[] {
  const tokens = renderer.parse(source ?? '', {});
  const out: Heading[] = [];
  for (let i = 0; i < tokens.length; i += 1) {
    const open = tokens[i];
    if (!open || open.type !== 'heading_open') continue;
    const inline = tokens[i + 1];
    out.push({
      level: Number(open.tag.slice(1)) || 1,
      text: (inline?.content ?? '').trim(),
      slug: open.attrGet('id') ?? '',
    });
  }
  return out;
}
