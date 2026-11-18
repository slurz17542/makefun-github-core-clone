// The HTTP router for the github-core-clone-01 forge.
//
// createApp(handlers) builds the server; it binds nothing until the caller
// listens. Routing, in order: the unauthenticated health probe, the
// issues/pulls/labels REST surface, the rest of REST v3, GraphQL, MCP, git
// smart HTTP, and a JSON 404 for everything else.
//
// Auth: every route except /healthz requires `Authorization: Bearer <token>`
// exactly equal to MAKEFUN_SHOP_TOKEN when that variable is set and non-empty;
// when it is unset or empty, anything is accepted. Every response carries a
// non-empty x-github-request-id header. The full request body (capped at
// 64 MiB) is read before dispatch, so handlers always see ctx.body complete.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { store, type Store } from './store.ts';
import { newRequestId, readBody, sendJson, unauthorized, type ReqCtx } from './http.ts';

export type Handler = (req: IncomingMessage, res: ServerResponse, ctx: ReqCtx) => Promise<boolean>;

export interface SurfaceHandlers {
  rest: Handler;
  issuesPulls: Handler;
  git: Handler;
  graphql: Handler;
  mcp: Handler;
}

const MAX_BODY_BYTES = 64 * 1024 * 1024;

/** The path of a request URL, or '/' when it does not parse (never a throw). */
function pathOf(req: IncomingMessage): string {
  try {
    return new URL(req.url ?? '/', 'http://entry').pathname;
  } catch {
    return '/';
  }
}

/** The query string of a request URL, or empty params when it does not parse. */
function queryOf(req: IncomingMessage): URLSearchParams {
  try {
    return new URL(req.url ?? '/', 'http://entry').searchParams;
  } catch {
    return new URLSearchParams();
  }
}

/** The bearer token the request presents, or '' when the header is absent. */
function presentedToken(req: IncomingMessage): string {
  const header = req.headers.authorization;
  if (typeof header !== 'string') return '';
  const prefix = 'Bearer ';
  if (!header.startsWith(prefix)) return '';
  return header.slice(prefix.length);
}

/** True when the request passes the bearer check (or no token is configured). */
function authorized(req: IncomingMessage): boolean {
  const expected = process.env.MAKEFUN_SHOP_TOKEN ?? '';
  if (expected === '') return true;
  return presentedToken(req) === expected;
}

/**
 * Split a path into its decoded segments: '/api/v3/repos/o/r' ->
 * ['api', 'v3', 'repos', 'o', 'r'].
 */
function segmentsOf(path: string): string[] {
  return path
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

/** Build the server. It binds nothing until the caller listens. */
export function createApp(handlers: SurfaceHandlers): Server {
  const sharedStore: Store = store;
  return createServer((req: IncomingMessage, res: ServerResponse) => {
    void (async () => {
      const requestId = newRequestId();
      res.setHeader('x-github-request-id', requestId);
      const path = pathOf(req);
      const method = req.method ?? 'GET';

      // (1) The health probe: no auth, no body read needed.
      if (method === 'GET' && path === '/healthz') {
        sendJson(res, 200, { ok: true });
        return;
      }

      // Every other route requires the bearer token.
      if (!authorized(req)) {
        unauthorized(res);
        return;
      }

      // Read the whole body before dispatch; a read failure is a 400.
      let body: Buffer;
      try {
        body = await readBody(req, MAX_BODY_BYTES);
      } catch {
        sendJson(res, 400, { message: 'Bad Request' });
        return;
      }

      const ctx: ReqCtx = {
        store: sharedStore,
        token: process.env.MAKEFUN_SHOP_TOKEN ?? '',
        requestId,
        body,
        query: queryOf(req),
      };

      const segments = segmentsOf(path);
      let handled = false;
      try {
        // (2) Issues, pulls and labels under a repository go to that surface.
        if (
          segments.length >= 6 &&
          segments[0] === 'api' &&
          segments[1] === 'v3' &&
          segments[2] === 'repos' &&
          (segments[5] === 'issues' || segments[5] === 'pulls' || segments[5] === 'labels')
        ) {
          handled = await handlers.issuesPulls(req, res, ctx);
        } else if (path === '/api/v3' || path.startsWith('/api/v3/') || path.startsWith('/api/v3?')) {
          // (3) The rest of REST v3.
          handled = await handlers.rest(req, res, ctx);
        } else if (method === 'POST' && path === '/api/graphql') {
          // (4) GraphQL v4.
          handled = await handlers.graphql(req, res, ctx);
        } else if (method === 'POST' && path === '/mcp') {
          // (5) MCP over Streamable HTTP.
          handled = await handlers.mcp(req, res, ctx);
        } else if (/^\/[^/]+\/[^/]+\.git(\/.*)?$/.test(path)) {
          // (6) Git smart HTTP at /{owner}/{repo}.git.
          handled = await handlers.git(req, res, ctx);
        }
      } catch {
        if (!res.writableEnded) {
          sendJson(res, 500, { message: 'Internal Server Error' });
        }
        return;
      }

      // (7) Anything unhandled is a JSON 404, never HTML.
      if (!handled && !res.writableEnded) {
        sendJson(res, 404, { message: 'Not Found' });
      }
    })();
  });
}
