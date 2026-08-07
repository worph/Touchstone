import { existsSync as nodeExistsSync, promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, URL } from 'node:url';

/** Real reports, imported from Docmost and committed. The only realistic corpus we have. */
export const FIXTURE_REPORTS = fileURLToPath(new URL('./fixtures/reports', import.meta.url));

/** The full imported archive, present only after `yarn run import` and never committed. */
export const DATA_REPORTS = fileURLToPath(new URL('../data/reports', import.meta.url));

export async function fixtureFiles(root = FIXTURE_REPORTS): Promise<string[]> {
  const out: string[] = [];
  for (const subject of (await fs.readdir(root, { withFileTypes: true })).sort((a, b) =>
    a.name.localeCompare(b.name),
  )) {
    if (!subject.isDirectory()) continue;
    const dir = path.join(root, subject.name);
    for (const f of (await fs.readdir(dir)).sort()) {
      if (f.endsWith('.md')) out.push(path.join(dir, f));
    }
  }
  return out;
}

export function existsSync(p: string): boolean {
  return nodeExistsSync(p);
}
