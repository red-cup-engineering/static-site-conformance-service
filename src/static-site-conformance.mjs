import { canonicalJson } from '@red-cup-engineering/json-services-section/canonical-json';
import { makeNiUri } from "@red-cup-engineering/uri-services-section/ni-uri";

const LINK_ATTRIBUTES = Object.freeze(new Map([
  ['a', ['href']], ['area', ['href']], ['audio', ['src']], ['embed', ['src']],
  ['form', ['action']], ['iframe', ['src']], ['img', ['src']], ['input', ['src']],
  ['link', ['href']], ['object', ['data']], ['script', ['src']], ['source', ['src']],
  ['track', ['src']], ['video', ['src', 'poster']],
]));
const SAFE_NON_HTTP_SCHEMES = new Set(['mailto:', 'tel:']);

/** Extract and resolve browser-facing HTML references without mutating the document. */
export function extractHtmlLinks(html, { documentUrl, canonicalOrigin } = {}) {
  if (typeof html !== 'string') throw new TypeError('html must be a string');
  const document = httpDirectoryOrDocumentUrl(documentUrl, 'documentUrl');
  const canonical = canonicalOrigin === undefined ? document.origin : httpOrigin(canonicalOrigin, 'canonicalOrigin');
  const diagnostics = [];
  const links = [];
  let base = document;
  const baseTag = [...openingTags(html)].find((match) => match[1].toLowerCase() === 'base');
  if (baseTag !== undefined) {
    const rawBase = attributeValue(baseTag[0], 'href');
    if (rawBase !== undefined) {
      const resolved = resolveReference(rawBase, document);
      if (resolved.problem !== undefined || !['http:', 'https:'].includes(resolved.url?.protocol)) {
        diagnostics.push(diagnostic('SSC-101', 'HTML base href is not a safe HTTP(S) reference', document.href, rawBase));
      } else {
        base = resolved.url;
        if (base.origin !== document.origin) {
          diagnostics.push(diagnostic(base.origin === canonical ? 'SSC-102' : 'SSC-103', base.origin === canonical
            ? 'HTML base href escapes the delivery origin to the canonical origin'
            : 'HTML base href escapes the delivery origin', document.href, base.href));
        }
      }
    }
  }
  for (const match of openingTags(html)) {
    const tag = match[1].toLowerCase();
    const attributes = LINK_ATTRIBUTES.get(tag);
    if (attributes === undefined) continue;
    for (const attribute of attributes) {
      const raw = attributeValue(match[0], attribute);
      if (raw === undefined || raw.trim() === '' || raw.trim().startsWith('#')) continue;
      const resolved = resolveReference(raw, base);
      if (resolved.problem !== undefined) {
        diagnostics.push(diagnostic('SSC-101', resolved.problem, document.href, raw));
        links.push(Object.freeze({ tag, attribute, raw, kind: 'unsafe' }));
        continue;
      }
      const url = resolved.url;
      if (!['http:', 'https:'].includes(url.protocol)) {
        const safe = SAFE_NON_HTTP_SCHEMES.has(url.protocol);
        links.push(Object.freeze({ tag, attribute, raw, url: url.href, kind: safe ? 'external' : 'unsafe' }));
        if (!safe) diagnostics.push(diagnostic('SSC-101', `unsafe URL scheme: ${url.protocol}`, document.href, raw));
        continue;
      }
      const kind = url.origin === document.origin ? 'internal'
        : url.origin === canonical && canonical !== document.origin ? 'canonical-origin-escape' : 'external';
      links.push(Object.freeze({ tag, attribute, raw, url: url.href, kind }));
      if (kind === 'canonical-origin-escape') {
        diagnostics.push(diagnostic('SSC-102', 'reference escapes the delivery origin to the canonical origin', document.href, url.href));
      }
    }
  }
  return deepFreeze({ documentUrl: document.href, baseUrl: base.href, links, diagnostics });
}

/** Check every HTML artifact's internal references against one completed inventory. */
export function checkStaticSiteInventory({ artifacts, manifest, deliveryBaseUrl, canonicalOrigin, runtimePaths = [] } = {}) {
  validateManifest(manifest);
  const delivery = normalizedDirectoryUrl(deliveryBaseUrl ?? manifest.baseUrl, 'deliveryBaseUrl');
  const canonical = httpOrigin(canonicalOrigin ?? manifest.baseUrl, 'canonicalOrigin');
  const inventory = normalizedInventory(artifacts);
  const available = availablePaths(manifest, delivery);
  for (const path of normalizedRuntimePaths(runtimePaths, delivery)) available.add(path);
  const diagnostics = [];
  const documents = [];
  for (const artifact of manifest.artifacts) {
    if (!isHtml(artifact)) continue;
    const value = inventory.get(artifact.path);
    if (value === undefined) {
      diagnostics.push(diagnostic('SSC-104', 'manifest HTML artifact is absent from the inventory', artifact.path));
      continue;
    }
    if (typeof value.body !== 'string' && !(value.body instanceof Uint8Array)) {
      diagnostics.push(diagnostic('SSC-105', 'HTML artifact body must be a string or Uint8Array', artifact.path));
      continue;
    }
    const html = typeof value.body === 'string' ? value.body : new TextDecoder().decode(value.body);
    const documentUrl = artifactUrlAt(artifact.path, delivery);
    const inspection = extractHtmlLinks(html, { documentUrl, canonicalOrigin: canonical });
    diagnostics.push(...inspection.diagnostics);
    const targets = [];
    for (const link of inspection.links.filter((item) => item.kind === 'internal')) {
      const url = new URL(link.url);
      const target = `${url.pathname}${url.search}`;
      const present = available.has(url.pathname);
      targets.push(Object.freeze({ target, present, source: artifact.path, tag: link.tag, attribute: link.attribute }));
      if (!present) diagnostics.push(diagnostic('SSC-106', 'internal reference has no release artifact target', artifact.path, target));
    }
    documents.push(Object.freeze({ path: artifact.path, url: documentUrl.href, links: inspection.links, targets: Object.freeze(targets) }));
  }
  return deepFreeze({
    kind: 'static-site-inventory-conformance', version: 1, manifestDigest: manifest.digest,
    deliveryBaseUrl: delivery.href, canonicalOrigin: canonical, documentCount: documents.length,
    linkCount: documents.reduce((sum, document) => sum + document.links.length, 0),
    valid: diagnostics.length === 0, diagnostics, documents,
  });
}

function normalizedRuntimePaths(value, delivery) {
  if (!Array.isArray(value)) throw new TypeError('runtimePaths must be an array');
  return Object.freeze([...new Set(value.map((entry) => {
    let url;
    try { url = new URL(entry, delivery); } catch { throw new TypeError(`runtimePaths contains an invalid URL: ${String(entry)}`); }
    if (!['http:', 'https:'].includes(url.protocol) || url.origin !== delivery.origin || url.username || url.password || url.hash) {
      throw new TypeError(`runtimePaths must remain on the delivery origin: ${String(entry)}`);
    }
    return url.pathname;
  }))].sort(compareText));
}

/** Probe deployed representations through an injected fetch implementation. */
export async function probeStaticSiteRelease(options = {}) {
  const {
    manifest, origin, includePaths, maxRedirects = 5, concurrency = 8, headers = {},
    probePaths = [], maxBytes = 16 * 1024 * 1024, expectedHeaders = {}, timeoutMilliseconds = 15_000,
  } = options;
  if (options.fetch !== undefined && options.fetchImpl !== undefined) throw new TypeError('provide fetch or fetchImpl, not both');
  const fetchImpl = options.fetch ?? options.fetchImpl ?? globalThis.fetch;
  validateManifest(manifest);
  if (typeof fetchImpl !== 'function') throw new TypeError('fetchImpl must be a function');
  const delivery = normalizedDirectoryUrl(origin ?? manifest.baseUrl, 'origin');
  if (!Number.isInteger(maxRedirects) || maxRedirects < 0 || maxRedirects > 20) throw new TypeError('maxRedirects must be an integer from 0 through 20');
  if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 64) throw new TypeError('concurrency must be an integer from 1 through 64');
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) throw new TypeError('maxBytes must be a positive safe integer');
  if (!Number.isSafeInteger(timeoutMilliseconds) || timeoutMilliseconds < 1 || timeoutMilliseconds > 300_000) throw new TypeError('timeoutMilliseconds must be an integer from 1 through 300000');
  const responseHeaderExpectations = normalizedExpectedHeaders(expectedHeaders);
  const runtimePaths = normalizedProbePaths(probePaths, delivery);
  const selected = selectedArtifacts(manifest, includePaths);
  const probes = new Array(selected.length);
  let cursor = 0;
  async function worker() {
    while (true) {
      const index = cursor++;
      const artifact = selected[index];
      if (artifact === undefined) return;
      probes[index] = await probeArtifact(artifact, delivery, fetchImpl, maxRedirects, headers, maxBytes, responseHeaderExpectations, timeoutMilliseconds);
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, Math.max(1, selected.length)) }, () => worker()));
  const runtimeProbes = await concurrentMap(runtimePaths, concurrency, (path) => probeRuntimePath(path, delivery, fetchImpl, maxRedirects, headers, maxBytes, timeoutMilliseconds));
  const diagnostics = [...probes.flatMap((probe) => probe.diagnostics), ...runtimeProbes.flatMap((probe) => probe.diagnostics)];
  return deepFreeze({
    kind: 'static-site-remote-conformance', version: 1, manifestDigest: manifest.digest,
    origin: delivery.href, routeCount: probes.length, exactCount: probes.filter((probe) => probe.exact).length,
    probeCount: runtimeProbes.length, valid: diagnostics.length === 0, passed: diagnostics.length === 0,
    diagnostics, probes, runtimeProbes,
  });
}

async function probeArtifact(artifact, delivery, fetchImpl, maxRedirects, headers, maxBytes, expectedHeaders, timeoutMilliseconds) {
  const start = artifactUrlAt(artifact.path, delivery);
  if (artifact.bytes > maxBytes) return failedProbe(artifact, start, [], 'SSC-210', `declared artifact exceeds the ${maxBytes}-byte response limit`, 0);
  let current = start;
  const redirects = [];
  let response;
  try {
    for (let count = 0; ; count += 1) {
      response = await fetchImpl(current, { redirect: 'manual', headers: { accept: '*/*', 'cache-control': 'no-cache', ...headers }, signal: AbortSignal.timeout(timeoutMilliseconds) });
      if (![301, 302, 303, 307, 308].includes(response.status)) break;
      const location = response.headers.get('location');
      await response.body?.cancel?.();
      if (location === null) return failedProbe(artifact, start, redirects, 'SSC-202', 'redirect response has no Location header', response.status);
      if (count >= maxRedirects) return failedProbe(artifact, start, redirects, 'SSC-203', 'redirect bound exceeded', response.status);
      const next = new URL(location, current);
      redirects.push(next.href);
      if (!['http:', 'https:'].includes(next.protocol) || next.origin !== delivery.origin || next.username || next.password) {
        return failedProbe(artifact, start, redirects, 'SSC-204', 'release route redirects outside the probed origin', response.status);
      }
      current = next;
    }
  } catch (error) {
    return failedProbe(artifact, start, redirects, 'SSC-201', error instanceof Error ? error.message : String(error), 0);
  }
  let body;
  try { body = await boundedResponseBytes(response, maxBytes); }
  catch (error) { return failedProbe(artifact, start, redirects, error?.code === 'BODY_LIMIT' ? 'SSC-210' : 'SSC-209', error instanceof Error ? error.message : String(error), response.status); }
  const observedMediaType = mediaType(response.headers.get('content-type'));
  const expectedMediaType = artifact.mediaType === undefined ? undefined : mediaType(artifact.mediaType);
  const observedDigest = makeNiUri(body);
  const diagnostics = [];
  if (response.status !== 200) diagnostics.push(diagnostic('SSC-205', `expected status 200, observed ${response.status}`, artifact.path, current.href));
  if (expectedMediaType !== undefined && observedMediaType !== expectedMediaType) diagnostics.push(diagnostic('SSC-206', `expected media type ${expectedMediaType}, observed ${observedMediaType}`, artifact.path, current.href));
  if (body.byteLength !== artifact.bytes) diagnostics.push(diagnostic('SSC-207', `expected ${artifact.bytes} bytes, observed ${body.byteLength}`, artifact.path, current.href));
  if (observedDigest !== artifact.digest) diagnostics.push(diagnostic('SSC-208', 'response digest differs from the release manifest', artifact.path, current.href));
  for (const [name, expectation] of expectedHeaders) {
    const actual = response.headers.get(name);
    if (expectation instanceof RegExp) expectation.lastIndex = 0;
    const matches = typeof expectation === 'string' ? actual === expectation : actual !== null && expectation.test(actual);
    if (expectation instanceof RegExp) expectation.lastIndex = 0;
    if (!matches) diagnostics.push(diagnostic('SSC-211', `response header ${name} does not satisfy ${String(expectation)}; observed ${String(actual)}`, artifact.path, current.href));
  }
  return deepFreeze({ path: artifact.path, url: start.href, finalUrl: current.href, status: response.status,
    mediaType: observedMediaType, bytes: body.byteLength, digest: observedDigest, redirects, exact: diagnostics.length === 0, diagnostics });
}

async function probeRuntimePath(path, delivery, fetchImpl, maxRedirects, headers, maxBytes, timeoutMilliseconds) {
  const start = new URL(path, delivery);
  let current = start;
  const redirects = [];
  let response;
  try {
    for (let count = 0; ; count += 1) {
      response = await fetchImpl(current, { redirect: 'manual', headers: { accept: 'application/health+json, application/json;q=0.9, */*;q=0.1', 'cache-control': 'no-cache', ...headers }, signal: AbortSignal.timeout(timeoutMilliseconds) });
      if (![301, 302, 303, 307, 308].includes(response.status)) break;
      const location = response.headers.get('location');
      await response.body?.cancel?.();
      if (location === null) return failedRuntimeProbe(path, start, redirects, 'SSC-202', 'redirect response has no Location header', response.status);
      if (count >= maxRedirects) return failedRuntimeProbe(path, start, redirects, 'SSC-203', 'redirect bound exceeded', response.status);
      const next = new URL(location, current);
      redirects.push(next.href);
      if (!['http:', 'https:'].includes(next.protocol) || next.origin !== delivery.origin || next.username || next.password) return failedRuntimeProbe(path, start, redirects, 'SSC-204', 'probe redirects outside the probed origin', response.status);
      current = next;
    }
  } catch (error) { return failedRuntimeProbe(path, start, redirects, 'SSC-201', error instanceof Error ? error.message : String(error), 0); }
  let body;
  try { body = await boundedResponseBytes(response, maxBytes); }
  catch (error) { return failedRuntimeProbe(path, start, redirects, error?.code === 'BODY_LIMIT' ? 'SSC-210' : 'SSC-209', error instanceof Error ? error.message : String(error), response.status); }
  const diagnostics = [];
  if (response.status < 200 || response.status >= 300) diagnostics.push(diagnostic('SSC-212', `probe expected a 2xx status, observed ${response.status}`, path, current.href));
  const healthStatus = healthDocumentStatus(body, response.headers.get('content-type'));
  if (healthStatus === 'fail') diagnostics.push(diagnostic('SSC-213', 'probe health document reports failure', path, current.href));
  return deepFreeze({ path, url: start.href, finalUrl: current.href, status: response.status, mediaType: mediaType(response.headers.get('content-type')),
    bytes: body.byteLength, digest: makeNiUri(body), healthStatus, redirects, passed: diagnostics.length === 0, diagnostics });
}

function failedRuntimeProbe(path, start, redirects, code, message, status) {
  const diagnostics = [diagnostic(code, message, path, redirects.at(-1) ?? start.href)];
  return deepFreeze({ path, url: start.href, finalUrl: redirects.at(-1) ?? start.href, status,
    mediaType: '', bytes: 0, digest: '', healthStatus: null, redirects, passed: false, diagnostics });
}

async function boundedResponseBytes(response, maxBytes) {
  const declared = response.headers.get('content-length');
  if (declared !== null && /^\d+$/u.test(declared) && Number(declared) > maxBytes) throw bodyLimit(maxBytes);
  if (response.body === null) return new Uint8Array();
  const chunks = [];
  let length = 0;
  for await (const chunk of response.body) {
    const bytes = chunk instanceof Uint8Array ? chunk : new Uint8Array(chunk);
    length += bytes.byteLength;
    if (length > maxBytes) {
      try { await response.body.cancel(); } catch { /* the bounded refusal remains authoritative */ }
      throw bodyLimit(maxBytes);
    }
    chunks.push(bytes);
  }
  const result = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) { result.set(chunk, offset); offset += chunk.byteLength; }
  return result;
}

function bodyLimit(maxBytes) { const error = new Error(`response exceeds the ${maxBytes}-byte limit`); error.code = 'BODY_LIMIT'; return error; }

function healthDocumentStatus(body, contentType) {
  if (!new Set(['application/health+json', 'application/json']).has(mediaType(contentType))) return null;
  try {
    const status = JSON.parse(new TextDecoder().decode(body))?.status;
    return new Set(['pass', 'warn', 'fail']).has(status) ? status : null;
  } catch { return null; }
}

function normalizedExpectedHeaders(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError('expectedHeaders must be an object');
  return Object.freeze(Object.entries(value).map(([name, expectation]) => {
    if (!/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/u.test(name) || !(typeof expectation === 'string' || expectation instanceof RegExp)) throw new TypeError('expectedHeaders must map valid names to strings or RegExp values');
    return Object.freeze([name.toLowerCase(), expectation]);
  }).sort(([left], [right]) => compareText(left, right)));
}

function normalizedProbePaths(value, delivery) {
  if (!Array.isArray(value) || value.length > 32) throw new TypeError('probePaths must be an array of at most 32 same-origin paths');
  return Object.freeze([...new Set(value.map((path) => {
    let url;
    try { url = new URL(path, delivery); } catch { throw new TypeError(`probePaths contains an invalid URL: ${String(path)}`); }
    if (typeof path !== 'string' || !path.startsWith('/') || path.startsWith('//') || url.origin !== delivery.origin || url.username || url.password || url.hash) throw new TypeError(`probePaths must remain on the delivery origin: ${String(path)}`);
    return `${url.pathname}${url.search}`;
  }))].sort(compareText));
}

async function concurrentMap(values, concurrency, operation) {
  const result = new Array(values.length);
  let cursor = 0;
  async function worker() {
    while (cursor < values.length) { const index = cursor++; result[index] = await operation(values[index], index); }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, values.length) }, () => worker()));
  return result;
}

function failedProbe(artifact, start, redirects, code, message, status) {
  const diagnostics = [diagnostic(code, message, artifact.path, redirects.at(-1) ?? start.href)];
  return deepFreeze({ path: artifact.path, url: start.href, finalUrl: redirects.at(-1) ?? start.href,
    status, mediaType: '', bytes: 0, digest: '', redirects, exact: false, diagnostics });
}

function selectedArtifacts(manifest, includePaths) {
  if (includePaths === undefined) return manifest.artifacts;
  if (!Array.isArray(includePaths)) throw new TypeError('includePaths must be an array');
  const byPath = new Map(manifest.artifacts.map((artifact) => [artifact.path, artifact]));
  return Object.freeze([...new Set(includePaths)].map((path) => {
    if (typeof path !== 'string' || !byPath.has(path)) throw new TypeError(`includePaths names no manifest artifact: ${path}`);
    return byPath.get(path);
  }));
}

function normalizedInventory(value) {
  if (!value || typeof value[Symbol.iterator] !== 'function') throw new TypeError('artifacts must be an iterable inventory');
  const result = new Map();
  for (const entry of value) {
    const tuple = Array.isArray(entry);
    const path = tuple ? entry[0] : entry?.path;
    const raw = tuple ? entry[1] : entry;
    if (typeof path !== 'string' || !path || result.has(path)) throw new TypeError(`invalid or duplicate artifact path: ${String(path)}`);
    const record = raw && typeof raw === 'object' && !(raw instanceof Uint8Array) && 'body' in raw ? raw : { body: raw };
    result.set(path, record);
  }
  return result;
}

function availablePaths(manifest, delivery) {
  const paths = new Set();
  for (const artifact of manifest.artifacts) {
    const url = artifactUrlAt(artifact.path, delivery);
    paths.add(url.pathname);
    if (artifact.path === 'index.html' || artifact.path.endsWith('/index.html')) {
      paths.add(url.pathname === '/' ? '/' : url.pathname.replace(/\/$/u, ''));
      paths.add(new URL(artifact.path, delivery).pathname);
    }
  }
  return paths;
}

function artifactUrlAt(path, base) {
  const route = path === 'index.html' ? '' : path.endsWith('/index.html') ? path.slice(0, -'index.html'.length) : path;
  return new URL(route, base);
}

function validateManifest(manifest) {
  if (!manifest || typeof manifest !== 'object' || manifest.kind !== 'web-release-manifest' || manifest.version !== 1) throw new TypeError('manifest must be a web-release-manifest version 1');
  const base = normalizedDirectoryUrl(manifest.baseUrl, 'manifest.baseUrl');
  if (typeof manifest.digest !== 'string' || !/^ni:\/\/\/sha-256;[A-Za-z0-9_-]{43}$/u.test(manifest.digest)) throw new TypeError('manifest.digest must be an ni SHA-256 identifier');
  if (!Array.isArray(manifest.artifacts)) throw new TypeError('manifest.artifacts must be an array');
  const paths = new Set();
  for (const artifact of manifest.artifacts) {
    if (!artifact || typeof artifact.path !== 'string' || !artifact.path || artifact.path.startsWith('/') || artifact.path.includes('\\')
      || artifact.path.split('/').some((part) => !part || part === '.' || part === '..') || paths.has(artifact.path)
      || typeof artifact.url !== 'string' || !Number.isInteger(artifact.bytes) || artifact.bytes < 0
      || typeof artifact.digest !== 'string' || !/^ni:\/\/\/sha-256;[A-Za-z0-9_-]{43}$/u.test(artifact.digest)) {
      throw new TypeError('manifest contains an invalid or duplicate artifact');
    }
    if (artifact.url !== artifactUrlAt(artifact.path, base).href) throw new TypeError(`manifest artifact URL does not match its path: ${artifact.path}`);
    paths.add(artifact.path);
  }
  if (manifest.artifactCount !== manifest.artifacts.length
    || manifest.byteCount !== manifest.artifacts.reduce((sum, artifact) => sum + artifact.bytes, 0)) {
    throw new TypeError('manifest aggregate counts do not match its artifacts');
  }
  const core = {
    kind: manifest.kind, version: manifest.version, baseUrl: manifest.baseUrl, profile: manifest.profile,
    exclusions: manifest.exclusions, artifactCount: manifest.artifactCount, byteCount: manifest.byteCount,
    metadata: manifest.metadata, artifacts: manifest.artifacts,
  };
  if (makeNiUri(Buffer.from(canonicalJson(core), 'utf8')) !== manifest.digest) throw new TypeError('manifest digest does not identify its declared content');
}

function openingTags(html) { return html.matchAll(/<([a-z][a-z0-9-]*)(?:\s[^<>]*?)?>/giu); }
function attributeValue(tag, name) {
  const match = tag.match(new RegExp(`\\b${name}\\s*=\\s*(?:(["'])(.*?)\\1|([^\\s>]+))`, 'iu'));
  return match?.[2] ?? match?.[3];
}
function resolveReference(raw, base) {
  if (/[\u0000-\u001f\u007f]/u.test(raw)) return { problem: 'URL contains control characters' };
  try {
    const url = new URL(raw, base);
    if (url.username || url.password) return { problem: 'URL contains credentials' };
    return { url };
  } catch { return { problem: 'URL cannot be resolved' }; }
}
function isHtml(artifact) { return mediaType(artifact.mediaType ?? '') === 'text/html' || artifact.path.endsWith('.html'); }
function mediaType(value) { return String(value).split(';', 1)[0].trim().toLowerCase(); }
function normalizedDirectoryUrl(value, field) {
  const url = httpDirectoryOrDocumentUrl(value, field);
  if (!url.pathname.endsWith('/') || url.search || url.hash) throw new TypeError(`${field} must be an HTTP(S) directory URL without query or fragment`);
  return url;
}
function httpDirectoryOrDocumentUrl(value, field) {
  let url;
  try { url = new URL(value); } catch { throw new TypeError(`${field} must be an absolute HTTP(S) URL`); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new TypeError(`${field} must be an absolute HTTP(S) URL without credentials`);
  return url;
}
function httpOrigin(value, field) { return httpDirectoryOrDocumentUrl(value, field).origin; }
function compareText(left, right) { return left < right ? -1 : left > right ? 1 : 0; }
function diagnostic(code, message, subject, target) { return Object.freeze({ severity: 'error', code, message, subject, ...(target === undefined ? {} : { target }) }); }
function deepFreeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const item of Object.values(value)) deepFreeze(item);
  return Object.freeze(value);
}
