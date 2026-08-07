/**
 * The Findings page, before there is a Findings page.
 *
 * A CLI over exactly the query the UI will run — group by rule across the latest assay per
 * (subject, leg) — so the rule vocabulary can be judged against real output while it is
 * being written, and so the acceptance result can be reproduced by hand:
 *
 *   yarn run tsx tools/query.ts              the whole grouping, biggest cluster first
 *   yarn run tsx tools/query.ts CPU2         one rule, with its subjects
 *   yarn run tsx tools/query.ts blocked      every leg the bench denied, with the reason
 *   yarn run tsx tools/query.ts uncoded      findings the vocabulary does not cover yet
 */

import { buildIndex } from '../src/server/store/index.js';
import { loadConfig } from '../src/server/store/config.js';

const cfg = await loadConfig();
const index = await buildIndex(cfg.reportsRoot, { cacheFile: null });
const arg = process.argv[2];

const row = (n: number, rule: string, status: string, title: string): string =>
  `${String(n).padStart(4)}  ${rule.padEnd(30)} ${status.padEnd(11)} ${title.slice(0, 56)}`;

if (arg === 'blocked') {
  for (const r of index.latestPerSubjectLeg({ status: 'any' })) {
    if (r.meta.status !== 'blocked') continue;
    console.log(`${r.subject.padEnd(24)} ${String(r.meta.blocked_reason).padEnd(20)} ${r.meta.blocked_detail ?? ''}`);
  }
} else if (arg === 'uncoded') {
  // The long tail. Anything recurring here is a candidate for data/standards/static-v3.yaml.
  const groups = index.groupByRule().filter((g) => g.rule.startsWith('x:'));
  console.log(`${groups.length} uncoded groups, ${groups.reduce((n, g) => n + g.subjects.length, 0)} findings`);
  for (const g of groups.slice(0, 40)) console.log(row(g.subjects.length, g.rule, g.status, g.title));
} else if (arg) {
  for (const g of index.groupByRule()) {
    if (g.rule !== arg) continue;
    console.log(`${g.rule} [${g.status}] ${g.title} — ${g.subjects.length} subject(s)`);
    console.log(`  ${g.subjects.join(' · ')}`);
  }
} else {
  console.log(`index: ${index.size} assays, ${index.subjects().length} subjects, ${index.broken.length} broken`);
  for (const g of index.groupByRule().slice(0, 45)) console.log(row(g.subjects.length, g.rule, g.status, g.title));
}
