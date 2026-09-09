#!/usr/bin/env node
/**
 * Builds README.md from README.template.md plus live GitHub metadata.
 *
 *   node scripts/build.mjs
 *
 * No dependencies, no install step. Node 20+ for global fetch. Set GITHUB_TOKEN to get the
 * 5000/hr rate limit instead of 60; without it the script still runs, just unauthenticated.
 *
 * The stats block is the only generated section. It is built here rather than pulled from a
 * third-party card service so it can never 404 and so it matches the banner. If the data
 * cannot be fetched this exits non-zero and writes nothing, because a half-empty profile is
 * worse than a stale one.
 *
 * These numbers cover public repositories only. The API will not report private work to an
 * unprivileged token, so anything inside a private org is not counted.
 */

import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

// ---------------------------------------------------------------------------------------
// Tunables
// ---------------------------------------------------------------------------------------

const USER = 'NikhileshThiru';

/** How many languages get a bar. */
const TOP_LANGUAGES = 6;

/**
 * Only repos pushed inside this window count toward the language bars. Without it a single
 * 6.7MB Python dump from 2021 renders as 82% of everything you have ever written, which is
 * true by byte count and false about the work.
 */
const LANGUAGE_WINDOW_DAYS = 1095;

/** Layout of the stats block. Stays well under 80 columns so it never sidescrolls. */
const COL = { label: 18, value: 10, bar: 38, lang: 14, gap: 4 };

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

const day = (iso) => String(iso ?? '').slice(0, 10);
const ms = (iso) => Date.parse(iso) || 0;

/** `total stars ......` - the label, a space, then dots out to a fixed column. */
function padDots(label, width) {
  const text = label.length > width ? `${label.slice(0, width - 1)}…` : label;
  const dots = width - text.length - 1;
  return dots > 0 ? `${text} ${'.'.repeat(dots)}` : text.padEnd(width, ' ');
}

/**
 * A fork counts as the user's own work only once it has been pushed to since it was
 * created, which separates a repo actually worked on from a drive-by fork.
 */
const isOwnWork = (repo) =>
  !repo.archived && !repo.disabled && (!repo.fork || ms(repo.pushed_at) > ms(repo.created_at));

// ---------------------------------------------------------------------------------------
// Stats
// ---------------------------------------------------------------------------------------

/**
 * Sum language bytes across every repo. Requests run one at a time on purpose: a burst of
 * parallel calls is what trips GitHub's secondary rate limit, and this is a cron job with
 * no reason to be in a hurry.
 */
async function languageBytes(repos) {
  const totals = {};
  for (const repo of repos) {
    const langs = await api(`/repos/${repo.full_name}/languages`).catch(() => ({}));
    for (const [name, count] of Object.entries(langs)) {
      totals[name] = (totals[name] ?? 0) + count;
    }
  }
  return totals;
}

function renderStats({ profile, repos, bytes }) {
  const stars = repos.reduce((sum, r) => sum + (r.stargazers_count ?? 0), 0);
  const forks = repos.reduce((sum, r) => sum + (r.forks_count ?? 0), 0);
  const lastPush = repos.reduce((latest, r) => Math.max(latest, ms(r.pushed_at)), 0);

  const cell = (label, value) =>
    `${padDots(label, COL.label)} ${String(value).padStart(COL.value)}`;

  const counters = [
    [cell('public repos', repos.length), cell('languages', Object.keys(bytes).length)],
    [cell('total stars', stars), cell('forks of my work', forks)],
    [
      cell('member since', new Date(profile.created_at).getUTCFullYear()),
      cell('last push', lastPush ? day(new Date(lastPush).toISOString()) : 'n/a'),
    ],
  ].map((row) => row.join(' '.repeat(COL.gap)));

  const total = Object.values(bytes).reduce((sum, n) => sum + n, 0);
  const bars = Object.entries(bytes)
    .sort((a, b) => b[1] - a[1])
    .slice(0, TOP_LANGUAGES)
    .map(([name, count]) => {
      const pct = total > 0 ? (count / total) * 100 : 0;
      const filled = Math.max(1, Math.round((pct / 100) * COL.bar));
      const label = name.toLowerCase().slice(0, COL.lang - 1).padEnd(COL.lang);
      const bar = '█'.repeat(filled) + '░'.repeat(COL.bar - filled);
      return `${label}${bar} ${pct.toFixed(1).padStart(5)}%`;
    });

  const body = bars.length ? [...counters, '', ...bars] : counters;
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

  const allRepos = await api(`/users/${USER}/repos?per_page=100&sort=pushed`);
  if (!Array.isArray(allRepos) || allRepos.length === 0) {
    throw new Error(`the repo list for ${USER} came back empty, refusing to write a stub README`);
  }

  const profile = await api(`/users/${USER}`);
  const repos = allRepos.filter(isOwnWork);
  const cutoff = Date.now() - LANGUAGE_WINDOW_DAYS * 86_400_000;
  const recent = repos.filter((r) => ms(r.pushed_at) >= cutoff);
  const counted = recent.length > 0 ? recent : repos;
  const bytes = await languageBytes(counted);

  const out = inject(template, 'STATS', renderStats({ profile, repos, bytes }));
  await writeFile(path.join(ROOT, OUTPUT_FILE), GENERATED_HEADER + out.trimStart(), 'utf8');

  console.log(`built ${OUTPUT_FILE}`);
  console.log(`  repos seen     ${allRepos.length}, own work ${repos.length}`);
  console.log(`  languages      ${Object.keys(bytes).length} across ${counted.length} repos in the last ${LANGUAGE_WINDOW_DAYS} days`);
}

main().catch((err) => {
  console.error(`\nbuild failed: ${err.message}\n`);
  process.exit(1);
});
