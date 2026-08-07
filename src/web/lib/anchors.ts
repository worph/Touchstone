/**
 * Matching a finding to a heading in the rendered report.
 *
 * The finding is the index, the report is the evidence — but the only link
 * between them is prose. The API emits heading anchors (markdown-it-anchor
 * slugs), and we cannot know the slug from the finding alone, so we score the
 * report's own headings by text instead. That works against the fixture and
 * against the real renderer without either having to agree on a scheme.
 */
import type { Finding } from '@shared/types';

const STOP = new Set([
  'a', 'an', 'the', 'and', 'or', 'no', 'not', 'on', 'in', 'of', 'to', 'for',
  'with', 'without', 'is', 'are', 'be', 'it', 'its', 'as', 'at', 'by',
]);

function tokens(s: string): string[] {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .split(' ')
    .filter((t) => t.length > 1 && !STOP.has(t));
}

/** Rule codes are `D1`..`D5`, `A`, `C`, `E8`, `E9`, `G` — or `—` for none. */
function hasRuleCode(rule: string): boolean {
  return /^[A-Z][0-9]?$/.test(rule);
}

export interface AnchorMatch {
  el: HTMLElement;
  score: number;
}

/**
 * @param root  the container holding the injected report HTML
 * @returns the best-matching heading, or null when the report has no section
 *          for this finding (which is normal — passes rarely get one).
 */
export function findHeadingFor(root: HTMLElement, f: Finding): AnchorMatch | null {
  const headings = Array.from(
    root.querySelectorAll<HTMLElement>('h1, h2, h3, h4, h5, h6'),
  );
  if (headings.length === 0) return null;

  const want = tokens(f.title ?? '');
  const rule = (f.rule ?? '').trim();
  const codeRe = hasRuleCode(rule) ? new RegExp(`(^|[^a-z0-9])${rule}([^a-z0-9]|$)`, 'i') : null;

  let best: AnchorMatch | null = null;
  for (const el of headings) {
    // strip the "#" permalink markdown-it-anchor injects
    const text = (el.textContent ?? '').replace(/^#\s*/, '').trim();
    if (!text) continue;

    let score = 0;
    if (codeRe && codeRe.test(text)) score += 60;

    const got = new Set(tokens(text));
    if (want.length) {
      const hit = want.filter((t) => got.has(t)).length;
      score += (hit / want.length) * 55;
      // an exact title match should always win over a bare rule-code match
      if (hit === want.length && want.length >= 2) score += 25;
    }

    if (!best || score > best.score) best = { el, score };
  }

  // Below this, the "match" is one incidental shared word and jumping the
  // report to it is worse than not moving at all.
  return best && best.score >= 40 ? best : null;
}

/**
 * Scroll the *pane*, never the window — the report lives in its own scroll
 * container and moving the page instead would throw away the findings list.
 */
export function scrollPaneTo(pane: HTMLElement, el: HTMLElement, offset = 12): void {
  const paneBox = pane.getBoundingClientRect();
  const elBox = el.getBoundingClientRect();
  const top = pane.scrollTop + (elBox.top - paneBox.top) - offset;
  pane.scrollTo({ top: Math.max(0, top), behavior: 'smooth' });
}

/** A brief highlight, so the eye lands where the scroll landed. */
export function flash(el: HTMLElement): void {
  el.classList.remove('md-flash');
  // force reflow so the animation restarts on repeated clicks
  void el.offsetWidth;
  el.classList.add('md-flash');
  window.setTimeout(() => el.classList.remove('md-flash'), 1600);
}
