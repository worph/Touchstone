import { existsSync as nodeExistsSync, promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, URL } from 'node:url';

/** Real reports, imported from Docmost and committed. The only realistic corpus we have. */
export const FIXTURE_REPORTS = fileURLToPath(new URL('./fixtures/reports', import.meta.url));

/** The full imported archive, present only after `yarn run import` and never committed. */
export const DATA_REPORTS = fileURLToPath(new URL('../data/reports', import.meta.url));

/**
 * Every report in the corpus, at any depth, sorted.
 *
 * **Throws when it finds nothing**, and that is not defensive programming — it is the guard on
 * a specific way this suite can lie. This used to walk exactly two levels, `<Subject>/<file>`.
 * When the corpus moved under a store folder it would have returned an empty list rather than
 * an error, and every caller here is a `for (const f of await fixtureFiles())` loop: they would
 * all have passed while asserting nothing at all. A corpus helper that can quietly return
 * nothing is a helper that turns a broken suite green.
 */
export async function fixtureFiles(root = FIXTURE_REPORTS): Promise<string[]> {
  const out: string[] = [];
  const walk = async (dir: string): Promise<void> => {
    const entries = (await fs.readdir(dir, { withFileTypes: true })).sort((a, b) =>
      a.name.localeCompare(b.name),
    );
    for (const e of entries) {
      const abs = path.join(dir, e.name);
      if (e.isDirectory()) await walk(abs);
      else if (e.isFile() && e.name.endsWith('.md')) out.push(abs);
    }
  };
  await walk(root);
  if (out.length === 0) throw new Error(`no report fixtures found under ${root}`);
  return out;
}

export function existsSync(p: string): boolean {
  return nodeExistsSync(p);
}
