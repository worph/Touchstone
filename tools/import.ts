/**
 * `yarn sync` — run the importer from the command line.
 *
 * The importer itself is `src/server/services/importer.ts`, because the API runs it on a
 * timer and has to upsert the results into its live index. This file is what is left once
 * that moved out: argv, printing, and an exit code.
 *
 *   yarn sync               fetch from Docmost via beacon, using the on-disk page cache
 *   yarn sync --refresh     ignore the page cache and re-fetch every page
 *   yarn sync --offline     fail rather than hit the network; cache only
 *   yarn sync --dry-run     parse and report, write nothing
 *
 * Note that a hand-run import does *not* show up in a running dev server: the index is
 * built at boot. Restart the API, or let the timer do it.
 */

import { runImport } from '../src/server/services/importer.js';

const argv = process.argv.slice(2);

const summary = await runImport({
  refresh: argv.includes('--refresh'),
  offline: argv.includes('--offline'),
  dryRun: argv.includes('--dry-run'),
  onProgress: (line) => console.log(line),
}).catch((err) => {
  console.error(err);
  process.exit(1);
});

const only = summary.rollupOnly;
console.log('');
console.log(`subjects            ${summary.subjects}`);
console.log(`reports fetched     ${summary.fetched}`);
console.log(`roll-up only        ${only.length}${only.length ? ` (${only.join(', ')})` : ''}`);
console.log(`functional blocked  ${summary.functionalBlocked}`);
console.log(`scored from row     ${summary.scoredFromRow}`);
console.log(
  argv.includes('--dry-run')
    ? 'dry run — nothing written'
    : `written ${summary.written}, unchanged ${summary.unchanged}`,
);
console.log(`reports root        ${summary.reportsRoot}`);
