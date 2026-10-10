/**
 * SSRF-safe HTTP(S) fetch for user-supplied URLs.
 *
 * - Only http: / https: are allowed.
 * - Every hostname is resolved and rejected when ANY address is private, loopback,
 *   link-local, CGNAT, multicast, reserved, etc. This covers internal Docker service
 *   names (e.g. "redis", "falkordb"), which resolve to private bridge-network IPs.
 * - The same check runs again inside the socket's DNS lookup, so the address that is
 *   actually connected to is the one that was validated (no DNS-rebinding window).
 * - Redirects are followed manually (max 5) and every hop is re-validated.
 * - Response bodies are size-capped and the whole request is time-boxed.
 *
 * Returns a standard WHATWG `Response` so callers can use .ok/.headers/.text()/.arrayBuffer().
 */

import * as dns from "dns";
import * as http from "http";
import * as https from "https";
import * as net from "net";
import * as zlib from "zlib";

export class SsrfBlockedError extends Error {
  constructor(message: string) {
    super(`SSRF blocked: ${message}`);
    this.name = "SsrfBlockedError";
  }
}

export interface SafeFetchOptions {
  headers?: Record<string, string>;
  /** Abort after this many ms (default 30 s). */
  timeoutMs?: number;
  /** Maximum decoded body size in bytes (default 50 MB). */
  maxBytes?: number;
  /** Maximum number of redirects to follow (default 5). */
  maxRedirects?: number;
}

const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_BYTES = 50 * 1024 * 1024;
const DEFAULT_MAX_REDIRECTS = 5;

// ─── Address classification ──────────────────────────────────────────────────

// Separate lists: a single BlockList would match every IPv4 address against the
// IPv4-mapped IPv6 rule (::ffff:0:0/96).
const blockListV4 = new net.BlockList();
const blockListV6 = new net.BlockList();
const V4_BLOCKED: Array<[string, number]> = [
  ["0.0.0.0", 8],        // "this" network
  ["10.0.0.0", 8],       // RFC 1918
  ["100.64.0.0", 10],    // CGNAT
  ["127.0.0.0", 8],      // loopback
  ["169.254.0.0", 16],   // link-local / cloud metadata
  ["172.16.0.0", 12],    // RFC 1918 (Docker bridge networks live here)
  ["192.0.0.0", 24],     // IETF protocol assignments
  ["192.0.2.0", 24],     // TEST-NET-1
  ["192.88.99.0", 24],   // 6to4 relay anycast
  ["192.168.0.0", 16],   // RFC 1918
  ["198.18.0.0", 15],    // benchmarking
  ["198.51.100.0", 24],  // TEST-NET-2
  ["203.0.113.0", 24],   // TEST-NET-3
  ["224.0.0.0", 4],      // multicast
  ["240.0.0.0", 4],      // reserved + broadcast
];
const V6_BLOCKED: Array<[string, number]> = [
  ["::", 96],            // unspecified, loopback, IPv4-compatible (deprecated)
  ["::ffff:0:0", 96],    // IPv4-mapped
  ["::ffff:0:0:0", 96],  // IPv4-translated
  ["64:ff9b::", 96],     // NAT64
  ["64:ff9b:1::", 48],   // local-use NAT64
  ["100::", 64],         // discard
  ["2001::", 23],        // IETF protocol assignments (Teredo, ORCHID, benchmarking, ...)
  ["2001:db8::", 32],    // documentation
  ["2002::", 16],        // 6to4 (can embed private IPv4)
  ["fc00::", 7],         // unique local
  ["fe80::", 10],        // link-local
  ["fec0::", 10],        // site-local (deprecated)
  ["ff00::", 8],         // multicast
];
for (const [addr, prefix] of V4_BLOCKED) blockListV4.addSubnet(addr, prefix, "ipv4");
for (const [addr, prefix] of V6_BLOCKED) blockListV6.addSubnet(addr, prefix, "ipv6");


/** True when the IP literal is not a publicly routable unicast address. Non-IPs return true. */
export function isPrivateAddress(address: string): boolean {
  let ip = address.trim();
  if (ip.startsWith("[") && ip.endsWith("]")) ip = ip.slice(1, -1);
  const zone = ip.indexOf("%");
  if (zone >= 0) ip = ip.slice(0, zone);

  const family = net.isIP(ip);
  if (family === 4) return blockListV4.check(ip, "ipv4");
  if (family === 6) {
    // IPv4-mapped/translated forms are never needed for public content; they are blocked
    // outright by ::ffff:0:0/96 and 64:ff9b::/96.
    return blockListV6.check(ip, "ipv6");
  }
  return true;
}

// ─── DNS ─────────────────────────────────────────────────────────────────────

export type ResolveFn = (hostname: string) => Promise<Array<{ address: string; family: number }>>;

const defaultResolve: ResolveFn = (hostname) =>
  dns.promises.lookup(hostname, { all: true, verbatim: true });

let resolveHost: ResolveFn = defaultResolve;

/** Test hook: replace DNS resolution (pass null to restore the system resolver). */
export function __setResolverForTest(fn: ResolveFn | null): void {
  resolveHost = fn ?? defaultResolve;
}

function bareHostname(url: URL): string {
  const h = url.hostname.toLowerCase();
  return h.startsWith("[") && h.endsWith("]") ? h.slice(1, -1) : h;
}

/**
 * Validate a URL as a public http(s) target. Resolves the hostname and throws
 * SsrfBlockedError when it is (or resolves to) a non-public address.
 */
export async function assertPublicUrl(rawUrl: string): Promise<URL> {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new Error(`Invalid URL: ${rawUrl}`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error(`Unsupported URL protocol: ${url.protocol}. Use http:// or https://`);
  }
  const host = bareHostname(url);
  if (!host) throw new Error(`Invalid URL: ${rawUrl}`);
  if (host === "localhost" || host.endsWith(".localhost")) {
    throw new SsrfBlockedError(`private/internal URL not allowed — ${rawUrl}`);
  }

  if (net.isIP(host)) {
    if (isPrivateAddress(host)) throw new SsrfBlockedError(`private/internal URL not allowed — ${rawUrl}`);
    return url;
  }

  let addresses: Array<{ address: string; family: number }>;
  try {
    addresses = await resolveHost(host);
  } catch (err) {
    throw new Error(`Could not resolve host ${host}: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (addresses.length === 0) throw new Error(`Could not resolve host ${host}`);
  const bad = addresses.find(a => isPrivateAddress(a.address));
  if (bad) {
    throw new SsrfBlockedError(`${host} resolves to a private/internal address (${bad.address})`);
  }
  return url;
}

/**
 * Socket-level lookup used by http(s).request: re-validates the addresses actually
 * being connected to, closing the DNS-rebinding window between check and connect.
 */
function guardedLookup(
  hostname: string,
  options: dns.LookupOptions,
  callback: (err: NodeJS.ErrnoException | null, address: string | dns.LookupAddress[], family?: number) => void
): void {
  resolveHost(hostname).then(
    (addresses) => {
      if (addresses.length === 0) {
        callback(Object.assign(new Error(`Could not resolve host ${hostname}`), { code: "ENOTFOUND" }), "");
        return;
      }
      const bad = addresses.find(a => isPrivateAddress(a.address));
      if (bad) {
        callback(new SsrfBlockedError(`${hostname} resolves to a private/internal address (${bad.address})`), "");
        return;
      }
      const wanted = options.family === 4 || options.family === 6
        ? addresses.filter(a => a.family === options.family)
        : addresses;
      const list = wanted.length ? wanted : addresses;
      if (options.all) callback(null, list);
      else callback(null, list[0].address, list[0].family);
    },
    (err) => callback(err as NodeJS.ErrnoException, "")
  );
}

// ─── Fetch ───────────────────────────────────────────────────────────────────

interface RawResponse {
  status: number;
  statusText: string;
  headers: http.IncomingHttpHeaders;
  body: Buffer;
}

type ResolvedOptions = SafeFetchOptions & { timeoutMs: number; maxBytes: number };

function requestOnce(url: URL, opts: ResolvedOptions): Promise<RawResponse> {
  const mod = url.protocol === "https:" ? https : http;
  return new Promise((resolve, reject) => {
    const req = mod.request(
      url,
      {
        method: "GET",
        headers: {
          "user-agent": "PoCW-Engine/1.0 (+content indexer)",
          "accept-encoding": "gzip, deflate, br",
          ...(opts.headers ?? {}),
        },
        lookup: guardedLookup as unknown as typeof dns.lookup,
        timeout: opts.timeoutMs,
      },
      (res) => {
        const status = res.statusCode ?? 0;
        if (status >= 300 && status < 400 && res.headers.location) {
          res.resume(); // redirect: body not needed
          resolve({ status, statusText: res.statusMessage ?? "", headers: res.headers, body: Buffer.alloc(0) });
          return;
        }

        const encoding = String(res.headers["content-encoding"] ?? "").toLowerCase();
        let stream: NodeJS.ReadableStream = res;
        if (encoding === "gzip" || encoding === "x-gzip") stream = res.pipe(zlib.createGunzip());
        else if (encoding === "deflate") stream = res.pipe(zlib.createInflate());
        else if (encoding === "br") stream = res.pipe(zlib.createBrotliDecompress());

        const chunks: Buffer[] = [];
        let total = 0;
        stream.on("data", (chunk: Buffer) => {
          total += chunk.length;
          if (total > opts.maxBytes) {
            req.destroy(new Error(`Response body exceeds ${opts.maxBytes} bytes`));
            return;
          }
          chunks.push(chunk);
        });
        stream.on("end", () => {
          const headers = { ...res.headers };
          if (encoding) delete headers["content-encoding"];
          delete headers["content-length"];
          resolve({ status, statusText: res.statusMessage ?? "", headers, body: Buffer.concat(chunks) });
        });
        stream.on("error", reject);
        res.on("error", reject);
      }
    );
    // Socket `timeout` is only an idle timeout; this bounds the whole request (slow-drip bodies).
    const deadline = setTimeout(
      () => req.destroy(new Error(`Request timed out after ${opts.timeoutMs} ms`)),
      opts.timeoutMs
    );
    deadline.unref();
    req.on("close", () => clearTimeout(deadline));
    req.on("timeout", () => req.destroy(new Error(`Request timed out after ${opts.timeoutMs} ms`)));
    req.on("error", reject);
    req.end();
  });
}

function toResponse(raw: RawResponse): Response {
  const headers = new Headers();
  for (const [k, v] of Object.entries(raw.headers)) {
    if (v === undefined) continue;
    if (Array.isArray(v)) v.forEach(item => headers.append(k, item));
    else headers.set(k, String(v));
  }
  const nullBody = [101, 204, 205, 304].includes(raw.status);
  return new Response(nullBody ? null : raw.body, {
    status: raw.status,
    statusText: raw.statusText,
    headers,
  });
}

/**
 * GET a user-supplied URL with SSRF protection (see module docs).
 * Throws SsrfBlockedError when any hop targets a non-public address.
 */
export async function safeFetch(rawUrl: string, options: SafeFetchOptions = {}): Promise<Response> {
  return toResponse((await fetchRaw(rawUrl, options)).raw);
}

/** Result of safeFetchBuffer: the body as one Buffer (no WHATWG Response copies). */
export interface BufferResponse {
  ok: boolean;
  status: number;
  /** Lower-cased Content-Type header ("" when absent). */
  contentType: string;
  /** URL of the final hop (after redirects). */
  url: string;
  body: Buffer;
}

/**
 * Same protections as safeFetch, but returns the body as a single Buffer. Use for large
 * downloads (books up to tens of MB) so the body is not copied again into a Response.
 */
export async function safeFetchBuffer(rawUrl: string, options: SafeFetchOptions = {}): Promise<BufferResponse> {
  const { raw, url } = await fetchRaw(rawUrl, options);
  const ct = raw.headers["content-type"];
  return {
    ok: raw.status >= 200 && raw.status < 300,
    status: raw.status,
    contentType: String(Array.isArray(ct) ? ct[0] : ct ?? "").toLowerCase(),
    url,
    body: raw.body,
  };
}

async function fetchRaw(rawUrl: string, options: SafeFetchOptions): Promise<{ raw: RawResponse; url: string }> {
  const opts: ResolvedOptions = {
    ...options,
    timeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    maxBytes: options.maxBytes ?? DEFAULT_MAX_BYTES,
  };
  const maxRedirects = options.maxRedirects ?? DEFAULT_MAX_REDIRECTS;

  let current = rawUrl;
  for (let hop = 0; hop <= maxRedirects; hop++) {
    const url = await assertPublicUrl(current);
    const raw = await requestOnce(url, opts);
    const location = raw.headers.location;
    if (raw.status >= 300 && raw.status < 400 && location) {
      current = new URL(location, url).toString();
      continue;
    }
    return { raw, url: url.toString() };
  }
  throw new Error(`Too many redirects (>${maxRedirects}) fetching ${rawUrl}`);
}
