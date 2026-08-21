/**
 * The prompt's store parameters.
 *
 * The first test is the safety argument for the whole change: supplying the default origin must
 * reproduce the text the n8n node produces, byte for byte. `prompt.ts`'s header says why —
 * every verdict in the archive was produced by an agent reading these words, so a change here
 * is a change to the standard rather than a refactor.
 */

import { describe, expect, it } from 'vitest';

import { buildPrompt } from './prompt.js';

const BASE = {
  app_name: 'OpenClaw',
  sections: [{ id: 'static', name: 'Static Review Protocol' }],
};

describe('the store parameters', () => {
  it('reproduces the old text exactly when given the default store', () => {
    const bare = buildPrompt(BASE).prompt;
    const explicit = buildPrompt({
      ...BASE,
      repo: 'Yundera/AppStore',
      ref: 'main',
      apps_path: 'Apps',
    }).prompt;

    expect(explicit).toBe(bare);
    // And the literals the node carried are still the literals we send.
    expect(bare).toContain('repo=Yundera/AppStore');
    expect(bare).toContain('at ref main');
    expect(bare).toContain('gh api repos/Yundera/AppStore/contents/Apps');
  });

  it('carries the repo, ref and apps path of another store', () => {
    const prompt = buildPrompt({
      ...BASE,
      repo: 'Acme/AppStore',
      ref: 'pr-812',
      apps_path: 'apps',
    }).prompt;

    expect(prompt).toContain('repo=Acme/AppStore ; ref=pr-812 ; apps_path=apps');
    expect(prompt).toContain('gh api repos/Acme/AppStore/contents/apps?ref=pr-812');
    expect(prompt).toContain('apps/OpenClaw at ref pr-812');
    // The one that would otherwise be silently wrong: listing one repo's apps and auditing
    // another's, or auditing `main` while claiming to audit the branch.
    expect(prompt).not.toContain('Yundera/AppStore');
    expect(prompt).not.toContain('at ref main');
  });

  it('binds the asset rule to the ref under audit, but only off main', () => {
    const onMain = buildPrompt({ ...BASE, repo: 'Acme/AppStore', ref: 'main' }).prompt;
    expect(onMain).not.toContain('read it as');

    // `static.md` requires asset URLs point at `<repo>@main`. Read literally on a branch that
    // flags every asset URL — a finding about the ref, not about the app.
    const onBranch = buildPrompt({ ...BASE, repo: 'Acme/AppStore', ref: 'pr-812' }).prompt;
    expect(onBranch).toContain('read it as Acme/AppStore@pr-812');
  });

  it('tolerates a slashed apps path', () => {
    const prompt = buildPrompt({ ...BASE, apps_path: '/Apps/' }).prompt;
    expect(prompt).toContain('apps_path=Apps ');
    expect(prompt).toContain('Apps/OpenClaw at ref main');
    expect(prompt).not.toContain('//OpenClaw');
  });

  it('titles the report with the store it audited', () => {
    expect(buildPrompt({ ...BASE, repo: 'Acme/AppStore' }).prompt).toContain(
      'title: the string Acme/AppStore',
    );
  });
});
