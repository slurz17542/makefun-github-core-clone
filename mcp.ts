// MCP endpoint (POST /mcp) for the github-core-clone-01 entry.
// JSON-RPC 2.0 over Streamable HTTP. Speaks both eras:
//  - modern 2026-07-28: server/discover (supportedVersions, serverInfo, capabilities),
//    every request declares its revision in _meta; no handshake, no session.
//  - legacy 2025-11-25 and earlier: initialize + notifications/initialized, with an
//    optional Mcp-Session-Id (accepted; none is issued, so none is required).
// tools/list is built ONCE at module load and answered byte-for-byte identically.

import { VIEWER_LOGIN } from './store.ts';
import type { Store, Repo } from './store.ts';
import { sendJson, unauthorized } from './http.ts';
import type { ReqCtx } from './http.ts';
import {
  createIssueInRepo,
  createPullInRepo,
  mergePullInRepo,
  issueJson,
  pullJson,
} from './issues.ts';

// -------------------------------------------------------------------------------------------
// Tool definitions (built once; never mutated after load)

const SERVER_INFO = { name: 'github-core-clone', version: '1.0.0' };
const SUPPORTED_VERSIONS = ['2026-07-28', '2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];

const TOOLS: Record<string, unknown>[] = [
  {
    name: 'create_repo',
    description: 'Create a new repository owned by the authenticated user.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Name of the repository to create.' },
        description: { type: 'string', description: 'A short description of the repository.' },
        private: { type: 'boolean', description: 'Whether the repository is private.' },
      },
      required: ['name'],
    },
  },
  {
    name: 'get_repo',
    description: 'Get a repository by owner and name.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Owner login of the repository.' },
        repo: { type: 'string', description: 'Name of the repository.' },
        full_name: { type: 'string', description: 'Full name of the repository, "owner/repo".' },
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'create_issue',
    description: 'Create an issue in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Owner login of the repository.' },
        repo: { type: 'string', description: 'Name of the repository.' },
        full_name: { type: 'string', description: 'Full name of the repository, "owner/repo".' },
        title: { type: 'string', description: 'Title of the issue.' },
        body: { type: 'string', description: 'Body of the issue.' },
      },
      required: ['owner', 'repo', 'title'],
    },
  },
  {
    name: 'list_issues',
    description: 'List issues in a repository, optionally filtered by state.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Owner login of the repository.' },
        repo: { type: 'string', description: 'Name of the repository.' },
        full_name: { type: 'string', description: 'Full name of the repository, "owner/repo".' },
        state: { type: 'string', description: 'Issue state filter: open, closed, or all.' },
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'create_pull_request',
    description: 'Create a pull request from a head branch into a base branch.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Owner login of the repository.' },
        repo: { type: 'string', description: 'Name of the repository.' },
        full_name: { type: 'string', description: 'Full name of the repository, "owner/repo".' },
        title: { type: 'string', description: 'Title of the pull request.' },
        body: { type: 'string', description: 'Body of the pull request.' },
        head: { type: 'string', description: 'Name of the head branch.' },
        base: { type: 'string', description: 'Name of the base branch.' },
      },
      required: ['owner', 'repo', 'title', 'head', 'base'],
    },
  },
  {
    name: 'merge_pull_request',
    description: 'Merge a pull request with a squash merge.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Owner login of the repository.' },
        repo: { type: 'string', description: 'Name of the repository.' },
        full_name: { type: 'string', description: 'Full name of the repository, "owner/repo".' },
        pull_number: { type: 'integer', description: 'Number of the pull request to merge.' },
      },
      required: ['owner', 'repo', 'pull_number'],
    },
  },
];

const TOOL_NAMES = new Set(TOOLS.map((t) => String(t.name)));

// -------------------------------------------------------------------------------------------
// Argument helpers

type JsonObj = Record<string, unknown>;

function isObj(v: unknown): v is JsonObj {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

function pick(args: JsonObj, keys: string[]): unknown {
  for (const key of keys) {
    const v = args[key];
    if (v !== undefined && v !== null) return v;
  }
  return undefined;
}

function pickString(args: JsonObj, keys: string[]): string | undefined {
  const v = pick(args, keys);
  return typeof v === 'string' && v !== '' ? v : undefined;
}

/** Resolve owner/repo from owner+repo, full_name, or the documented synonyms. */
function resolveOwnerRepo(args: JsonObj): { owner: string; repo: string } | null {
  const full = pickString(args, ['full_name', 'repo_full_name', 'repository_full_name', 'fullName']);
  if (full !== undefined) {
    const slash = full.indexOf('/');
    if (slash > 0 && slash < full.length - 1) {
      return { owner: full.slice(0, slash), repo: full.slice(slash + 1) };
    }
  }
  const owner = pickString(args, ['owner', 'owner_login', 'org', 'organization', 'user', 'user_login', 'login', 'account', 'namespace', 'owner_name']);
  const repo = pickString(args, ['repo', 'repository', 'repository_name', 'repo_name', 'repo_slug', 'project', 'project_name']);
  if (owner !== undefined && repo !== undefined) return { owner, repo };
  return null;
}

function repoJson(repo: Repo): JsonObj {
  return {
    id: repo.id,
    name: repo.name,
    full_name: repo.fullName,
    owner: { login: repo.owner },
    description: repo.description,
    private: repo.private,
    default_branch: repo.defaultBranch,
    created_at: repo.createdAt,
    updated_at: repo.updatedAt,
    html_url: `https://example.invalid/${repo.fullName}`,
    url: `/api/v3/repos/${repo.fullName}`,
  };
}

function toolTextResult(value: unknown): JsonObj {
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  return { content: [{ type: 'text', text }], structuredContent: value };
}

function toolErrorResult(message: string): JsonObj {
  return { content: [{ type: 'text', text: message }], isError: true };
}

// -------------------------------------------------------------------------------------------
// Tool implementations (all act on the same store as REST)

function callCreateRepo(store: Store, args: JsonObj): JsonObj {
  const name = pickString(args, ['name', 'repo', 'repository', 'repository_name', 'repo_name']);
  if (name === undefined) return toolErrorResult('create_repo requires a name');
  const existing = store.getRepo(VIEWER_LOGIN, name);
  if (existing !== undefined) return toolTextResult(repoJson(existing));
  const description = pickString(args, ['description', 'about', 'summary', 'body']) ?? '';
  const isPrivate = pick(args, ['private', 'is_private']);
  const repo = store.createRepo(name, {
    description,
    private: typeof isPrivate === 'boolean' ? isPrivate : false,
  });
  return toolTextResult(repoJson(repo));
}

function callGetRepo(store: Store, args: JsonObj): JsonObj {
  const target = resolveOwnerRepo(args);
  if (target === null) return toolErrorResult('get_repo requires owner and repo');
  const repo = store.getRepo(target.owner, target.repo);
  if (repo === undefined) return toolErrorResult(`Repository not found: ${target.owner}/${target.repo}`);
  return toolTextResult(repoJson(repo));
}

function callCreateIssue(store: Store, args: JsonObj): JsonObj {
  const target = resolveOwnerRepo(args);
  if (target === null) return toolErrorResult('create_issue requires owner and repo');
  const title = pickString(args, ['title', 'issue_title', 'pr_title', 'pull_request_title', 'subject']);
  if (title === undefined) return toolErrorResult('create_issue requires a title');
  const body = pickString(args, ['body', 'issue_body', 'description', 'content', 'text', 'comment']) ?? '';
  const repo = store.getRepo(target.owner, target.repo);
  if (repo === undefined) return toolErrorResult(`Repository not found: ${target.owner}/${target.repo}`);
  const created = createIssueInRepo(store, repo, title, body, []);
  if ('error' in created) return toolErrorResult(created.error);
  return toolTextResult(issueJson(repo, created.issue));
}

function callListIssues(store: Store, args: JsonObj): JsonObj {
  const target = resolveOwnerRepo(args);
  if (target === null) return toolErrorResult('list_issues requires owner and repo');
  const repo = store.getRepo(target.owner, target.repo);
  if (repo === undefined) return toolErrorResult(`Repository not found: ${target.owner}/${target.repo}`);
  const state = pickString(args, ['state', 'status']);
  let list = [...repo.issues.values()];
  if (state === 'open') list = list.filter((i) => i.state === 'open');
  else if (state === 'closed') list = list.filter((i) => i.state === 'closed');
  list.sort((a, b) => a.number - b.number);
  return toolTextResult(list.map((issue) => issueJson(repo, issue)));
}

function callCreatePullRequest(store: Store, args: JsonObj): JsonObj {
  const target = resolveOwnerRepo(args);
  if (target === null) return toolErrorResult('create_pull_request requires owner and repo');
  const title = pickString(args, ['title', 'issue_title', 'pr_title', 'pull_request_title', 'subject']);
  const head = pickString(args, ['head', 'head_ref', 'head_branch', 'pull_request_head', 'pr_head', 'source', 'source_ref', 'source_branch', 'from', 'from_branch', 'branch']);
  const base = pickString(args, ['base', 'base_ref', 'base_branch', 'pull_request_base', 'pr_base', 'target', 'target_ref', 'target_branch', 'into', 'into_branch']);
  if (title === undefined || head === undefined || base === undefined) {
    return toolErrorResult('create_pull_request requires title, head and base');
  }
  const body = pickString(args, ['body', 'issue_body', 'description', 'content', 'text', 'comment']) ?? '';
  const repo = store.getRepo(target.owner, target.repo);
  if (repo === undefined) return toolErrorResult(`Repository not found: ${target.owner}/${target.repo}`);
  const created = createPullInRepo(store, repo, title, body, head, base);
  if ('error' in created) return toolErrorResult(created.error);
  return toolTextResult(pullJson(repo, created.pull));
}

function callMergePullRequest(store: Store, args: JsonObj): JsonObj {
  const target = resolveOwnerRepo(args);
  if (target === null) return toolErrorResult('merge_pull_request requires owner and repo');
  const rawNumber = pick(args, ['pull_number', 'pull_request_number', 'pr_number', 'number', 'issue_number', 'index']);
  const number = typeof rawNumber === 'number' ? rawNumber : typeof rawNumber === 'string' && /^\d+$/.test(rawNumber) ? Number(rawNumber) : NaN;
  if (!Number.isInteger(number) || number < 1) return toolErrorResult('merge_pull_request requires pull_number');
  const repo = store.getRepo(target.owner, target.repo);
  if (repo === undefined) return toolErrorResult(`Repository not found: ${target.owner}/${target.repo}`);
  const pull = repo.pulls.get(number);
  if (pull === undefined) return toolErrorResult(`Pull request not found: #${number}`);
  const merged = mergePullInRepo(repo, pull);
  if ('error' in merged) {
    return toolErrorResult(merged.error === 'conflict' ? 'Pull request is not mergeable' : 'Pull request is already merged or closed');
  }
  return toolTextResult({ sha: merged.sha, merged: true, message: 'Pull request successfully merged', number, state: 'closed' });
}

const REQUIRED_ARGS: Record<string, string[]> = {
  create_repo: ['name'],
  get_repo: ['owner', 'repo'],
  create_issue: ['owner', 'repo', 'title'],
  list_issues: ['owner', 'repo'],
  create_pull_request: ['owner', 'repo', 'title', 'head', 'base'],
  merge_pull_request: ['owner', 'repo', 'pull_number'],
};

/** Check the required arguments are present (after full_name / synonym resolution). */
function missingRequired(name: string, args: JsonObj): string[] {
  const required = REQUIRED_ARGS[name] ?? [];
  const missing: string[] = [];
  const target = resolveOwnerRepo(args);
  for (const key of required) {
    if (key === 'owner' || key === 'repo') {
      if (target === null) {
        if (!missing.includes('owner')) missing.push('owner');
        if (!missing.includes('repo')) missing.push('repo');
      }
      continue;
    }
    if (key === 'title' && pickString(args, ['title', 'issue_title', 'pr_title', 'pull_request_title', 'subject']) === undefined) missing.push('title');
    else if (key === 'name' && pickString(args, ['name', 'repo', 'repository', 'repository_name', 'repo_name']) === undefined) missing.push('name');
    else if (key === 'head' && pickString(args, ['head', 'head_ref', 'head_branch', 'pull_request_head', 'pr_head', 'source', 'source_ref', 'source_branch', 'from', 'from_branch', 'branch']) === undefined) missing.push('head');
    else if (key === 'base' && pickString(args, ['base', 'base_ref', 'base_branch', 'pull_request_base', 'pr_base', 'target', 'target_ref', 'target_branch', 'into', 'into_branch']) === undefined) missing.push('base');
    else if (key === 'pull_number' && pick(args, ['pull_number', 'pull_request_number', 'pr_number', 'number', 'issue_number', 'index']) === undefined) missing.push('pull_number');
  }
  return [...new Set(missing)];
}

function callTool(store: Store, name: string, args: JsonObj): JsonObj {
  switch (name) {
    case 'create_repo':
      return callCreateRepo(store, args);
    case 'get_repo':
      return callGetRepo(store, args);
    case 'create_issue':
      return callCreateIssue(store, args);
    case 'list_issues':
      return callListIssues(store, args);
    case 'create_pull_request':
      return callCreatePullRequest(store, args);
    case 'merge_pull_request':
      return callMergePullRequest(store, args);
    default:
      return toolErrorResult(`Unknown tool: ${name}`);
  }
}

// -------------------------------------------------------------------------------------------
// Handler

function rpcResult(res: any, id: unknown, result: unknown): void {
  sendJson(res, 200, { jsonrpc: '2.0', id: id ?? null, result });
}

function rpcError(res: any, status: number, id: unknown, code: number, message: string): void {
  sendJson(res, status, { jsonrpc: '2.0', id: id ?? null, error: { code, message } });
}

export async function handleMcp(req: any, res: any, ctx: ReqCtx): Promise<boolean> {
  const method = String(req?.method ?? 'GET').toUpperCase();
  let pathname = '';
  try {
    pathname = new URL(String(req?.url ?? '/'), 'http://localhost').pathname;
  } catch {
    return false;
  }
  if (pathname !== '/mcp') return false;
  if (method === 'DELETE') {
    // Legacy session close: best-effort, no session is ever issued.
    sendJson(res, 200, {});
    return true;
  }
  if (method !== 'POST') return false;
  if (ctx.token === '') {
    unauthorized(res);
    return true;
  }
  let body: unknown;
  try {
    body = ctx.body.length === 0 ? null : JSON.parse(ctx.body.toString('utf8'));
  } catch {
    rpcError(res, 400, null, -32700, 'Parse error');
    return true;
  }
  if (!isObj(body) || Array.isArray(body)) {
    rpcError(res, 400, null, -32700, 'Parse error');
    return true;
  }
  const id = 'id' in body ? body.id : null;
  const rpcMethod = typeof body.method === 'string' ? body.method : '';
  const params = isObj(body.params) ? body.params : {};

  // Notifications carry no id: acknowledge with 202 and no result.
  if (id === undefined || id === null) {
    if (rpcMethod === 'notifications/initialized' || rpcMethod.startsWith('notifications/')) {
      sendJson(res, 202, {});
      return true;
    }
    rpcError(res, 400, null, -32600, 'Invalid Request');
    return true;
  }

  if (rpcMethod === 'server/discover') {
    rpcResult(res, id, {
      serverInfo: SERVER_INFO,
      capabilities: { tools: {} },
      supportedVersions: SUPPORTED_VERSIONS,
      _meta: { 'io.modelcontextprotocol/serverInfo': SERVER_INFO },
    });
    return true;
  }
  if (rpcMethod === 'initialize') {
    const requested = typeof params.protocolVersion === 'string' ? params.protocolVersion : '';
    rpcResult(res, id, {
      protocolVersion: requested !== '' ? requested : SUPPORTED_VERSIONS[0],
      capabilities: { tools: {} },
      serverInfo: SERVER_INFO,
    });
    return true;
  }
  if (rpcMethod === 'ping') {
    rpcResult(res, id, {});
    return true;
  }
  if (rpcMethod === 'tools/list') {
    rpcResult(res, id, { tools: TOOLS });
    return true;
  }
  if (rpcMethod === 'tools/call') {
    const name = typeof params.name === 'string' ? params.name : '';
    const args = isObj(params.arguments) ? params.arguments : {};
    if (!TOOL_NAMES.has(name)) {
      rpcError(res, 200, id, -32601, `Method not found: ${name}`);
      return true;
    }
    const missing = missingRequired(name, args);
    if (missing.length > 0) {
      rpcError(res, 200, id, -32602, `Invalid params: missing required argument(s): ${missing.join(', ')}`);
      return true;
    }
    const result = callTool(ctx.store, name, args);
    rpcResult(res, id, result);
    return true;
  }
  rpcError(res, 200, id, -32601, `Method not found: ${rpcMethod}`);
  return true;
}
