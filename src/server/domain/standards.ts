/**
 * The standard **in force** — what would judge a subject if it were audited right now, and
 * when that last moved.
 *
 * Every assay already records the revision that judged it (`standard_sha256`, invariant 9).
 * Until this file existed nothing read it back, so a rubric edit changed what the *next*
 * audit was judged by and said nothing about the verdicts that predated it. Two readers want
 * that answer, and they want two different halves of it:
 *
 *   - `sections` — the identity of each rubric now, per section. `domain/hallmark.ts`
 *     compares it against the sha the **last verdict** carries, which is the honest statement
 *     for a badge: *this verdict was reached under an older revision*.
 *   - `moved_at` — when the judging set last changed. `scheduler/policy.ts` compares it
 *     against the subject's last **attempt**, which is the honest statement for scheduling:
 *     *we have not looked at this app since the standard moved*.
 *
 * They are deliberately not one predicate. A section that is permanently blocked (no bench,
 * an unsatisfiable `requires:`) keeps its old `done` record forever, so a scheduler reading
 * the verdict's sha would find that subject stale on every tick until the end of time and
 * re-audit it every cooldown for a section it cannot run. Attempting under the new standard
 * has to settle the scheduling question even when the attempt blocked — invariant 4 says
 * `blocked` is not a statement about the subject, but it *is* a statement that we looked.
 * The badge, meanwhile, must keep saying "older" for exactly as long as the verdict on
 * display was reached under an older revision, which is what it is for.
 *
 * **`scores: false` sections are excluded from `moved_at`.** Invariant 12 says a reading is
 * invisible to the hallmark: not summed into risk, not allowed to set `age_days`. This is the
 * third clause — not allowed to move the backlog either. `currency.sh` is a six-second script
 * that rides every audit; letting a threshold edit in it make all 72 subjects eligible would
 * spend three days of agent time re-measuring something that re-measures itself for free on
 * the next run. Their `sections` entry is still built, because a per-section badge on a
 * reading is honest and costs nothing.
 *
 * The orchestrator counts toward `moved_at` and carries no badge, which is the one asymmetry
 * here. Its prose goes into the prompt (`runner/prompt.ts`), so editing it does change what
 * judges a run — but no assay records its hash, so the archive cannot say which revision of
 * it was in force. Re-eligibility is derivable; a badge is not, and inventing one would be
 * inventing the evidence.
 *
 * Only a recorded *edit* counts — an `observed` or a `save`, never a `seed`. See `movedAt`.
 *
 * The timestamps come from the revision log rather than from file mtimes. An mtime is
 * rewritten by a checkout or a container redeploy, and using it would put the whole store
 * back in the backlog every time the image was pulled; the log only gains an entry when the
 * *bytes* changed. If the sweep has not seen an edit yet, or the history is unwritable, this
 * reports no movement at all — the feature goes inert rather than guessing.
 */

import { lineOf, type LineKey } from '../../shared/schedule.js';
import type { Revision } from '../../shared/standard.js';
import type { Section } from '../../shared/types.js';
import { sectionsOf, type Protocol, type ProtocolStore } from '../store/protocols.js';
import type { RevisionStore } from '../store/revisions.js';

/** The identity of one section's rubric, and of the script that performs it. */
export interface SectionStandard {
  sha256: string;
  /** Only for a section an executor performs. Its version, in the same sense. */
  executor_sha256?: string;
}

export type Standards = Record<Section, SectionStandard>;

export interface StandardSnapshot {
  sections: Standards;
  /** When the judging set last changed, anywhere. Absent when the history cannot say. */
  moved_at?: string;
  /**
   * When each **line**'s judging set last changed — the per-platform answer.
   *
   * The scheduler reads this one, because re-eligibility is per line: editing
   * `functional-foss.md` must put the FOSS line back in the backlog and leave the Yundera
   * rotation alone, or one platform's rubric edit spends days of agent time re-auditing the
   * other. `moved_at` above stays the max, for readers whose question is about the standard
   * as a whole.
   *
   * The orchestrator counts toward **every** line, since its prose goes into every prompt.
   */
  moved_at_by_line: Record<LineKey, string | undefined>;
}

/** One file of the standard and the bytes it holds now. */
interface StandardFile {
  file: string;
  sha256: string;
}

/**
 * Read the standard in force.
 *
 * `revisions` is optional and a failure in it is not an error: a history that cannot be read
 * costs the `moved_at` half and leaves the badges working.
 */
export async function readStandards(
  protocols: ProtocolStore,
  revisions?: RevisionStore,
): Promise<StandardSnapshot> {
  const list = await protocols.list();
  const { sections, judging, byLine } = await resolve(protocols, list);
  const moved_at_by_line: Record<LineKey, string | undefined> = {};
  for (const [line, files] of byLine) {
    moved_at_by_line[line] = (await movedAt(files, revisions)).moved_at;
  }
  return { sections, moved_at_by_line, ...(await movedAt(judging, revisions)) };
}

/**
 * Split the protocol directory into the per-section identities and the set of files whose
 * bytes decide a verdict.
 */
async function resolve(
  protocols: ProtocolStore,
  list: readonly Protocol[],
): Promise<{ sections: Standards; judging: StandardFile[]; byLine: Map<LineKey, StandardFile[]> }> {
  const fileOf = new Map(list.map((p) => [p.meta.id, p.file]));
  const sections: Standards = {};
  // The orchestrator's body is in the prompt, so its bytes judge every agent section.
  const orchestrators: StandardFile[] = list
    .filter((p) => p.meta.kind === 'orchestrator')
    .map((p) => ({ file: p.file, sha256: p.sha256 }));
  const judging: StandardFile[] = [...orchestrators];
  const byLine = new Map<LineKey, StandardFile[]>();
  const into = (line: LineKey): StandardFile[] => {
    // Seeded with the orchestrators, because they judge every line.
    if (!byLine.has(line)) byLine.set(line, [...orchestrators]);
    return byLine.get(line)!;
  };

  for (const section of sectionsOf(list)) {
    // A missing or unsafely-named script is not resolved here: `runner/exec.ts` records that
    // section blocked (invariant 11), and a section that cannot run cannot go stale either.
    const executor =
      section.executor.kind === 'script' ? await protocols.executor(section.executor.file) : null;
    sections[section.id] = {
      sha256: section.sha256,
      ...(executor ? { executor_sha256: executor.sha256 } : {}),
    };
    if (!section.scores) continue;
    const line = into(lineOf(section));
    // **`rubric`, not `id`.** `fileOf` is keyed on the protocol file's own id, so a section id
    // derived from (rubric, target) misses — and the `if (file)` below would swallow the miss,
    // leaving the rubric contributing to neither `judging` nor this line. The symptom is a
    // rubric edit that silently stops re-eligibling anybody: no error, no failing test, a whole
    // clause quietly inert. `rubricOf` is the same value for a section that is not
    // target-scoped, so this is an identity until expansion lands.
    const file = fileOf.get(section.rubric);
    if (file) {
      judging.push({ file, sha256: section.sha256 });
      line.push({ file, sha256: section.sha256 });
    }
    if (executor) {
      judging.push({ file: executor.file, sha256: executor.sha256 });
      line.push({ file: executor.file, sha256: executor.sha256 });
    }
  }

  return { sections, judging, byLine };
}

/**
 * When any of these files last became what it is now.
 *
 * Matching on the hash rather than taking each file's newest entry is what makes a stale log
 * harmless: an edit the sweep has not recorded yet contributes nothing, so the answer is
 * always a moment that actually happened. It can therefore move *backwards* while the sweep
 * is behind, which errs the safe way — the only thing a later `moved_at` can do is put
 * subjects into the backlog.
 */
async function movedAt(
  judging: readonly StandardFile[],
  revisions?: RevisionStore,
): Promise<{ moved_at?: string }> {
  if (!revisions || judging.length === 0) return {};
  let log: Revision[];
  try {
    log = await revisions.all(); // newest first
  } catch {
    return {};
  }

  let newest: string | undefined;
  for (const want of judging) {
    // `seed` is skipped, and it is the difference between this shipping quietly and this
    // emptying the freshness window on deploy day. A seed is the sweep learning what was
    // already on the volume — the first boot after the history existed — so nothing moved,
    // and counting it would date the whole standard to that instant and make every verdict
    // in the archive older than it. The cost is the other kind of seed: a brand-new rubric
    // dropped onto the volume is not itself a trigger, and the subjects that have never been
    // judged by it come to it on the ordinary `fresh_days` rotation instead. The first edit
    // to that file — or to the orchestrator that composes it — records `observed` or `save`
    // and does trigger, which is the escape hatch if a week is too long to wait.
    const landed = log.find(
      (r) => r.file === want.file && r.sha256 === want.sha256 && r.source !== 'seed',
    );
    if (!landed?.at) continue;
    if (!newest || Date.parse(landed.at) > Date.parse(newest)) newest = landed.at;
  }
  return newest ? { moved_at: newest } : {};
}
