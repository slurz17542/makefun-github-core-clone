// Shared HTTP helpers for the github-core-clone-01 forge.
//
// Every JSON reply is `application/json; charset=utf-8` with a trailing newline,
// and every error body is `{"message": string}`. Nothing here reads the wall
// clock or randomness except the request-id counter, which only has to be
// unique and non-empty within one process, not unpredictable.

import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Store } from './store.ts';

export interface ReqCtx {
  store: Store;
  token: string;
  requestId: string;
  body: Buffer;
  query: URLSearchParams;
}

/** JSON replies: stringified with a trailing newline, with length set. */
export function sendJson(res: ServerResponse, status: number, body: unknown, headers?: Record<string, string>): void {
  const text = `${JSON.stringify(body)}\n`;
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(text),
    ...(headers ?? {}),
  });
  res.end(text);
}

/** Raw byte replies (used by the git surface) with an explicit content type. */
export function sendBytes(res: ServerResponse, status: number, body: Buffer, contentType: string, headers?: Record<string, string>): void {
  res.writeHead(status, {
    'content-type': contentType,
    'content-length': body.length,
    ...(headers ?? {}),
  });
  res.end(body);
}

/** Read a whole request body, rejecting when it passes `maxBytes`. */
export function readBody(req: IncomingMessage, maxBytes = 64 * 1024 * 1024): Promise<Buffer> {
  return new Promise<Buffer>((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    let failed = false;
    req.on('data', (chunk: Buffer) => {
      if (failed) return;
      total += chunk.length;
      if (total > maxBytes) {
        failed = true;
        reject(new Error('request body too large'));
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (!failed) resolve(Buffer.concat(chunks));
    });
    req.on('error', (err: Error) => {
      if (!failed) {
        failed = true;
        reject(err);
      }
    });
  });
}

/** 400 with a JSON message body. */
export function badJson(res: ServerResponse, message = 'Bad Request'): void {
  sendJson(res, 400, { message });
}

/** 404 with a JSON message body. */
export function notFound(res: ServerResponse, message = 'Not Found'): void {
  sendJson(res, 404, { message });
}

/** 401 with GitHub's bad-credentials message. */
export function unauthorized(res: ServerResponse): void {
  sendJson(res, 401, { message: 'Bad credentials' });
}

let requestCounter = 0;

/** A fresh non-empty request id for the x-github-request-id header. */
export function newRequestId(): string {
  requestCounter += 1;
  return `req-${requestCounter}`;
}
