// REST v3 for the github-core-clone-01 forge: repositories, branches, commits,
// git refs and file contents.
//
// handleRest(req, res, ctx) answers the routes in its scope and returns true;
// it returns false for routes outside its scope so the router can answer the
// JSON 404. Issues, pull requests and labels live in issues.ts, not here.
//
// Every timestamp comes from trialNowIso(); every id is deterministic (repo
// ids from the store's sequence). Commit messages are stored with a trailing
// newline (see store.makeCommit) and presented without it, so a commit created
// through PUT /contents reads back with exactly the message it was given.

import type { IncomingMessage, ServerResponse } from 'node:http';
import {
  VIEWER_EMAIL,
  VIEWER_ID,
  VIEWER_LOGIN,
  VIEWER_NAME,
  makeCommit,
  makeTree,
  parseCommit,
  parseTree,
  putObject,
  resolveRef,
  trialNowIso,
  type Repo,
} from './store.ts';
import { badJson, notFound, sendJson, type ReqCtx } from './http.ts';

type JsonObject = Record<string, unknown>;

/** The path of a request URL, split into decoded segments. */
function segmentsOf(req: IncomingMessage): string[] {
  let pathname = '/';
  try {
    pathname = new URL(req.url ?? '/', 'http://entry').pathname;
  } catch {
    pathname = '/';
  }
  return pathname
    .split('/')
    .filter((part) => part !== '')
    .map((part) => {
      try {
        return decodeURIComponent(part);
      } catch {
        return part;
      }
    });
}

/** The request's own origin, for absolute URLs in repo objects and Link headers. */
function originOf(req: IncomingMessage): string {
  const host = req.headers.host;
  if (typeof host === 'string' && host !== '') return `http://${host}`;
  return 'http://localhost';
}

/** Parse ctx.body as a JSON object; on malformed JSON answer 400 and return null. */
function parseBody(req: IncomingMessage, res: ServerResponse, ctx: ReqCtx): JsonObject | null {
  if (ctx.body.length === 0) return {};
  let value: unknown;
  try {
    value = JSON.parse(ctx.body.toString('utf8')) as unknown;
  } catch {
    badJson(res, 'Invalid JSON');
    return null;
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    badJson(res, 'Invalid JSON');
    return null;
  }
  return value as JsonObject;
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function asBoolean(value: unknown): boolean | undefined {
  return typeof value === 'boolean' ? value : undefined;
}

/** The repository object as REST presents it. */
function repoJson(req: IncomingMessage, repo: Repo): JsonObject {
  const origin = originOf(req);
  return {
    id: repo.id,
    name: repo.name,
    full_name: repo.fullName,
    owner: { login: repo.owner, id: VIEWER_ID, type: 'User' },
    private: repo.private,
    description: repo.description,
    default_branch: repo.defaultBranch,
    created_at: repo.createdAt,
    updated_at: repo.updatedAt,
    html_url: `${origin}/${repo.fullName}`,
    url: `${origin}/api/v3/repos/${repo.fullName}`,
    git_url: `git://${origin.replace(/^https?:\/\//, '')}/${repo.fullName}.git`,
    clone_url: `${origin}/${repo.fullName}.git`,
    ssh_url: `git@example.invalid:${repo.fullName}.git`,
    homepage: '',
    fork: false,
    has_issues: true,
    has_projects: true,
    has_downloads: true,
    has_wiki: true,
    has_pages: false,
    archived: false,
    disabled: false,
    visibility: repo.private ? 'private' : 'public',
  };
}

function viewerJson(): JsonObject {
  return {
    login: VIEWER_LOGIN,
    id: VIEWER_ID,
    name: VIEWER_NAME,
    email: VIEWER_EMAIL,
    type: 'User',
  };
}

/** One commit as REST presents it, with the stored message's trailing newline trimmed. */
function commitJson(req: IncomingMessage, repo: Repo, sha: string): JsonObject | null {
  const obj = repo.objects.get(sha);
  if (obj === undefined || obj.type !== 'commit') return null;
  const parsed = parseCommit(obj.data);
  const date = new Date(parsed.authorEpoch * 1000).toISOString();
  const message = parsed.message.replace(/\n+$/, '');
  const origin = originOf(req);
  const person = { name: VIEWER_NAME, email: VIEWER_EMAIL, date };
  return {
    sha,
    commit: {
      message,
      author: person,
      committer: person,
      tree: { sha: parsed.tree },
    },
    author: { login: VIEWER_LOGIN, id: VIEWER_ID, type: 'User' },
    committer: { login: VIEWER_LOGIN, id: VIEWER_ID, type: 'User' },
    parents: parsed.parents.map((parent) => ({ sha: parent })),
    url: `${origin}/api/v3/repos/${repo.fullName}/commits/${sha}`,
    html_url: `${origin}/${repo.fullName}/commit/${sha}`,
  };
}

/** Walk parents from a tip, newest first (pre-order depth-first, each commit once). */
function walkCommits(repo: Repo, tip: string): string[] {
  const order: string[] = [];
  const seen = new Set<string>();
  const stack: string[] = [tip];
  while (stack.length > 0) {
    const sha = stack.pop() as string;
    if (seen.has(sha)) continue;
    seen.add(sha);
    const obj = repo.objects.get(sha);
    if (obj === undefined || obj.type !== 'commit') continue;
    order.push(sha);
    const parents = parseCommit(obj.data).parents;
    for (let index = parents.length - 1; index >= 0; index -= 1) {
      stack.push(parents[index] as string);
    }
  }
  return order;
}

/** Resolve a ref parameter (branch name, full ref or commit sha) to a commit sha. */
function resolveTip(repo: Repo, ref: string | null): string | undefined {
  if (ref === null || ref === '') return resolveRef(repo, 'HEAD');
  const obj = repo.objects.get(ref);
  if (obj !== undefined && obj.type === 'commit') return ref;
  return resolveRef(repo, ref);
}

/** Flatten a tree into path -> blob sha, walking subtrees. */
function flattenTree(repo: Repo, treeSha: string, prefix: string, out: Map<string, string>): void {
  const obj = repo.objects.get(treeSha);
  if (obj === undefined || obj.type !== 'tree') return;
  for (const entry of parseTree(obj.data)) {
    const path = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
    const child = repo.objects.get(entry.sha);
    if (child !== undefined && child.type === 'tree') {
      flattenTree(repo, entry.sha, path, out);
    } else if (child !== undefined && child.type === 'blob') {
      out.set(path, entry.sha);
    }
  }
}

/**
 * Rebuild a whole tree from a flat path -> blob sha map, creating intermediate
 * trees bottom-up. Files keep the other files already in the tree.
 */
function buildTree(repo: Repo, files: Map<string, string>): string {
  const build = (prefix: string): string => {
    const entries: { mode: string; name: string; sha: string }[] = [];
    const dirs = new Map<string, Map<string, string>>();
    for (const [path, sha] of files) {
      if (prefix !== '' && !path.startsWith(`${prefix}/`)) continue;
      const rest = prefix === '' ? path : path.slice(prefix.length + 1);
      const slash = rest.indexOf('/');
      if (slash === -1) {
        entries.push({ mode: '100644', name: rest, sha });
      } else {
        const dir = rest.slice(0, slash);
        let sub = dirs.get(dir);
        if (sub === undefined) {
          sub = new Map<string, string>();
          dirs.set(dir, sub);
        }
        sub.set(path, sha);
      }
    }
    for (const [dir] of dirs) {
      entries.push({ mode: '040000', name: dir, sha: build(prefix === '' ? dir : `${prefix}/${dir}`) });
    }
    return makeTree(repo, entries);
  };
  return build('');
}

/** Look one path up in a tree: the entry at `parts`, or undefined when absent. */
function lookupPath(repo: Repo, treeSha: string, parts: string[]): { type: string; sha: string } | undefined {
  let current = treeSha;
  for (let index = 0; index < parts.length; index += 1) {
    const obj = repo.objects.get(current);
    if (obj === undefined || obj.type !== 'tree') return undefined;
    const entry = parseTree(obj.data).find((item) => item.name === parts[index]);
    if (entry === undefined) return undefined;
    if (index === parts.length - 1) {
      const child = repo.objects.get(entry.sha);
      return { type: child?.type ?? 'blob', sha: entry.sha };
    }
    current = entry.sha;
  }
  return undefined;
}

/** The entries of the tree at `parts` (or the root tree when parts is empty). */
function listDirectory(repo: Repo, treeSha: string, parts: string[]): { name: string; path: string; sha: string; size: number; type: string }[] | null {
  let current = treeSha;
  for (const part of parts) {
    const obj = repo.objects.get(current);
    if (obj === undefined || obj.type !== 'tree') return null;
    const entry = parseTree(obj.data).find((item) => item.name === part);
    if (entry === undefined) return null;
    current = entry.sha;
  }
  const obj = repo.objects.get(current);
  if (obj === undefined || obj.type !== 'tree') return null;
  const prefix = parts.join('/');
  return parseTree(obj.data).map((entry) => {
    const child = repo.objects.get(entry.sha);
    const isTree = child !== undefined && child.type === 'tree';
    return {
      name: entry.name,
      path: prefix === '' ? entry.name : `${prefix}/${entry.name}`,
      sha: entry.sha,
      size: isTree ? 0 : (child?.data.length ?? 0),
      type: isTree ? 'dir' : 'file',
    };
  });
}

function refJson(ref: string, sha: string, type: string): JsonObject {
  return { ref, object: { sha, type } };
}

/** Find a repository the viewer owns; anything else is a 404, never a 403. */
function findRepo(ctx: ReqCtx, owner: string, name: string): Repo | undefined {
  if (owner !== VIEWER_LOGIN) return undefined;
  return ctx.store.getRepo(owner, name);
}

export async function handleRest(req: IncomingMessage, res: ServerResponse, ctx: ReqCtx): Promise<boolean> {
  const method = req.method ?? 'GET';
  const segments = segmentsOf(req);

  try {
    // GET /api/v3/ — the API root.
    if (method === 'GET' && segments.length === 2 && segments[0] === 'api' && segments[1] === 'v3') {
      sendJson(res, 200, { current_user_url: '/api/v3/user', rate_limit_url: '/api/v3/rate_limit' }, { 'x-oauth-scopes': 'repo, read:org' });
      return true;
    }

    // GET /api/v3/meta
    if (method === 'GET' && segments.length === 3 && segments[0] === 'api' && segments[1] === 'v3' && segments[2] === 'meta') {
      sendJson(res, 200, { installed_version: '1.0.0' });
      return true;
    }

    // GET /api/v3/user
    if (method === 'GET' && segments.length === 3 && segments[0] === 'api' && segments[1] === 'v3' && segments[2] === 'user') {
      sendJson(res, 200, viewerJson());
      return true;
    }

    // POST /api/v3/user/repos — create a repository for the viewer.
    if (segments.length === 4 && segments[0] === 'api' && segments[1] === 'v3' && segments[2] === 'user' && segments[3] === 'repos') {
      if (method === 'POST') {
        const body = parseBody(req, res, ctx);
        if (body === null) return true;
        const name = asString(body.name);
        if (name === undefined || name === '' || name.includes('/') || name === '.' || name === '..') {
          sendJson(res, 422, { message: 'Validation Failed: name is required' });
          return true;
        }
        if (ctx.store.getRepo(VIEWER_LOGIN, name) !== undefined) {
          sendJson(res, 422, { message: 'Repository already exists' });
          return true;
        }
        const repo = ctx.store.createRepo(name, {
          description: asString(body.description) ?? '',
          private: asBoolean(body.private) ?? false,
        });
        sendJson(res, 201, repoJson(req, repo));
        return true;
      }
      // GET /api/v3/user/repos — the viewer's repositories, paginated.
      if (method === 'GET') {
        const perPageRaw = Number(ctx.query.get('per_page') ?? '30');
        const perPage = Number.isFinite(perPageRaw) && perPageRaw > 0 ? Math.min(Math.floor(perPageRaw), 100) : 30;
        const pageRaw = Number(ctx.query.get('page') ?? '1');
        const page = Number.isFinite(pageRaw) && pageRaw > 0 ? Math.floor(pageRaw) : 1;
        const all = [...ctx.store.repos.values()].filter((repo) => repo.owner === VIEWER_LOGIN);
        const slice = all.slice((page - 1) * perPage, page * perPage);
        const headers: Record<string, string> = {};
        if (page * perPage < all.length) {
          const next = `${originOf(req)}/api/v3/user/repos?per_page=${perPage}&page=${page + 1}`;
          headers.link = `<${next}>; rel="next"`;
        }
        sendJson(res, 200, slice.map((repo) => repoJson(req, repo)), headers);
        return true;
      }
      return false;
    }

    // Everything below is /api/v3/repos/{owner}/{repo}[...].
    if (segments.length < 5 || segments[0] !== 'api' || segments[1] !== 'v3' || segments[2] !== 'repos') return false;
    const owner = segments[3] as string;
    const repoName = segments[4] as string;
    const repo = findRepo(ctx, owner, repoName);
    if (repo === undefined) {
      // A missing repository (or another owner's name) is a 404 for this token.
      if (
        (method === 'GET' || method === 'PATCH' || method === 'DELETE' || method === 'PUT' || method === 'POST') &&
        (segments.length === 5 ||
          segments[5] === 'branches' ||
          segments[5] === 'commits' ||
          segments[5] === 'git' ||
          segments[5] === 'contents')
      ) {
        notFound(res);
        return true;
      }
      return false;
    }
    const rest = segments.slice(5);

    // GET/PATCH/DELETE /api/v3/repos/{o}/{r}
    if (rest.length === 0) {
      if (method === 'GET') {
        sendJson(res, 200, repoJson(req, repo));
        return true;
      }
      if (method === 'PATCH') {
        const body = parseBody(req, res, ctx);
        if (body === null) return true;
        const description = asString(body.description);
        if (description !== undefined) repo.description = description;
        repo.updatedAt = trialNowIso();
        sendJson(res, 200, repoJson(req, repo));
        return true;
      }
      if (method === 'DELETE') {
        ctx.store.deleteRepo(owner, repoName);
        res.writeHead(204, { 'content-type': 'application/json; charset=utf-8', 'content-length': '0' });
        res.end();
        return true;
      }
      return false;
    }

    // GET /api/v3/repos/{o}/{r}/branches and /branches/{branch}
    if (rest[0] === 'branches' && method === 'GET') {
      if (rest.length === 1) {
        const branches = [...repo.refs.entries()]
          .filter(([ref]) => ref.startsWith('refs/heads/'))
          .map(([ref, sha]) => ({ name: ref.slice('refs/heads/'.length), commit: { sha, url: `${originOf(req)}/api/v3/repos/${repo.fullName}/commits/${sha}` } }))
          .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
        sendJson(res, 200, branches);
        return true;
      }
      const branch = rest.slice(1).join('/');
      const sha = repo.refs.get(`refs/heads/${branch}`);
      if (sha === undefined) {
        notFound(res);
        return true;
      }
      sendJson(res, 200, { name: branch, commit: { sha, url: `${originOf(req)}/api/v3/repos/${repo.fullName}/commits/${sha}` } });
      return true;
    }

    // GET /api/v3/repos/{o}/{r}/commits and /commits/{sha}
    if (rest[0] === 'commits' && method === 'GET') {
      if (rest.length === 1) {
        const tip = resolveTip(repo, ctx.query.get('sha'));
        if (tip === undefined) {
          notFound(res);
          return true;
        }
        const commits = walkCommits(repo, tip)
          .map((sha) => commitJson(req, repo, sha))
          .filter((item): item is JsonObject => item !== null);
        sendJson(res, 200, commits);
        return true;
      }
      const sha = rest.slice(1).join('/');
      const one = commitJson(req, repo, sha);
      if (one === null) {
        notFound(res);
        return true;
      }
      sendJson(res, 200, one);
      return true;
    }

    // POST/GET /api/v3/repos/{o}/{r}/git/refs and GET .../git/refs/heads/{branch}
    if (rest[0] === 'git' && rest[1] === 'refs') {
      if (method === 'POST' && rest.length === 2) {
        const body = parseBody(req, res, ctx);
        if (body === null) return true;
        const ref = asString(body.ref);
        const sha = asString(body.sha);
        if (ref === undefined || !ref.startsWith('refs/') || sha === undefined || !/^[0-9a-f]{40}$/i.test(sha)) {
          sendJson(res, 422, { message: 'Validation Failed' });
          return true;
        }
        if (repo.refs.has(ref) || repo.objects.get(sha) === undefined) {
          sendJson(res, 422, { message: 'Validation Failed: ref already exists or sha is unknown' });
          return true;
        }
        repo.refs.set(ref, sha);
        repo.updatedAt = trialNowIso();
        const obj = repo.objects.get(sha);
        sendJson(res, 201, refJson(ref, sha, obj?.type ?? 'commit'));
        return true;
      }
      if (method === 'GET' && rest.length === 2) {
        const refs = [...repo.refs.entries()]
          .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
          .map(([ref, sha]) => refJson(ref, sha, repo.objects.get(sha)?.type ?? 'commit'));
        sendJson(res, 200, refs);
        return true;
      }
      if (method === 'GET' && rest.length >= 4 && rest[2] === 'heads') {
        const branch = rest.slice(3).join('/');
        const ref = `refs/heads/${branch}`;
        const sha = repo.refs.get(ref);
        if (sha === undefined) {
          notFound(res);
          return true;
        }
        sendJson(res, 200, refJson(ref, sha, 'commit'));
        return true;
      }
      return false;
    }

    // PUT/GET/DELETE /api/v3/repos/{o}/{r}/contents[/{path}]
    if (rest[0] === 'contents') {
      const parts = rest.slice(1);
      const path = parts.join('/');
      if (method === 'PUT') {
        const body = parseBody(req, res, ctx);
        if (body === null) return true;
        const contentB64 = asString(body.content);
        if (contentB64 === undefined) {
          sendJson(res, 422, { message: 'Validation Failed: content is required' });
          return true;
        }
        const branch = asString(body.branch) ?? repo.defaultBranch;
        const tip = resolveRef(repo, branch);
        const isUnborn = tip === undefined && repo.refs.size === 0 && branch === repo.defaultBranch;
        if (tip === undefined && !isUnborn) {
          notFound(res);
          return true;
        }
        const message = asString(body.message) ?? `Update ${path}`;
        const files = new Map<string, string>();
        if (tip !== undefined) {
          const tipObj = repo.objects.get(tip);
          if (tipObj !== undefined && tipObj.type === 'commit') flattenTree(repo, parseCommit(tipObj.data).tree, '', files);
        }
        const currentSha = files.get(path);
        const isUpdate = currentSha !== undefined;
        if (isUpdate && asString(body.sha) !== currentSha) {
          sendJson(res, 409, { message: 'Conflict: sha does not match the current blob' });
          return true;
        }
        const bytes = Buffer.from(contentB64, 'base64');
        const blobSha = putObject(repo, 'blob', bytes);
        files.set(path, blobSha);
        const treeSha = buildTree(repo, files);
        const commitSha = makeCommit(repo, { tree: treeSha, parents: tip === undefined ? [] : [tip], message });
        repo.refs.set(`refs/heads/${branch}`, commitSha);
        repo.updatedAt = trialNowIso();
        const name = parts[parts.length - 1] ?? '';
        sendJson(res, isUpdate ? 200 : 201, {
          content: { name, path, sha: blobSha, size: bytes.length, encoding: 'base64' },
          commit: { sha: commitSha, message: message.replace(/\n+$/, '') },
        });
        return true;
      }
      if (method === 'GET') {
        const tip = resolveTip(repo, ctx.query.get('ref'));
        if (tip === undefined) {
          notFound(res);
          return true;
        }
        const tipObj = repo.objects.get(tip);
        if (tipObj === undefined || tipObj.type !== 'commit') {
          notFound(res);
          return true;
        }
        const treeSha = parseCommit(tipObj.data).tree;
        if (parts.length === 0) {
          const entries = listDirectory(repo, treeSha, []);
          if (entries === null) {
            notFound(res);
            return true;
          }
          sendJson(res, 200, entries);
          return true;
        }
        const found = lookupPath(repo, treeSha, parts);
        if (found === undefined) {
          notFound(res);
          return true;
        }
        if (found.type === 'tree') {
          const entries = listDirectory(repo, treeSha, parts);
          if (entries === null) {
            notFound(res);
            return true;
          }
          sendJson(res, 200, entries);
          return true;
        }
        const blob = repo.objects.get(found.sha);
        if (blob === undefined || blob.type !== 'blob') {
          notFound(res);
          return true;
        }
        sendJson(res, 200, {
          type: 'file',
          name: parts[parts.length - 1] ?? '',
          path,
          sha: found.sha,
          size: blob.data.length,
          content: blob.data.toString('base64'),
          encoding: 'base64',
        });
        return true;
      }
      if (method === 'DELETE') {
        const body = parseBody(req, res, ctx);
        if (body === null) return true;
        const branch = asString(body.branch) ?? repo.defaultBranch;
        const tip = resolveRef(repo, branch);
        if (tip === undefined) {
          notFound(res);
          return true;
        }
        const tipObj = repo.objects.get(tip);
        if (tipObj === undefined || tipObj.type !== 'commit') {
          notFound(res);
          return true;
        }
        const files = new Map<string, string>();
        flattenTree(repo, parseCommit(tipObj.data).tree, '', files);
        const currentSha = files.get(path);
        if (currentSha === undefined) {
          notFound(res);
          return true;
        }
        if (asString(body.sha) !== currentSha) {
          sendJson(res, 409, { message: 'Conflict: sha does not match the current blob' });
          return true;
        }
        const message = asString(body.message) ?? `Delete ${path}`;
        files.delete(path);
        const treeSha = buildTree(repo, files);
        const commitSha = makeCommit(repo, { tree: treeSha, parents: [tip], message });
        repo.refs.set(`refs/heads/${branch}`, commitSha);
        repo.updatedAt = trialNowIso();
        sendJson(res, 200, { commit: { sha: commitSha, message: message.replace(/\n+$/, '') } });
        return true;
      }
      return false;
    }

    return false;
  } catch {
    if (!res.writableEnded) sendJson(res, 500, { message: 'Internal Server Error' });
    return true;
  }
}
