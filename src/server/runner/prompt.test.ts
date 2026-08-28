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

/**
 * A trial of supplied files. The agent normally fetches its own subject with `gh`; here the
 * bytes are handed to it, and the two things that must survive that are the ones the rubric
 * leans on — the nominal repo it judges assets and CONTRIBUTING.md against, and the absence of
 * any instruction to go and fetch the app itself.
 */
describe('auditing supplied files', () => {
  const SOURCE = {
    files: ['docker-compose.yml', 'icon.png', 'rationale.md'],
    compose: 'name: openclaw\nservices:\n  app:\n    image: ghcr.io/x/y:1.0.0\n',
    rationale: 'It needs /DATA because …',
  };

  it('inlines the files and stops telling the agent to fetch the app', () => {
    const prompt = buildPrompt({ ...BASE, source: SOURCE }).prompt;

    expect(prompt).toContain('=== APP FILES (authoritative, supplied inline');
    expect(prompt).toContain('image: ghcr.io/x/y:1.0.0');
    expect(prompt).toContain('--- rationale.md ---');
    // The manifest is what `assets` is judged on, since there is nothing to fetch.
    expect(prompt).toContain('docker-compose.yml, icon.png, rationale.md');

    // The `gh` listing step is gone: running it would report the working copy as missing from
    // the repo, which is true and is not a finding about the app.
    expect(prompt).not.toContain('gh api repos/Yundera/AppStore/contents/Apps');
    expect(prompt).toContain('Do NOT run gh to list or fetch them');
  });

  it('still sends the agent for CONTRIBUTING.md, which the protocol requires every run', () => {
    const prompt = buildPrompt({ ...BASE, source: SOURCE }).prompt;
    expect(prompt).toContain('CONTRIBUTING.md');
    expect(prompt).toContain('repo=Yundera/AppStore');
  });

  it('never rebinds the asset rule, because supplied files were on no branch', () => {
    const prompt = buildPrompt({ ...BASE, source: SOURCE, ref: 'main' }).prompt;
    // `prompt.ts` rewrites `<repo>@main` to `<repo>@<ref>` for any other ref — right for a PR
    // branch, and wrong here: an uploaded app's assets legitimately point at the real main.
    expect(prompt).not.toContain('read it as');
  });

  it('omits the rationale heading when the app ships none', () => {
    const prompt = buildPrompt({
      ...BASE,
      source: { files: ['docker-compose.yml'], compose: 'name: x\n', rationale: null },
    }).prompt;
    expect(prompt).toContain('--- docker-compose.yml ---');
    expect(prompt).not.toContain('--- rationale.md ---');
  });
});

/**
 * The store URL a trial hands the bench.
 *
 * Two things this has to get right, and the second was learned the hard way. Give the agent
 * the finished address rather than a template to assemble — and tell it that Maison will
 * immediately rewrite that address into `/store/<store url sans scheme>/-/Apps/<APP>`. That
 * rewrite is Maison canonicalising the query parameter (verified by hand on 2026-08-22: the
 * rewritten page shows the unlisted-store warning and a working Install button), but an agent
 * that has not been told looks at its URL apparently mangled into a path and starts
 * troubleshooting a problem that does not exist.
 */
describe('installing from the trial\'s own store', () => {
  const SOURCE = { files: ['docker-compose.yml'], compose: 'name: x\n' };
  const LIVE = {
    ...BASE,
    sections: [
      { id: 'static', name: 'Static Review Protocol' },
      { id: 'functional', name: 'Functional Review Protocol', requires: ['bench', 'browser'] },
    ],
    source: SOURCE,
    store_url: 'https://touchstone-lab.example/api/v1/trialstore/tok3n.zip',
  };

  it('hands over one finished URL when the host is already chosen', () => {
    const prompt = buildPrompt({ ...LIVE, demo_host: 'https://demostaging1.inojob.com' }).prompt;
    expect(prompt).toContain(
      'https://demostaging1.inojob.com/store/OpenClaw?store=https%3A%2F%2Ftouchstone-lab.example%2Fapi%2Fv1%2Ftrialstore%2Ftok3n.zip',
    );
    expect(prompt).toContain('copied character for character');
  });

  it('warns that Maison will rewrite the address, so the agent does not chase it', () => {
    const prompt = buildPrompt({ ...LIVE, demo_host: 'https://demostaging1.inojob.com' }).prompt;
    expect(prompt).toContain('EXPECTED, not a failure');
    expect(prompt).toContain('/-/Apps/OpenClaw');
    expect(prompt).toContain('do not conclude the navigation failed');
    // And it says what "arrived" looks like, so there is a positive test rather than a vibe.
    expect(prompt).toContain('an Install control');
  });

  it('leaves only the host to substitute when it has not been chosen yet', () => {
    const prompt = buildPrompt(LIVE).prompt;
    expect(prompt).toContain('substitute ONLY the host');
    expect(prompt).toContain('?store=https%3A%2F%2Ftouchstone-lab.example');
  });

  it('says nothing about a store when the trial has none to offer', () => {
    const prompt = buildPrompt({ ...LIVE, store_url: undefined }).prompt;
    expect(prompt).not.toContain('4a. STORE');
  });
});

/**
 * The knowledge base.
 *
 * Two properties, and they are the whole reason it can exist beside the rubric without
 * becoming one: it arrives **after** the protocol, and it arrives under a sentence saying the
 * protocol wins. A KB that could be read as a qualification of the rubric would be an
 * unversioned standard, which is exactly what moving this prose out of `functional.md` was
 * meant to avoid.
 */
describe('the knowledge base', () => {
  const KB = {
    index: '# Knowledge base\n\nWhat is here.',
    docs: [{ file: 'maison.md', title: 'Driving Maison', body: 'The Tips dialog carries the first-run credentials.' }],
  };

  it('is reproduced after the protocol, and says the protocol governs', () => {
    const prompt = buildPrompt({
      ...BASE,
      protocols: { sections: [{ id: 'static', name: 'Static Review Protocol', body: 'The rubric.' }] },
      kb: KB,
    }).prompt;

    expect(prompt).toContain('=== KNOWLEDGE BASE (reference, supplied inline');
    expect(prompt).toContain('--- DRIVING MAISON (maison.md) ---');
    expect(prompt).toContain('The Tips dialog carries the first-run credentials.');
    expect(prompt).toContain('the PROTOCOL governs');
    // Order is the claim: the rubric first, its reference material after it.
    expect(prompt.indexOf('=== PROTOCOL')).toBeLessThan(prompt.indexOf('=== KNOWLEDGE BASE'));
  });

  it('never says it may add or excuse a requirement', () => {
    const prompt = buildPrompt({ ...BASE, kb: KB }).prompt;
    expect(prompt).toContain('never adds a requirement, never excuses one, and never decides a verdict');
  });

  /**
   * The compatibility argument. Every box that has no `data/kb/` must get the prompt it got
   * before the KB existed, or the archive's earlier reports stop being comparable with the
   * next one for a reason that has nothing to do with any app.
   */
  it('adds nothing at all when there is none', () => {
    const bare = buildPrompt(BASE).prompt;
    expect(buildPrompt({ ...BASE, kb: { docs: [] } }).prompt).toBe(bare);
    expect(buildPrompt({ ...BASE, kb: { index: null, docs: [] } }).prompt).toBe(bare);
    expect(bare).not.toContain('KNOWLEDGE BASE');
  });

  // The builder renders whatever it is handed; deciding that an index with no pages is not a
  // knowledge base is `KbStore.forSections`'s job, and it answers null there.
  it('renders an index it is handed even with no pages', () => {
    const prompt = buildPrompt({ ...BASE, kb: { index: '# Knowledge base', docs: [] } }).prompt;
    expect(prompt).toContain('--- INDEX ---');
    expect(prompt).toContain('KNOWLEDGE BASE');
  });
});
