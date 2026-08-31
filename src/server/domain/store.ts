/**
 * The narrow view of the archive that the domain and the routes need.
 *
 * Stream A owns `src/server/store/**` and the real implementation; nothing in this
 * directory imports it. The routes take an `AssayStore` by injection and fall back to
 * the in-memory fixtures in `./fixtures.ts` so this stream builds and tests standalone.
 * Integration is a one-line change: pass A's index into `registerRoutes`.
 */

import type { AssayMeta, AssayRecord, Section } from '../../shared/types.js';

export type MaybePromise<T> = T | Promise<T>;

/** One report file, read off disk: the parsed frontmatter plus the markdown body. */
export interface StoredReport {
  meta: AssayMeta;
  /** Markdown body, i.e. the file with its frontmatter block stripped. */
  body: string;
  /** Optional verbatim file contents. When absent, `body` is served as `raw`. */
  raw?: string;
}

export interface AssayStore {
  /** Every assay in the archive, any order. */
  all(): readonly AssayRecord[];

  /** The body of one report, addressed by `AssayRecord.path`. `null` if the file is gone. */
  read(path: string): MaybePromise<StoredReport | null>;

  /**
   * Optional fast paths. When absent the routes derive the same answers from `all()`,
   * so an implementation may provide neither, either, or both.
   */
  forSubject?(name: string): readonly AssayRecord[];
  latest?(subject: string, section: Section): AssayRecord | null;

  /**
   * Delete every report of one subject, from disk and from the index. Optional: the fixture
   * store has no disk to delete from and simply does not offer it, and the route answers
   * that it cannot rather than pretending it did.
   *
   * The **only** destructive verb in this interface, and deliberately coarse — a subject, not
   * a file. There is no use for deleting one report of an audit and keeping the other: half
   * an audit in the archive is a hallmark composed from one section, which reads as a verdict
   * somebody reached rather than as a record somebody pruned.
   */
  purgeSubject?(name: string): MaybePromise<{ removed: number }>;
}

/** `forSubject` if the store has it, otherwise a scan of `all()`. Subject match is exact. */
export function recordsForSubject(store: AssayStore, name: string): readonly AssayRecord[] {
  if (store.forSubject) return store.forSubject(name);
  return store.all().filter((r) => r.subject === name);
}
