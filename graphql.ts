// GraphQL v4 (POST /api/graphql) for the github-core-clone-01 entry.
// A small purpose-built parser/executor for the exact documents the suite sends
// (see the kit's checks-graphql.ts): viewer/repository reads, __type introspection,
// issue / pull-request reads with connections and cursors, node(id:), the five
// mutations, and JSON-array operation batching. Unknown fields -> HTTP 200 with
// an errors array naming the field; unknown repository -> data.repository = null.

import { VIEWER_LOGIN, trialNowIso } from './store.ts';
import type { Store, Repo, Issue, Pull } from './store.ts';
import { sendJson, unauthorized } from './http.ts';
import type { ReqCtx } from './http.ts';
import {
  createIssueInRepo,
  createPullInRepo,
  mergePullInRepo,
  pullMergeable,
  pullFiles,
} from './issues.ts';

// -------------------------------------------------------------------------------------------
// Node ids: opaque base64url of a reversible string.

export function encodeNodeId(plain: string): string {
  return Buffer.from(plain, 'utf8').toString('base64url');
}

export function decodeNodeId(id: string): string | null {
  try {
    const text = Buffer.from(id, 'base64url').toString('utf8');
    return text === '' ? null : text;
  } catch {
    return null;
  }
}

function repoNodeId(repo: Repo): string {
  return encodeNodeId(`Repository:${repo.fullName}`);
}
function issueNodeId(repo: Repo, issue: Issue): string {
  return encodeNodeId(`Issue:${repo.fullName}:${issue.number}`);
}
function pullNodeId(repo: Repo, pull: Pull): string {
  return encodeNodeId(`PullRequest:${repo.fullName}:${pull.number}`);
}
function userNodeId(login: string): string {
  return encodeNodeId(`User:${login}`);
}

function encodeCursor(index: number): string {
  return encodeNodeId(`cursor:${index}`);
}
function decodeCursor(cursor: string | null | undefined): number | null {
  if (typeof cursor !== 'string' || cursor === '') return null;
  const text = decodeNodeId(cursor);
  if (text === null) return null;
  const match = /^cursor:(\d+)$/.exec(text);
  return match === null ? null : Number(match[1]);
}

// -------------------------------------------------------------------------------------------
// Lexer

type Token =
  | { kind: 'name'; value: string }
  | { kind: 'int'; value: string }
  | { kind: 'float'; value: string }
  | { kind: 'string'; value: string }
  | { kind: 'punct'; value: string }
  | { kind: 'spread' };

function lex(input: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  while (i < input.length) {
    const ch = input[i] as string;
    if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r' || ch === ',' || ch === '﻿') {
      i += 1;
      continue;
    }
    if (ch === '#') {
      while (i < input.length && input[i] !== '\n') i += 1;
      continue;
    }
    if (ch === '.' && input.slice(i, i + 3) === '...') {
      tokens.push({ kind: 'spread' });
      i += 3;
      continue;
    }
    if ('{}()[]:!=$@|&'.includes(ch)) {
      tokens.push({ kind: 'punct', value: ch });
      i += 1;
      continue;
    }
    if (ch === '"') {
      let j = i + 1;
      let out = '';
      while (j < input.length && input[j] !== '"') {
        if (input[j] === '\\' && j + 1 < input.length) {
          const esc = input[j + 1] as string;
          if (esc === 'n') out += '\n';
          else if (esc === 't') out += '\t';
          else if (esc === 'r') out += '\r';
          else if (esc === 'u' && j + 5 < input.length) {
            out += String.fromCharCode(Number.parseInt(input.slice(j + 2, j + 6), 16));
            j += 4;
          } else out += esc;
          j += 2;
        } else {
          out += input[j] as string;
          j += 1;
        }
      }
      tokens.push({ kind: 'string', value: out });
      i = j + 1;
      continue;
    }
    if (/[0-9-]/.test(ch)) {
      let j = i;
      while (j < input.length && /[0-9.eE+-]/.test(input[j] as string)) j += 1;
      const raw = input.slice(i, j);
      tokens.push(raw.includes('.') || raw.includes('e') || raw.includes('E') ? { kind: 'float', value: raw } : { kind: 'int', value: raw });
      i = j;
      continue;
    }
    if (/[A-Za-z_]/.test(ch)) {
      let j = i;
      while (j < input.length && /[A-Za-z0-9_]/.test(input[j] as string)) j += 1;
      tokens.push({ kind: 'name', value: input.slice(i, j) });
      i = j;
      continue;
    }
    // Unknown character: skip it rather than failing the whole document.
    i += 1;
  }
  return tokens;
}

// -------------------------------------------------------------------------------------------
// Parser

type Value =
  | { kind: 'var'; name: string }
  | { kind: 'string'; value: string }
  | { kind: 'int'; value: number }
  | { kind: 'float'; value: number }
  | { kind: 'boolean'; value: boolean }
  | { kind: 'null' }
  | { kind: 'enum'; value: string }
  | { kind: 'list'; items: Value[] }
  | { kind: 'object'; fields: { name: string; value: Value }[] };

type Selection =
  | { kind: 'field'; alias: string | null; name: string; args: { name: string; value: Value }[]; selection: Selection[] | null }
  | { kind: 'inlineFragment'; typeCondition: string | null; selection: Selection[] }
  | { kind: 'fragmentSpread'; name: string };

interface Operation {
  kind: 'query' | 'mutation';
  name: string | null;
  varDefs: { name: string; defaultValue: Value | null }[];
  selection: Selection[];
}

interface Document {
  operations: Operation[];
  fragments: Map<string, { typeCondition: string; selection: Selection[] }>;
}

class Parser {
  private pos = 0;
  private readonly tokens: Token[];

  constructor(tokens: Token[]) {
    this.tokens = tokens;
  }

  private peek(): Token | undefined {
    return this.tokens[this.pos];
  }
  private next(): Token | undefined {
    return this.tokens[this.pos++];
  }
  private expectPunct(value: string): void {
    const tok = this.next();
    if (tok === undefined || tok.kind !== 'punct' || tok.value !== value) throw new Error(`expected ${value}`);
  }
  private expectName(value?: string): string {
    const tok = this.next();
    if (tok === undefined || tok.kind !== 'name') throw new Error('expected name');
    if (value !== undefined && tok.value !== value) throw new Error(`expected ${value}`);
    return tok.value;
  }

  parseDocument(): Document {
    const operations: Operation[] = [];
    const fragments = new Map<string, { typeCondition: string; selection: Selection[] }>();
    while (this.peek() !== undefined) {
      const tok = this.peek() as Token;
      if (tok.kind === 'name' && tok.value === 'fragment') {
        this.next();
        const name = this.expectName();
        this.expectName('on');
        const typeCondition = this.expectName();
        const selection = this.parseSelectionSet();
        fragments.set(name, { typeCondition, selection });
        continue;
      }
      operations.push(this.parseOperation());
    }
    return { operations, fragments };
  }

  private parseOperation(): Operation {
    let kind: 'query' | 'mutation' = 'query';
    const tok = this.peek();
    if (tok !== undefined && tok.kind === 'name' && (tok.value === 'query' || tok.value === 'mutation')) {
      kind = this.next() as unknown as 'query' | 'mutation';
      // The line above consumed the keyword; kind is the token value.
      kind = (tok.value === 'mutation' ? 'mutation' : 'query') as 'query' | 'mutation';
    }
    let name: string | null = null;
    const nextTok = this.peek();
    if (nextTok !== undefined && nextTok.kind === 'name') {
      name = this.next() as unknown as string;
      name = (nextTok.value as string) ?? null;
    }
    const varDefs: { name: string; defaultValue: Value | null }[] = [];
    if (this.peek() !== undefined && this.peek()?.kind === 'punct' && (this.peek() as { value: string }).value === '(') {
      this.next();
      while (this.peek() !== undefined && !(this.peek()?.kind === 'punct' && (this.peek() as { value: string }).value === ')')) {
        this.expectPunct('$');
        const varName = this.expectName();
        this.expectPunct(':');
        this.skipType();
        let defaultValue: Value | null = null;
        if (this.peek() !== undefined && this.peek()?.kind === 'punct' && (this.peek() as { value: string }).value === '=') {
          this.next();
          defaultValue = this.parseValue();
        }
        varDefs.push({ name: varName, defaultValue });
      }
      this.expectPunct(')');
    }
    const selection = this.parseSelectionSet();
    return { kind, name, varDefs, selection };
  }

  private skipType(): void {
    const tok = this.peek();
    if (tok !== undefined && tok.kind === 'punct' && tok.value === '[') {
      this.next();
      this.skipType();
      this.expectPunct(']');
    } else {
      this.expectName();
    }
    if (this.peek() !== undefined && this.peek()?.kind === 'punct' && (this.peek() as { value: string }).value === '!') this.next();
  }

  private parseSelectionSet(): Selection[] {
    this.expectPunct('{');
    const out: Selection[] = [];
    while (this.peek() !== undefined && !(this.peek()?.kind === 'punct' && (this.peek() as { value: string }).value === '}')) {
      out.push(this.parseSelection());
    }
    this.expectPunct('}');
    return out;
  }

  private parseSelection(): Selection {
    const tok = this.peek();
    if (tok !== undefined && tok.kind === 'spread') {
      this.next();
      const after = this.peek();
      if (after !== undefined && after.kind === 'name' && after.value === 'on') {
        this.next();
        const typeCondition = this.expectName();
        return { kind: 'inlineFragment', typeCondition, selection: this.parseSelectionSet() };
      }
      if (after !== undefined && after.kind === 'name') {
        return { kind: 'fragmentSpread', name: this.next() as unknown as string };
      }
      return { kind: 'inlineFragment', typeCondition: null, selection: this.parseSelectionSet() };
    }
    const first = this.expectName();
    let alias: string | null = null;
    let name = first;
    if (this.peek() !== undefined && this.peek()?.kind === 'punct' && (this.peek() as { value: string }).value === ':') {
      this.next();
      alias = first;
      name = this.expectName();
    }
    const args: { name: string; value: Value }[] = [];
    if (this.peek() !== undefined && this.peek()?.kind === 'punct' && (this.peek() as { value: string }).value === '(') {
      this.next();
      while (this.peek() !== undefined && !(this.peek()?.kind === 'punct' && (this.peek() as { value: string }).value === ')')) {
        const argName = this.expectName();
        this.expectPunct(':');
        args.push({ name: argName, value: this.parseValue() });
      }
      this.expectPunct(')');
    }
    // Directives (@...) are not used by the suite; skip them if present.
    while (this.peek() !== undefined && this.peek()?.kind === 'punct' && (this.peek() as { value: string }).value === '@') {
      this.next();
      this.expectName();
      if (this.peek() !== undefined && this.peek()?.kind === 'punct' && (this.peek() as { value: string }).value === '(') {
        this.next();
        let depth = 1;
        while (this.peek() !== undefined && depth > 0) {
          const t = this.next() as Token;
          if (t.kind === 'punct' && t.value === '(') depth += 1;
          if (t.kind === 'punct' && t.value === ')') depth -= 1;
        }
      }
    }
    let selection: Selection[] | null = null;
    if (this.peek() !== undefined && this.peek()?.kind === 'punct' && (this.peek() as { value: string }).value === '{') {
      selection = this.parseSelectionSet();
    }
    return { kind: 'field', alias, name, args, selection };
  }

  private parseValue(): Value {
    const tok = this.next();
    if (tok === undefined) throw new Error('unexpected end of document');
    if (tok.kind === 'punct' && tok.value === '$') return { kind: 'var', name: this.expectName() };
    if (tok.kind === 'string') return { kind: 'string', value: tok.value };
    if (tok.kind === 'int') return { kind: 'int', value: Number(tok.value) };
    if (tok.kind === 'float') return { kind: 'float', value: Number(tok.value) };
    if (tok.kind === 'name') {
      if (tok.value === 'true') return { kind: 'boolean', value: true };
      if (tok.value === 'false') return { kind: 'boolean', value: false };
      if (tok.value === 'null') return { kind: 'null' };
      return { kind: 'enum', value: tok.value };
    }
    if (tok.kind === 'punct' && tok.value === '[') {
      const items: Value[] = [];
      while (this.peek() !== undefined && !(this.peek()?.kind === 'punct' && (this.peek() as { value: string }).value === ']')) {
        items.push(this.parseValue());
      }
      this.expectPunct(']');
      return { kind: 'list', items };
    }
    if (tok.kind === 'punct' && tok.value === '{') {
      const fields: { name: string; value: Value }[] = [];
      while (this.peek() !== undefined && !(this.peek()?.kind === 'punct' && (this.peek() as { value: string }).value === '}')) {
        const name = this.expectName();
        this.expectPunct(':');
        fields.push({ name, value: this.parseValue() });
      }
      this.expectPunct('}');
      return { kind: 'object', fields };
    }
    throw new Error(`unexpected token in value: ${tok.kind}`);
  }
}

// -------------------------------------------------------------------------------------------
// Schema knowledge (fields the suite may ask for, per type)

const FIELDS: Record<string, Set<string>> = {
  Query: new Set(['viewer', 'repository', 'node', '__type', '__typename']),
  Mutation: new Set(['createIssue', 'closeIssue', 'createPullRequest', 'mergePullRequest', 'addComment', '__typename']),
  User: new Set(['id', 'login', 'name', '__typename']),
  Repository: new Set(['id', 'databaseId', 'name', 'nameWithOwner', 'owner', 'defaultBranchRef', 'viewerPermission', 'hasIssuesEnabled', 'issue', 'issues', 'pullRequests', 'pullRequest', '__typename']),
  Ref: new Set(['name', '__typename']),
  Issue: new Set(['id', 'number', 'title', 'state', 'body', '__typename']),
  IssueConnection: new Set(['nodes', 'pageInfo', 'totalCount', '__typename']),
  PageInfo: new Set(['hasNextPage', 'endCursor', 'hasPreviousPage', 'startCursor', '__typename']),
  PullRequest: new Set(['id', 'number', 'title', 'body', 'state', 'merged', 'headRefName', 'baseRefName', 'mergeable', 'files', '__typename']),
  PullRequestConnection: new Set(['nodes', 'pageInfo', 'totalCount', '__typename']),
  PullRequestChangedFileConnection: new Set(['nodes', 'pageInfo', '__typename']),
  PullRequestChangedFile: new Set(['path', '__typename']),
  CreateIssuePayload: new Set(['issue', 'clientMutationId', '__typename']),
  CloseIssuePayload: new Set(['issue', 'clientMutationId', '__typename']),
  CreatePullRequestPayload: new Set(['pullRequest', 'clientMutationId', '__typename']),
  MergePullRequestPayload: new Set(['pullRequest', 'clientMutationId', '__typename']),
  AddCommentPayload: new Set(['commentEdge', 'clientMutationId', '__typename']),
  IssueCommentEdge: new Set(['node', 'cursor', '__typename']),
  IssueComment: new Set(['id', 'body', '__typename']),
  __Type: new Set(['name', 'kind', 'fields', 'enumValues', 'description', '__typename']),
  __Field: new Set(['name', 'description', '__typename']),
  __EnumValue: new Set(['name', 'description', '__typename']),
};

const TYPE_INFO: Record<string, { kind: string; fields: string[]; enumValues: string[] }> = {
  Issue: { kind: 'OBJECT', fields: ['id', 'number', 'title', 'state', 'body'], enumValues: [] },
  PullRequest: {
    kind: 'OBJECT',
    fields: ['id', 'number', 'title', 'body', 'state', 'merged', 'headRefName', 'baseRefName', 'mergeable', 'files'],
    enumValues: [],
  },
  Repository: {
    kind: 'OBJECT',
    fields: ['id', 'databaseId', 'name', 'nameWithOwner', 'owner', 'defaultBranchRef', 'viewerPermission', 'hasIssuesEnabled', 'issue', 'issues', 'pullRequests', 'pullRequest'],
    enumValues: [],
  },
  User: { kind: 'OBJECT', fields: ['id', 'login', 'name'], enumValues: [] },
  SearchType: { kind: 'ENUM', fields: [], enumValues: ['ISSUE', 'REPOSITORY', 'USER', 'DISCUSSION', 'COMMIT'] },
  IssueState: { kind: 'ENUM', fields: [], enumValues: ['OPEN', 'CLOSED'] },
  PullRequestState: { kind: 'ENUM', fields: [], enumValues: ['OPEN', 'CLOSED', 'MERGED'] },
  MergeableState: { kind: 'ENUM', fields: [], enumValues: ['MERGEABLE', 'CONFLICTING', 'UNKNOWN'] },
  RepositoryPermission: { kind: 'ENUM', fields: [], enumValues: ['ADMIN', 'MAINTAIN', 'WRITE', 'TRIAGE', 'READ'] },
};

// -------------------------------------------------------------------------------------------
// Executor

type AnyObj = Record<string, unknown>;

interface ExecCtx {
  store: Store;
  errors: { message: string }[];
  fragments: Map<string, { typeCondition: string; selection: Selection[] }>;
}

function resolveValue(value: Value, variables: Record<string, unknown>): unknown {
  switch (value.kind) {
    case 'var': {
      const v = variables[value.name];
      return v === undefined ? null : v;
    }
    case 'string':
    case 'enum':
      return value.value;
    case 'int':
    case 'float':
    case 'boolean':
      return value.value;
    case 'null':
      return null;
    case 'list':
      return value.items.map((item) => resolveValue(item, variables));
    case 'object': {
      const out: Record<string, unknown> = {};
      for (const field of value.fields) out[field.name] = resolveValue(field.value, variables);
      return out;
    }
  }
}

function argsOf(field: Extract<Selection, { kind: 'field' }>, variables: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const arg of field.args) out[arg.name] = resolveValue(arg.value, variables);
  return out;
}

function isRecord(v: unknown): v is AnyObj {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

function typenameOf(value: unknown): string {
  if (isRecord(value) && typeof value.__typename === 'string') return value.__typename;
  return 'Unknown';
}

// Node objects the resolvers build. Internal references live under keys starting with '_'.

function userNode(login: string): AnyObj {
  return { __typename: 'User', _login: login, id: userNodeId(login), login, name: login };
}

function repoNode(repo: Repo): AnyObj {
  return { __typename: 'Repository', _repo: repo, id: repoNodeId(repo), databaseId: repo.id, name: repo.name, nameWithOwner: repo.fullName };
}

function issueNode(repo: Repo, issue: Issue): AnyObj {
  return {
    __typename: 'Issue',
    _repo: repo,
    _issue: issue,
    id: issueNodeId(repo, issue),
    number: issue.number,
    title: issue.title,
    state: issue.state === 'open' ? 'OPEN' : 'CLOSED',
    body: issue.body,
  };
}

function pullNode(repo: Repo, pull: Pull): AnyObj {
  const merged = pull.merged;
  return {
    __typename: 'PullRequest',
    _repo: repo,
    _pull: pull,
    id: pullNodeId(repo, pull),
    number: pull.number,
    title: pull.title,
    body: pull.body,
    state: merged ? 'MERGED' : pull.state === 'open' ? 'OPEN' : 'CLOSED',
    merged,
    headRefName: pull.head,
    baseRefName: pull.base,
    mergeable: pullMergeable(repo, pull) ? 'MERGEABLE' : 'CONFLICTING',
  };
}

function typeNode(name: string): AnyObj | null {
  const info = TYPE_INFO[name];
  if (info === undefined) return null;
  return {
    __typename: '__Type',
    _typeName: name,
    name,
    kind: info.kind,
    fields: info.fields.map((f) => ({ __typename: '__Field', name: f })),
    enumValues: info.enumValues.map((e) => ({ __typename: '__EnumValue', name: e })),
  };
}

function sortIssues(issues: Issue[], orderBy: unknown): Issue[] {
  const list = [...issues];
  const order = isRecord(orderBy) ? orderBy : {};
  const field = typeof order.field === 'string' ? order.field : '';
  const direction = order.direction === 'ASC' ? 1 : -1;
  if (field === 'CREATED_AT' || field === 'UPDATED_AT') {
    const key = field === 'CREATED_AT' ? 'createdAt' : 'updatedAt';
    list.sort((a, b) => {
      if (a[key] !== b[key]) return a[key] < b[key] ? -direction : direction;
      return (a.number - b.number) * direction;
    });
  } else if (field === 'COMMENTS') {
    list.sort((a, b) => {
      if (a.comments.length !== b.comments.length) return (a.comments.length - b.comments.length) * direction;
      return (a.number - b.number) * direction;
    });
  } else {
    // No orderBy: creation order (number ascending).
    list.sort((a, b) => a.number - b.number);
  }
  return list;
}

function connectionFor<T>(nodes: T[], first: unknown, after: unknown): AnyObj {
  const all = nodes;
  let start = 0;
  const cursorIndex = decodeCursor(typeof after === 'string' ? after : null);
  if (cursorIndex !== null) start = cursorIndex + 1;
  const limit = typeof first === 'number' && Number.isFinite(first) ? Math.max(0, Math.trunc(first)) : all.length;
  const slice = all.slice(start, start + limit);
  const end = start + slice.length;
  return {
    __typename: 'IssueConnection',
    nodes: slice,
    totalCount: all.length,
    pageInfo: {
      __typename: 'PageInfo',
      hasNextPage: end < all.length,
      endCursor: slice.length > 0 ? encodeCursor(end - 1) : null,
      hasPreviousPage: start > 0,
      startCursor: slice.length > 0 ? encodeCursor(start) : null,
    },
  };
}

function resolveField(
  ctx: ExecCtx,
  parentType: string,
  parent: AnyObj,
  field: Extract<Selection, { kind: 'field' }>,
  args: Record<string, unknown>,
): unknown {
  const name = field.name;
  if (name === '__typename') return parentType;
  if (name === '__type') {
    const typeName = typeof args.name === 'string' ? args.name : '';
    return typeNode(typeName);
  }
  switch (parentType) {
    case 'Query': {
      if (name === 'viewer') return userNode(VIEWER_LOGIN);
      if (name === 'repository') {
        const owner = typeof args.owner === 'string' ? args.owner : '';
        const repoName = typeof args.name === 'string' ? args.name : '';
        if (owner !== VIEWER_LOGIN) return null;
        const repo = ctx.store.getRepo(owner, repoName);
        return repo === undefined ? null : repoNode(repo);
      }
      if (name === 'node') {
        const id = typeof args.id === 'string' ? args.id : '';
        const decoded = decodeNodeId(id);
        if (decoded === null) return null;
        const [kind, ...restParts] = decoded.split(':');
        if (kind === 'Repository') {
          const fullName = restParts.join(':');
          const [owner, repoName] = fullName.split('/');
          if (owner === undefined || repoName === undefined) return null;
          const repo = ctx.store.getRepo(owner, repoName);
          return repo === undefined ? null : repoNode(repo);
        }
        if (kind === 'Issue') {
          const fullName = restParts.slice(0, -1).join(':');
          const number = Number(restParts[restParts.length - 1]);
          const [owner, repoName] = fullName.split('/');
          if (owner === undefined || repoName === undefined || !Number.isInteger(number)) return null;
          const repo = ctx.store.getRepo(owner, repoName);
          const issue = repo?.issues.get(number);
          return repo !== undefined && issue !== undefined ? issueNode(repo, issue) : null;
        }
        if (kind === 'PullRequest') {
          const fullName = restParts.slice(0, -1).join(':');
          const number = Number(restParts[restParts.length - 1]);
          const [owner, repoName] = fullName.split('/');
          if (owner === undefined || repoName === undefined || !Number.isInteger(number)) return null;
          const repo = ctx.store.getRepo(owner, repoName);
          const pull = repo?.pulls.get(number);
          return repo !== undefined && pull !== undefined ? pullNode(repo, pull) : null;
        }
        if (kind === 'User') {
          return userNode(restParts.join(':'));
        }
        return null;
      }
      return undefined;
    }
    case 'Repository': {
      const repo = parent._repo as Repo;
      if (name === 'owner') return userNode(repo.owner);
      if (name === 'defaultBranchRef') return { __typename: 'Ref', name: repo.defaultBranch };
      if (name === 'viewerPermission') return 'ADMIN';
      if (name === 'hasIssuesEnabled') return true;
      if (name === 'issue') {
        const number = typeof args.number === 'number' ? args.number : NaN;
        const issue = repo.issues.get(number);
        return issue === undefined ? null : issueNode(repo, issue);
      }
      if (name === 'issues') {
        let list = [...repo.issues.values()];
        if (Array.isArray(args.states)) {
          const wanted = new Set(args.states.map((s) => String(s)));
          list = list.filter((issue) => wanted.has(issue.state === 'open' ? 'OPEN' : 'CLOSED'));
        }
        const sorted = sortIssues(list, args.orderBy);
        const conn = connectionFor(sorted.map((issue) => issueNode(repo, issue)), args.first, args.after);
        conn.__typename = 'IssueConnection';
        return conn;
      }
      if (name === 'pullRequests') {
        const list = [...repo.pulls.values()].sort((a, b) => a.number - b.number);
        const conn = connectionFor(list.map((pull) => pullNode(repo, pull)), args.first, undefined);
        conn.__typename = 'PullRequestConnection';
        return conn;
      }
      if (name === 'pullRequest') {
        const number = typeof args.number === 'number' ? args.number : NaN;
        const pull = repo.pulls.get(number);
        return pull === undefined ? null : pullNode(repo, pull);
      }
      return parent[name];
    }
    case 'PullRequest': {
      const repo = parent._repo as Repo;
      const pull = parent._pull as Pull;
      if (name === 'files') {
        const files = pullFiles(repo, pull).map((f) => ({
          __typename: 'PullRequestChangedFile',
          path: String(f.filename),
        }));
        const limit = typeof args.first === 'number' && Number.isFinite(args.first) ? Math.max(0, Math.trunc(args.first)) : files.length;
        const slice = files.slice(0, limit);
        return {
          __typename: 'PullRequestChangedFileConnection',
          nodes: slice,
          pageInfo: {
            __typename: 'PageInfo',
            hasNextPage: slice.length < files.length,
            endCursor: null,
            hasPreviousPage: false,
            startCursor: null,
          },
        };
      }
      return parent[name];
    }
    case 'Mutation': {
      return resolveMutation(ctx, name, args);
    }
    default: {
      return parent[name];
    }
  }
}

function resolveMutation(ctx: ExecCtx, name: string, args: Record<string, unknown>): unknown {
  const input = isRecord(args.input) ? args.input : {};
  if (name === 'createIssue') {
    const repoId = typeof input.repositoryId === 'string' ? input.repositoryId : '';
    const decoded = decodeNodeId(repoId);
    if (decoded === null || !decoded.startsWith('Repository:')) {
      ctx.errors.push({ message: 'createIssue: unknown repositoryId' });
      return { __typename: 'CreateIssuePayload', issue: null };
    }
    const fullName = decoded.slice('Repository:'.length);
    const [owner, repoName] = fullName.split('/');
    const repo = owner !== undefined && repoName !== undefined ? ctx.store.getRepo(owner, repoName) : undefined;
    if (repo === undefined) {
      ctx.errors.push({ message: 'createIssue: repository not found' });
      return { __typename: 'CreateIssuePayload', issue: null };
    }
    const title = typeof input.title === 'string' ? input.title : '';
    const body = typeof input.body === 'string' ? input.body : '';
    const created = createIssueInRepo(ctx.store, repo, title, body, []);
    if ('error' in created) {
      ctx.errors.push({ message: `createIssue: ${created.error}` });
      return { __typename: 'CreateIssuePayload', issue: null };
    }
    return { __typename: 'CreateIssuePayload', issue: issueNode(repo, created.issue) };
  }
  if (name === 'closeIssue') {
    const issueId = typeof input.issueId === 'string' ? input.issueId : '';
    const decoded = decodeNodeId(issueId);
    if (decoded === null || !decoded.startsWith('Issue:')) {
      ctx.errors.push({ message: 'closeIssue: unknown issueId' });
      return { __typename: 'CloseIssuePayload', issue: null };
    }
    const parts = decoded.split(':');
    const number = Number(parts[parts.length - 1]);
    const fullName = parts.slice(1, -1).join(':');
    const [owner, repoName] = fullName.split('/');
    const repo = owner !== undefined && repoName !== undefined ? ctx.store.getRepo(owner, repoName) : undefined;
    const issue = repo?.issues.get(number);
    if (repo === undefined || issue === undefined) {
      ctx.errors.push({ message: 'closeIssue: issue not found' });
      return { __typename: 'CloseIssuePayload', issue: null };
    }
    issue.state = 'closed';
    issue.updatedAt = trialNowIso();
    return { __typename: 'CloseIssuePayload', issue: issueNode(repo, issue) };
  }
  if (name === 'createPullRequest') {
    const repoId = typeof input.repositoryId === 'string' ? input.repositoryId : '';
    const decoded = decodeNodeId(repoId);
    if (decoded === null || !decoded.startsWith('Repository:')) {
      ctx.errors.push({ message: 'createPullRequest: unknown repositoryId' });
      return { __typename: 'CreatePullRequestPayload', pullRequest: null };
    }
    const fullName = decoded.slice('Repository:'.length);
    const [owner, repoName] = fullName.split('/');
    const repo = owner !== undefined && repoName !== undefined ? ctx.store.getRepo(owner, repoName) : undefined;
    if (repo === undefined) {
      ctx.errors.push({ message: 'createPullRequest: repository not found' });
      return { __typename: 'CreatePullRequestPayload', pullRequest: null };
    }
    const created = createPullInRepo(
      ctx.store,
      repo,
      typeof input.title === 'string' ? input.title : '',
      typeof input.body === 'string' ? input.body : '',
      typeof input.headRefName === 'string' ? input.headRefName : '',
      typeof input.baseRefName === 'string' ? input.baseRefName : '',
    );
    if ('error' in created) {
      ctx.errors.push({ message: `createPullRequest: ${created.error}` });
      return { __typename: 'CreatePullRequestPayload', pullRequest: null };
    }
    return { __typename: 'CreatePullRequestPayload', pullRequest: pullNode(repo, created.pull) };
  }
  if (name === 'mergePullRequest') {
    const prId = typeof input.pullRequestId === 'string' ? input.pullRequestId : '';
    const decoded = decodeNodeId(prId);
    if (decoded === null || !decoded.startsWith('PullRequest:')) {
      ctx.errors.push({ message: 'mergePullRequest: unknown pullRequestId' });
      return { __typename: 'MergePullRequestPayload', pullRequest: null };
    }
    const parts = decoded.split(':');
    const number = Number(parts[parts.length - 1]);
    const fullName = parts.slice(1, -1).join(':');
    const [owner, repoName] = fullName.split('/');
    const repo = owner !== undefined && repoName !== undefined ? ctx.store.getRepo(owner, repoName) : undefined;
    const pull = repo?.pulls.get(number);
    if (repo === undefined || pull === undefined) {
      ctx.errors.push({ message: 'mergePullRequest: pull request not found' });
      return { __typename: 'MergePullRequestPayload', pullRequest: null };
    }
    const merged = mergePullInRepo(repo, pull);
    if ('error' in merged) {
      ctx.errors.push({ message: `mergePullRequest: pull request is not mergeable` });
      return { __typename: 'MergePullRequestPayload', pullRequest: pullNode(repo, pull) };
    }
    return { __typename: 'MergePullRequestPayload', pullRequest: pullNode(repo, pull) };
  }
  if (name === 'addComment') {
    const subjectId = typeof input.subjectId === 'string' ? input.subjectId : '';
    const decoded = decodeNodeId(subjectId);
    if (decoded === null || !decoded.startsWith('Issue:')) {
      ctx.errors.push({ message: 'addComment: unknown subjectId' });
      return { __typename: 'AddCommentPayload', commentEdge: null };
    }
    const parts = decoded.split(':');
    const number = Number(parts[parts.length - 1]);
    const fullName = parts.slice(1, -1).join(':');
    const [owner, repoName] = fullName.split('/');
    const repo = owner !== undefined && repoName !== undefined ? ctx.store.getRepo(owner, repoName) : undefined;
    const issue = repo?.issues.get(number);
    if (repo === undefined || issue === undefined) {
      ctx.errors.push({ message: 'addComment: issue not found' });
      return { __typename: 'AddCommentPayload', commentEdge: null };
    }
    const body = typeof input.body === 'string' ? input.body : '';
    const now = trialNowIso();
    const comment = { id: ctx.store.commentIdSeq++, body, createdAt: now, updatedAt: now };
    issue.comments.push(comment);
    const node = {
      __typename: 'IssueComment',
      id: encodeNodeId(`IssueComment:${repo.fullName}:${issue.number}:${comment.id}`),
      body,
    };
    return { __typename: 'AddCommentPayload', commentEdge: { __typename: 'IssueCommentEdge', node, cursor: null } };
  }
  return undefined;
}

function executeSelection(
  ctx: ExecCtx,
  parentType: string,
  parent: AnyObj,
  selection: Selection[],
  variables: Record<string, unknown>,
  out: AnyObj,
): void {
  for (const sel of selection) {
    if (sel.kind === 'fragmentSpread') {
      const frag = ctx.fragments.get(sel.name);
      if (frag !== undefined) executeSelection(ctx, parentType, parent, frag.selection, variables, out);
      continue;
    }
    if (sel.kind === 'inlineFragment') {
      if (sel.typeCondition === null || sel.typeCondition === parentType) {
        executeSelection(ctx, parentType, parent, sel.selection, variables, out);
      }
      continue;
    }
    const field = sel;
    const key = field.alias ?? field.name;
    const known = FIELDS[parentType];
    if (field.name !== '__typename' && field.name !== '__type' && (known === undefined || !known.has(field.name))) {
      ctx.errors.push({ message: `Cannot query field "${field.name}" on type "${parentType}".` });
      continue;
    }
    const args = argsOf(field, variables);
    let value: unknown;
    try {
      value = resolveField(ctx, parentType, parent, field, args);
    } catch (err) {
      ctx.errors.push({ message: err instanceof Error ? err.message : String(err) });
      continue;
    }
    if (value === undefined) {
      ctx.errors.push({ message: `Cannot query field "${field.name}" on type "${parentType}".` });
      continue;
    }
    out[key] = completeValue(ctx, field, value, variables);
  }
}

function completeValue(
  ctx: ExecCtx,
  field: Extract<Selection, { kind: 'field' }>,
  value: unknown,
  variables: Record<string, unknown>,
): unknown {
  if (field.selection === null) return value;
  if (value === null) return null;
  if (Array.isArray(value)) {
    return value.map((item) => {
      if (!isRecord(item)) return item;
      const child: AnyObj = {};
      executeSelection(ctx, typenameOf(item), item, field.selection as Selection[], variables, child);
      return child;
    });
  }
  if (isRecord(value)) {
    const child: AnyObj = {};
    executeSelection(ctx, typenameOf(value), value, field.selection, variables, child);
    return child;
  }
  return value;
}

function executeOperation(
  store: Store,
  doc: Document,
  op: Operation,
  variables: Record<string, unknown>,
): { data: AnyObj; errors: { message: string }[] } {
  const ctx: ExecCtx = { store, errors: [], fragments: doc.fragments };
  const rootType = op.kind === 'mutation' ? 'Mutation' : 'Query';
  const data: AnyObj = {};
  executeSelection(ctx, rootType, { __typename: rootType }, op.selection, variables, data);
  return { data, errors: ctx.errors };
}

// -------------------------------------------------------------------------------------------
// Handler

function executeOne(
  store: Store,
  body: unknown,
): { data: AnyObj | null; errors: { message: string }[] } {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    return { data: null, errors: [{ message: 'Request body must be a JSON object with a query string.' }] };
  }
  const record = body as Record<string, unknown>;
  const query = typeof record.query === 'string' ? record.query : '';
  if (query === '') {
    return { data: null, errors: [{ message: 'No query string was present in the request.' }] };
  }
  const variables = isRecord(record.variables) ? (record.variables as Record<string, unknown>) : {};
  let doc: Document;
  try {
    doc = new Parser(lex(query)).parseDocument();
  } catch (err) {
    return { data: null, errors: [{ message: err instanceof Error ? err.message : 'Could not parse the query.' }] };
  }
  if (doc.operations.length === 0) {
    return { data: null, errors: [{ message: 'No operation was present in the request.' }] };
  }
  let op = doc.operations[0] as Operation;
  if (typeof record.operationName === 'string') {
    const named = doc.operations.find((o) => o.name === record.operationName);
    if (named !== undefined) op = named;
  }
  const vars: Record<string, unknown> = { ...variables };
  for (const def of op.varDefs) {
    if (!(def.name in vars) && def.defaultValue !== null) vars[def.name] = resolveValue(def.defaultValue, vars);
  }
  return executeOperation(store, doc, op, vars);
}

export async function handleGraphql(req: any, res: any, ctx: ReqCtx): Promise<boolean> {
  const method = String(req?.method ?? 'GET').toUpperCase();
  if (method !== 'POST') return false;
  let pathname = '';
  try {
    pathname = new URL(String(req?.url ?? '/'), 'http://localhost').pathname;
  } catch {
    return false;
  }
  if (pathname !== '/api/graphql') return false;
  if (ctx.token === '') {
    unauthorized(res);
    return true;
  }
  let parsed: unknown;
  try {
    parsed = ctx.body.length === 0 ? null : JSON.parse(ctx.body.toString('utf8'));
  } catch {
    sendJson(res, 400, { errors: [{ message: 'Problems parsing JSON' }] });
    return true;
  }
  if (Array.isArray(parsed)) {
    const results = parsed.map((entry) => {
      const { data, errors } = executeOne(ctx.store, entry);
      return errors.length > 0 ? { data, errors } : { data };
    });
    sendJson(res, 200, results);
    return true;
  }
  const { data, errors } = executeOne(ctx.store, parsed);
  if (errors.length > 0) sendJson(res, 200, { data, errors });
  else sendJson(res, 200, { data });
  return true;
}
