/**
 * @file LatticeDX — Open Digital Enterprise Platform
 * @author CTU-OpenPaw
 * @copyright (C) 2026 CTU-OpenPaw
 * @license Apache-2.0
 * @see https://github.com/CTU-OpenPaw/lattice-dx
 * SPDX-License-Identifier: Apache-2.0
 */
import { createHash, createHmac } from 'node:crypto';

export interface S3Config {
  endpoint: string;
  accessKeyId: string;
  secretAccessKey: string;
  bucket?: string;
  region?: string;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

export interface SigV4SignInput {
  method: string;
  host: string;
  canonicalUri: string;
  query?: Record<string, string>;
  extraHeaders?: Record<string, string>;
  payloadHash: string;
  accessKeyId: string;
  secretAccessKey: string;
  region: string;
  date?: Date;
}

export interface RustfsS3Client {
  ensureBucket(): Promise<void>;
  putObject(
    key: string,
    body: Buffer | string,
    contentType?: string,
    options?: { ifNoneMatch?: string },
  ): Promise<'created' | 'precondition_failed'>;
  getObject(key: string): Promise<Buffer | undefined>;
  listKeys(prefix: string): Promise<string[]>;
}

const BUCKET_RE = /^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/;
const EMPTY_SHA256 = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';

function rfc3986Encode(value: string): string {
  return encodeURIComponent(value).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
}

function encodeS3Path(key: string): string {
  if (!key || key.startsWith('/')) {
    throw new Error('Invalid S3 object key');
  }
  const segments = key.split('/');
  if (segments.some((seg) => !seg || seg === '.' || seg === '..')) {
    throw new Error('Invalid S3 object key');
  }
  return segments.map(rfc3986Encode).join('/');
}

function sha256Hex(data: Buffer | string): string {
  return createHash('sha256').update(data).digest('hex');
}

function hmacSha256(key: Buffer | string, data: string): Buffer {
  return createHmac('sha256', key).update(data).digest();
}

function formatAmzDate(date: Date): string {
  return date.toISOString().replace(/[:-]|\.\d{3}/g, '');
}

function decodeXmlEntities(value: string): string {
  return value.replace(/&(#x[0-9a-fA-F]+|#\d+|amp|lt|gt|quot|apos);/g, (_match, entity: string) => {
    if (entity === 'amp') return '&';
    if (entity === 'lt') return '<';
    if (entity === 'gt') return '>';
    if (entity === 'quot') return '"';
    if (entity === 'apos') return "'";
    if (entity.startsWith('#x')) return String.fromCodePoint(Number.parseInt(entity.slice(2), 16));
    return String.fromCodePoint(Number.parseInt(entity.slice(1), 10));
  });
}

function parseListObjectsXml(xml: string): { keys: string[]; nextToken?: string } {
  const keys: string[] = [];
  const contentsRe = /<Contents\b[^>]*>([\s\S]*?)<\/Contents>/g;
  for (const match of xml.matchAll(contentsRe)) {
    const keyMatch = match[1].match(/<Key>([\s\S]*?)<\/Key>/);
    if (keyMatch) keys.push(decodeXmlEntities(keyMatch[1]));
  }
  const truncated = /<IsTruncated>\s*true\s*<\/IsTruncated>/i.test(xml);
  const nextMatch = xml.match(/<NextContinuationToken>([\s\S]*?)<\/NextContinuationToken>/);
  const nextToken = truncated && nextMatch ? decodeXmlEntities(nextMatch[1]) : undefined;
  return { keys, nextToken };
}

function compareCodePoint(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

export function signAwsSigV4(input: SigV4SignInput): { headers: Record<string, string>; queryString: string } {
  const amzDate = formatAmzDate(input.date ?? new Date());
  const dateStamp = amzDate.slice(0, 8);
  const queryEntries = Object.entries(input.query ?? {})
    .map(([k, v]) => [rfc3986Encode(k), rfc3986Encode(v)] as const)
    .sort((a, b) => compareCodePoint(a[0], b[0]) || compareCodePoint(a[1], b[1]));
  const queryString = queryEntries.map(([k, v]) => `${k}=${v}`).join('&');

  const headerMap = new Map<string, string>();
  headerMap.set('host', input.host);
  headerMap.set('x-amz-content-sha256', input.payloadHash);
  headerMap.set('x-amz-date', amzDate);
  for (const [rawName, rawValue] of Object.entries(input.extraHeaders ?? {})) {
    headerMap.set(rawName.toLowerCase(), rawValue.trim());
  }

  const sortedNames = [...headerMap.keys()].sort();
  const canonicalHeaders = sortedNames.map((name) => `${name}:${headerMap.get(name)}\n`).join('');
  const signedHeaders = sortedNames.join(';');

  const canonicalRequest = [
    input.method.toUpperCase(),
    input.canonicalUri,
    queryString,
    canonicalHeaders,
    signedHeaders,
    input.payloadHash,
  ].join('\n');

  const credentialScope = `${dateStamp}/${input.region}/s3/aws4_request`;
  const stringToSign = [
    'AWS4-HMAC-SHA256',
    amzDate,
    credentialScope,
    sha256Hex(canonicalRequest),
  ].join('\n');

  const kDate = hmacSha256(`AWS4${input.secretAccessKey}`, dateStamp);
  const kRegion = hmacSha256(kDate, input.region);
  const kService = hmacSha256(kRegion, 's3');
  const kSigning = hmacSha256(kService, 'aws4_request');
  const signature = createHmac('sha256', kSigning).update(stringToSign).digest('hex');

  const headers: Record<string, string> = {};
  for (const name of sortedNames) {
    if (name !== 'host') {
      headers[name] = headerMap.get(name)!;
    }
  }
  headers.authorization = `AWS4-HMAC-SHA256 Credential=${input.accessKeyId}/${credentialScope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;

  return { headers, queryString };
}

export function createRustfsS3Client(config: S3Config): RustfsS3Client {
  let endpointUrl: URL;
  try {
    endpointUrl = new URL(config.endpoint);
  } catch {
    throw new Error('Invalid S3_ENDPOINT URL');
  }
  if (
    !['http:', 'https:'].includes(endpointUrl.protocol) ||
    !endpointUrl.hostname ||
    endpointUrl.username ||
    endpointUrl.password ||
    endpointUrl.search ||
    endpointUrl.hash
  ) {
    throw new Error('Invalid S3_ENDPOINT URL');
  }
  if (!config.accessKeyId.trim() || /[\r\n]/.test(config.accessKeyId)) {
    throw new Error('Invalid S3_ACCESS_KEY_ID');
  }
  if (!config.secretAccessKey.trim() || /[\r\n]/.test(config.secretAccessKey)) {
    throw new Error('Invalid S3_SECRET_ACCESS_KEY');
  }
  const bucket = config.bucket ?? 'latticedx-native-files';
  if (!BUCKET_RE.test(bucket) || bucket.includes('..')) {
    throw new Error('Invalid S3_BUCKET');
  }
  const region = config.region?.trim() || 'us-east-1';
  const timeoutMs = config.timeoutMs ?? 15_000;
  const fetchImpl = config.fetchImpl ?? fetch;
  const basePath = endpointUrl.pathname.replace(/\/+$/, '');
  const origin = endpointUrl.origin;

  let bucketReady: Promise<void> | undefined;

  async function sendSigned(
    method: string,
    canonicalUri: string,
    options: {
      query?: Record<string, string>;
      body?: Buffer;
      extraHeaders?: Record<string, string>;
    } = {},
  ): Promise<Response> {
    const payloadHash = options.body ? sha256Hex(options.body) : EMPTY_SHA256;
    const { headers, queryString } = signAwsSigV4({
      method,
      host: endpointUrl.host,
      canonicalUri,
      query: options.query,
      extraHeaders: options.extraHeaders,
      payloadHash,
      accessKeyId: config.accessKeyId,
      secretAccessKey: config.secretAccessKey,
      region,
    });
    const requestUrl = queryString ? `${origin}${canonicalUri}?${queryString}` : `${origin}${canonicalUri}`;
    return fetchImpl(requestUrl, {
      method,
      headers,
      body: options.body ? new Uint8Array(options.body) : undefined,
      redirect: 'error',
      signal: AbortSignal.timeout(timeoutMs),
    });
  }

  async function ensureBucket(): Promise<void> {
    if (bucketReady) return bucketReady;
    bucketReady = (async () => {
      const bucketUri = `${basePath}/${rfc3986Encode(bucket)}`;
      const head = await sendSigned('HEAD', bucketUri);
      await head.body?.cancel();
      if (head.status === 200 || head.status === 204) return;
      if (head.status !== 404) {
        throw new Error(`S3 bucket check failed (${head.status})`);
      }
      const create = await sendSigned('PUT', bucketUri);
      await create.body?.cancel();
      if (![200, 201, 204, 409].includes(create.status)) {
        throw new Error(`S3 bucket creation failed (${create.status})`);
      }
    })();
    try {
      await bucketReady;
    } catch (error) {
      bucketReady = undefined;
      throw error;
    }
  }

  return {
    ensureBucket,
    async putObject(
      key: string,
      body: Buffer | string,
      contentType = 'application/octet-stream',
      options?: { ifNoneMatch?: string },
    ): Promise<'created' | 'precondition_failed'> {
      await ensureBucket();
      const buffer = typeof body === 'string' ? Buffer.from(body, 'utf8') : body;
      const canonicalUri = `${basePath}/${rfc3986Encode(bucket)}/${encodeS3Path(key)}`;
      const extraHeaders: Record<string, string> = { 'content-type': contentType };
      if (options?.ifNoneMatch) {
        extraHeaders['if-none-match'] = options.ifNoneMatch;
      }
      const response = await sendSigned('PUT', canonicalUri, { body: buffer, extraHeaders });
      await response.body?.cancel();
      if (options?.ifNoneMatch && (response.status === 412 || response.status === 409)) {
        return 'precondition_failed';
      }
      if (![200, 201, 204].includes(response.status)) {
        throw new Error(`S3 putObject failed (${response.status})`);
      }
      return 'created';
    },
    async getObject(key: string): Promise<Buffer | undefined> {
      await ensureBucket();
      const canonicalUri = `${basePath}/${rfc3986Encode(bucket)}/${encodeS3Path(key)}`;
      const response = await sendSigned('GET', canonicalUri);
      if (response.status === 404) {
        await response.body?.cancel();
        return undefined;
      }
      if (!response.ok) {
        await response.body?.cancel();
        throw new Error(`S3 getObject failed (${response.status})`);
      }
      return Buffer.from(await response.arrayBuffer());
    },
    async listKeys(prefix: string): Promise<string[]> {
      await ensureBucket();
      const bucketUri = `${basePath}/${rfc3986Encode(bucket)}`;
      const allKeys: string[] = [];
      let continuationToken: string | undefined;

      for (;;) {
        const query: Record<string, string> = { 'list-type': '2', prefix };
        if (continuationToken) {
          query['continuation-token'] = continuationToken;
        }
        const response = await sendSigned('GET', bucketUri, { query });
        if (!response.ok) {
          await response.body?.cancel();
          throw new Error(`S3 listKeys failed (${response.status})`);
        }
        const xml = await response.text();
        const parsed = parseListObjectsXml(xml);
        allKeys.push(...parsed.keys);
        if (!parsed.nextToken) break;
        continuationToken = parsed.nextToken;
      }

      return allKeys;
    },
  };
}
