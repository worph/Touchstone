/**
 * Is the workshop's GitHub identity usable — and if not, say why, once.
 *
 * Three questions, each a GET: does the token belong to the account `github.login` names,
 * may it push to the origin repo, and does the `touchstone` label exist. The first two failing
 * open `github.auth`; a missing label opens it too, but only as a warning — a PR without its
 * label is still a PR (D13), so it never blocks a submission.
 *
 * No token is not a fault: the workshop is simply unconfigured, there is nothing to alert on,
 * and the probe does nothing.
 */

import type { GitHubStatus } from '../../shared/workshop.js';
import type { AlertStore } from './alerts.js';
import { GitHubClient, GitHubError } from './github.js';

export const WORKSHOP_LABEL = 'touchstone';

export interface GitHubProbeOptions {
  client?: GitHubClient;
  expectedLogin: string;
  alerts?: AlertStore;
  now?: () => Date;
}

export class GitHubProbe {
  private last: GitHubStatus;
  private timer: NodeJS.Timeout | null = null;

  constructor(private readonly opts: GitHubProbeOptions) {
    this.last = opts.client
      ? { state: 'unknown', repo: opts.client.repo, expected_login: opts.expectedLogin, problems: [] }
      : { state: 'unconfigured', problems: [] };
  }

  status(): GitHubStatus {
    return this.last;
  }

  /** Account id of the token's user, once seen — for the noreply commit address. */
  userId?: number;

  async probe(): Promise<GitHubStatus> {
    const client = this.opts.client;
    if (!client) return this.last;
    const problems: string[] = [];
    const status: GitHubStatus = {
      state: 'ok',
      repo: client.repo,
      expected_login: this.opts.expectedLogin,
      problems,
      checked_at: (this.opts.now?.() ?? new Date()).toISOString(),
    };
    try {
      const user = await client.user();
      status.login = user.login;
      this.userId = user.id;
      if (this.opts.expectedLogin && user.login.toLowerCase() !== this.opts.expectedLogin.toLowerCase()) {
        problems.push(`the token belongs to ${user.login}, not ${this.opts.expectedLogin}`);
      }
      const repo = await client.repoInfo();
      status.push = repo.push;
      if (!repo.push) problems.push(`the token cannot push to ${client.repo} (needs Contents: read and write)`);
      status.label = await client.labelExists(WORKSHOP_LABEL);
    } catch (err) {
      problems.push(err instanceof GitHubError ? err.message : `GitHub could not be reached: ${(err as Error).message}`);
    }

    const blocking = problems.length > 0;
    if (blocking) status.state = 'failing';
    this.last = status;

    if (blocking) {
      this.opts.alerts?.open({
        key: 'github.auth',
        title: 'The workshop cannot use its GitHub token',
        detail: problems.join('; '),
        impact: 'Nothing can be submitted as a pull request. Authoring and validation still run.',
      });
    } else if (status.label === false) {
      this.opts.alerts?.open({
        key: 'github.auth',
        title: `The "${WORKSHOP_LABEL}" label does not exist on ${client.repo}`,
        detail: `Create it once by hand. Until then pull requests are opened unlabelled.`,
        impact: 'Pull requests still open; they are just not labelled.',
      });
    } else {
      this.opts.alerts?.resolve('github.auth', 'The workshop\'s GitHub token works');
    }
    return status;
  }

  /** Whether a submission may proceed. A missing label does not block. */
  usable(): boolean {
    return this.last.state === 'ok';
  }

  start(intervalMs: number): void {
    if (!this.opts.client || this.timer) return;
    this.timer = setInterval(() => void this.probe(), intervalMs);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }
}
