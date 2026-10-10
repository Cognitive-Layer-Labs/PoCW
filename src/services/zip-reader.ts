/**
 * Minimal, defensive ZIP reader (read-only, in-memory) — enough for EPUB.
 *
 * Built on Node's zlib instead of a third-party zip library: an EPUB only needs the central
 * directory plus stored/deflated entries. Hardening:
 *   - entry count is capped (ZIP_MAX_ENTRIES) before anything is decompressed;
 *   - every inflate runs with zlib's `maxOutputLength`, so the cap holds even when an entry
 *     lies about its uncompressed size (zip bomb);
 *   - callers pass a shared ZipBudget, so the TOTAL decompressed size is capped as well;
 *   - all offsets are bounds-checked; encrypted, ZIP64 and exotic compression methods are refused.
 */

import * as zlib from "zlib";

export const ZIP_MAX_ENTRIES = 10_000;
/** Total bytes a single archive may decompress to (see ZipBudget). */
export const ZIP_MAX_TOTAL_UNCOMPRESSED = 60 * 1024 * 1024;

export class ZipError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ZipError";
  }
}

export interface ZipEntry {
  name: string;
  method: number;
  flags: number;
  compressedSize: number;
  uncompressedSize: number;
  localHeaderOffset: number;
}

/** Remaining decompression allowance, shared by all reads from one archive. */
export interface ZipBudget {
  remaining: number;
}

export function newZipBudget(bytes = ZIP_MAX_TOTAL_UNCOMPRESSED): ZipBudget {
  return { remaining: bytes };
}

const SIG_LOCAL = 0x04034b50;
const SIG_CENTRAL = 0x02014b50;
const SIG_EOCD = 0x06054b50;

/** True when the buffer starts like a ZIP archive ("PK\x03\x04"). */
export function looksLikeZip(buf: Buffer): boolean {
  return buf.length >= 4 && buf.readUInt32LE(0) === SIG_LOCAL;
}

function findEndOfCentralDirectory(buf: Buffer): number {
  // EOCD is 22 bytes + an optional comment of up to 65535 bytes.
  const min = Math.max(0, buf.length - 22 - 0xffff);
  for (let i = buf.length - 22; i >= min; i--) {
    if (buf.readUInt32LE(i) === SIG_EOCD) return i;
  }
  throw new ZipError("Not a ZIP archive (no end of central directory)");
}

/** List the entries of an in-memory ZIP archive (central directory only, nothing inflated). */
export function listZipEntries(buf: Buffer, maxEntries = ZIP_MAX_ENTRIES): ZipEntry[] {
  if (buf.length < 22) throw new ZipError("Not a ZIP archive (too small)");
  const eocd = findEndOfCentralDirectory(buf);
  const count = buf.readUInt16LE(eocd + 10);
  const cdSize = buf.readUInt32LE(eocd + 12);
  const cdOffset = buf.readUInt32LE(eocd + 16);
  if (count === 0xffff || cdOffset === 0xffffffff || cdSize === 0xffffffff) {
    throw new ZipError("ZIP64 archives are not supported");
  }
  if (count > maxEntries) throw new ZipError(`ZIP has too many entries (${count} > ${maxEntries})`);
  if (cdOffset + cdSize > buf.length) throw new ZipError("Corrupt ZIP (central directory out of bounds)");

  const entries: ZipEntry[] = [];
  let p = cdOffset;
  for (let i = 0; i < count; i++) {
    if (p + 46 > buf.length || buf.readUInt32LE(p) !== SIG_CENTRAL) {
      throw new ZipError("Corrupt ZIP (bad central directory entry)");
    }
    const flags = buf.readUInt16LE(p + 8);
    const method = buf.readUInt16LE(p + 10);
    const compressedSize = buf.readUInt32LE(p + 20);
    const uncompressedSize = buf.readUInt32LE(p + 24);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const localHeaderOffset = buf.readUInt32LE(p + 42);
    if (p + 46 + nameLen > buf.length) throw new ZipError("Corrupt ZIP (entry name out of bounds)");
    // Bit 11 = UTF-8 names; EPUB requires UTF-8 anyway, and latin1 names only matter for lookups.
    const name = buf.toString(flags & 0x800 ? "utf8" : "latin1", p + 46, p + 46 + nameLen);
    entries.push({ name, method, flags, compressedSize, uncompressedSize, localHeaderOffset });
    p += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
}

/**
 * Decompress one entry. Charges the actual output size to `budget` and throws when either the
 * budget or `maxBytes` (per entry) would be exceeded — whatever the entry header claims.
 */
export function readZipEntry(buf: Buffer, entry: ZipEntry, budget: ZipBudget, maxBytes = Infinity): Buffer {
  if (entry.flags & 0x1) throw new ZipError(`Encrypted ZIP entries are not supported (${entry.name})`);
  const h = entry.localHeaderOffset;
  if (h + 30 > buf.length || buf.readUInt32LE(h) !== SIG_LOCAL) {
    throw new ZipError(`Corrupt ZIP (bad local header for ${entry.name})`);
  }
  const start = h + 30 + buf.readUInt16LE(h + 26) + buf.readUInt16LE(h + 28);
  const end = start + entry.compressedSize;
  if (end > buf.length) throw new ZipError(`Corrupt ZIP (data out of bounds for ${entry.name})`);
  const data = buf.subarray(start, end);

  const limit = Math.min(maxBytes, budget.remaining);
  let out: Buffer;
  if (entry.method === 0) {
    if (data.length > limit) throw new ZipError(`ZIP entry too large: ${entry.name}`);
    out = data;
  } else if (entry.method === 8) {
    try {
      out = zlib.inflateRawSync(data, { maxOutputLength: Math.max(1, limit) });
    } catch (err) {
      if (err instanceof RangeError || (err as NodeJS.ErrnoException)?.code === "ERR_BUFFER_TOO_LARGE") {
        throw new ZipError(`ZIP entry too large (decompression limit reached): ${entry.name}`);
      }
      throw new ZipError(`Corrupt ZIP entry ${entry.name}: ${(err as Error).message}`);
    }
  } else {
    throw new ZipError(`Unsupported ZIP compression method ${entry.method} (${entry.name})`);
  }
  budget.remaining -= out.length;
  return out;
}
