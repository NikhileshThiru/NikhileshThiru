#!/usr/bin/env node
/**
 * Builds README.md from README.template.md plus live GitHub metadata.
 *
 *   node scripts/build.mjs
 *
 * No dependencies, no install step. Node 20+ for global fetch. Set GITHUB_TOKEN to get the
 * 5000/hr rate limit instead of 60; without it the script still runs, just unauthenticated.
 *
 * The contract is that README.md is a build artifact. Everything time-sensitive on the
 * profile is generated here, so the template stays evergreen and never needs editing.
 * If the data cannot be fetched this exits non-zero and writes nothing, because a
 * half-empty profile is worse than a stale one.
 */

import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

// ---------------------------------------------------------------------------------------
// Tunables
// ---------------------------------------------------------------------------------------

const USER = 'NikhileshThiru';

/** Shown first, in this order. Everything else follows by pushed_at descending. */
const PINNED = ['RefNet', 'octave', 'nikhileshthiru-site'];

/** Hard cap on the projects section. */
const MAX_PROJECTS = 6;

/** Topic chips are truncated to this many so a heavily tagged repo cannot run away. */
const MAX_CHIPS = 8;

/** Target length of the now.log body, excluding the trailing [SYNC] line. */
const LOG_LINES = 10;

/** Below this many real events, now.log switches to the [WORK] fallback. */
const MIN_REAL_EVENTS = 4;

/** Fallback rows older than this are dropped, unless that would empty the log. */
const FALLBACK_MAX_AGE_DAYS = 550;

/** Column widths for the log block. Total stays under 80 so it never sidescrolls. */
const COL = { level: 6, repo: 22, total: 86 };

const TEMPLATE_FILE = 'README.template.md';
const OUTPUT_FILE = 'README.md';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

const GENERATED_HEADER = `<!--
  ============================================================================
   GENERATED FILE - DO NOT EDIT
   Built by scripts/build.mjs from README.template.md.
   Edit the template. This file is overwritten by .github/workflows/build.yml.
  ============================================================================
-->
`;

// ---------------------------------------------------------------------------------------
// GitHub API
// ---------------------------------------------------------------------------------------

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * GET a GitHub API path as JSON. Retries transient failures, then throws with enough
 * detail to diagnose from a CI log.
 */
async function api(pathname) {
  const url = `https://api.github.com${pathname}`;
  const headers = {
    accept: 'application/vnd.github+json',
    'x-github-api-version': '2022-11-28',
    'user-agent': `${USER}-profile-builder`,
  };
  if (process.env.GITHUB_TOKEN) headers.authorization = `Bearer ${process.env.GITHUB_TOKEN}`;

  let failure;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    let res;
    try {
      res = await fetch(url, { headers });
    } catch (err) {
      failure = new Error(`GET ${url} failed to connect: ${err.message}`);
      await sleep(attempt * 1000);
      continue;
    }

    if (res.ok) return res.json();

    const remaining = res.headers.get('x-ratelimit-remaining') ?? 'unknown';
    failure = new Error(
      `GET ${url} -> ${res.status} ${res.statusText} (rate limit remaining: ${remaining})`,
    );
    // 5xx and 429 are worth another go; anything else will not fix itself.
    if (res.status < 500 && res.status !== 429) break;
    await sleep(attempt * 1500);
  }
  throw failure;
}

// ---------------------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------------------

const collapse = (s) => String(s ?? '').replace(/\s+/g, ' ').trim();
const day = (iso) => String(iso ?? '').slice(0, 10);
const ms = (iso) => Date.parse(iso) || 0;

/** Truncate to a width, preferring a word boundary so the log does not cut mid-word. */
function truncate(s, width) {
  const text = collapse(s);
  if (width <= 1) return '';
  if (text.length <= width) return text;
  const cut = text.slice(0, width - 1);
  const lastSpace = cut.lastIndexOf(' ');
  const body = lastSpace > width * 0.55 ? cut.slice(0, lastSpace) : cut;
  return `${body.replace(/[\s.,;:|·—-]+$/u, '')}…`;
}

/** `lifetracker ..........` - name, a space, then dots out to a fixed column. */
function padDots(name, width) {
  const n = name.length > width ? `${name.slice(0, width - 1)}…` : name;
  const dots = width - n.length - 1;
  return dots > 0 ? `${n} ${'.'.repeat(dots)}` : n.padEnd(width, ' ');
}

// ---------------------------------------------------------------------------------------
// Projects
// ---------------------------------------------------------------------------------------

/**
 * An empty description is the opt-out. A fork counts only if it has been pushed to since
 * it was created, which is what separates a repo actually worked on from a drive-by fork.
 */
function isEligible(repo) {
  if (repo.archived || repo.disabled) return false;
  if (!collapse(repo.description)) return false;
  if (repo.fork && ms(repo.pushed_at) <= ms(repo.created_at)) return false;
  return true;
}

function selectProjects(repos) {
  const rank = (repo) => {
    const i = PINNED.indexOf(repo.name);
    return i === -1 ? PINNED.length : i;
  };
  return repos
    .filter(isEligible)
    .sort((a, b) => rank(a) - rank(b) || ms(b.pushed_at) - ms(a.pushed_at))
    .slice(0, MAX_PROJECTS);
}

function renderProjects(projects) {
  return projects
    .map((repo) => {
      const head = [`**[${repo.name}](${repo.html_url})**`];
      const home = collapse(repo.homepage);
      if (home) head.push(`[\`↗ live\`](${home})`);
      if (repo.stargazers_count > 0) head.push(`\`★ ${repo.stargazers_count}\``);

      const tags = repo.topics?.length
        ? repo.topics.slice(0, MAX_CHIPS)
        : repo.language
          ? [repo.language.toLowerCase()]
          : [];

      const block = [head.join(' &nbsp;·&nbsp; '), '', `> ${collapse(repo.description)}`];
      if (tags.length) block.push('', tags.map((t) => `\`${t}\``).join(' '));
      return block.join('\n');
    })
    .join('\n\n');
}

// ---------------------------------------------------------------------------------------
// now.log
// ---------------------------------------------------------------------------------------

function headCommitMessage(event) {
  const commits = event.payload?.commits ?? [];
  const head = commits[commits.length - 1];
  return collapse(head?.message ?? '').split('\n')[0];
}

const pushDetail = (count, message) =>
  count > 1 ? `${count} commits · ${message}` : message || '1 commit';

/** Map the public events feed onto log rows. Watch, fork and comment noise is dropped. */
function rowsFromEvents(events) {
  const rows = [];

  for (const event of events) {
    if (rows.length >= LOG_LINES) break;
    const date = day(event.created_at);
    const repo = String(event.repo?.name ?? '').split('/').pop() || '?';
    const previous = rows[rows.length - 1];

    switch (event.type) {
      case 'PushEvent': {
        const n = event.payload?.distinct_size ?? event.payload?.size ?? 1;
        // Consecutive pushes to the same repo on the same day are one line.
        if (previous?.level === 'PUSH' && previous.repo === repo && previous.date === date) {
          previous.count += n;
          previous.detail = pushDetail(previous.count, previous.message);
          break;
        }
        const message = headCommitMessage(event);
        rows.push({ level: 'PUSH', repo, date, count: n, message, detail: pushDetail(n, message) });
        break;
      }

      case 'CreateEvent': {
        if (event.payload?.ref_type !== 'repository') break;
        rows.push({ level: 'INIT', repo, date, detail: 'repository created' });
        break;
      }

      case 'ReleaseEvent': {
        const tag = collapse(event.payload?.release?.tag_name);
        rows.push({ level: 'SHIP', repo, date, detail: tag ? `released ${tag}` : 'released' });
        break;
      }

      case 'PullRequestEvent': {
        const action = event.payload?.action;
        const merged = Boolean(event.payload?.pull_request?.merged);
        if (action !== 'opened' && !(action === 'closed' && merged)) break;
        const number = event.payload?.number ?? event.payload?.pull_request?.number;
        const title = collapse(event.payload?.pull_request?.title);
        const verb = merged ? 'merged' : 'opened';
        rows.push({ level: 'PR', repo, date, detail: `${verb} #${number} ${title}`.trim() });
        break;
      }

      case 'PublicEvent': {
        rows.push({ level: 'OPEN', repo, date, detail: 'source went public' });
        break;
      }

      default:
        break;
    }
  }
  return rows;
}

/**
 * The public events feed only covers ~90 days and only public work, and most of the real
 * output here happens inside a private org. When it comes back thin, fall back to what the
 * repo list can prove: the most recently pushed repos, rendered as [WORK].
 */
function rowsFromRepos(repos) {
  const cutoff = Date.now() - FALLBACK_MAX_AGE_DAYS * 86_400_000;
  const candidates = repos.filter(isEligible).sort((a, b) => ms(b.pushed_at) - ms(a.pushed_at));
  const fresh = candidates.filter((r) => ms(r.pushed_at) >= cutoff);
  const chosen = fresh.length >= MIN_REAL_EVENTS ? fresh : candidates;

  return chosen.slice(0, LOG_LINES).map((repo) => ({
    level: 'WORK',
    repo: repo.name,
    date: day(repo.pushed_at),
    detail: [repo.language?.toLowerCase(), collapse(repo.description)].filter(Boolean).join(' · '),
  }));
}

function formatRow(row) {
  const level = `[${row.level}]`.padEnd(COL.level, ' ');
  const prefix = `${level}  ${row.date}  ${padDots(row.repo, COL.repo)}  `;
  return `${prefix}${truncate(row.detail, COL.total - prefix.length)}`.trimEnd();
}

function renderLog(events, repos, now) {
  const live = rowsFromEvents(events);
  const rows = live.length >= MIN_REAL_EVENTS ? live : rowsFromRepos(repos);
  const stamp = now.toISOString().replace(/\.\d{3}Z$/, 'Z');
  const body = rows.map(formatRow);
  body.push(`${'[SYNC]'.padEnd(COL.level, ' ')}  last updated ${stamp} UTC`);
  return ['```', ...body, '```'].join('\n');
}

// ---------------------------------------------------------------------------------------
// Template injection
// ---------------------------------------------------------------------------------------

function inject(doc, marker, body) {
  const open = `<!-- ${marker}:START -->`;
  const close = `<!-- ${marker}:END -->`;
  const i = doc.indexOf(open);
  const j = doc.indexOf(close);
  if (i === -1 || j === -1 || j < i) {
    throw new Error(`${TEMPLATE_FILE} is missing a matching ${open} / ${close} pair`);
  }
  return `${doc.slice(0, i + open.length)}\n${body}\n${doc.slice(j)}`;
}

// ---------------------------------------------------------------------------------------

async function main() {
  const template = await readFile(path.join(ROOT, TEMPLATE_FILE), 'utf8');

  const repos = await api(`/users/${USER}/repos?per_page=100&sort=pushed`);
  if (!Array.isArray(repos) || repos.length === 0) {
    throw new Error(`the repo list for ${USER} came back empty, refusing to write a stub README`);
  }

  // A thin or failed events feed is expected and handled, so it must not fail the build.
  const feed = await api(`/users/${USER}/events/public?per_page=100`).catch((err) => {
    console.warn(`  ! events feed unavailable, using the [WORK] fallback: ${err.message}`);
    return [];
  });
  const events = Array.isArray(feed) ? feed : [];

  const projects = selectProjects(repos);
  if (projects.length === 0) {
    throw new Error('no repo passed the projects filter, refusing to write an empty section');
  }

  let out = template;
  out = inject(out, 'PROJECTS', renderProjects(projects));
  out = inject(out, 'NOWLOG', renderLog(events, repos, new Date()));
  await writeFile(path.join(ROOT, OUTPUT_FILE), GENERATED_HEADER + out.trimStart(), 'utf8');

  console.log(`built ${OUTPUT_FILE}`);
  console.log(`  repos seen      ${repos.length}`);
  console.log(`  projects shown  ${projects.length}  (${projects.map((r) => r.name).join(', ')})`);
  console.log(`  events usable   ${rowsFromEvents(events).length} of ${events.length} fetched`);
}

main().catch((err) => {
  console.error(`\nbuild failed: ${err.message}\n`);
  process.exit(1);
});
