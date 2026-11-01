#!/usr/bin/env node
// Generated from shared/jira.mjs by scripts/sync-shared.mjs: edit that file, then run node scripts/sync-shared.mjs.
// Reads a Jira ticket (read-only) and prints compact JSON for the kit's commands. Writes nothing.
// Custom fields are reported by their display names, so any Jira project works without field ids.
// Credentials: JIRA_USER and JIRA_API_TOKEN from the environment, .claude/.env.local or ~/.claude/.env. The site: JIRA_BASE_URL
// from those files, else jiraBaseUrl from the kit's settings (or JIRA_BASE_URL from the environment), atlassian.net only.
// Self-contained: the same file ships in the theme kit and the app kit, and finds its kit from where it sits.
const HELP = `Usage:
  node .claude/kit/jira.mjs <KEY>                ticket, links, mentioned keys, estimates, comments
  node .claude/kit/jira.mjs <KEY> --no-comments  the same without comments (for related tickets)
  node .claude/kit/jira.mjs --check              which credentials would be used (never prints the token)`;
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';
import { spawnSync } from 'node:child_process';

// ── The kit around this file ──

const KIT_DIR = dirname(fileURLToPath(import.meta.url));
const CLAUDE_DIR = resolve(KIT_DIR, '..');
const ROOT = resolve(CLAUDE_DIR, '..');
// The app kit has kit/app.mjs; the theme kit has kit/kit.mjs.
const APP = existsSync(join(KIT_DIR, 'app.mjs'));
const CONFIG_REL = APP ? '.claude/app-kit.json' : '.claude/shopify-kit.json';
const SETUP = APP ? '/app-setup' : '/shopify-setup';

const print = (value) => process.stdout.write(`${typeof value === 'string' ? value : JSON.stringify(value, null, 2)}\n`);
function fail(message, code = 1) {
  process.stderr.write(`${String(message).trimEnd()}\n`);
  process.exit(code);
}
function normKey(raw) {
  const key = String(raw || '').trim().toUpperCase();
  if (!/^[A-Z][A-Z0-9]+-\d+$/.test(key)) fail(`"${raw}" is not a Jira key (expected something like ABC-123).`);
  return key;
}
function readConfig() {
  try { return JSON.parse(readFileSync(join(ROOT, CONFIG_REL), 'utf8')); } catch { return null; }
}
function git(args) {
  const r = spawnSync('git', args, { cwd: ROOT, encoding: 'utf8' });
  return r.status === 0 ? r.stdout.trim() : '';
}

// ── Secrets ──

// KEY=value lines, with an optional export prefix and matching quotes. No escapes or multi-line values.
function readEnvFile(path) {
  const out = {};
  let text = '';
  try { text = existsSync(path) ? readFileSync(path, 'utf8') : ''; } catch { /* unreadable: nothing */ }
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    const eq = line.indexOf('=');
    if (!line || line.startsWith('#') || eq === -1) continue;
    let val = line.slice(eq + 1).trim();
    if (val.length > 1 && /^(['"]).*\1$/.test(val)) val = val.slice(1, -1);
    out[line.slice(0, eq).trim().replace(/^export\s+/, '')] = val;
  }
  return out;
}
const LOCAL = join(CLAUDE_DIR, '.env.local');
const GLOBAL = join(homedir(), '.claude', '.env');
/** A secret from the dev's own files only: what the agent can't set by prefixing a command. */
const fromFiles = (name) => readEnvFile(LOCAL)[name] || readEnvFile(GLOBAL)[name] || '';
const secret = (name) => process.env[name] || fromFiles(name);

/** Where each secret comes from (they can come from different places), or null if any is missing. */
function secretSource(names) {
  const from = names.map((n) => (process.env[n] ? 'process environment' : readEnvFile(LOCAL)[n] ? LOCAL : readEnvFile(GLOBAL)[n] ? GLOBAL : null));
  if (from.some((f) => !f)) return null;
  return [...new Set(from)].join(' + ');
}

// ── Jira values to text ──

// Fields kept out of `fields`: tracking data, or shown under their own key in the output.
const SKIP = new Set(['lastViewed', 'watches', 'votes', 'worklog', 'timetracking', 'aggregatetimeestimate', 'aggregatetimeoriginalestimate',
  'aggregatetimespent', 'aggregateprogress', 'progress', 'workratio', 'issuerestriction', 'thumbnail', 'statuscategorychangedate',
  'timeestimate', 'timeoriginalestimate', 'timespent', 'security', 'comment', 'attachment', 'issuelinks', 'subtasks', 'parent',
  'summary', 'description', 'status', 'issuetype', 'project', 'priority', 'assignee', 'reporter', 'creator', 'created', 'updated',
  'labels', 'duedate', 'resolution', 'resolutiondate', 'fixVersions', 'versions', 'components', 'environment']);

// Atlassian Document Format (Jira's rich-text JSON) to compact Markdown.
function adf(node) {
  if (!node) return '';
  if (typeof node === 'string') return node;
  if (Array.isArray(node)) return node.map(adf).join('');
  if (node.type === 'text') {
    let t = node.text || '';
    const marks = node.marks || [];
    if (marks.some((m) => m.type === 'code')) t = '`' + t + '`';
    if (marks.some((m) => m.type === 'strong')) t = '**' + t + '**';
    const link = marks.find((m) => m.type === 'link');
    if (link?.attrs?.href && link.attrs.href !== t) t = `[${t}](${link.attrs.href})`;
    return t;
  }
  if (node.type === 'inlineCard' || node.type === 'blockCard' || node.type === 'embedCard') return node.attrs?.url || '';
  if (node.type === 'mention') return node.attrs?.text || '';
  if (node.type === 'emoji') return node.attrs?.text || '';
  if (node.type === 'hardBreak') return '\n';
  if (node.type === 'rule') return '\n---\n';
  if (node.type === 'media' || node.type === 'mediaInline') return '[image]';
  const kids = (node.content || []).map(adf).join('');
  switch (node.type) {
    case 'paragraph': return kids + '\n';
    case 'heading': return '#'.repeat(node.attrs?.level || 3) + ' ' + kids + '\n';
    case 'listItem': return kids.split('\n').filter((l) => l.trim()).map((l, i) => (i ? '  ' : '- ') + l).join('\n') + '\n';
    case 'codeBlock': return '```\n' + kids + '\n```\n';
    case 'blockquote': return kids.split('\n').map((l) => (l.trim() ? '> ' + l : l)).join('\n');
    case 'tableRow': return '| ' + (node.content || []).map((c) => adf(c).trim().replace(/\n/g, ' ')).join(' | ') + ' |\n';
    case 'mediaSingle': case 'mediaGroup': return '[image]\n';
    default: return kids;
  }
}

// Any field value as a string or null: rich text, lists, and option or user objects by their name.
function text(v) {
  if (v == null || v === '') return null;
  if (typeof v === 'string') return v.trim() || null;
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  if (Array.isArray(v)) return v.map(text).filter(Boolean).join(', ') || null;
  if (v.type === 'doc' || v.content) return adf(v).trim() || null;
  return text(v.value ?? v.name ?? v.displayName ?? v.key ?? null);
}

// Every URL in a value, from plain text and from link attributes (for figmaLinks).
function urls(v, acc = new Set()) {
  if (!v) return acc;
  if (typeof v === 'string') { for (const u of v.match(/https?:\/\/[^\s)>\]|"]+/g) || []) acc.add(u); return acc; }
  if (Array.isArray(v)) { v.forEach((x) => urls(x, acc)); return acc; }
  if (typeof v === 'object') {
    if (v.attrs?.url) acc.add(v.attrs.url);
    if (v.attrs?.href) acc.add(v.attrs.href);
    for (const m of v.marks || []) if (m.attrs?.href) acc.add(m.attrs.href);
    for (const x of Object.values(v)) if (typeof x === 'object' || typeof x === 'string') urls(x, acc);
  }
  return acc;
}

// ── Credentials and requests ──

// JIRA_BASE_URL from the dev's own files wins over the repo's jiraBaseUrl; hostProblem says why that matters.
function creds() {
  const cfg = readConfig();
  const own = fromFiles('JIRA_BASE_URL');
  let base = (own || process.env.JIRA_BASE_URL || cfg?.jiraBaseUrl || '').trim().replace(/\/+$/, '');
  if (base && !/^https?:\/\//.test(base)) base = 'https://' + base;
  return { base, baseProblem: base ? hostProblem(base, Boolean(own)) : null, user: secret('JIRA_USER'), token: secret('JIRA_API_TOKEN'), source: secretSource(['JIRA_USER', 'JIRA_API_TOKEN']) };
}

/**
 * The token goes wherever the base URL points. jiraBaseUrl lives in a repo file the agent can edit, and the agent can
 * prefix a command with JIRA_BASE_URL=…, so from either only an atlassian.net site gets it; another host must come from
 * the dev's own .env.local (or ~/.claude/.env).
 */
function hostProblem(base, own) {
  let url;
  try { url = new URL(base); } catch { return `"${base}" isn't a URL.`; }
  if (url.protocol !== 'https:') return `${base} isn't https, so the token isn't sent.`;
  if (!own && !url.hostname.endsWith('.atlassian.net')) return `The Jira URL (jiraBaseUrl in ${CONFIG_REL}, or JIRA_BASE_URL in the environment) points at ${url.hostname}, not an atlassian.net site, so the token isn't sent. For a self-hosted Jira, put JIRA_BASE_URL in .claude/.env.local.`;
  return null;
}

// null on 404; refused credentials and other errors end the script. A redirect isn't followed: the token goes only to base.
async function get(c, path) {
  const res = await fetch(c.base + path, {
    redirect: 'error',
    headers: { Authorization: 'Basic ' + Buffer.from(`${c.user}:${c.token}`).toString('base64'), Accept: 'application/json' },
  });
  if (res.status === 401 || res.status === 403) fail(`Jira refused the credentials (HTTP ${res.status}). The API token may be expired or lack access. Source: ${c.source}`);
  if (res.status === 404) return null;
  if (!res.ok) fail(`Jira error ${res.status} for ${path}`);
  return res.json();
}

// ── Arguments and --check ──

const argv = process.argv.slice(2);
if (!argv.length || argv.includes('--help') || argv.includes('help')) { print(HELP); process.exit(argv.length ? 0 : 1); }
const c = creds();

if (argv.includes('--check')) {
  // The token file must be git-ignored before anyone writes a token into it.
  const inRepo = git(['rev-parse', '--is-inside-work-tree'], { allowFail: true }) === 'true';
  const ignored = !inRepo || git(['check-ignore', '.claude/.env.local'], { allowFail: true }) !== '';
  print({
    baseUrl: c.base || null, baseUrlProblem: c.baseProblem, credentials: c.source || 'missing', user: c.user || null,
    envLocalIgnoredByGit: ignored,
    fix: !ignored
      ? 'STOP: .claude/.env.local is not git-ignored here, so a token in it could be committed. Re-run the kit installer (it writes .claude/.gitignore) or add .claude/ to the repo\'s .gitignore first.'
      : c.source ? null : 'Create .claude/.env.local with two lines: JIRA_USER=<your Atlassian email> and JIRA_API_TOKEN=<token from id.atlassian.com>. Never paste the token into chat.',
  });
  process.exit(ignored ? 0 : 2);
}

// ── Fetch and filter the ticket ──

const key = normKey(argv.find((a) => !a.startsWith('--')));
if (!c.base) fail(`No Jira URL. Set jiraBaseUrl in ${CONFIG_REL} (run ${SETUP}).`);
if (c.baseProblem) fail(c.baseProblem);
if (!c.user || !c.token) fail('No Jira credentials. Create .claude/.env.local with JIRA_USER and JIRA_API_TOKEN (see .claude/README.md), or paste the ticket text instead.');

const issue = await get(c, `/rest/api/3/issue/${encodeURIComponent(key)}?expand=names`);
if (!issue) fail(`${key} not found on ${c.base}, or you can't see it.`);
const f = issue.fields || {};
const names = issue.names || {};
const withComments = !argv.includes('--no-comments');
const [comments, remote] = await Promise.all([
  withComments ? get(c, `/rest/api/3/issue/${encodeURIComponent(key)}/comment?maxResults=100&orderBy=created`) : null,
  get(c, `/rest/api/3/issue/${encodeURIComponent(key)}/remotelink`),
]);

// Tracking fields (counters, time logs, chart data) carry no requirements and cost tokens. Estimates are kept apart.
const NOISE_NAME = /\b(count|counter|time spent|rank|sprint)\b|\[chart\]|status category/i;
const REQUIREMENT_NAME = /criteria|hypothesis|target|segment|goal|url|link|asset|scenario|expected|actual|steps|environment|overlap|preview|figma|design|experiment|variant|variation|device|page|market|locale|content|description|note/i;
const fields = {};
const estimates = {};
for (const [id, value] of Object.entries(f)) {
  if (SKIP.has(id)) continue;
  const name = names[id] || id;
  let t = text(value);
  if (!t) continue;
  if (/estimat/i.test(name)) { estimates[name] = t; continue; }
  if (NOISE_NAME.test(name)) continue;
  if (t.length > 20000) t = `${t.slice(0, 20000)}\n…(truncated)`;
  // Integration fields serialise as {key=value} blobs; numbers and dates alone are tracking data.
  if (/^\{.*=.*\}$/s.test(t) || /^-?\d+(\.\d+)?$/.test(t) || /^\d{4}-\d{2}-\d{2}([T ][\d:.+-]+)?$/.test(t)) continue;
  if (t.length < 25 && !REQUIREMENT_NAME.test(name)) continue;
  fields[name] = t;
}

const description = text(f.description);
const commentList = (comments?.comments || []).map((cm) => ({
  author: cm.author?.displayName || null, date: (cm.created || '').slice(0, 10), text: adf(cm.body).trim().slice(0, 3000),
})).filter((cm) => cm.text && cm.text !== '[image]');

const allText = [f.summary, description, ...Object.values(fields), ...commentList.map((cm) => cm.text)].join('\n');
const linked = new Set([...(f.issuelinks || []).map((l) => (l.outwardIssue || l.inwardIssue)?.key), f.parent?.key, ...(f.subtasks || []).map((s) => s.key)].filter(Boolean));
// With ticket prefixes configured, "UTF-8" or "ISO-8601" can't pass for ticket keys.
const prefixes = readConfig({ required: false })?.ticketPrefixes || [];
const looksLikeTicket = (k) => (prefixes.length ? prefixes.includes(k.split('-')[0]) : !/^(UTF|ISO|SHA|RFC|ES|TLS|HTTP|H|X)-/.test(k));
const mentioned = [...new Set(allText.match(/\b[A-Z][A-Z0-9]+-\d+\b/g) || [])].filter((k) => k !== key && !linked.has(k) && looksLikeTicket(k));
const allUrls = [...urls(f.description), ...urls(Object.values(f)), ...commentList.flatMap((cm) => cm.text.match(/https?:\/\/[^\s)>\]]+/g) || [])];

// ── Output ──

print({
  key: issue.key,
  url: `${c.base}/browse/${issue.key}`,
  summary: f.summary || null,
  type: f.issuetype?.name || null,
  status: f.status?.name || null,
  priority: f.priority?.name || null,
  labels: f.labels || [],
  assignee: f.assignee?.displayName || null,
  reporter: f.reporter?.displayName || null,
  created: (f.created || '').slice(0, 10),
  updated: (f.updated || '').slice(0, 10),
  parent: f.parent ? { key: f.parent.key, summary: f.parent.fields?.summary || null } : null,
  links: (f.issuelinks || []).map((l) => {
    const other = l.outwardIssue || l.inwardIssue;
    return { relation: l.outwardIssue ? l.type?.outward : l.type?.inward, key: other?.key, summary: other?.fields?.summary || null, status: other?.fields?.status?.name || null };
  }),
  subtasks: (f.subtasks || []).map((s) => ({ key: s.key, summary: s.fields?.summary || null, status: s.fields?.status?.name || null })),
  mentionedKeys: mentioned,
  description,
  fields,
  estimates,
  attachments: (f.attachment || []).map((a) => ({ name: a.filename, type: a.mimeType, url: a.content })),
  remoteLinks: (remote || []).map((r) => ({ title: r.object?.title || null, url: r.object?.url || null })),
  figmaLinks: [...new Set(allUrls.filter((u) => /figma\.com/.test(u)))],
  comments: withComments ? commentList : 'skipped (--no-comments)',
  _source: { baseUrl: c.base, credentials: c.source },
});
