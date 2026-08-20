/**
 * The fix report — the audit, turned round to face the person who has to act on it.
 *
 * A Touchstone report is written for a reader deciding whether an app ships. This is written
 * for whoever has to change the app, and for the model they will hand it to: it states the
 * problem, quotes the evidence, names the remedy the audit already proposed, and ends with
 * the requirement ids that must flip to `pass`. Those ids are the acceptance criteria, which
 * is what makes it a brief rather than a complaint.
 *
 * **Composed, never re-derived.** Every sentence here comes out of the frontmatter the agent
 * wrote: the finding, its severity, its evidence, its remedy. Nothing in this file judges the
 * app, re-scores it, or softens a verdict — invariant 1 holds on the way out of the archive
 * exactly as it holds on the way in. If the audit did not propose a fix, this says so rather
 * than inventing one.
 *
 * It is deliberately a *file*, not a chat: the dev team pastes it into whatever assistant they
 * use, or feeds it to one in CI, and it has to be complete on its own.
 */

import type { AssayMeta, Leg, RecordedPhase, RecordedRequirement, Severity } from '../../shared/types.js';
import { SEVERITY_RANK } from '../../shared/types.js';
import { PHASE_LABEL } from '../../shared/activity.js';

export interface FixReportLeg {
  meta: AssayMeta;
  /** Path relative to the reports root, cited so the reader can go to the source. */
  path: string;
}

export interface FixReportInput {
  subject: string;
  static?: FixReportLeg | null;
  functional?: FixReportLeg | null;
}

interface Finding {
  leg: Leg;
  requirement: RecordedRequirement;
  severity: Severity;
}

/**
 * Some notes end with the agent's own remedy, in a sentence it marks. Splitting it out is
 * the one piece of parsing here, and it is conservative: if the marker is absent the whole
 * note stays evidence and the report says no remedy was proposed. A guessed remedy in a
 * document whose purpose is to be executed would be worse than none.
 */
const REMEDY = /(?:^|\n|\s)(?:Remedy|Fix|Suggested fix|Recommendation)\s*:\s*/i;

export function splitRemedy(note: string | undefined): { evidence: string; remedy: string | null } {
  const text = (note ?? '').trim();
  if (!text) return { evidence: '', remedy: null };
  const match = REMEDY.exec(text);
  if (!match || match.index === undefined) return { evidence: text, remedy: null };
  const evidence = text.slice(0, match.index).trim();
  const remedy = text.slice(match.index + match[0].length).trim();
  // A marker with nothing after it, or nothing before it, is not a split worth making.
  if (!evidence || !remedy) return { evidence: text, remedy: null };
  return { evidence, remedy };
}

function findingsOf(input: FixReportInput): Finding[] {
  const out: Finding[] = [];
  for (const leg of ['static', 'functional'] as const) {
    const source = input[leg];
    if (!source) continue;
    for (const requirement of source.meta.requirements ?? []) {
      if (requirement.verdict !== 'fail') continue;
      out.push({ leg, requirement, severity: requirement.severity ?? 'minor' });
    }
  }
  // Worst first: the order a dev should work in, and the order the gate cares about.
  return out.sort((a, b) => SEVERITY_RANK[b.severity] - SEVERITY_RANK[a.severity]);
}

function failedPhases(meta: AssayMeta | undefined): RecordedPhase[] {
  return (meta?.phases ?? []).filter((p) => p.result === 'fail' || p.result === 'errored');
}

/** Whether there is anything to write a brief about. The UI hides the button when there is not. */
export function hasFixWork(input: FixReportInput): boolean {
  return (
    findingsOf(input).length > 0 ||
    failedPhases(input.static?.meta).length > 0 ||
    failedPhases(input.functional?.meta).length > 0
  );
}

export function fixReportFilename(subject: string): string {
  return `${subject}-fix.md`;
}

const SEVERITY_WORD: Record<Severity, string> = {
  critical: 'CRITICAL',
  major: 'MAJOR',
  minor: 'MINOR',
  none: 'NONE',
};

/**
 * The document.
 *
 * Returns null only when there is no assay at all — there is nothing honest to say about an
 * app nobody has looked at, and a brief that opened with "no issues found" would read as a
 * clean bill of health.
 */
export function buildFixReport(input: FixReportInput): string | null {
  const legs = [input.static, input.functional].filter(Boolean) as FixReportLeg[];
  if (legs.length === 0) return null;

  const findings = findingsOf(input);
  const L: string[] = [];
  const ref = legs.find((l) => l.meta.subject_ref)?.meta.subject_ref;
  const repo = ref ? parseRef(ref) : null;

  L.push(`# Fix ${input.subject}${repo ? ` — ${repo.repo}` : ''}`);
  L.push('');
  L.push(
    `You are fixing one app in the Yundera AppStore so that it passes Touchstone's conformance audit. ` +
      `Everything below was recorded by the audit itself; the evidence is quoted verbatim and is not a summary.`,
  );
  L.push('');

  // ── the facts a change needs before it is safe to make ────────────────────────────────
  L.push('## The subject');
  L.push('');
  L.push(`- **App** \`${input.subject}\``);
  if (repo) {
    L.push(`- **Repository** \`${repo.repo}\` at ref \`${repo.ref}\``);
    L.push(`- **Path** \`${repo.path}\` — \`${repo.path}/docker-compose.yml\` is the file most findings are about`);
  }
  for (const leg of legs) {
    const m = leg.meta;
    L.push(
      `- **${cap(m.leg)} leg** — ${m.status === 'blocked' ? 'blocked' : (m.verdict ?? 'no verdict')}` +
        `${m.status === 'blocked' ? '' : ` · top severity ${m.top_severity} · risk ${m.risk_score}`}` +
        ` · judged by ${m.standard} v${m.standard_version} · finished ${m.finished_at}`,
    );
  }
  const images = legs.flatMap((l) => l.meta.images ?? []);
  if (images.length > 0) L.push(`- **Images** ${images.map((i) => `\`${i}\``).join(', ')}`);
  const commit = legs.find((l) => l.meta.commit)?.meta.commit;
  if (commit) L.push(`- **Commit audited** \`${commit}\``);
  L.push('');

  // A blocked leg is a statement about the environment, and saying so here stops a reader
  // from concluding that half of the app was checked and found fine. Invariant 4.
  const blocked = legs.filter((l) => l.meta.status === 'blocked');
  for (const leg of blocked) {
    L.push(
      `> The ${leg.meta.leg} leg could not run (\`${leg.meta.blocked_reason ?? 'unknown'}\`). That is a fact about ` +
        `Touchstone's environment, not about this app: nothing below covers what that leg would have checked.`,
    );
    L.push('');
  }

  // ── how to use it ─────────────────────────────────────────────────────────────────────
  L.push('## Rules of engagement');
  L.push('');
  L.push('1. Change only what a finding below requires. An unrelated improvement makes the fix harder to review and can break a requirement that currently passes.');
  L.push('2. Each finding names a **requirement id**. Those ids are the acceptance criteria — the next audit checks the same ids.');
  L.push('3. Where the audit proposed a remedy it is quoted under **Proposed fix**. Where it did not, derive one from the requirement and the evidence, and say what you chose and why.');
  L.push('4. `CONTRIBUTING.md` in the app repository is the normative source. Read it before changing the compose file; the audit is an application of it, not a replacement for it.');
  L.push('5. Do not edit anything under Touchstone — the report is a record. Fix the app.');
  L.push('');

  // ── the work ──────────────────────────────────────────────────────────────────────────
  if (findings.length === 0) {
    L.push('## What must change');
    L.push('');
    L.push('No failing requirement was recorded.');
    L.push('');
  } else {
    L.push(`## What must change (${findings.length})`);
    L.push('');
    const critical = findings.filter((f) => f.severity === 'critical').length;
    if (critical > 0) {
      L.push(
        `**${critical} of these ${critical === 1 ? 'is' : 'are'} Critical.** Touchstone's gate is unconditional: ` +
          `any Critical finding makes the app non-compliant regardless of how much else passes. Fix ${critical === 1 ? 'it' : 'those'} first.`,
      );
      L.push('');
    }

    findings.forEach((f, i) => {
      const { evidence, remedy } = splitRemedy(f.requirement.note);
      L.push(`### ${i + 1}. \`${f.requirement.id}\` — ${SEVERITY_WORD[f.severity]}`);
      L.push('');
      if (f.requirement.requirement) L.push(`**Requirement** ${f.requirement.requirement}`);
      L.push(`**Leg** ${f.leg}`);
      if (f.requirement.unlisted) {
        L.push('**Note** The protocol does not list this id — the audit recorded it anyway. Treat it as a real finding and expect the requirement list to gain it.');
      }
      L.push('');
      L.push('**What the audit found**');
      L.push('');
      L.push(quote(evidence || 'No evidence was recorded.'));
      L.push('');
      if (remedy) {
        L.push('**Proposed fix**');
        L.push('');
        L.push(quote(remedy));
      } else {
        L.push('**Proposed fix** — the audit did not propose one. Derive it from the requirement above.');
      }
      L.push('');
    });
  }

  // ── functional behaviour ──────────────────────────────────────────────────────────────
  const phases = input.functional?.meta.phases ?? [];
  if (phases.length > 0) {
    const bad = failedPhases(input.functional?.meta);
    L.push('## Functional behaviour');
    L.push('');
    if (bad.length === 0) {
      L.push(
        `All ${phases.length} functional phases passed — ${phases.map((p) => `\`${p.phase}\``).join(', ')} — ` +
          'including F (zero-config usability) and G (data survives an uninstall/reinstall). Whatever you change must keep them passing.',
      );
    } else {
      L.push('These phases did not pass. A failed phase is behaviour a user would hit, not paperwork:');
      L.push('');
      for (const p of bad) {
        L.push(`- **Phase ${p.phase}${PHASE_LABEL[p.phase] ? ` — ${PHASE_LABEL[p.phase]}` : ''}** — ${p.result}${p.note ? `: ${oneLine(p.note)}` : ''}`);
      }
    }
    L.push('');
  }

  // ── the ground that must not move ─────────────────────────────────────────────────────
  const passing = legs.flatMap((l) => (l.meta.requirements ?? []).filter((r) => r.verdict === 'pass'));
  const unverified = legs.flatMap((l) => (l.meta.requirements ?? []).filter((r) => r.verdict === 'unverified'));
  if (passing.length > 0) {
    L.push(`## Already passing — do not regress (${passing.length})`);
    L.push('');
    L.push(passing.map((r) => `\`${r.id}\``).join(', '));
    L.push('');
  }
  if (unverified.length > 0) {
    L.push('## Not checked');
    L.push('');
    L.push(
      `The audit did not settle ${unverified.map((r) => `\`${r.id}\``).join(', ')}. ` +
        'Absence of a finding here is not a pass — it is a question nobody answered.',
    );
    L.push('');
  }

  // ── done means this ───────────────────────────────────────────────────────────────────
  L.push('## Acceptance');
  L.push('');
  if (findings.length > 0) {
    L.push('The change is complete when a re-audit records these ids as `pass`:');
    L.push('');
    L.push(findings.map((f) => `- \`${f.requirement.id}\``).join('\n'));
    L.push('');
  }
  L.push(
    'Touchstone re-audits from the repository, so the fix has to be **merged** to be seen. ' +
      'Compliance is gated on severity, not on a count: one Critical outranks every pass.',
  );
  L.push('');

  L.push('---');
  L.push('');
  L.push(
    `Composed by Touchstone from ${legs.map((l) => `\`${l.path}\``).join(' and ')}. ` +
      'Those files are the full audit, including the passing evidence summarised above.',
  );
  L.push('');

  return L.join('\n');
}

/** `Yundera/AppStore@main:Apps/SegmentPlayer` → its three parts. */
function parseRef(ref: string): { repo: string; ref: string; path: string } | null {
  const match = /^([^@]+)@([^:]+):(.+)$/.exec(ref.trim());
  if (!match) return null;
  return { repo: match[1]!, ref: match[2]!, path: match[3]! };
}

function quote(text: string): string {
  return text
    .split('\n')
    .map((line) => `> ${line}`.trimEnd())
    .join('\n');
}

function oneLine(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

function cap(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}
