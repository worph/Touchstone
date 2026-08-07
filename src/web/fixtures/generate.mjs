#!/usr/bin/env node
/**
 * Generates src/web/fixtures/*.json for Touchstone stream C.
 *
 * The numbers are reverse-engineered from UX.md §2.1 and §2.3 so that the UI
 * reproduces the documented screen exactly:
 *   static      compliant 12 · non-compliant 19 · not yet 38      total risk 1407
 *   functional  compliant  1 · blocked      49 · not yet 19
 *   rule groups cpu_shares 5 · descriptions 14 · D2 6 · E9 unverified 11 · D1 pass 9
 *
 * Everything downstream (risk_score, top_severity, verdict, rule groups, tallies)
 * is COMPUTED from the per-subject finding lists, so the fixture cannot drift
 * out of internal consistency.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// Run with: node src/web/fixtures/generate.mjs
const FIXTURES = fileURLToPath(new URL('.', import.meta.url)).replace(/[\\/]$/, '');

const NOW = new Date('2026-08-06T12:00:00Z');
const WEIGHT = { none: 0, minor: 1, major: 10, critical: 100 };
const RANK = { none: 0, minor: 1, major: 2, critical: 3 };

// ---------------------------------------------------------------- prng
function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const rnd = mulberry32(0x7011c5);
const pick = (arr) => arr[Math.floor(rnd() * arr.length)];
const int = (lo, hi) => lo + Math.floor(rnd() * (hi - lo + 1));
const hex = (n) => Array.from({ length: n }, () => '0123456789abcdef'[int(0, 15)]).join('');

// ---------------------------------------------------------------- rules
const R = {
  A:  { rule: 'A',  title: 'reverse-proxy auth bypass (DisabledForLocalAddresses)', severity: 'critical',
        note: 'AppShield forwards with DisabledForLocalAddresses; the nip.io label makes the host internet-reachable, so the bypass is not local-only.' },
  C:  { rule: 'C',  title: 'container runs privileged', severity: 'critical',
        note: 'privileged: true with no rationale.md; full host device access.' },
  G:  { rule: 'G',  title: 'secrets committed in compose', severity: 'critical',
        note: 'literal API token in the environment block of docker-compose.yml.' },
  E8: { rule: 'E8', title: 'default credentials accepted', severity: 'critical',
        note: 'first-boot admin/admin still accepted after setup completes.' },
  E9: { rule: 'E9', title: 'auth gate present', severity: 'critical',
        note: 'suspected reverse-proxy bypass; phase E9 is exactly the check that would settle it, and it is the one that could not run.' },
  D1: { rule: 'D1', title: 'root, AppData-only', severity: 'none',
        note: 'writes confined to /DATA/AppData/<app>; no user-directory mounts.' },
  D2: { rule: 'D2', title: 'root + user dir, no rationale.md', severity: 'major',
        note: 'mounts /DATA/Downloads and /DATA/Media as root with no rationale.md.' },
  D3: { rule: 'D3', title: 'missing required asset', severity: 'major',
        note: 'no screenshot-1.png; the store card renders with a placeholder.' },
  D4: { rule: 'D4', title: 'name regex violation', severity: 'major',
        note: 'container_name does not match ^[a-z0-9][a-z0-9_.-]*$.' },
  D5: { rule: 'D5', title: 'host network without rationale', severity: 'major',
        note: 'network_mode: host, no rationale.md explaining why bridge will not do.' },
  B:  { rule: 'B',  title: ':latest on the main image', severity: 'major',
        note: 'main image tagged :latest; the assayed digest is not reproducible.' },
  cpu:  { rule: '—', title: 'cpu_shares on reserved tier 10', severity: 'minor',
          note: 'cpu_shares: 10 is inside the reserved system tier; store apps start at 50.' },
  desc: { rule: '—', title: 'no volume/env descriptions', severity: 'minor',
          note: 'x-casaos volumes[].description and envs[].description are absent.' },
  pin:  { rule: '—', title: 'unpinned helper image', severity: 'minor',
          note: 'sidecar image is tag-pinned but not digest-pinned.' },
  hc:   { rule: '—', title: 'no healthcheck defined', severity: 'minor',
          note: 'no healthcheck; the store reports "running" before the app is serving.' },
  tags: { rule: '—', title: 'no tags in store metadata', severity: 'minor',
          note: 'x-casaos.tags is empty, so the app is unreachable by category browse.' },
};

// ---------------------------------------------------------------- subjects
/** fail[] = failing findings, pass[] = passing findings recorded in the report */
const NONCOMPLIANT = {
  OpenClaw:         { fail: ['A', 'G', 'D2', 'D3', 'B', 'desc', 'pin'], pass: ['D1'], age: 1 },
  Vaultwarden:      { fail: ['C', 'E8', 'D2', 'desc', 'pin', 'hc'], pass: [], age: 2 },
  TINCatan:         { fail: ['G', 'D2', 'D3', 'D4', 'desc', 'pin', 'hc', 'tags'], pass: [], age: 7 },
  CasaOS:           { fail: ['C', 'D2', 'B', 'D3', 'desc'], pass: [], age: 6 },
  Tailscale:        { fail: ['C', 'D2', 'D4', 'desc', 'hc'], pass: [], age: 7 },
  Nextcloud:        { fail: ['E8', 'D3', 'B', 'desc', 'pin'], pass: [], age: 4 },
  Gitea:            { fail: ['G', 'B', 'desc', 'pin', 'hc'], pass: [], age: 3 },
  Portainer:        { fail: ['C', 'D2', 'desc'], pass: [], age: 8 },
  n8n:              { fail: ['G', 'desc', 'hc'], pass: [], age: 2 },
  Jellyfin:         { fail: ['D3', 'D4', 'B', 'D5', 'desc', 'pin', 'hc'], pass: [], age: 9 },
  'Home-Assistant': { fail: ['D5', 'D4', 'B', 'desc'], pass: [], age: 5 },
  Immich:           { fail: ['D3', 'desc'], pass: ['D1'], age: 3 },
  qBittorrent:      { fail: ['B', 'cpu', 'desc'], pass: [], age: 6 },
  Sonarr:           { fail: ['cpu', 'hc'], pass: [], age: 7 },
  Lidarr:           { fail: ['cpu', 'hc'], pass: [], age: 7 },
  Prowlarr:         { fail: ['cpu', 'hc'], pass: [], age: 8 },
  Bazarr:           { fail: ['cpu'], pass: ['D1'], age: 8 },
  Caddy:            { fail: ['D4', 'D5', 'desc'], pass: [], age: 5 },
  Beacon:           { fail: ['hc', 'tags'], pass: [], age: 6 },
};

const COMPLIANT = {
  Radarr:        { pass: ['D1'], age: 7 },
  AppShield:     { pass: ['D1'], age: 1 },
  'Uptime-Kuma': { pass: ['D1'], age: 4 },
  Dozzle:        { pass: ['D1'], age: 6 },
  Homepage:      { pass: ['D1'], age: 3 },
  Syncthing:     { pass: ['D1'], age: 9 },
  Ntfy:          { pass: [], age: 2 },
  Gotify:        { pass: [], age: 5 },
  Vikunja:       { pass: [], age: 8 },
  Navidrome:     { pass: [], age: 4 },
  Filebrowser:   { pass: [], age: 6 },
  Mealie:        { pass: [], age: 9 },
};

/** static never ran, but a functional assay was claimed and blocked */
const BLOCKED_ONLY = [
  'Docmost', 'Seafile', 'Paperless-ngx', 'Joplin', 'Trilium', 'Outline', 'AFFiNE',
  'Spliit', 'Wallos', 'Actual', 'Firefly-III', 'Grocy', 'Forgejo', 'Code-Server',
  'Node-RED', 'Wiki-js', 'Matrix-Synapse', 'Element', 'Mattermost', 'Rocket-Chat',
];

/** never assayed at all — the "no assays yet" degraded state */
const UNASSAYED = [
  'Jitsi', 'Owncast', 'Transmission', 'SABnzbd', 'NZBGet', 'Jackett',
  'FlareSolverr', 'Zigbee2MQTT', 'ESPHome', 'Frigate', 'Scrypted', 'Duplicati',
  'MeTube', 'Stirling-PDF', 'LibreTranslate', 'SearXNG', 'Pi-hole', 'AdGuard-Home',
];

/** the suspected-Critical queue: E9 recorded unverified by a blocked functional run */
const E9_SUBJECTS = new Set([
  'OpenClaw', 'Sonarr', 'Lidarr', 'Prowlarr', 'Bazarr', 'qBittorrent',
  'Jellyfin', 'Immich', 'Nextcloud', 'Vaultwarden', 'Gitea',
]);

/** one subject is mid-flight, for the `running` degraded state */
const RUNNING_SUBJECT = 'Docmost';

// ---------------------------------------------------------------- helpers
const iso = (d) => d.toISOString().replace(/\.\d{3}Z$/, 'Z');
const fileStamp = (d) => iso(d).replace(/:/g, '-');
const daysAgo = (n, hourSeed = 9) => {
  const d = new Date(NOW.getTime() - n * 864e5);
  d.setUTCHours(hourSeed, int(0, 59), int(0, 59), 0);
  return d;
};

function finding(key, status) {
  const r = R[key];
  return { rule: r.rule, title: r.title, severity: r.severity, status, note: r.note };
}
function riskOf(findings) {
  return findings.filter((f) => f.status === 'fail').reduce((s, f) => s + WEIGHT[f.severity], 0);
}
function topSeverityOf(findings) {
  let top = 'none';
  for (const f of findings) if (f.status === 'fail' && RANK[f.severity] > RANK[top]) top = f.severity;
  return top;
}
const IMAGE_TAGS = ['1.4.2', '2.1.0', '0.9.14', '3.0.1', '12.6.0', '2026.7.3', '5.2.9'];
function imagesFor(name) {
  const base = `${name.toLowerCase().replace(/[^a-z0-9]+/g, '')}:${pick(IMAGE_TAGS)}`;
  return rnd() > 0.45 ? [base, 'appshield:2.0.7'] : [base];
}

// ---------------------------------------------------------------- markdown
function mdTable(headers, rows) {
  return [
    `| ${headers.join(' | ')} |`,
    `| ${headers.map(() => '---').join(' | ')} |`,
    ...rows.map((r) => `| ${r.join(' | ')} |`),
  ].join('\n');
}

const SEV_LABEL = { none: '—', minor: 'Minor', major: 'Major', critical: 'Critical' };
const STATUS_LABEL = { pass: 'pass', fail: 'FAIL', 'n-a': 'n/a', advisory: 'advisory', unverified: 'UNVERIFIED' };

function staticReportMd(meta, full) {
  const L = [];
  L.push(`# Yundera/AppStore — ${meta.subject}`);
  L.push('');
  const tier = meta.verdict === 'compliant' ? 'COMPLIANT' : 'NON-COMPLIANT';
  L.push(`> **Verdict: ${tier} · ${SEV_LABEL[meta.top_severity]} · risk ${meta.risk_score}**`);
  L.push('');
  L.push(`Subject \`${meta.subject_ref}\` at commit \`${meta.commit}\`, assayed under **${meta.standard} v${meta.standard_version}** on ${meta.started_at.slice(0, 10)}.`);
  L.push('');
  L.push('## Summary');
  L.push('');
  L.push(mdTable(
    ['Leg', 'Standard', 'Verdict', 'Top severity', 'Risk', 'Started', 'Finished', 'Commit'],
    [[meta.leg, `${meta.standard} v${meta.standard_version}`, meta.verdict ?? '—',
      SEV_LABEL[meta.top_severity], String(meta.risk_score), meta.started_at, meta.finished_at,
      `\`${meta.commit}\``]],
  ));
  L.push('');

  if (!full) {
    L.push('## Checklist');
    L.push('');
    L.push(mdTable(['Rule', 'Check', 'Result', 'Severity'],
      meta.findings.map((f) => [f.rule, f.title, STATUS_LABEL[f.status], SEV_LABEL[f.severity]])));
    L.push('');
    L.push('_Archived assay. The full narrative for this run was truncated on import._');
    return L.join('\n');
  }

  L.push('## Tech & Documentation');
  L.push('');
  L.push(mdTable(
    ['#', 'Check', 'Result', 'Severity', 'Evidence', 'Rule ref', 'Mandatory', 'Note'],
    meta.findings.map((f, i) => [
      String(i + 1), f.title, STATUS_LABEL[f.status], SEV_LABEL[f.severity],
      `\`docker-compose.yml:${int(3, 84)}\``, f.rule, f.severity === 'critical' ? 'yes' : 'no',
      (f.note ?? '').replace(/\|/g, '\\|'),
    ]),
  ));
  L.push('');
  L.push('## Images');
  L.push('');
  L.push(mdTable(['Image', 'Tag pinned', 'Digest pinned', 'Registry', 'Size'],
    (meta.images ?? []).map((im) => [
      `\`${im}\``, im.endsWith(':latest') ? 'no' : 'yes', rnd() > 0.6 ? 'yes' : 'no',
      'docker.io', `${int(48, 940)} MB`,
    ])));
  L.push('');

  const fails = meta.findings.filter((f) => f.status === 'fail' || f.status === 'unverified');
  if (fails.length) {
    L.push('## Findings');
    L.push('');
    for (const f of fails) {
      L.push(`### ${f.rule === '—' ? f.title : `${f.rule} — ${f.title}`}`);
      L.push('');
      L.push(`**Severity:** ${SEV_LABEL[f.severity]} · **Status:** ${STATUS_LABEL[f.status]}`);
      L.push('');
      L.push(f.note ?? '');
      L.push('');
      if (f.severity === 'critical') {
        L.push('```yaml');
        L.push('services:');
        L.push(`  ${meta.subject.toLowerCase()}:`);
        L.push(`    image: ${(meta.images ?? ['app:latest'])[0]}`);
        L.push('    environment:');
        L.push('      - AUTH_DISABLE_LOCAL=true');
        L.push('```');
        L.push('');
      }
      L.push('- See [the standard](https://example.invalid/standards/static-v3) for the wording of this rule.');
      L.push('');
    }
  }

  L.push('## Remediation');
  L.push('');
  L.push(mdTable(['Priority', 'Action', 'Rule', 'Effort', 'Risk removed'],
    fails.slice(0, 4).map((f, i) => [
      String(i + 1), `resolve ${f.title}`, f.rule,
      f.severity === 'critical' ? 'M' : 'S', String(WEIGHT[f.severity]),
    ])));
  return L.join('\n');
}

function blockedReportMd(meta) {
  const L = [];
  L.push(`# Yundera/AppStore — ${meta.subject} (functional)`);
  L.push('');
  L.push('> **Assay blocked — this is not a verdict about the subject.**');
  L.push('');
  L.push(mdTable(['Leg', 'Standard', 'Status', 'Blocked reason', 'Claimed', 'Released', 'Tries consumed'],
    [['functional', `${meta.standard} v${meta.standard_version}`, 'blocked',
      `\`${meta.blocked_reason}\``, meta.started_at, meta.finished_at, '0']]));
  L.push('');
  L.push('The bench pool rejected the preflight before any phase ran, so nothing was observed about');
  L.push('this subject. No retry budget was consumed and the previous hallmark stands.');
  L.push('');
  L.push('## Probe');
  L.push('');
  L.push(mdTable(['Bench', 'Probe', 'Result', 'Detail', 'Board says'],
    [['demostaging1.inojob.com', 'POST /api/firstfactor', '401', 'auth/invalid-credential', '✅ Ready'],
     ['demostaging2.inojob.com', 'POST /api/firstfactor', '401', 'auth/invalid-credential', '✅ Ready']]));
  L.push('');
  if (meta.findings.length) {
    L.push('## Carried forward');
    L.push('');
    L.push(mdTable(['Rule', 'Check', 'Status', 'Suspected severity', 'Why it matters'],
      meta.findings.map((f) => [f.rule, f.title, STATUS_LABEL[f.status], SEV_LABEL[f.severity],
        (f.note ?? '').replace(/\|/g, '\\|')])));
    L.push('');
    L.push('### E9 — auth gate present');
    L.push('');
    L.push('This is the single highest-value thing the blocked run would have settled. Recorded as');
    L.push('`unverified` rather than `fail` so it ranks in the suspected-Critical queue without');
    L.push('being counted as observed risk.');
  }
  return L.join('\n');
}

function runningReportMd(meta) {
  return [
    `# Yundera/AppStore — ${meta.subject} (functional)`, '',
    '> **Assay in progress.** Partial output; the report is rewritten on completion.', '',
    mdTable(['Leg', 'Standard', 'Status', 'Worker', 'Bench', 'Started'],
      [['functional', `${meta.standard} v${meta.standard_version}`, 'running', 'worker-2',
        'demostaging2.inojob.com', meta.started_at]]),
  ].join('\n');
}

// ---------------------------------------------------------------- md → html
const slug = (s) => encodeURIComponent(String(s).trim().toLowerCase().replace(/\s+/g, '-'));

function esc(s) {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
function inline(s) {
  return esc(s)
    .replace(/\\\|/g, '|')
    .replace(/`([^`]+)`/g, (_, c) => `<code>${c}</code>`)
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g,
      (_, t, h) => `<a href="${h}" target="_blank" rel="noopener noreferrer">${t}</a>`)
    .replace(/_([^_]+)_/g, '<em>$1</em>');
}
function renderMd(md) {
  const lines = md.split('\n');
  const out = [];
  const seen = new Map();
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (/^```/.test(line)) {
      const lang = line.slice(3).trim();
      const buf = [];
      i++;
      while (i < lines.length && !/^```/.test(lines[i])) buf.push(lines[i++]);
      i++;
      out.push(`<pre><code${lang ? ` class="language-${lang}"` : ''}>${esc(buf.join('\n'))}\n</code></pre>`);
      continue;
    }
    const h = /^(#{1,6})\s+(.*)$/.exec(line);
    if (h) {
      const lvl = h[1].length;
      let id = slug(h[2]);
      const n = (seen.get(id) ?? 0) + 1;
      seen.set(id, n);
      if (n > 1) id = `${id}-${n - 1}`;
      out.push(`<h${lvl} id="${id}"><a class="header-anchor" href="#${id}">#</a>${inline(h[2])}</h${lvl}>`);
      i++;
      continue;
    }
    if (/^\|/.test(line)) {
      const rows = [];
      while (i < lines.length && /^\|/.test(lines[i])) rows.push(lines[i++]);
      const cells = (r) => r.replace(/^\||\|$/g, '').split(/(?<!\\)\|/).map((c) => c.trim());
      const head = cells(rows[0]);
      const body = rows.slice(2).map(cells);
      out.push(
        '<table>\n<thead>\n<tr>' + head.map((c) => `<th>${inline(c)}</th>`).join('') + '</tr>\n</thead>\n<tbody>\n' +
        body.map((r) => '<tr>' + r.map((c) => `<td>${inline(c)}</td>`).join('') + '</tr>').join('\n') +
        '\n</tbody>\n</table>',
      );
      continue;
    }
    if (/^>\s?/.test(line)) {
      const buf = [];
      while (i < lines.length && /^>\s?/.test(lines[i])) buf.push(lines[i++].replace(/^>\s?/, ''));
      out.push(`<blockquote>\n<p>${inline(buf.join(' '))}</p>\n</blockquote>`);
      continue;
    }
    if (/^[-*]\s+/.test(line)) {
      const buf = [];
      while (i < lines.length && /^[-*]\s+/.test(lines[i])) buf.push(lines[i++].replace(/^[-*]\s+/, ''));
      out.push('<ul>\n' + buf.map((b) => `<li>${inline(b)}</li>`).join('\n') + '\n</ul>');
      continue;
    }
    if (/^---+$/.test(line)) { out.push('<hr>'); i++; continue; }
    if (line.trim() === '') { i++; continue; }
    const buf = [];
    while (i < lines.length && lines[i].trim() !== '' && !/^(#{1,6}\s|\||>|```|[-*]\s|---+$)/.test(lines[i])) {
      buf.push(lines[i++]);
    }
    out.push(`<p>${inline(buf.join(' '))}</p>`);
  }
  return out.join('\n');
}

// ---------------------------------------------------------------- build
const subjects = [];       // SubjectState[]
const histories = {};      // name -> AssayRecord[]  (newest first)
const reports = {};        // "Subject/file" -> ReportResponse

const BLOCKED_AT = new Date('2026-08-05T07:12:04Z');   // the outage started here

function makeRecord(subject, leg, meta) {
  const file = `${fileStamp(new Date(meta.started_at))}-${leg}.md`;
  return { meta, path: `${subject}/${file}`, subject, file };
}

function addReport(rec, md) {
  reports[`${rec.subject}/${rec.file}`] = { meta: rec.meta, html: renderMd(md), raw: md };
}

function staticMeta(subject, started, findings, ref, commit, images, standardVersion = 3) {
  const finished = new Date(started.getTime() + int(6, 22) * 60000 + int(0, 59) * 1000);
  const risk = riskOf(findings);
  const top = topSeverityOf(findings);
  return {
    subject, leg: 'static',
    standard: 'Static Review Protocol', standard_version: standardVersion,
    status: 'done',
    verdict: risk === 0 && top === 'none' ? 'compliant' : 'non-compliant',
    top_severity: top, risk_score: risk, blocked_reason: null,
    subject_ref: ref, commit, images,
    started_at: iso(started), finished_at: iso(finished),
    findings,
  };
}

function buildSubject(name, cfg) {
  const ref = `Yundera/AppStore@main:Apps/${name}`;
  const images = imagesFor(name);
  const history = [];

  // ---- static leg -----------------------------------------------------
  let staticRec = null;
  if (cfg.staticKind !== 'none') {
    const failing = (cfg.fail ?? []).map((k) => finding(k, 'fail'));
    const passing = (cfg.pass ?? []).map((k) => finding(k, 'pass'));
    const current = [...failing, ...passing];

    // history: 3–7 assays, oldest ones sometimes clean so a regression shows up
    const runs = cfg.runs ?? int(3, 7);
    const regressAt = cfg.staticKind === 'noncompliant' && runs > 2 ? (cfg.regressAt ?? int(1, runs - 2)) : -1;
    const spacing = Math.max(2, Math.floor((26 - cfg.age) / Math.max(1, runs - 1)));

    for (let k = runs - 1; k >= 0; k--) {
      const started = daysAgo(cfg.age + k * spacing, 9);
      let findings;
      if (k === 0) findings = current;
      else if (regressAt >= 0 && k > regressAt) findings = passing.length ? passing : [finding('D1', 'pass')];
      else findings = [...failing.slice(0, Math.max(1, failing.length - int(0, 1))), ...passing];
      const commit = hex(12);
      const meta = staticMeta(name, started, findings, ref, commit, images,
        k > runs - 2 ? 2 : 3);
      const rec = makeRecord(name, 'static', meta);
      addReport(rec, staticReportMd(meta, k === 0));
      history.push(rec);
      if (k === 0) staticRec = rec;
    }
  }

  // ---- functional leg -------------------------------------------------
  let funcRec = null;
  if (cfg.functionalKind === 'compliant') {
    const started = daysAgo(cfg.age, 11);
    const findings = [finding('E9', 'pass'), finding('E8', 'pass')];
    const meta = {
      subject: name, leg: 'functional',
      standard: 'Functional Review Protocol', standard_version: 2,
      status: 'done', verdict: 'compliant', top_severity: 'none', risk_score: 0,
      blocked_reason: null, subject_ref: ref, commit: hex(12), images,
      started_at: iso(started),
      finished_at: iso(new Date(started.getTime() + 18 * 60000)),
      findings,
    };
    const rec = makeRecord(name, 'functional', meta);
    addReport(rec, staticReportMd(meta, true));
    history.push(rec);
    funcRec = rec;
  } else if (cfg.functionalKind === 'blocked') {
    const attempts = cfg.attempts ?? int(1, 3);
    for (let k = attempts - 1; k >= 0; k--) {
      const started = new Date(BLOCKED_AT.getTime() + (attempts - 1 - k) * 9 * 36e5 + int(0, 3600) * 1000);
      const findings = k === 0 && E9_SUBJECTS.has(name) ? [finding('E9', 'unverified')] : [];
      const meta = {
        subject: name, leg: 'functional',
        standard: 'Functional Review Protocol', standard_version: 2,
        status: 'blocked', verdict: null, top_severity: 'none', risk_score: 0,
        blocked_reason: 'bench_unavailable', subject_ref: ref, commit: hex(12), images,
        started_at: iso(started),
        finished_at: iso(new Date(started.getTime() + 4200)),
        findings,
      };
      const rec = makeRecord(name, 'functional', meta);
      addReport(rec, blockedReportMd(meta));
      history.push(rec);
      if (k === 0) funcRec = rec;
    }
  } else if (cfg.functionalKind === 'running') {
    const started = new Date(NOW.getTime() - 4 * 60000 - 12000);
    const meta = {
      subject: name, leg: 'functional',
      standard: 'Functional Review Protocol', standard_version: 2,
      status: 'running', verdict: null, top_severity: 'none', risk_score: 0,
      blocked_reason: null, subject_ref: ref, commit: hex(12), images,
      started_at: iso(started), finished_at: iso(started), findings: [],
      worker: 'worker-2', bench: 'demostaging2.inojob.com',
    };
    const rec = makeRecord(name, 'functional', meta);
    addReport(rec, runningReportMd(meta));
    history.push(rec);
    funcRec = rec;
  }

  history.sort((a, b) => b.meta.started_at.localeCompare(a.meta.started_at));
  histories[name] = history;

  const latest = history[0];
  const age_days = latest
    ? Math.max(0, Math.floor((NOW - new Date(latest.meta.finished_at)) / 864e5))
    : null;

  subjects.push({
    name,
    static: staticRec,
    functional: funcRec,
    risk: (staticRec?.meta.risk_score ?? 0) + (funcRec?.meta.risk_score ?? 0),
    age_days,
  });
}

for (const [name, cfg] of Object.entries(NONCOMPLIANT)) {
  buildSubject(name, {
    ...cfg, staticKind: 'noncompliant',
    functionalKind: 'blocked',
    regressAt: name === 'OpenClaw' ? 3 : undefined,
    runs: name === 'OpenClaw' ? 7 : undefined,
  });
}
for (const [name, cfg] of Object.entries(COMPLIANT)) {
  buildSubject(name, {
    ...cfg, fail: [], staticKind: 'compliant',
    functionalKind: name === 'Radarr' ? 'compliant' : 'blocked',
  });
}
for (const name of BLOCKED_ONLY) {
  buildSubject(name, {
    staticKind: 'none', age: 1,
    functionalKind: name === RUNNING_SUBJECT ? 'running' : 'blocked',
  });
}
for (const name of UNASSAYED) {
  buildSubject(name, { staticKind: 'none', functionalKind: 'none', age: 0 });
}

subjects.sort((a, b) => b.risk - a.risk || a.name.localeCompare(b.name));

// One archived report is deliberately absent from disk, so UX.md §4's
// "report file missing" state is reachable from the version picker: the index
// is built from frontmatter and still knows about the assay, but the evidence
// for it is gone.
const ocArchived = histories.OpenClaw
  .filter((r) => r.meta.leg === 'static')
  .sort((a, b) => a.meta.started_at.localeCompare(b.meta.started_at))[2];
if (ocArchived) delete reports[`${ocArchived.subject}/${ocArchived.file}`];

// ---------------------------------------------------------------- findings
// latest assay per (subject, leg) only — exactly what the contract promises.
const groups = new Map();
const unverified = [];
for (const s of subjects) {
  for (const rec of [s.static, s.functional]) {
    if (!rec) continue;
    for (const f of rec.meta.findings) {
      const key = `${f.rule}|${f.title ?? ''}|${f.status}`;
      if (!groups.has(key)) {
        groups.set(key, {
          rule: f.rule, title: f.title ?? '', severity: f.severity,
          status: f.status, subjects: [], risk: 0,
        });
      }
      const g = groups.get(key);
      g.subjects.push(s.name);
      g.risk += (f.status === 'fail' || f.status === 'unverified') ? WEIGHT[f.severity] : 0;
      if (f.status === 'unverified') {
        unverified.push({
          ...f, subject: s.name, leg: rec.meta.leg, file: rec.file,
          since: rec.meta.started_at,
          blocked_reason: rec.meta.blocked_reason ?? null,
        });
      }
    }
  }
}
const ruleGroups = [...groups.values()].sort(
  (a, b) => b.risk - a.risk || RANK[b.severity] - RANK[a.severity] || b.subjects.length - a.subjects.length,
);

// ---------------------------------------------------------------- write
mkdirSync(FIXTURES, { recursive: true });
const w = (f, v) => {
  writeFileSync(`${FIXTURES}/${f}`, JSON.stringify(v, null, f === 'reports.json' ? 0 : 1) + '\n');
  return `${f} ${(JSON.stringify(v).length / 1024).toFixed(0)} KB`;
};

console.log(w('subjects.json', subjects));
console.log(w('histories.json', histories));
console.log(w('reports.json', reports));
console.log(w('findings-by-rule.json', ruleGroups));
console.log(w('findings-unverified.json', unverified));

// ---------------------------------------------------------------- verify
const tally = (leg, pred) => subjects.filter((s) => pred(s[leg])).length;
const check = (label, got, want) =>
  console.log(`${got === want ? 'ok  ' : 'FAIL'} ${label}: ${got} (want ${want})`);

console.log('\n--- self-check -------------------------------------------');
check('subjects', subjects.length, 69);
check('static compliant', tally('static', (r) => r?.meta.verdict === 'compliant'), 12);
check('static non-compliant', tally('static', (r) => r?.meta.verdict === 'non-compliant'), 19);
check('static not yet', tally('static', (r) => !r), 38);
check('functional compliant', tally('functional', (r) => r?.meta.verdict === 'compliant'), 1);
check('functional blocked', tally('functional', (r) => r?.meta.status === 'blocked'), 49);
check('functional running', tally('functional', (r) => r?.meta.status === 'running'), 1);
check('functional not yet', tally('functional', (r) => !r), 18);
check('total risk', subjects.reduce((s, x) => s + x.risk, 0), 1407);
const g = (title, status) => ruleGroups.find((x) => x.title === title && x.status === status);
check('cpu_shares subjects', g('cpu_shares on reserved tier 10', 'fail')?.subjects.length, 5);
check('descriptions subjects', g('no volume/env descriptions', 'fail')?.subjects.length, 14);
check('D2 subjects', g('root + user dir, no rationale.md', 'fail')?.subjects.length, 6);
check('E9 unverified subjects', g('auth gate present', 'unverified')?.subjects.length, 11);
check('E9 unverified risk', g('auth gate present', 'unverified')?.risk, 1100);
check('D1 pass subjects', g('root, AppData-only', 'pass')?.subjects.length, 9);
check('assay records (one report deliberately missing)', Object.keys(reports).length, Object.values(histories).flat().length - 1);
console.log('OpenClaw history:', histories.OpenClaw.length, 'assays');
