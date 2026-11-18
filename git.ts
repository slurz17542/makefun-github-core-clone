// Git smart HTTP: protocol v2 upload-pack (ls-refs, fetch), v0 upload-pack
// fallback, and v0 receive-pack (push). The suite's own client
// (program/env/src/git-client.ts) is the spec: this module answers exactly
// what it sends and expects, nothing extra.
//
// Wire summary:
// - GET  /{owner}/{repo}.git/info/refs?service=git-upload-pack
//     Git-Protocol: version=2 -> v2 capability advertisement ("version 2" first)
//     otherwise            -> v0 advertisement ("# service=git-upload-pack" preamble)
// - GET  /{owner}/{repo}.git/info/refs?service=git-receive-pack
//     -> v0 advertisement ("# service=git-receive-pack", report-status,
//        side-band-64k, delete-refs)
// - POST /{owner}/{repo}.git/git-upload-pack   (v2 when Git-Protocol: version=2)
// - POST /{owner}/{repo}.git/git-receive-pack  (v0 only)
//
// Packs are built from plain full objects only (no deltas): deterministic,
// byte-exact, SHA-1 verified. Packs received on push may carry OFS_DELTA and
// REF_DELTA entries (real git sends them); those are resolved here, including
// thin-pack bases the repository already holds.
//
// No wall clock, no randomness: pack bytes are deterministic for identical
// object sets (sorted object order, zlib default settings, no timestamps).

import { createHash } from 'node:crypto';
import { deflateSync, inflateSync } from 'node:zlib';
import type { IncomingMessage, ServerResponse } from 'node:http';
import {
  VIEWER_LOGIN,
  hashObject,
  isAncestor,
  parseCommit,
  parseTree,
  putObject,
  resolveRef,
  type GitObj,
  type ObjType,
  type Repo,
} from './store.ts';
import { badJson, notFound, sendBytes, sendJson, type ReqCtx } from './http.ts';

const ZERO_OID = '0'.repeat(40);

/** Largest sideband payload chunk: a pkt-line is at most 65520 bytes total. */
const SIDEBAND_CHUNK = 65515;

const TYPE_CODE: Readonly<Record<ObjType, number>> = { commit: 1, tree: 2, blob: 3, tag: 4 };
const CODE_TYPE: Readonly<Record<number, ObjType>> = { 1: 'commit', 2: 'tree', 3: 'blob', 4: 'tag' };

const V2_AGENT = 'github-core-clone/1.0';

// ---------------------------------------------------------------------------------------------
// pkt-line codec
// ---------------------------------------------------------------------------------------------

function pktLine(payload: string | Buffer): Buffer {
  const data = typeof payload === 'string' ? Buffer.from(payload, 'utf8') : payload;
  if (data.length + 4 > 65520) throw new Error('pkt-line payload is too long');
  const header = Buffer.allocUnsafe(4);
  header.write((data.length + 4).toString(16).padStart(4, '0'), 0, 4, 'ascii');
  return Buffer.concat([header, data]);
}

const PKT_FLUSH = Buffer.from('0000', 'ascii');
const PKT_DELIM = Buffer.from('0001', 'ascii');

type Packet =
  | { readonly kind: 'data'; readonly payload: Buffer }
  | { readonly kind: 'flush' }
  | { readonly kind: 'delim' }
  | { readonly kind: 'response-end' };

const HEX4 = /^[0-9a-fA-F]{4}$/;

/**
 * Decode pkt-lines from `buf`. When `stopAtFlush` is set, decoding stops just
 * past the first flush packet and `consumed` marks where the raw bytes after
 * it (a receive-pack packfile) begin. Otherwise every byte must be framed.
 */
function decodePackets(buf: Buffer, stopAtFlush: boolean): { packets: Packet[]; consumed: number } {
  const packets: Packet[] = [];
  let offset = 0;
  while (offset < buf.length) {
    if (offset + 4 > buf.length) throw new Error('truncated pkt-line header');
    const head = buf.subarray(offset, offset + 4).toString('ascii');
    if (!HEX4.test(head)) throw new Error(`invalid pkt-line length ${JSON.stringify(head)}`);
    const length = Number.parseInt(head, 16);
    if (length === 0) {
      packets.push({ kind: 'flush' });
      offset += 4;
      if (stopAtFlush) break;
      continue;
    }
    if (length === 1) {
      packets.push({ kind: 'delim' });
      offset += 4;
      continue;
    }
    if (length === 2) {
      packets.push({ kind: 'response-end' });
      offset += 4;
      continue;
    }
    if (length === 3 || length > 65520) throw new Error(`invalid pkt-line length ${length}`);
    if (offset + length > buf.length) throw new Error('truncated pkt-line');
    packets.push({ kind: 'data', payload: buf.subarray(offset + 4, offset + length) });
    offset += length;
  }
  return { packets, consumed: offset };
}

// ---------------------------------------------------------------------------------------------
// small object helpers
// ---------------------------------------------------------------------------------------------

/** The `object` header of an annotated tag, or undefined when it has none. */
function parseTagTarget(data: Buffer): string | undefined {
  const text = data.toString('utf8');
  const blank = text.indexOf('\n\n');
  const header = blank < 0 ? text : text.slice(0, blank);
  for (const line of header.split('\n')) {
    if (line.startsWith('object ')) {
      const oid = line.slice(7).trim();
      return /^[0-9a-f]{40}$/.test(oid) ? oid : undefined;
    }
  }
  return undefined;
}

/** Follow tag objects to the object they ultimately name (undefined if missing). */
function peelOid(repo: Repo, oid: string): string | undefined {
  const seen = new Set<string>();
  let current = oid;
  for (;;) {
    if (seen.has(current)) return undefined;
    seen.add(current);
    const obj = repo.objects.get(current);
    if (obj === undefined) return undefined;
    if (obj.type !== 'tag') return current;
    const target = parseTagTarget(obj.data);
    if (target === undefined) return undefined;
    current = target;
  }
}

/** The repository's refs, sorted by name for deterministic advertisements. */
function sortedRefs(repo: Repo): Array<readonly [string, string]> {
  return [...repo.refs.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
}

// ---------------------------------------------------------------------------------------------
// packfile write (plain full objects, deterministic order)
// ---------------------------------------------------------------------------------------------

function packObjectHeader(type: ObjType, size: number): Buffer {
  const code = TYPE_CODE[type];
  const bytes: number[] = [];
  let remaining = size;
  let first = (code << 4) | (remaining & 0x0f);
  remaining = Math.floor(remaining / 16);
  while (remaining > 0) {
    bytes.push(first | 0x80);
    first = remaining & 0x7f;
    remaining = Math.floor(remaining / 128);
  }
  bytes.push(first);
  return Buffer.from(bytes);
}

/** Build a packfile (version 2) from the given objects, in sorted oid order. */
function buildPack(repo: Repo, oids: ReadonlySet<string>): Buffer {
  const list = [...oids].sort().filter((oid) => repo.objects.has(oid));
  const parts: Buffer[] = [];
  const header = Buffer.allocUnsafe(12);
  header.write('PACK', 0, 4, 'ascii');
  header.writeUInt32BE(2, 4);
  header.writeUInt32BE(list.length, 8);
  parts.push(header);
  for (const oid of list) {
    const obj = repo.objects.get(oid) as GitObj;
    parts.push(packObjectHeader(obj.type, obj.data.length));
    parts.push(deflateSync(obj.data));
  }
  const body = Buffer.concat(parts);
  return Buffer.concat([body, createHash('sha1').update(body).digest()]);
}

// ---------------------------------------------------------------------------------------------
// packfile read (full objects plus OFS_DELTA / REF_DELTA, thin-pack aware)
// ---------------------------------------------------------------------------------------------

function inflateAt(buf: Buffer, offset: number, end: number): { data: Buffer; next: number } {
  const view = buf.subarray(offset, end);
  let result: { buffer: Buffer; engine: { bytesWritten: number } };
  try {
    result = inflateSync(view, { info: true }) as unknown as {
      buffer: Buffer;
      engine: { bytesWritten: number };
    };
  } catch (err) {
    throw new Error(`zlib inflate failed at offset ${offset}: ${(err as Error).message}`);
  }
  const consumed = result.engine.bytesWritten;
  if (!consumed || consumed <= 0) throw new Error(`zlib stream at offset ${offset} consumed no bytes`);
  return { data: result.buffer, next: offset + consumed };
}

/** Apply a git delta instruction stream to a base object's bytes. */
function applyDelta(base: Buffer, delta: Buffer): Buffer {
  let offset = 0;
  const readVarint = (): number => {
    let value = 0;
    let shift = 0;
    for (;;) {
      if (offset >= delta.length) throw new Error('delta size varint is truncated');
      const byte = delta[offset++];
      value += (byte & 0x7f) * 2 ** shift;
      shift += 7;
      if ((byte & 0x80) === 0) break;
      if (shift > 63) throw new Error('delta size varint is too long');
    }
    return value;
  };
  const sourceSize = readVarint();
  const targetSize = readVarint();
  if (sourceSize !== base.length) {
    throw new Error(`delta expects a ${sourceSize}-byte base, got ${base.length}`);
  }
  const out = Buffer.allocUnsafe(targetSize);
  let written = 0;
  while (offset < delta.length) {
    const op = delta[offset++];
    if ((op & 0x80) !== 0) {
      let copyOffset = 0;
      let copySize = 0;
      for (let bit = 0; bit < 4; bit += 1) {
        if ((op & (1 << bit)) !== 0) {
          if (offset >= delta.length) throw new Error('delta copy offset is truncated');
          copyOffset += delta[offset++] * 2 ** (bit * 8);
        }
      }
      for (let bit = 0; bit < 3; bit += 1) {
        if ((op & (0x10 << bit)) !== 0) {
          if (offset >= delta.length) throw new Error('delta copy size is truncated');
          copySize += delta[offset++] * 2 ** (bit * 8);
        }
      }
      if (copySize === 0) copySize = 0x10000;
      if (copyOffset + copySize > base.length) throw new Error('delta copy is out of the base');
      if (written + copySize > targetSize) throw new Error('delta writes past its target size');
      base.copy(out, written, copyOffset, copyOffset + copySize);
      written += copySize;
    } else if (op !== 0) {
      const literal = op & 0x7f;
      if (offset + literal > delta.length) throw new Error('delta insert is truncated');
      if (written + literal > targetSize) throw new Error('delta writes past its target size');
      delta.copy(out, written, offset, offset + literal);
      offset += literal;
      written += literal;
    } else {
      throw new Error('delta opcode 0 is invalid');
    }
  }
  if (written !== targetSize) throw new Error(`delta produced ${written} of ${targetSize} bytes`);
  return out;
}

interface RawPackEntry {
  offset: number;
  typeCode: number;
  size: number;
  data: Buffer;
  baseOffset?: number;
  baseOid?: string;
}

/**
 * Parse a packfile into its objects, keyed by recomputed SHA-1. Full entries
 * resolve directly; deltas resolve against earlier pack entries or objects
 * the repository already holds (thin packs). Any structural problem throws,
 * so the caller reports an unpack failure instead of storing partial data.
 */
function readPackBytes(buf: Buffer, repo: Repo): Map<string, GitObj> {
  if (buf.length < 32) throw new Error('pack is too short');
  if (buf.subarray(0, 4).toString('ascii') !== 'PACK') throw new Error('pack does not start with PACK');
  const version = buf.readUInt32BE(4);
  if (version !== 2 && version !== 3) throw new Error(`unsupported pack version ${version}`);
  const count = buf.readUInt32BE(8);
  const trailerStart = buf.length - 20;
  const trailer = buf.subarray(trailerStart).toString('hex');
  const computed = createHash('sha1').update(buf.subarray(0, trailerStart)).digest('hex');
  if (trailer !== computed) throw new Error('pack trailer checksum mismatch');

  const raw: RawPackEntry[] = [];
  const byOffset = new Map<number, RawPackEntry>();
  let offset = 12;
  for (let index = 0; index < count; index += 1) {
    const entryOffset = offset;
    if (offset >= trailerStart) throw new Error('pack entry header is truncated');
    let byte = buf[offset];
    const first = byte;
    let size = byte & 0x0f;
    let shift = 4;
    offset += 1;
    while ((byte & 0x80) !== 0) {
      if (offset >= trailerStart) throw new Error('pack entry size varint is truncated');
      byte = buf[offset++];
      size += (byte & 0x7f) * 2 ** shift;
      shift += 7;
      if (shift > 63) throw new Error('pack entry size varint is too long');
    }
    const typeCode = (first >> 4) & 0x07;
    const entry: RawPackEntry = { offset: entryOffset, typeCode, size, data: Buffer.alloc(0) };
    if (typeCode === 6) {
      if (offset >= trailerStart) throw new Error('ofs-delta base offset is truncated');
      byte = buf[offset++];
      let value = byte & 0x7f;
      while ((byte & 0x80) !== 0) {
        if (offset >= trailerStart) throw new Error('ofs-delta base offset is truncated');
        byte = buf[offset++];
        value = (value + 1) * 128 + (byte & 0x7f);
      }
      entry.baseOffset = entryOffset - value;
      if (entry.baseOffset < 0) throw new Error('ofs-delta base offset is out of range');
    } else if (typeCode === 7) {
      if (offset + 20 > trailerStart) throw new Error('ref-delta base id is truncated');
      entry.baseOid = buf.subarray(offset, offset + 20).toString('hex');
      offset += 20;
    } else if (typeCode < 1 || typeCode > 4) {
      throw new Error(`pack entry ${index} has unknown type code ${typeCode}`);
    }
    const inflated = inflateAt(buf, offset, trailerStart);
    if (inflated.data.length !== size) {
      throw new Error(`pack entry at ${entryOffset} declares ${size} bytes but inflated to ${inflated.data.length}`);
    }
    entry.data = inflated.data;
    offset = inflated.next;
    raw.push(entry);
    byOffset.set(entryOffset, entry);
  }
  if (offset !== trailerStart) throw new Error('pack has stray bytes before its trailer');

  const resolved = new Map<number, GitObj & { oid: string }>();
  const resolvedByOid = new Map<string, GitObj & { oid: string }>();
  const resolving = new Set<number>();

  // Resolve one entry, or return null when its delta base is not resolved yet
  // (a later entry may still supply it); real corruption throws.
  const resolveEntry = (entry: RawPackEntry): (GitObj & { oid: string }) | null => {
    const done = resolved.get(entry.offset);
    if (done !== undefined) return done;
    if (resolving.has(entry.offset)) throw new Error(`delta cycle at pack offset ${entry.offset}`);
    resolving.add(entry.offset);
    try {
      let type: ObjType;
      let data: Buffer;
      if (entry.typeCode === 6) {
        const baseEntry = byOffset.get(entry.baseOffset as number);
        if (baseEntry === undefined) throw new Error('ofs-delta base is not in the pack');
        const base = resolveEntry(baseEntry);
        if (base === null) return null;
        type = base.type;
        data = applyDelta(base.data, entry.data);
      } else if (entry.typeCode === 7) {
        const baseOid = entry.baseOid as string;
        const inPack = resolvedByOid.get(baseOid);
        if (inPack !== undefined) {
          type = inPack.type;
          data = applyDelta(inPack.data, entry.data);
        } else {
          const external = repo.objects.get(baseOid);
          if (external === undefined) return null;
          type = external.type;
          data = applyDelta(external.data, entry.data);
        }
      } else {
        type = CODE_TYPE[entry.typeCode] as ObjType;
        data = entry.data;
      }
      const oid = hashObject(type, data);
      const out: GitObj & { oid: string } = { type, data, oid };
      resolved.set(entry.offset, out);
      resolvedByOid.set(oid, out);
      return out;
    } finally {
      resolving.delete(entry.offset);
    }
  };

  const deferred: RawPackEntry[] = [];
  for (const entry of raw) {
    if (resolveEntry(entry) === null) deferred.push(entry);
  }
  while (deferred.length > 0) {
    let made = 0;
    for (let index = deferred.length - 1; index >= 0; index -= 1) {
      if (resolveEntry(deferred[index]) !== null) {
        deferred.splice(index, 1);
        made += 1;
      }
    }
    if (made === 0) throw new Error('ref-delta base is neither in the pack nor in the repository');
  }

  const objects = new Map<string, GitObj>();
  for (const entry of raw) {
    const out = resolved.get(entry.offset) as GitObj & { oid: string };
    objects.set(out.oid, { type: out.type, data: out.data });
  }
  return objects;
}

// ---------------------------------------------------------------------------------------------
// fetch planning: depth-limited walk, have subtraction, shallow boundary
// ---------------------------------------------------------------------------------------------

interface WalkOut {
  included: Set<string>;
  boundary: Set<string>;
}

/**
 * Every object reachable from `tips`. Commits are walked by generation so a
 * `depth` limit cuts history cleanly (depth 1 = the tips only, with their
 * trees and blobs); tag objects are followed at the same generation as the
 * tag. When `stopParents` names commits, their parents are not traversed:
 * those are the client's existing shallow boundary, whose objects the client
 * already holds but whose parents it does not.
 */
function walkObjects(
  repo: Repo,
  tips: readonly string[],
  depth: number | undefined,
  stopParents: ReadonlySet<string> | undefined,
): WalkOut {
  const included = new Set<string>();
  const commitGens = new Map<string, number>();
  const queue: Array<{ oid: string; gen: number }> = [];

  const pushCommit = (oid: string, gen: number): void => {
    const prev = commitGens.get(oid);
    if (prev !== undefined && prev <= gen) return;
    commitGens.set(oid, gen);
    queue.push({ oid, gen });
  };

  const includeTree = (oid: string): void => {
    const stack: string[] = [oid];
    while (stack.length > 0) {
      const current = stack.pop() as string;
      if (included.has(current)) continue;
      const obj = repo.objects.get(current);
      if (obj === undefined) continue;
      included.add(current);
      if (obj.type === 'tree') {
        for (const entry of parseTree(obj.data)) {
          if (entry.mode === '160000') continue;
          stack.push(entry.sha);
        }
      }
    }
  };

  const enqueueObject = (oid: string, gen: number): void => {
    const obj = repo.objects.get(oid);
    if (obj === undefined) return;
    if (obj.type === 'commit') {
      pushCommit(oid, gen);
    } else if (obj.type === 'tag') {
      if (!included.has(oid)) {
        included.add(oid);
        const target = parseTagTarget(obj.data);
        if (target !== undefined) enqueueObject(target, gen);
      }
    } else if (obj.type === 'tree') {
      includeTree(oid);
    } else {
      included.add(oid);
    }
  };

  for (const tip of tips) enqueueObject(tip, 0);

  let head = 0;
  while (head < queue.length) {
    const { oid, gen } = queue[head++];
    if (commitGens.get(oid) !== gen) continue;
    const obj = repo.objects.get(oid);
    if (obj === undefined || obj.type !== 'commit') continue;
    const commit = parseCommit(obj.data);
    includeTree(commit.tree);
    const stopped = stopParents !== undefined && stopParents.has(oid);
    const atLimit = depth !== undefined && gen >= depth - 1;
    if (!stopped && !atLimit) {
      for (const parent of commit.parents) pushCommit(parent, gen + 1);
    }
    included.add(oid);
  }

  const boundary = new Set<string>();
  for (const oid of included) {
    const obj = repo.objects.get(oid);
    if (obj === undefined || obj.type !== 'commit') continue;
    const parents = parseCommit(obj.data).parents;
    if (parents.length > 0 && parents.some((parent) => !included.has(parent))) boundary.add(oid);
  }
  return { included, boundary };
}

interface FetchPlan {
  pack: Buffer;
  shallow: string[];
  unshallow: string[];
}

function computeFetch(
  repo: Repo,
  wants: readonly string[],
  haves: readonly string[],
  clientShallow: readonly string[],
  depth: number | undefined,
): FetchPlan {
  const wantWalk = walkObjects(repo, wants, depth, undefined);
  const haveWalk =
    haves.length > 0
      ? walkObjects(repo, haves, undefined, new Set(clientShallow))
      : { included: new Set<string>(), boundary: new Set<string>() };
  const send = new Set<string>();
  for (const oid of wantWalk.included) {
    if (!haveWalk.included.has(oid)) send.add(oid);
  }
  const shallow: string[] = [];
  for (const oid of wantWalk.boundary) {
    if (send.has(oid)) shallow.push(oid);
  }
  shallow.sort();
  const unshallow: string[] = [];
  for (const oid of clientShallow) {
    if (!wantWalk.included.has(oid)) continue;
    const obj = repo.objects.get(oid);
    if (obj === undefined || obj.type !== 'commit') continue;
    const parents = parseCommit(obj.data).parents;
    if (parents.every((parent) => wantWalk.included.has(parent) || haveWalk.included.has(parent))) {
      unshallow.push(oid);
    }
  }
  unshallow.sort();
  return { pack: buildPack(repo, send), shallow, unshallow };
}

// ---------------------------------------------------------------------------------------------
// sideband framing for fetch / receive-pack responses
// ---------------------------------------------------------------------------------------------

function sidebandPackets(pack: Buffer): Buffer[] {
  const out: Buffer[] = [];
  for (let off = 0; off < pack.length; off += SIDEBAND_CHUNK) {
    const chunk = pack.subarray(off, Math.min(pack.length, off + SIDEBAND_CHUNK));
    out.push(pktLine(Buffer.concat([Buffer.from([1]), chunk])));
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// advertisements
// ---------------------------------------------------------------------------------------------

function v2Advertisement(): Buffer {
  return Buffer.concat([
    pktLine('version 2\n'),
    pktLine('ls-refs=unborn\n'),
    pktLine('fetch=shallow wait-for-done\n'),
    pktLine('object-format=sha1\n'),
    pktLine(`agent=${V2_AGENT}\n`),
    PKT_FLUSH,
  ]);
}

/** The v0 ref section: the first line carries the capabilities after a NUL. */
function v0RefSection(repo: Repo, caps: string): Buffer[] {
  const refs = sortedRefs(repo);
  if (refs.length === 0) {
    return [pktLine(`${ZERO_OID} capabilities^{}\0${caps}\n`)];
  }
  const lines: string[] = [];
  const headTip = resolveRef(repo, 'HEAD');
  if (headTip !== undefined) lines.push(`${headTip} HEAD`);
  for (const [name, oid] of refs) {
    lines.push(`${oid} ${name}`);
    const peeled = peelOid(repo, oid);
    if (peeled !== undefined && peeled !== oid) lines.push(`${peeled} ${name}^{}`);
  }
  return lines.map((line, index) => pktLine(index === 0 ? `${line}\0${caps}\n` : `${line}\n`));
}

function v0UploadAdvertisement(repo: Repo): Buffer {
  const caps =
    `side-band-64k thin-pack ofs-delta shallow multi_ack ` +
    `symref=HEAD:refs/heads/${repo.defaultBranch} agent=${V2_AGENT}`;
  return Buffer.concat([
    pktLine('# service=git-upload-pack\n'),
    PKT_FLUSH,
    ...v0RefSection(repo, caps),
    PKT_FLUSH,
  ]);
}

function v0ReceiveAdvertisement(repo: Repo): Buffer {
  const caps = `report-status side-band-64k delete-refs ofs-delta agent=${V2_AGENT}`;
  return Buffer.concat([
    pktLine('# service=git-receive-pack\n'),
    PKT_FLUSH,
    ...v0RefSection(repo, caps),
    PKT_FLUSH,
  ]);
}

// ---------------------------------------------------------------------------------------------
// request parsing
// ---------------------------------------------------------------------------------------------

function gitProtocolVersion(req: IncomingMessage): string {
  const value = req.headers['git-protocol'];
  return typeof value === 'string' ? value.trim().toLowerCase() : '';
}

/** Parse a v2 request: the command line, then arguments after the delim packet. */
function parseV2Request(body: Buffer): { command: string; args: string[] } {
  const { packets } = decodePackets(body, false);
  let command = '';
  const args: string[] = [];
  let seenDelim = false;
  for (const packet of packets) {
    if (packet.kind === 'delim') {
      seenDelim = true;
      continue;
    }
    if (packet.kind === 'flush') break;
    if (packet.kind !== 'data') continue;
    const text = packet.payload.toString('utf8').replace(/\n$/, '');
    if (!seenDelim) {
      if (text.startsWith('command=')) command = text.slice('command='.length);
      else if (text.startsWith('agent=') || text.startsWith('object-format=')) continue;
      else args.push(text);
    } else {
      args.push(text);
    }
  }
  if (command === '') throw new Error('v2 request has no command');
  return { command, args };
}

interface FetchArgs {
  wants: string[];
  haves: string[];
  shallow: string[];
  depth: number | undefined;
  /** True when the client sent `done`: negotiation is over. */
  done: boolean;
}

/** Pick wants/haves/shallow/deepen out of v2 fetch arguments. */
function parseV2FetchArgs(args: readonly string[]): FetchArgs {
  const out: FetchArgs = { wants: [], haves: [], shallow: [], depth: undefined, done: false };
  for (const arg of args) {
    if (arg.startsWith('want ')) out.wants.push(arg.slice(5).trim());
    else if (arg.startsWith('have ')) out.haves.push(arg.slice(5).trim());
    else if (arg.startsWith('shallow ')) out.shallow.push(arg.slice(8).trim());
    else if (arg === 'done') out.done = true;
    else if (arg.startsWith('deepen ')) {
      const n = Number(arg.slice(7).trim());
      if (Number.isInteger(n) && n > 0) out.depth = n;
    }
  }
  return out;
}

/** Pick wants/haves/shallow/deepen out of a v0 upload-pack request. */
function parseV0FetchRequest(body: Buffer): FetchArgs {
  const { packets } = decodePackets(body, false);
  const out: FetchArgs = { wants: [], haves: [], shallow: [], depth: undefined, done: false };
  for (const packet of packets) {
    if (packet.kind !== 'data') continue;
    const text = packet.payload.toString('utf8').replace(/\n$/, '');
    if (text.startsWith('want ')) out.wants.push(text.slice(5).split(' ')[0]);
    else if (text.startsWith('have ')) out.haves.push(text.slice(5).trim());
    else if (text.startsWith('shallow ')) out.shallow.push(text.slice(8).trim());
    else if (text.startsWith('deepen ')) {
      const n = Number(text.slice(7).trim());
      if (Number.isInteger(n) && n > 0) out.depth = n;
    }
  }
  return out;
}

interface PushCommand {
  oldOid: string;
  newOid: string;
  ref: string;
}

/** Parse a receive-pack command list; returns the commands and the raw pack bytes after the flush. */
function parseReceivePack(body: Buffer): { commands: PushCommand[]; pack: Buffer } {
  const { packets, consumed } = decodePackets(body, true);
  const commands: PushCommand[] = [];
  for (const packet of packets) {
    if (packet.kind !== 'data') continue;
    let text = packet.payload.toString('utf8');
    const nul = text.indexOf('\0');
    if (nul >= 0) text = text.slice(0, nul);
    text = text.replace(/\n$/, '');
    const parts = text.split(' ');
    if (parts.length < 3) throw new Error(`bad receive-pack command ${JSON.stringify(text.slice(0, 60))}`);
    const [oldOid, newOid, ref] = parts;
    if (!/^[0-9a-f]{40}$/.test(oldOid) || !/^[0-9a-f]{40}$/.test(newOid)) {
      throw new Error('receive-pack command has a bad object id');
    }
    if (!ref.startsWith('refs/')) throw new Error(`receive-pack command names a bad ref ${JSON.stringify(ref)}`);
    commands.push({ oldOid, newOid, ref });
  }
  if (commands.length === 0) throw new Error('receive-pack got no commands');
  return { commands, pack: body.subarray(consumed) };
}

// ---------------------------------------------------------------------------------------------
// responses
// ---------------------------------------------------------------------------------------------

function lsRefsResponse(
  repo: Repo,
  opts: { peel: boolean; symrefs: boolean; unborn: boolean; prefixes: string[] },
): Buffer {
  const parts: Buffer[] = [];
  const headTarget = `refs/heads/${repo.defaultBranch}`;
  const headTip = resolveRef(repo, 'HEAD');
  const matches = (name: string): boolean =>
    opts.prefixes.length === 0 || opts.prefixes.some((prefix) => name.startsWith(prefix));
  // HEAD is a ref like any other for prefix filtering: it matches a `HEAD`
  // prefix (which real git asks for on clone) and no `refs/...` prefix.
  if (matches('HEAD')) {
    if (headTip !== undefined) {
      parts.push(
        pktLine(`${headTip} HEAD${opts.symrefs ? ` symref-target:${headTarget}` : ''}\n`),
      );
    } else if (opts.unborn) {
      parts.push(pktLine(`unborn HEAD${opts.symrefs ? ` symref-target:${headTarget}` : ''}\n`));
    }
  }
  for (const [name, oid] of sortedRefs(repo)) {
    if (!matches(name)) continue;
    let line = `${oid} ${name}`;
    if (opts.peel) {
      const peeled = peelOid(repo, oid);
      if (peeled !== undefined && peeled !== oid) line += ` peeled:${peeled}`;
    }
    parts.push(pktLine(`${line}\n`));
  }
  parts.push(PKT_FLUSH);
  return Buffer.concat(parts);
}

/**
 * A v2 fetch response. The section layout depends on the request:
 * - with `done` (every request the suite's client and a real git clone send)
 *   the response is the shallow-info section, when there is one, and then the
 *   packfile section. There is no acknowledgments section: real git expects
 *   the packfile next and dies on an acknowledgments header here.
 * - without `done` (a real git fetch's negotiation round) the response opens
 *   with the acknowledgments section — ACK lines for the haves both sides
 *   hold, plus `ready`, or NAK when none is common — and then the packfile.
 * `acks` is null for the done case, otherwise the common-have oids (possibly
 * empty, which answers NAK).
 */
function fetchResponseV2(plan: FetchPlan, acks: readonly string[] | null): Buffer {
  const parts: Buffer[] = [];
  if (acks !== null) {
    parts.push(pktLine('acknowledgments\n'));
    if (acks.length > 0) {
      for (const oid of acks) parts.push(pktLine(`ACK ${oid}\n`));
      parts.push(pktLine('ready\n'));
    } else {
      parts.push(pktLine('NAK\n'));
    }
    parts.push(PKT_DELIM);
  }
  if (plan.shallow.length > 0 || plan.unshallow.length > 0) {
    parts.push(pktLine('shallow-info\n'));
    for (const oid of plan.shallow) parts.push(pktLine(`shallow ${oid}\n`));
    for (const oid of plan.unshallow) parts.push(pktLine(`unshallow ${oid}\n`));
    parts.push(PKT_DELIM);
  }
  parts.push(pktLine('packfile\n'));
  parts.push(...sidebandPackets(plan.pack));
  parts.push(PKT_FLUSH);
  return Buffer.concat(parts);
}

function fetchResponseV0(plan: FetchPlan): Buffer {
  const parts: Buffer[] = [pktLine('NAK\n')];
  for (const oid of plan.shallow) parts.push(pktLine(`shallow ${oid}\n`));
  for (const oid of plan.unshallow) parts.push(pktLine(`unshallow ${oid}\n`));
  parts.push(...sidebandPackets(plan.pack));
  parts.push(PKT_FLUSH);
  return Buffer.concat(parts);
}

interface RefReport {
  ref: string;
  ok: boolean;
  reason: string;
}

/** The report-status stream, pkt-lined inside sideband band 1. */
function receiveResponse(unpackOk: boolean, unpackDetail: string, refs: readonly RefReport[]): Buffer {
  const inner: Buffer[] = [pktLine(`unpack ${unpackOk ? 'ok' : unpackDetail}\n`)];
  for (const report of refs) {
    inner.push(pktLine(report.ok ? `ok ${report.ref}\n` : `ng ${report.ref} ${report.reason}\n`));
  }
  // The report-status stream ends with a flush inside band 1: without it a
  // real git client reads the two report lines and then reports that the
  // remote end hung up.
  inner.push(Buffer.from('0000', 'ascii'));
  const innerBytes = Buffer.concat(inner);
  const parts: Buffer[] = [];
  for (let off = 0; off < innerBytes.length; off += SIDEBAND_CHUNK) {
    const chunk = innerBytes.subarray(off, Math.min(innerBytes.length, off + SIDEBAND_CHUNK));
    parts.push(pktLine(Buffer.concat([Buffer.from([1]), chunk])));
  }
  parts.push(PKT_FLUSH);
  return Buffer.concat(parts);
}

// ---------------------------------------------------------------------------------------------
// handlers
// ---------------------------------------------------------------------------------------------

function handleInfoRefs(req: IncomingMessage, res: ServerResponse, repo: Repo, ctx: ReqCtx): void {
  const service = ctx.query.get('service');
  if (service === 'git-upload-pack') {
    if (gitProtocolVersion(req) === 'version=2') {
      sendBytes(res, 200, v2Advertisement(), 'application/x-git-upload-pack-advertisement');
    } else {
      sendBytes(res, 200, v0UploadAdvertisement(repo), 'application/x-git-upload-pack-advertisement');
    }
    return;
  }
  if (service === 'git-receive-pack') {
    sendBytes(res, 200, v0ReceiveAdvertisement(repo), 'application/x-git-receive-pack-advertisement');
    return;
  }
  notFound(res);
}

function handleUploadPack(req: IncomingMessage, res: ServerResponse, repo: Repo, ctx: ReqCtx): void {
  const isV2 = gitProtocolVersion(req) === 'version=2';
  if (isV2) {
    let parsed: { command: string; args: string[] };
    try {
      parsed = parseV2Request(ctx.body);
    } catch {
      badJson(res, 'malformed pkt-line request');
      return;
    }
    if (parsed.command === 'ls-refs') {
      const opts = { peel: false, symrefs: false, unborn: false, prefixes: [] as string[] };
      for (const arg of parsed.args) {
        if (arg === 'peel') opts.peel = true;
        else if (arg === 'symrefs') opts.symrefs = true;
        else if (arg === 'unborn') opts.unborn = true;
        else if (arg.startsWith('ref-prefix ')) opts.prefixes.push(arg.slice('ref-prefix '.length));
      }
      sendBytes(res, 200, lsRefsResponse(repo, opts), 'application/x-git-upload-pack-result');
      return;
    }
    if (parsed.command === 'fetch') {
      const fetchArgs = parseV2FetchArgs(parsed.args);
      for (const want of fetchArgs.wants) {
        if (!repo.objects.has(want)) {
          badJson(res, `want ${want} is not in the repository`);
          return;
        }
      }
      const plan = computeFetch(repo, fetchArgs.wants, fetchArgs.haves, fetchArgs.shallow, fetchArgs.depth);
      if (fetchArgs.done) {
        sendBytes(res, 200, fetchResponseV2(plan, null), 'application/x-git-upload-pack-result');
      } else {
        // A negotiation round: acknowledge the haves both sides hold.
        const wantWalk = walkObjects(repo, fetchArgs.wants, undefined, undefined);
        const common = fetchArgs.haves.filter((have) => wantWalk.included.has(have));
        sendBytes(res, 200, fetchResponseV2(plan, common), 'application/x-git-upload-pack-result');
      }
      return;
    }
    badJson(res, `unknown upload-pack command ${JSON.stringify(parsed.command)}`);
    return;
  }

  let fetchArgs: FetchArgs;
  try {
    fetchArgs = parseV0FetchRequest(ctx.body);
  } catch {
    badJson(res, 'malformed pkt-line request');
    return;
  }
  for (const want of fetchArgs.wants) {
    if (!repo.objects.has(want)) {
      badJson(res, `want ${want} is not in the repository`);
      return;
    }
  }
  const plan = computeFetch(repo, fetchArgs.wants, fetchArgs.haves, fetchArgs.shallow, fetchArgs.depth);
  sendBytes(res, 200, fetchResponseV0(plan), 'application/x-git-upload-pack-result');
}

function handleReceivePack(req: IncomingMessage, res: ServerResponse, repo: Repo, ctx: ReqCtx): void {
  let parsed: { commands: PushCommand[]; pack: Buffer };
  try {
    parsed = parseReceivePack(ctx.body);
  } catch {
    badJson(res, 'malformed pkt-line request');
    return;
  }
  const { commands, pack } = parsed;
  const updatesRef = commands.some((command) => command.newOid !== ZERO_OID);

  let unpackError: string | null = null;
  let unpacked: Map<string, GitObj> | null = null;
  if (pack.length > 0) {
    try {
      unpacked = readPackBytes(pack, repo);
    } catch (err) {
      unpackError = (err as Error).message;
    }
  } else if (updatesRef) {
    unpackError = 'a ref update arrived without a packfile';
  }

  if (unpackError !== null) {
    const refs = commands.map((command) => ({ ref: command.ref, ok: false, reason: 'unpack failed' }));
    sendBytes(
      res,
      200,
      receiveResponse(false, `error ${unpackError}`, refs),
      'application/x-git-receive-pack-result',
    );
    return;
  }
  if (unpacked !== null) {
    for (const [oid, obj] of unpacked) {
      const stored = putObject(repo, obj.type, obj.data);
      if (stored !== oid) {
        // putObject recomputes the SHA-1; a mismatch would mean corrupt data.
        badJson(res, 'unpacked object failed verification');
        return;
      }
    }
  }

  const reports: RefReport[] = [];
  for (const command of commands) {
    const current = repo.refs.get(command.ref);
    if (command.newOid === ZERO_OID) {
      if (current === undefined) {
        reports.push({ ref: command.ref, ok: false, reason: 'remote ref does not exist' });
      } else if (command.oldOid !== ZERO_OID && command.oldOid !== current) {
        reports.push({ ref: command.ref, ok: false, reason: 'non-fast-forward' });
      } else {
        repo.refs.delete(command.ref);
        reports.push({ ref: command.ref, ok: true, reason: '' });
      }
      continue;
    }
    if (current === undefined) {
      if (command.oldOid !== ZERO_OID) {
        reports.push({ ref: command.ref, ok: false, reason: 'non-fast-forward' });
      } else if (!repo.objects.has(command.newOid)) {
        reports.push({ ref: command.ref, ok: false, reason: 'missing object' });
      } else {
        repo.refs.set(command.ref, command.newOid);
        reports.push({ ref: command.ref, ok: true, reason: '' });
      }
      continue;
    }
    if (command.oldOid !== current) {
      reports.push({ ref: command.ref, ok: false, reason: 'non-fast-forward' });
    } else if (command.newOid === current) {
      reports.push({ ref: command.ref, ok: true, reason: '' });
    } else if (!repo.objects.has(command.newOid)) {
      reports.push({ ref: command.ref, ok: false, reason: 'missing object' });
    } else if (!isAncestor(repo, current, command.newOid)) {
      reports.push({ ref: command.ref, ok: false, reason: 'non-fast-forward' });
    } else {
      repo.refs.set(command.ref, command.newOid);
      reports.push({ ref: command.ref, ok: true, reason: '' });
    }
  }
  sendBytes(res, 200, receiveResponse(true, 'ok', reports), 'application/x-git-receive-pack-result');
}

// ---------------------------------------------------------------------------------------------
// entry point
// ---------------------------------------------------------------------------------------------

/** Split a request URL into owner, repo and the path after `.git`. */
function parseGitPath(req: IncomingMessage): { owner: string; repo: string; rest: string } | null {
  let pathname: string;
  try {
    pathname = new URL(req.url ?? '/', 'http://entry').pathname;
  } catch {
    return null;
  }
  const trimmed = pathname.length > 1 && pathname.endsWith('/') ? pathname.slice(0, -1) : pathname;
  const match = /^\/([^/]+)\/([^/]+)\.git(\/.*)?$/.exec(trimmed);
  if (match === null) return null;
  let owner: string;
  let repo: string;
  try {
    owner = decodeURIComponent(match[1]);
    repo = decodeURIComponent(match[2]);
  } catch {
    return null;
  }
  return { owner, repo, rest: match[3] ?? '' };
}

/**
 * Answer a git smart-HTTP request. Returns true when the request was answered
 * (including a 404 for a missing repository or a wrong owner), false when the
 * path is not a git route this module owns.
 */
export async function handleGit(req: IncomingMessage, res: ServerResponse, ctx: ReqCtx): Promise<boolean> {
  const parsed = parseGitPath(req);
  if (parsed === null) return false;
  try {
    if (parsed.owner !== VIEWER_LOGIN) {
      notFound(res);
      return true;
    }
    const repo = ctx.store.getRepo(parsed.owner, parsed.repo);
    if (repo === undefined) {
      notFound(res);
      return true;
    }
    const method = req.method ?? 'GET';
    if (method === 'GET' && parsed.rest === '/info/refs') {
      handleInfoRefs(req, res, repo, ctx);
      return true;
    }
    if (method === 'POST' && parsed.rest === '/git-upload-pack') {
      handleUploadPack(req, res, repo, ctx);
      return true;
    }
    if (method === 'POST' && parsed.rest === '/git-receive-pack') {
      handleReceivePack(req, res, repo, ctx);
      return true;
    }
    notFound(res);
    return true;
  } catch {
    if (!res.writableEnded) {
      try {
        sendJson(res, 500, { message: 'Internal Server Error' });
      } catch {
        // The response is already gone; there is nothing left to answer with.
      }
    }
    return true;
  }
}
