// Shared in-memory store for the github-core-clone-01 forge.
//
// One Store instance (`store`) is shared by every surface (REST, git smart HTTP,
// GraphQL, MCP), so a repository or issue created through one surface reads back
// through the others with the same ids. All timestamps come from the trial clock
// (MAKEFUN_TRIAL_NOW), never from the wall clock, so two runs on the same trial
// leave byte-identical state.

import { createHash } from 'node:crypto';

export const VIEWER_LOGIN = 'adaiversen';
export const VIEWER_ID = 1000;
export const VIEWER_NAME = 'ada iversen';
export const VIEWER_EMAIL = 'adaiversen@example.invalid';
export const STRANGER_LOGIN = 'olgabauer';

/** The trial's "now" as an ISO string; the fixed fallback is the competition opening. */
export function trialNowIso(): string {
  const value = process.env.MAKEFUN_TRIAL_NOW;
  if (value !== undefined && value !== '') return value;
  return '2026-11-14T06:30:00.000Z';
}

/** The trial's "now" as seconds since the epoch. */
export function trialNowEpoch(): number {
  return Math.floor(Date.parse(trialNowIso()) / 1000);
}

export type ObjType = 'blob' | 'tree' | 'commit' | 'tag';

export interface GitObj {
  type: ObjType;
  data: Buffer;
}

export interface GitComment {
  id: number;
  body: string;
  createdAt: string;
  updatedAt: string;
}

export interface Issue {
  id: number;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  labels: string[];
  comments: GitComment[];
  createdAt: string;
  updatedAt: string;
}

export interface Pull {
  id: number;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  merged: boolean;
  head: string;
  base: string;
  headSha: string;
  baseSha: string;
  mergeable: boolean;
  createdAt: string;
  updatedAt: string;
  mergedAt: string | null;
}

export interface Label {
  name: string;
  color: string;
  description: string;
}

export interface Repo {
  id: number;
  owner: string;
  name: string;
  fullName: string;
  description: string;
  private: boolean;
  defaultBranch: string;
  createdAt: string;
  updatedAt: string;
  refs: Map<string, string>;
  objects: Map<string, GitObj>;
  issues: Map<number, Issue>;
  issueSeq: number;
  labels: Map<string, Label>;
  pulls: Map<number, Pull>;
  pullSeq: number;
}

export class Store {
  repos: Map<string, Repo>;
  repoIdSeq: number;
  issueIdSeq: number;
  pullIdSeq: number;
  commentIdSeq: number;

  constructor() {
    this.repos = new Map<string, Repo>();
    this.repoIdSeq = 5000;
    this.issueIdSeq = 1;
    this.pullIdSeq = 1;
    this.commentIdSeq = 1;
  }

  getRepo(owner: string, name: string): Repo | undefined {
    return this.repos.get(`${owner}/${name}`);
  }

  createRepo(name: string, opts?: { description?: string; private?: boolean }): Repo {
    const now = trialNowIso();
    const repo: Repo = {
      id: this.repoIdSeq,
      owner: VIEWER_LOGIN,
      name,
      fullName: `${VIEWER_LOGIN}/${name}`,
      description: opts?.description ?? '',
      private: opts?.private ?? false,
      defaultBranch: 'main',
      createdAt: now,
      updatedAt: now,
      refs: new Map<string, string>(),
      objects: new Map<string, GitObj>(),
      issues: new Map<number, Issue>(),
      issueSeq: 0,
      labels: new Map<string, Label>(),
      pulls: new Map<number, Pull>(),
      pullSeq: 0,
    };
    this.repoIdSeq += 1;
    this.repos.set(repo.fullName, repo);
    return repo;
  }

  deleteRepo(owner: string, name: string): boolean {
    return this.repos.delete(`${owner}/${name}`);
  }
}

/** The single shared instance every surface imports. */
export const store: Store = new Store();

/** Git object id: SHA-1 of `<type> <byte length>\0` followed by the raw data. */
export function hashObject(type: ObjType, data: Buffer): string {
  const header = Buffer.from(`${type} ${data.length}\0`, 'utf8');
  return createHash('sha1').update(header).update(data).digest('hex');
}

/** Hash an object, store it in the repository, and return its sha. */
export function putObject(repo: Repo, type: ObjType, data: Buffer): string {
  const sha = hashObject(type, data);
  repo.objects.set(sha, { type, data });
  return sha;
}

/**
 * Build a tree object from entries, sorted by name in git tree order, and store it.
 * Each entry is encoded as `<mode> <name>\0` followed by the 20 raw sha bytes.
 */
export function makeTree(repo: Repo, entries: { mode: string; name: string; sha: string }[]): string {
  const sorted = [...entries].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  const parts: Buffer[] = [];
  for (const entry of sorted) {
    parts.push(Buffer.from(`${entry.mode} ${entry.name}\0`, 'utf8'));
    parts.push(Buffer.from(entry.sha, 'hex'));
  }
  return putObject(repo, 'tree', Buffer.concat(parts));
}

/**
 * Build a commit object and store it. The stored message always ends with a
 * newline; callers that present the message (REST/GraphQL) trim it back off.
 */
export function makeCommit(repo: Repo, opts: { tree: string; parents: string[]; message: string; epoch?: number }): string {
  const epoch = opts.epoch ?? trialNowEpoch();
  const message = opts.message.endsWith('\n') ? opts.message : `${opts.message}\n`;
  let text = `tree ${opts.tree}\n`;
  for (const parent of opts.parents) text += `parent ${parent}\n`;
  text += `author ${VIEWER_NAME} <${VIEWER_EMAIL}> ${epoch} +0000\n`;
  text += `committer ${VIEWER_NAME} <${VIEWER_EMAIL}> ${epoch} +0000\n`;
  text += `\n${message}`;
  return putObject(repo, 'commit', Buffer.from(text, 'utf8'));
}

/**
 * Resolve a ref to a commit sha. A full ref name looks itself up; 'HEAD' follows
 * the default branch; a bare name is a branch under refs/heads/.
 */
export function resolveRef(repo: Repo, ref: string): string | undefined {
  const direct = repo.refs.get(ref);
  if (direct !== undefined) return direct;
  if (ref === 'HEAD') return repo.refs.get(`refs/heads/${repo.defaultBranch}`);
  return repo.refs.get(`refs/heads/${ref}`);
}

/** True when `ancestor` is `sha` itself or reachable from it through parents. */
export function isAncestor(repo: Repo, ancestor: string, sha: string): boolean {
  const seen = new Set<string>();
  const stack: string[] = [sha];
  while (stack.length > 0) {
    const current = stack.pop() as string;
    if (current === ancestor) return true;
    if (seen.has(current)) continue;
    seen.add(current);
    const obj = repo.objects.get(current);
    if (obj === undefined || obj.type !== 'commit') continue;
    for (const parent of parseCommit(obj.data).parents) stack.push(parent);
  }
  return false;
}

/**
 * Every object reachable from the tip commits: the commits themselves, their
 * trees (recursively) and the blobs those trees name.
 */
export function collectReachable(repo: Repo, tips: string[]): Set<string> {
  const reachable = new Set<string>();
  const stack: string[] = [...tips];
  while (stack.length > 0) {
    const sha = stack.pop() as string;
    if (reachable.has(sha)) continue;
    const obj = repo.objects.get(sha);
    if (obj === undefined) continue;
    reachable.add(sha);
    if (obj.type === 'commit') {
      const commit = parseCommit(obj.data);
      stack.push(commit.tree);
      for (const parent of commit.parents) stack.push(parent);
    } else if (obj.type === 'tree') {
      for (const entry of parseTree(obj.data)) stack.push(entry.sha);
    }
  }
  return reachable;
}

/** Parse a raw tree object into its entries, in stored order. */
export function parseTree(data: Buffer): { mode: string; name: string; sha: string }[] {
  const entries: { mode: string; name: string; sha: string }[] = [];
  let offset = 0;
  while (offset < data.length) {
    const space = data.indexOf(0x20, offset);
    if (space === -1) break;
    const nul = data.indexOf(0x00, space + 1);
    if (nul === -1 || nul + 21 > data.length) break;
    const mode = data.subarray(offset, space).toString('utf8');
    const name = data.subarray(space + 1, nul).toString('utf8');
    const sha = data.subarray(nul + 1, nul + 21).toString('hex');
    entries.push({ mode, name, sha });
    offset = nul + 21;
  }
  return entries;
}

/** Parse a raw commit object: its tree, parents, message and author epoch. */
export function parseCommit(data: Buffer): { tree: string; parents: string[]; message: string; authorEpoch: number } {
  const text = data.toString('utf8');
  const blank = text.indexOf('\n\n');
  const header = blank === -1 ? text : text.slice(0, blank);
  const message = blank === -1 ? '' : text.slice(blank + 2);
  let tree = '';
  const parents: string[] = [];
  let authorEpoch = trialNowEpoch();
  for (const line of header.split('\n')) {
    if (line.startsWith('tree ')) tree = line.slice(5).trim();
    else if (line.startsWith('parent ')) parents.push(line.slice(7).trim());
    else if (line.startsWith('author ')) {
      const match = / (\d+) [+-]\d{4}$/.exec(line);
      if (match !== null) authorEpoch = Number(match[1]);
    }
  }
  return { tree, parents, message, authorEpoch };
}
