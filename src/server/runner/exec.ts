/**
 * The script executor — how Touchstone performs a section that is not a rubric.
 *
 * A section declares `executor: currency.sh` and this spawns that file, hands it the subject
 * on **stdin** and reads one JSON object off **stdout**. That is the entire contract, and its
 * shape is chosen so the app learns nothing about what any particular check does: Touchstone
 * knows "a section produced rows, a badge and some requirements", never "an image is behind".
 *
 * Three properties are deliberate, and each one is a failure we did not want:
 *
 * 1. **Input on stdin, never argv.** Subject names come out of a GitHub directory listing, so
 *    an app directory called `; rm -rf ~` is something a stranger can open a PR for. Nothing
 *    interpolated into a command line means nothing to escape.
 * 2. **The script never declares a verdict.** It records requirements with severities and
 *    Touchstone computes the gate, exactly as invariant 6 requires of the agent — and rather
 *    more strictly, since the agent does get to declare its own headline. A check that could
 *    post its own verdict would make the protocol advisory.
 * 3. **`status: blocked` is the honest answer.** A rate-limited registry is an environment
 *    condition; it must record blocked and say why, never "up to date". Invariant 4, one layer
 *    out from the bench.
 *
 * This module spawns a path it is *given*. It never builds one — `ProtocolStore.executor()`
 * resolves and hashes the file, which is what keeps "nothing outside `store/` touches the
 * filesystem" true of the interesting half.
 */

import { spawn } from 'node:child_process';
import os from 'node:os';

import type { RequirementVerdict, Severity } from '../../shared/types.js';

/** How a script asks for one of its `rows` to be drawn. Presentation only. */
export interface ScriptColumn {
  key: string;
  label?: string;
  align?: 'left' | 'right';
  /**
   * The cell holds an ISO date and should be drawn as an age.
   *
   * A formatting hint, not knowledge: it is what lets *"400 days behind"* stay true between
   * assays without the app knowing what is being counted. Recording the duration instead
   * would freeze it at whatever it was the last time the check ran.
   */
  kind?: 'since';
}

export type BadgeState = 'ok' | 'warn' | 'bad' | 'unknown';

/** One requirement a script settled. The same shape the agent records through the ledger. */
export interface ScriptRequirement {
  id: string;
  verdict: RequirementVerdict;
  severity?: Severity;
  requirement?: string;
  note?: string;
}

/**
 * Exactly what a script may put on stdout.
 *
 * Everything is optional except `status`, because a check that can only say "I could not
 * look" is still a check worth having.
 */
export interface ScriptOutput {
  status: 'done' | 'blocked';
  /** Why, when blocked. Recorded as `blocked_reason` and rendered as the cause. */
  reason?: string;
  /** The table cell — a dozen characters, e.g. `2 behind · 400d`. */
  badge?: string;
  /** How to colour it. `unknown` is a first-class state and must not read as `ok`. */
  badge_state?: BadgeState;
  /** One line for a card header. */
  summary?: string;
  columns?: ScriptColumn[];
  rows?: Record<string, string | number | boolean | null>[];
  /** The report body, as markdown. Composed from `summary` and `rows` when absent. */
  body?: string;
  requirements?: ScriptRequirement[];
}

export type ScriptRun =
  | { ok: true; output: ScriptOutput; stderr: string; ms: number }
  | {
      ok: false;
      /** `timeout` and `oversize` are ours; `exit`, `parse` and `spawn` are the script's. */
      reason: 'timeout' | 'oversize' | 'exit' | 'parse' | 'spawn';
      detail: string;
      stderr: string;
      ms: number;
    };

export interface RunScriptOptions {
  /** Absolute path, already resolved and hashed by the protocol store. */
  path: string;
  /** Handed over on stdin as one line of JSON. */
  input: unknown;
  /** The runner is single-flight, so a script that hangs parks the whole loop. */
  timeoutMs?: number;
  maxStdoutBytes?: number;
  maxStderrBytes?: number;
  now?: () => number;
}

const DEFAULT_TIMEOUT_MS = 180_000;
const DEFAULT_MAX_STDOUT = 2 * 1024 * 1024;
const DEFAULT_MAX_STDERR = 64 * 1024;
/** After SIGTERM, before SIGKILL. Long enough to flush, short enough not to matter. */
const KILL_GRACE_MS = 2_000;

const MAX_ROWS = 200;
const MAX_COLUMNS = 40;
const MAX_REQUIREMENTS = 200;
const MAX_BADGE = 32;

/**
 * The environment a script gets: enough to make an HTTPS request, and nothing else.
 *
 * Inheriting the process environment would hand every check the push keys, the bench
 * credentials and whatever else `config.yaml` exported — for a job whose entire need is
 * `curl`. The proxy and certificate variables are here because a container that can only
 * reach the internet through a proxy is a real deployment, not a hypothetical one.
 */
const ENV_PASSTHROUGH = [
  'PATH', 'HOME', 'LANG', 'LC_ALL', 'TZ',
  'HTTP_PROXY', 'HTTPS_PROXY', 'NO_PROXY', 'http_proxy', 'https_proxy', 'no_proxy',
  'SSL_CERT_FILE', 'SSL_CERT_DIR', 'CURL_CA_BUNDLE',
];

function childEnv(): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {};
  for (const key of ENV_PASSTHROUGH) {
    const value = process.env[key];
    if (value !== undefined) out[key] = value;
  }
  return out;
}

/**
 * Spawn through `sh` rather than executing the file directly.
 *
 * A file copied into a Docker volume does not reliably keep its executable bit, and a check
 * that fails at dispatch because of a file mode is a bad way to find that out. The cost is
 * that a shebang is decoration — every executor is POSIX `sh`, which is what `*.sh` says.
 */
export async function runScript(opts: RunScriptOptions): Promise<ScriptRun> {
  const clock = opts.now ?? (() => Date.now());
  const startedAt = clock();
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxOut = opts.maxStdoutBytes ?? DEFAULT_MAX_STDOUT;
  const maxErr = opts.maxStderrBytes ?? DEFAULT_MAX_STDERR;

  return new Promise<ScriptRun>((resolve) => {
    let child;
    try {
      child = spawn('sh', [opts.path], {
        // A script that writes a stray file should litter the temp directory, not the archive.
        cwd: os.tmpdir(),
        env: childEnv(),
        stdio: ['pipe', 'pipe', 'pipe'],
        // Its own process group, so a timeout can kill the whole tree. A check is a shell
        // driving `curl`, and signalling only the shell leaves the curl running — holding the
        // stdout pipe open, which means `close` never fires and the timeout never lands.
        detached: true,
      });
    } catch (err) {
      resolve({
        ok: false,
        reason: 'spawn',
        detail: err instanceof Error ? err.message : String(err),
        stderr: '',
        ms: clock() - startedAt,
      });
      return;
    }

    const out: Buffer[] = [];
    const err: Buffer[] = [];
    let outBytes = 0;
    let errBytes = 0;
    let oversize = false;
    let timedOut = false;
    let settled = false;
    let killTimer: ReturnType<typeof setTimeout> | undefined;

    const ms = () => clock() - startedAt;
    const stderrText = () => Buffer.concat(err).toString('utf8').trim();

    const finish = (run: ScriptRun) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (killTimer) clearTimeout(killTimer);
      resolve(run);
    };

    /** Signal the whole group, falling back to the child alone if the group is gone. */
    const signal = (sig: NodeJS.Signals) => {
      try {
        if (child.pid) process.kill(-child.pid, sig);
      } catch {
        try {
          child.kill(sig);
        } catch {
          /* already dead */
        }
      }
    };

    const stop = (giveUp: () => ScriptRun) => {
      signal('SIGTERM');
      killTimer = setTimeout(() => {
        signal('SIGKILL');
        // Resolve on our own authority rather than waiting for `close`. A grandchild that
        // ignored both signals still holds the pipe, and the run is over either way — the
        // alternative is a hung script hanging the runner, which is what the timeout is for.
        finish(giveUp());
      }, KILL_GRACE_MS);
      killTimer.unref?.();
    };

    const timer = setTimeout(() => {
      timedOut = true;
      stop(() => ({
        ok: false,
        reason: 'timeout',
        detail: `no answer within ${Math.round(timeoutMs / 1000)}s`,
        stderr: stderrText(),
        ms: ms(),
      }));
    }, timeoutMs);
    timer.unref?.();

    child.stdout.on('data', (chunk: Buffer) => {
      outBytes += chunk.length;
      if (outBytes > maxOut) {
        // Truncating and parsing what arrived would produce a plausible half-answer, which is
        // worse than none: JSON that happens to close early still parses.
        oversize = true;
        stop(() => ({
          ok: false,
          reason: 'oversize',
          detail: `wrote more than ${maxOut} bytes to stdout`,
          stderr: stderrText(),
          ms: ms(),
        }));
        return;
      }
      out.push(chunk);
    });
    child.stderr.on('data', (chunk: Buffer) => {
      if (errBytes >= maxErr) return;
      errBytes += chunk.length;
      err.push(chunk);
    });

    child.on('error', (e) => {
      finish({ ok: false, reason: 'spawn', detail: e.message, stderr: stderrText(), ms: ms() });
    });

    child.on('close', (code) => {
      if (timedOut) {
        finish({
          ok: false,
          reason: 'timeout',
          detail: `no answer within ${Math.round(timeoutMs / 1000)}s`,
          stderr: stderrText(),
          ms: ms(),
        });
        return;
      }
      if (oversize) {
        finish({
          ok: false,
          reason: 'oversize',
          detail: `wrote more than ${maxOut} bytes to stdout`,
          stderr: stderrText(),
          ms: ms(),
        });
        return;
      }
      const text = Buffer.concat(out).toString('utf8').trim();
      if (code !== 0) {
        // A non-zero exit is the executor itself being broken — an operator problem, and a
        // different thing from the check running and finding nothing out.
        finish({
          ok: false,
          reason: 'exit',
          detail: `exit ${code ?? '?'}${text ? `: ${text.slice(0, 300)}` : ''}`,
          stderr: stderrText(),
          ms: ms(),
        });
        return;
      }
      const parsed = parseOutput(text);
      if (!parsed.ok) {
        finish({ ok: false, reason: 'parse', detail: parsed.detail, stderr: stderrText(), ms: ms() });
        return;
      }
      finish({ ok: true, output: parsed.output, stderr: stderrText(), ms: ms() });
    });

    child.stdin.on('error', () => {
      /* a script that never reads stdin is legal; EPIPE here is not a failure */
    });
    child.stdin.end(`${JSON.stringify(opts.input)}\n`);
  });
}

const VERDICTS: readonly RequirementVerdict[] = ['pass', 'fail', 'n-a', 'unverified'];
const SEVERITIES: readonly Severity[] = ['none', 'minor', 'major', 'critical'];
const BADGE_STATES: readonly BadgeState[] = ['ok', 'warn', 'bad', 'unknown'];

/**
 * Validate stdout into a `ScriptOutput`, or say why it is not one.
 *
 * Everything unrecognised is dropped rather than passed through. The output of this lands in
 * an assay's frontmatter, which is the archive of record, and a check that could write
 * arbitrary keys there could overwrite `verdict` — which is precisely the thing no executor
 * may set.
 */
export function parseOutput(text: string): { ok: true; output: ScriptOutput } | { ok: false; detail: string } {
  if (text === '') return { ok: false, detail: 'the script wrote nothing to stdout' };
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (e) {
    return { ok: false, detail: `stdout is not JSON: ${e instanceof Error ? e.message : String(e)}` };
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { ok: false, detail: 'stdout is not a JSON object' };
  }
  const o = raw as Record<string, unknown>;
  const status = o.status === 'blocked' ? 'blocked' : o.status === 'done' || o.status === undefined ? 'done' : null;
  if (status === null) return { ok: false, detail: `unknown status \`${String(o.status)}\`` };

  const output: ScriptOutput = { status };
  const str = (v: unknown, max: number): string | undefined => {
    if (typeof v !== 'string') return undefined;
    const t = v.trim();
    return t === '' ? undefined : t.slice(0, max);
  };

  const reason = str(o.reason, 200);
  if (reason) output.reason = reason;
  const badge = str(o.badge, MAX_BADGE);
  if (badge) output.badge = badge;
  if (typeof o.badge_state === 'string' && (BADGE_STATES as readonly string[]).includes(o.badge_state)) {
    output.badge_state = o.badge_state as BadgeState;
  }
  const summary = str(o.summary, 400);
  if (summary) output.summary = summary;
  const body = str(o.body, 200_000);
  if (body) output.body = body;

  if (Array.isArray(o.columns)) {
    const columns: ScriptColumn[] = [];
    for (const c of o.columns.slice(0, MAX_COLUMNS)) {
      if (!c || typeof c !== 'object') continue;
      const col = c as Record<string, unknown>;
      const key = str(col.key, 60);
      if (!key) continue;
      columns.push({
        key,
        ...(str(col.label, 60) ? { label: str(col.label, 60)! } : {}),
        ...(col.align === 'right' ? { align: 'right' as const } : {}),
        ...(col.kind === 'since' ? { kind: 'since' as const } : {}),
      });
    }
    if (columns.length > 0) output.columns = columns;
  }

  if (Array.isArray(o.rows)) {
    const rows: Record<string, string | number | boolean | null>[] = [];
    for (const r of o.rows.slice(0, MAX_ROWS)) {
      if (!r || typeof r !== 'object' || Array.isArray(r)) continue;
      const row: Record<string, string | number | boolean | null> = {};
      for (const [k, v] of Object.entries(r as Record<string, unknown>).slice(0, MAX_COLUMNS)) {
        if (v === null || typeof v === 'number' || typeof v === 'boolean') row[k] = v;
        else if (typeof v === 'string') row[k] = v.slice(0, 300);
      }
      rows.push(row);
    }
    if (rows.length > 0) output.rows = rows;
  }

  if (Array.isArray(o.requirements)) {
    const reqs: ScriptRequirement[] = [];
    for (const r of o.requirements.slice(0, MAX_REQUIREMENTS)) {
      if (!r || typeof r !== 'object') continue;
      const req = r as Record<string, unknown>;
      const id = str(req.id, 80);
      if (!id) continue;
      if (typeof req.verdict !== 'string' || !(VERDICTS as readonly string[]).includes(req.verdict)) continue;
      reqs.push({
        id,
        verdict: req.verdict as RequirementVerdict,
        ...(typeof req.severity === 'string' && (SEVERITIES as readonly string[]).includes(req.severity)
          ? { severity: req.severity as Severity }
          : {}),
        ...(str(req.requirement, 300) ? { requirement: str(req.requirement, 300)! } : {}),
        ...(str(req.note, 600) ? { note: str(req.note, 600)! } : {}),
      });
    }
    if (reqs.length > 0) output.requirements = reqs;
  }

  return { ok: true, output };
}
