// REST v3 issues / labels / comments / pulls for the github-core-clone-01 entry.
// Handles /api/v3/repos/{owner}/{repo}/(issues|pulls|labels)(/...) — see handleIssuesPulls.
// Shared helpers (createIssueInRepo, createPullInRepo, mergePullInRepo, issueJson, pullJson,
// pullFiles, computeMergeable) are exported for graphql.ts and mcp.ts so all three
// surfaces act on the same store with identical semantics.

import {
  VIEWER_LOGIN,
  VIEWER_ID,
  trialNowIso,
  trialNowEpoch,
  resolveRef,
  makeCommit,
  parseTree,
  parseCommit,
} from './store.ts';
import type { Store, Repo, Issue, Pull, Label, GitComment } from './store.ts';
import { sendJson, notFound, badJson, unauthorized } from './http.ts';
import type { ReqCtx } from './http.ts';

// -------------------------------------------------------------------------------------------
// Small utilities

type JsonObj = Record<string, unknown>;

function isObj(v: unknown): v is JsonObj {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

function parseBody(ctx: ReqCtx): { ok: true; value: JsonObj } | { ok: false } {
  if (ctx.body.length === 0) return { ok: true, value: {} };
  try {
    const parsed: unknown = JSON.parse(ctx.body.toString('utf8'));
    if (isObj(parsed)) return { ok: true, value: parsed };
    return { ok: true, value: {} };
  } catch {
    return { ok: false };
  }
}

function errJson(res: any, status: number, message: string): void {
  sendJson(res, status, { message });
}

/** Merge commit shas, keyed by `${fullName}:${pullNumber}` (Pull has no merge-sha field). */
const mergeShas = new Map<string, string>();

export function getMergeSha(fullName: string, number: number): string | undefined {
  return mergeShas.get(`${fullName}:${number}`);
}

export function labelJson(label: Label): JsonObj {
  return { name: label.name, color: label.color, description: label.description };
}

export function issueJson(repo: Repo, issue: Issue): JsonObj {
  const labels = issue.labels.map((name) => {
    const found = repo.labels.get(name);
    return found !== undefined ? labelJson(found) : { name, color: 'ededed', description: '' };
  });
  return {
    id: issue.id,
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    labels,
    user: { login: VIEWER_LOGIN, id: VIEWER_ID },
    created_at: issue.createdAt,
    updated_at: issue.updatedAt,
    html_url: `https://example.invalid/${repo.fullName}/issues/${issue.number}`,
    url: `/api/v3/repos/${repo.fullName}/issues/${issue.number}`,
    comments: issue.comments.length,
    locked: false,
  };
}

export function commentJson(repo: Repo, issue: Issue, comment: GitComment): JsonObj {
  return {
    id: comment.id,
    body: comment.body,
    user: { login: VIEWER_LOGIN, id: VIEWER_ID },
    created_at: comment.createdAt,
    updated_at: comment.updatedAt,
    html_url: `https://example.invalid/${repo.fullName}/issues/${issue.number}#issuecomment-${comment.id}`,
    url: `/api/v3/repos/${repo.fullName}/issues/${issue.number}/comments/${comment.id}`,
  };
}

export function pullJson(repo: Repo, pull: Pull): JsonObj {
  const mergeSha = getMergeSha(repo.fullName, pull.number);
  const out: JsonObj = {
    id: pull.id,
    number: pull.number,
    title: pull.title,
    body: pull.body,
    state: pull.state,
    merged: pull.merged,
    mergeable: pullMergeable(repo, pull),
    head: { ref: pull.head, sha: pull.headSha, label: `${repo.owner}:${pull.head}` },
    base: { ref: pull.base, sha: pull.baseSha, label: `${repo.owner}:${pull.base}` },
    user: { login: VIEWER_LOGIN, id: VIEWER_ID },
    created_at: pull.createdAt,
    updated_at: pull.updatedAt,
    merged_at: pull.mergedAt,
    html_url: `https://example.invalid/${repo.fullName}/pull/${pull.number}`,
    url: `/api/v3/repos/${repo.fullName}/pulls/${pull.number}`,
  };
  if (mergeSha !== undefined) out.merge_commit_sha = mergeSha;
  return out;
}

// -------------------------------------------------------------------------------------------
// Git tree helpers (3-way merge + pull files)

// Flatten a tree sha to path -> {sha, mode}. Missing tree => empty map.
export function flattenTree(repo: Repo, treeSha: string): Map<string, { sha: string; mode: string }> {
  const out = new Map<string, { sha: string; mode: string }>();
  const walk = (sha: string, prefix: string): void => {
    const obj = repo.objects.get(sha);
    if (obj === undefined || obj.type !== 'tree') return;
    for (const entry of parseTree(obj.data)) {
      const path = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
      if (entry.mode === '40000' || entry.mode === '040000') {
        walk(entry.sha, path);
      } else {
        out.set(path, { sha: entry.sha, mode: entry.mode });
      }
    }
  };
  walk(treeSha, '');
  return out;
}

function treeOfCommit(repo: Repo, commitSha: string): string | null {
  const obj = repo.objects.get(commitSha);
  if (obj === undefined || obj.type !== 'commit') return null;
  return parseCommit(obj.data).tree;
}

function parentsOf(repo: Repo, commitSha: string): string[] {
  const obj = repo.objects.get(commitSha);
  if (obj === undefined || obj.type !== 'commit') return [];
  return parseCommit(obj.data).parents;
}

/** Newest common ancestor of headSha and baseSha, or null when histories are unrelated. */
export function findMergeBase(repo: Repo, headSha: string, baseSha: string): string | null {
  const headAncestors = new Set<string>();
  const stack: string[] = [headSha];
  while (stack.length > 0) {
    const sha = stack.pop() as string;
    if (headAncestors.has(sha)) continue;
    headAncestors.add(sha);
    for (const parent of parentsOf(repo, sha)) stack.push(parent);
  }
  // Breadth-first from the base tip: the first common ancestor found is the newest.
  const seen = new Set<string>();
  const queue: string[] = [baseSha];
  while (queue.length > 0) {
    const sha = queue.shift() as string;
    if (seen.has(sha)) continue;
    seen.add(sha);
    if (headAncestors.has(sha)) return sha;
    for (const parent of parentsOf(repo, sha)) queue.push(parent);
  }
  return null;
}

export function computeMergeable(
  repo: Repo,
  headSha: string,
  baseSha: string,
): { mergeable: boolean; mergeBase: string | null } {  const mergeBase = findMergeBase(repo, headSha, baseSha);
  const baseTree = treeOfCommit(repo, baseSha);
  const headTree = treeOfCommit(repo, headSha);
  const mergeTree = mergeBase === null ? null : treeOfCommit(repo, mergeBase);
  const baseMap = baseTree === null ? new Map() : flattenTree(repo, baseTree);
  const headMap = headTree === null ? new Map() : flattenTree(repo, headTree);
  const mergeMap = mergeTree === null ? new Map() : flattenTree(repo, mergeTree);
  const paths = new Set<string>([...baseMap.keys(), ...headMap.keys(), ...mergeMap.keys()]);
  for (const path of paths) {
    const b = baseMap.get(path);
    const h = headMap.get(path);
    const m = mergeMap.get(path);
    const bv = b === undefined ? undefined : `${b.mode}:${b.sha}`;
    const hv = h === undefined ? undefined : `${h.mode}:${h.sha}`;
    const mv = m === undefined ? undefined : `${m.mode}:${m.sha}`;
    if (bv === mv) continue; // base unchanged: take head's version
    if (hv === mv) continue; // head unchanged: take base's version
    if (bv === hv) continue; // both changed to the same thing
    return { mergeable: false, mergeBase };
  }
  return { mergeable: true, mergeBase };
}

/** The base branch tip as it stands now (moves as other PRs merge). */
export function currentBaseSha(repo: Repo, pull: Pull): string {
  return resolveRef(repo, `refs/heads/${pull.base}`) ?? pull.baseSha;
}

/** Mergeability against the CURRENT base tip, not the sha captured at PR creation. */
export function pullMergeable(repo: Repo, pull: Pull): boolean {
  return computeMergeable(repo, pull.headSha, currentBaseSha(repo, pull)).mergeable;
}

// -------------------------------------------------------------------------------------------
// Shared create / merge operations (used by REST, GraphQL and MCP alike)

export function createIssueInRepo(
  store: Store,
  repo: Repo,
  title: string,
  body: string,
  labelNames: string[],
): { issue: Issue } | { error: string } {
  for (const name of labelNames) {
    if (!repo.labels.has(name)) return { error: `Label does not exist: ${name}` };
  }
  const now = trialNowIso();
  const issue: Issue = {
    id: store.issueIdSeq++,
    number: ++repo.issueSeq,
    title,
    body,
    state: 'open',
    labels: [...labelNames],
    comments: [],
    createdAt: now,
    updatedAt: now,
  };
  repo.issues.set(issue.number, issue);
  return { issue };
}

export function createPullInRepo(
  store: Store,
  repo: Repo,
  title: string,
  body: string,
  head: string,
  base: string,
): { pull: Pull } | { error: string } {
  const headSha = resolveRef(repo, `refs/heads/${head}`);
  if (headSha === undefined) return { error: `Head branch does not exist: ${head}` };
  const baseSha = resolveRef(repo, `refs/heads/${base}`);
  if (baseSha === undefined) return { error: `Base branch does not exist: ${base}` };
  const now = trialNowIso();
  const pull: Pull = {
    id: store.pullIdSeq++,
    number: ++repo.pullSeq,
    title,
    body,
    state: 'open',
    merged: false,
    head,
    base,
    headSha,
    baseSha,
    mergeable: computeMergeable(repo, headSha, baseSha).mergeable,
    createdAt: now,
    updatedAt: now,
    mergedAt: null,
  };
  repo.pulls.set(pull.number, pull);
  return { pull };
}

/** Perform the squash merge. Returns the merge commit sha, or an error kind. */
export function mergePullInRepo(
  repo: Repo,
  pull: Pull,
): { sha: string } | { error: 'conflict' | 'closed' } {
  if (pull.merged || pull.state === 'closed') return { error: 'closed' };
  const baseTip = currentBaseSha(repo, pull);
  if (!pullMergeable(repo, pull)) return { error: 'conflict' };
  const headTree = treeOfCommit(repo, pull.headSha);
  if (headTree === null) return { error: 'conflict' };
  const sha = makeCommit(repo, {
    tree: headTree,
    parents: [baseTip],
    message: `Merge pull request #${pull.number} from ${pull.head}`,
    epoch: trialNowEpoch(),
  });
  repo.refs.set(`refs/heads/${pull.base}`, sha);
  pull.state = 'closed';
  pull.merged = true;
  pull.mergedAt = trialNowIso();
  pull.updatedAt = trialNowIso();
  mergeShas.set(`${repo.fullName}:${pull.number}`, sha);
  return { sha };
}

// -------------------------------------------------------------------------------------------
// Pull files diff

function countLineDiff(baseText: string, headText: string): { additions: number; deletions: number } {
  const count = (text: string): Map<string, number> => {
    const map = new Map<string, number>();
    for (const line of text.split('\n')) map.set(line, (map.get(line) ?? 0) + 1);
    return map;
  };
  const baseLines = count(baseText);
  const headLines = count(headText);
  let additions = 0;
  let deletions = 0;
  for (const [line, n] of headLines) additions += Math.max(0, n - (baseLines.get(line) ?? 0));
  for (const [line, n] of baseLines) deletions += Math.max(0, n - (headLines.get(line) ?? 0));
  return { additions, deletions };
}

export function pullFiles(repo: Repo, pull: Pull): JsonObj[] {
  const baseTree = treeOfCommit(repo, currentBaseSha(repo, pull));
  const headTree = treeOfCommit(repo, pull.headSha);
  const baseMap = baseTree === null ? new Map() : flattenTree(repo, baseTree);
  const headMap = headTree === null ? new Map() : flattenTree(repo, headTree);
  const paths = [...new Set([...baseMap.keys(), ...headMap.keys()])].sort();
  const out: JsonObj[] = [];
  for (const path of paths) {
    const b = baseMap.get(path);
    const h = headMap.get(path);
    let status: string;
    let additions = 0;
    let deletions = 0;
    let patch = '';
    const blobText = (sha: string | undefined): string => {
      if (sha === undefined) return '';
      const obj = repo.objects.get(sha);
      return obj === undefined ? '' : obj.data.toString('utf8');
    };
    if (b === undefined && h !== undefined) {
      status = 'added';
      const text = blobText(h.sha);
      additions = text === '' ? 0 : text.split('\n').length;
      patch = text.split('\n').map((line) => `+${line}`).join('\n');
    } else if (b !== undefined && h === undefined) {
      status = 'removed';
      const text = blobText(b.sha);
      deletions = text === '' ? 0 : text.split('\n').length;
      patch = text.split('\n').map((line) => `-${line}`).join('\n');
    } else if (b !== undefined && h !== undefined && b.sha !== h.sha) {
      status = 'modified';
      const diff = countLineDiff(blobText(b.sha), blobText(h.sha));
      additions = diff.additions;
      deletions = diff.deletions;
      const baseLines = blobText(b.sha).split('\n');
      const headLines = blobText(h.sha).split('\n');
      patch = [
        ...baseLines.map((line) => `-${line}`),
        ...headLines.map((line) => `+${line}`),
      ].join('\n');
    } else if (b !== undefined && h !== undefined && b.sha === h.sha && b.mode !== h.mode) {
      // A mode-only change with identical content still counts as modified.
      status = 'modified';
    } else {
      continue; // identical
    }
    out.push({
      filename: path,
      status,
      additions,
      deletions,
      changes: additions + deletions,
      patch,
    });
  }
  return out;
}

// -------------------------------------------------------------------------------------------
// Handler

function repoLookup(ctx: ReqCtx, owner: string, name: string): Repo | undefined {
  if (owner !== VIEWER_LOGIN) return undefined;
  return ctx.store.getRepo(owner, name);
}

function pageParams(ctx: ReqCtx): { perPage: number; page: number } {
  const perPageRaw = Number(ctx.query.get('per_page') ?? '30');
  const pageRaw = Number(ctx.query.get('page') ?? '1');
  const perPage = Number.isFinite(perPageRaw) ? Math.min(100, Math.max(1, Math.trunc(perPageRaw))) : 30;
  const page = Number.isFinite(pageRaw) ? Math.max(1, Math.trunc(pageRaw)) : 1;
  return { perPage, page };
}

/** Set a Link: <...>; rel="next" header when more pages exist (absolute same-origin URL). */
function setNextLink(req: any, res: any, ctx: ReqCtx, page: number, perPage: number, total: number): void {
  if (page * perPage >= total) return;
  try {
    const host = req?.headers?.host;
    if (typeof host !== 'string' || host === '') return;
    const url = new URL(req.url ?? '/', `http://${host}`);
    url.searchParams.set('page', String(page + 1));
    url.searchParams.set('per_page', String(perPage));
    if (typeof res?.setHeader === 'function') {
      res.setHeader('Link', `<${url.toString()}>; rel="next"`);
    }
  } catch {
    // A Link header is best-effort; the paged body is still correct without it.
  }
}

function paginate<T>(items: T[], perPage: number, page: number): T[] {
  return items.slice((page - 1) * perPage, page * perPage);
}

export async function handleIssuesPulls(req: any, res: any, ctx: ReqCtx): Promise<boolean> {
  const method = String(req?.method ?? 'GET').toUpperCase();
  let pathname = '';
  try {
    pathname = new URL(String(req?.url ?? '/'), 'http://localhost').pathname;
  } catch {
    return false;
  }
  const prefix = '/api/v3/repos/';
  if (!pathname.startsWith(prefix)) return false;
  const rest = pathname.slice(prefix.length);
  const parts = rest.split('/').map((s) => {
    try {
      return decodeURIComponent(s);
    } catch {
      return s;
    }
  });
  if (parts.length < 3) return false;
  const owner = parts[0] as string;
  const repoName = parts[1] as string;
  const resource = parts[2] as string;
  if (resource !== 'issues' && resource !== 'pulls' && resource !== 'labels') return false;

  if (ctx.token === '') {
    unauthorized(res);
    return true;
  }
  const repo = repoLookup(ctx, owner, repoName);
  if (repo === undefined) {
    notFound(res, 'Not Found');
    return true;
  }

  // ---- labels ----
  if (resource === 'labels') {
    if (parts.length !== 3) return false;
    if (method === 'GET') {
      sendJson(res, 200, [...repo.labels.values()].map(labelJson));
      return true;
    }
    if (method === 'POST') {
      const parsed = parseBody(ctx);
      if (!parsed.ok) {
        badJson(res, 'Problems parsing JSON');
        return true;
      }
      const body = parsed.value;
      const name = typeof body.name === 'string' ? body.name : '';
      if (name === '') {
        errJson(res, 422, 'Validation Failed: name is required');
        return true;
      }
      if (repo.labels.has(name)) {
        errJson(res, 422, 'Validation Failed: label already exists');
        return true;
      }
      const label: Label = {
        name,
        color: typeof body.color === 'string' && body.color !== '' ? body.color : 'ededed',
        description: typeof body.description === 'string' ? body.description : '',
      };
      repo.labels.set(name, label);
      sendJson(res, 201, labelJson(label));
      return true;
    }
    return false;
  }

  // ---- issues ----
  if (resource === 'issues') {
    if (parts.length === 3) {
      if (method === 'GET') {
        const state = ctx.query.get('state') ?? 'open';
        const sort = ctx.query.get('sort') ?? 'created';
        const direction = (ctx.query.get('direction') ?? 'desc').toLowerCase() === 'asc' ? 'asc' : 'desc';
        let list = [...repo.issues.values()];
        if (state === 'open') list = list.filter((i) => i.state === 'open');
        else if (state === 'closed') list = list.filter((i) => i.state === 'closed');
        // state=all (or anything else recognised as all) keeps everything; default is open.
        const dir = direction === 'asc' ? 1 : -1;
        if (sort === 'created' || sort === 'updated') {
          const key = sort === 'created' ? 'createdAt' : 'updatedAt';
          list.sort((a, b) => {
            const ta = a[key];
            const tb = b[key];
            if (ta !== tb) return ta < tb ? -dir : dir;
            return (a.number - b.number) * dir;
          });
        } else {
          list.sort((a, b) => (a.number - b.number) * dir);
        }
        const { perPage, page } = pageParams(ctx);
        setNextLink(req, res, ctx, page, perPage, list.length);
        sendJson(res, 200, paginate(list, perPage, page).map((i) => issueJson(repo, i)));
        return true;
      }
      if (method === 'POST') {
        const parsed = parseBody(ctx);
        if (!parsed.ok) {
          badJson(res, 'Problems parsing JSON');
          return true;
        }
        const body = parsed.value;
        const title = typeof body.title === 'string' ? body.title : '';
        if (title === '') {
          errJson(res, 422, 'Validation Failed: title is required');
          return true;
        }
        const labelNames: string[] = [];
        if (Array.isArray(body.labels)) {
          for (const entry of body.labels) {
            if (typeof entry === 'string') labelNames.push(entry);
            else if (isObj(entry) && typeof entry.name === 'string') labelNames.push(entry.name);
          }
        }
        const created = createIssueInRepo(ctx.store, repo, title, typeof body.body === 'string' ? body.body : '', labelNames);
        if ('error' in created) {
          errJson(res, 422, `Validation Failed: ${created.error}`);
          return true;
        }
        sendJson(res, 201, issueJson(repo, created.issue));
        return true;
      }
      return false;
    }
    const num = Number(parts[3]);
    if (!Number.isInteger(num) || num < 1) {
      notFound(res, 'Not Found');
      return true;
    }
    if (parts.length === 4) {
      const issue = repo.issues.get(num);
      if (method === 'GET') {
        if (issue === undefined) {
          notFound(res, 'Not Found');
          return true;
        }
        sendJson(res, 200, issueJson(repo, issue));
        return true;
      }
      if (method === 'PATCH') {
        if (issue === undefined) {
          notFound(res, 'Not Found');
          return true;
        }
        const parsed = parseBody(ctx);
        if (!parsed.ok) {
          badJson(res, 'Problems parsing JSON');
          return true;
        }
        const body = parsed.value;
        if (typeof body.title === 'string') issue.title = body.title;
        if (typeof body.body === 'string') issue.body = body.body;
        if (body.state === 'open' || body.state === 'closed') issue.state = body.state;
        if (Array.isArray(body.labels)) {
          const labelNames: string[] = [];
          for (const entry of body.labels) {
            if (typeof entry === 'string') labelNames.push(entry);
            else if (isObj(entry) && typeof entry.name === 'string') labelNames.push(entry.name);
          }
          for (const name of labelNames) {
            if (!repo.labels.has(name)) {
              errJson(res, 422, `Validation Failed: Label does not exist: ${name}`);
              return true;
            }
          }
          issue.labels = labelNames;
        }
        issue.updatedAt = trialNowIso();
        sendJson(res, 200, issueJson(repo, issue));
        return true;
      }
      return false;
    }
    if (parts.length === 5 && parts[4] === 'comments') {
      const issue = repo.issues.get(num);
      if (method === 'GET') {
        if (issue === undefined) {
          notFound(res, 'Not Found');
          return true;
        }
        sendJson(res, 200, issue.comments.map((c) => commentJson(repo, issue, c)));
        return true;
      }
      if (method === 'POST') {
        if (issue === undefined) {
          notFound(res, 'Not Found');
          return true;
        }
        const parsed = parseBody(ctx);
        if (!parsed.ok) {
          badJson(res, 'Problems parsing JSON');
          return true;
        }
        const bodyText = typeof parsed.value.body === 'string' ? parsed.value.body : '';
        const now = trialNowIso();
        const comment: GitComment = {
          id: ctx.store.commentIdSeq++,
          body: bodyText,
          createdAt: now,
          updatedAt: now,
        };
        issue.comments.push(comment);
        sendJson(res, 201, commentJson(repo, issue, comment));
        return true;
      }
      return false;
    }
    return false;
  }

  // ---- pulls ----
  if (resource === 'pulls') {
    if (parts.length === 3) {
      if (method === 'GET') {
        const state = ctx.query.get('state') ?? 'open';
        let list = [...repo.pulls.values()];
        if (state === 'open') list = list.filter((p) => p.state === 'open');
        else if (state === 'closed') list = list.filter((p) => p.state === 'closed');
        list.sort((a, b) => a.number - b.number);
        const { perPage, page } = pageParams(ctx);
        setNextLink(req, res, ctx, page, perPage, list.length);
        sendJson(res, 200, paginate(list, perPage, page).map((p) => pullJson(repo, p)));
        return true;
      }
      if (method === 'POST') {
        const parsed = parseBody(ctx);
        if (!parsed.ok) {
          badJson(res, 'Problems parsing JSON');
          return true;
        }
        const body = parsed.value;
        const title = typeof body.title === 'string' ? body.title : '';
        const head = typeof body.head === 'string' ? body.head : '';
        const base = typeof body.base === 'string' ? body.base : '';
        if (title === '' || head === '' || base === '') {
          errJson(res, 422, 'Validation Failed: title, head and base are required');
          return true;
        }
        const created = createPullInRepo(ctx.store, repo, title, typeof body.body === 'string' ? body.body : '', head, base);
        if ('error' in created) {
          errJson(res, 422, `Validation Failed: ${created.error}`);
          return true;
        }
        sendJson(res, 201, pullJson(repo, created.pull));
        return true;
      }
      return false;
    }
    const num = Number(parts[3]);
    if (!Number.isInteger(num) || num < 1) {
      notFound(res, 'Not Found');
      return true;
    }
    const pull = repo.pulls.get(num);
    if (parts.length === 4) {
      if (method === 'GET') {
        if (pull === undefined) {
          notFound(res, 'Not Found');
          return true;
        }
        sendJson(res, 200, pullJson(repo, pull));
        return true;
      }
      return false;
    }
    if (parts.length === 5 && parts[4] === 'files') {
      if (method === 'GET') {
        if (pull === undefined) {
          notFound(res, 'Not Found');
          return true;
        }
        sendJson(res, 200, pullFiles(repo, pull));
        return true;
      }
      return false;
    }
    if (parts.length === 5 && parts[4] === 'merge') {
      if (method === 'PUT') {
        if (pull === undefined) {
          notFound(res, 'Not Found');
          return true;
        }
        // A body is optional for the merge call; a malformed one is still a 400.
        if (ctx.body.length > 0) {
          const parsed = parseBody(ctx);
          if (!parsed.ok) {
            badJson(res, 'Problems parsing JSON');
            return true;
          }
        }
        const merged = mergePullInRepo(repo, pull);
        if ('error' in merged) {
          if (merged.error === 'conflict') {
            errJson(res, 405, 'Pull request is not mergeable');
            return true;
          }
          errJson(res, 409, 'Pull request is already merged or closed');
          return true;
        }
        sendJson(res, 200, {
          sha: merged.sha,
          merged: true,
          message: `Pull request successfully merged`,
        });
        return true;
      }
      return false;
    }
    return false;
  }

  return false;
}
