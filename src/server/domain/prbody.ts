/**
 * The pull request a ready proposal becomes — its title and body.
 *
 * Like `fixreport.ts`, it **quotes**: the verdicts, risks and standard hashes come out of the
 * validation trials' frontmatter, the before/after findings out of the archive and the
 * trials, and the narrative out of the author's own submit summary, labelled as such. Nothing
 * is re-derived and nothing is invented — a reviewer is reading evidence, and a body that
 * paraphrased it would be a second, unaccountable opinion.
 */

import type { FindingRow, Proposal, SectionResult } from '../../shared/workshop.js';

/** GitHub refuses a body over 65,536 characters. */
export const PR_BODY_LIMIT = 65_536;

export function prTitle(p: Pick<Proposal, 'kind' | 'app' | 'to_version' | 'major'>): string {
  switch (p.kind) {
    case 'fix':
      return `[touchstone] ${p.app}: fix compliance`;
    case 'currency':
      return `[touchstone] ${p.app}: update${p.to_version ? ` to ${p.to_version}` : ' images'}${p.major ? ' (major)' : ''}`;
    case 'wish':
      return `[touchstone] ${p.app}: add app`;
  }
}

export interface PrBodyInput {
  proposal: Pick<Proposal, 'id' | 'kind' | 'app' | 'summary' | 'major' | 'to_version' | 'round'>;
  validation: readonly SectionResult[];
  before?: readonly FindingRow[];
  /** Failing requirements in the validation trials — empty when it passed, which it did. */
  after?: readonly FindingRow[];
  /** Report markdown per section, as copied into the proposal's evidence. */
  reports: readonly { section: string; text: string }[];
  /** Where the full trials can be read, when Touchstone has a public address. */
  trialUrl?: (slug: string) => string;
}

const cell = (v: unknown) => String(v ?? '—').replace(/\|/g, '\\|').replace(/\n/g, ' ');

export function buildPrBody(input: PrBodyInput): string {
  const p = input.proposal;
  const head: string[] = [];
  const what =
    p.kind === 'fix'
      ? `fixes the compliance findings of **${p.app}**`
      : p.kind === 'currency'
        ? `updates **${p.app}**${p.to_version ? ` to \`${p.to_version}\`` : ''}${p.major ? ' — **a major version**' : ''}`
        : `adds **${p.app}** to the store`;
  head.push(`This pull request was prepared by Touchstone's workshop and ${what}.`);
  head.push('');
  head.push(
    `Before it was opened, Touchstone audited the change with the store's standard on every platform it covers, in sessions independent of the one that wrote it. Every scoring section came back **compliant** (round ${p.round}). It still needs a person's review — Touchstone never merges.`,
  );
  head.push('');
  head.push('## What the author says it changed');
  head.push('');
  head.push(p.summary?.trim() || '_The author gave no summary._');
  head.push('');
  head.push('## Validation');
  head.push('');
  head.push('| Section | Platform | Verdict | Risk | Trial |');
  head.push('| --- | --- | --- | --- | --- |');
  for (const r of input.validation) {
    const trial = input.trialUrl ? `[${r.trial}](${input.trialUrl(r.trial)})` : `\`${r.trial}\``;
    head.push(`| ${cell(r.section)} | ${cell(r.target ?? 'any')} | ${cell(r.verdict ?? r.status)} | ${cell(r.risk_score)} | ${trial} |`);
  }
  if (p.kind === 'fix') {
    head.push('');
    head.push('## Findings before and after');
    head.push('');
    const before = input.before ?? [];
    const after = input.after ?? [];
    if (before.length === 0) {
      head.push('_The archive recorded no failing requirement to quote._');
    } else {
      head.push('| Requirement | Section | Severity | Now |');
      head.push('| --- | --- | --- | --- |');
      const stillFailing = new Set(after.map((f) => `${f.section}:${f.id}`));
      for (const f of before) {
        head.push(
          `| ${cell(f.requirement ?? f.id)} | ${cell(f.section)} | ${cell(f.severity)} | ${stillFailing.has(`${f.section}:${f.id}`) ? 'still failing' : 'passes'} |`,
        );
      }
    }
  }
  const standards = input.validation.filter((r) => r.standard_sha256);
  if (standards.length > 0) {
    head.push('');
    head.push('## Standard');
    head.push('');
    for (const r of standards) head.push(`- \`${r.section}\` judged by revision \`${r.standard_sha256!.slice(0, 12)}\``);
  }
  const foot = ['', '---', `<sub>Touchstone workshop · proposal \`${p.id}\` · label \`touchstone\`</sub>`];

  // The reports are the evidence, and the part that gets cut: the fixed part above is what a
  // reviewer needs to decide, the reports are what they need to check it.
  let body = head.join('\n');
  const tail = foot.join('\n');
  const cutNote = '\n\n_The remaining reports were cut to fit GitHub\'s limit; they are on the trials linked above._';
  let budget = PR_BODY_LIMIT - body.length - tail.length - cutNote.length - 64;
  const parts: string[] = [];
  let cut = false;
  if (input.reports.length > 0) parts.push('\n\n## Reports');
  for (const r of input.reports) {
    const block = `\n\n<details><summary>${r.section}</summary>\n\n${r.text.trim()}\n\n</details>`;
    if (block.length <= budget) {
      parts.push(block);
      budget -= block.length;
      continue;
    }
    if (budget > 400) {
      const keep = r.text.trim().slice(0, budget - 200);
      parts.push(`\n\n<details><summary>${r.section} (truncated)</summary>\n\n${keep}\n\n…\n\n</details>`);
    }
    cut = true;
    break;
  }
  body += parts.join('') + (cut ? cutNote : '') + '\n' + tail;
  return body.length > PR_BODY_LIMIT ? body.slice(0, PR_BODY_LIMIT) : body;
}
