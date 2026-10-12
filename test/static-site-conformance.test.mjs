import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createWebReleaseManifest } from '@red-cup-engineering/web-release-candidate-service';
import { checkStaticSiteInventory, extractHtmlLinks, probeStaticSiteRelease } from '../src/static-site-conformance.mjs';

const inventory = new Map([
  ['index.html', { body: '<main><a href="guide/">Guide</a><img src="assets/logo.svg"><a href="mailto:hi@example.test">Mail</a></main>', mediaType: 'text/html; charset=utf-8' }],
  ['guide/index.html', { body: '<a href="../">Home</a>', mediaType: 'text/html; charset=utf-8' }],
  ['assets/logo.svg', { body: '<svg/>', mediaType: 'image/svg+xml' }],
]);
const manifest = createWebReleaseManifest({ artifacts: inventory, baseUrl: 'https://example.test/' });

test('extracts browser-facing links and identifies unsafe and canonical-origin escapes', () => {
  const found = extractHtmlLinks('<a href="https://example.test/guide/">canonical</a><script src="javascript:alert(1)"></script><a href="/local">local</a>', {
    documentUrl: 'https://preview.test/', canonicalOrigin: 'https://example.test',
  });
  assert.deepEqual(found.links.map(({ kind }) => kind), ['canonical-origin-escape', 'unsafe', 'internal']);
  assert.deepEqual(found.diagnostics.map(({ code }) => code), ['SSC-102', 'SSC-101']);
});

test('checks internal targets with directory-index semantics', () => {
  const found = checkStaticSiteInventory({ artifacts: inventory, manifest });
  assert.equal(found.valid, true);
  assert.equal(found.documentCount, 2);
  assert.equal(found.linkCount, 4);
  assert.ok(found.documents.flatMap(({ targets }) => targets).every(({ present }) => present));
});

test('explicit runtime paths admit composed dynamic application targets', () => {
  const dynamic = new Map(inventory);
  dynamic.set('index.html', { body: '<link rel="webmention" href="/webmention"><a href="guide/">Guide</a>', mediaType: 'text/html' });
  const dynamicManifest = createWebReleaseManifest({ artifacts: dynamic, baseUrl: 'https://example.test/' });
  assert.equal(checkStaticSiteInventory({ artifacts: dynamic, manifest: dynamicManifest }).valid, false);
  assert.equal(checkStaticSiteInventory({ artifacts: dynamic, manifest: dynamicManifest, runtimePaths: ['/webmention'] }).valid, true);
  assert.throws(() => checkStaticSiteInventory({ artifacts: dynamic, manifest: dynamicManifest, runtimePaths: ['https://elsewhere.test/webmention'] }), /delivery origin/);
});

test('reports missing targets, unsafe references, and preview canonical escapes', () => {
  const broken = new Map(inventory);
  broken.set('index.html', { body: '<a href="missing/">Nope</a><img src="data:text/plain,no"><a href="https://example.test/guide/">escape</a>', mediaType: 'text/html' });
  const found = checkStaticSiteInventory({ artifacts: broken, manifest: createWebReleaseManifest({ artifacts: broken, baseUrl: 'https://example.test/' }), deliveryBaseUrl: 'https://preview.test/', canonicalOrigin: 'https://example.test' });
  assert.equal(found.valid, false);
  assert.deepEqual(new Set(found.diagnostics.map(({ code }) => code)), new Set(['SSC-101', 'SSC-102', 'SSC-106']));
});

test('probes exact deployed bytes and follows bounded same-origin redirects', async () => {
  const routes = new Map([
    ['https://preview.test/', new Response(null, { status: 302, headers: { location: '/home/' } })],
    ['https://preview.test/home/', new Response(inventory.get('index.html').body, { headers: { 'content-type': 'text/html; charset=utf-8' } })],
    ['https://preview.test/guide/', new Response(inventory.get('guide/index.html').body, { headers: { 'content-type': 'text/html' } })],
    ['https://preview.test/assets/logo.svg', new Response(inventory.get('assets/logo.svg').body, { headers: { 'content-type': 'image/svg+xml' } })],
  ]);
  const found = await probeStaticSiteRelease({ manifest, origin: 'https://preview.test/', fetchImpl: async (url) => routes.get(String(url)) ?? new Response('missing', { status: 404 }) });
  assert.equal(found.valid, true);
  assert.equal(found.exactCount, 3);
  assert.deepEqual(found.probes.find(({ path }) => path === 'index.html').redirects, ['https://preview.test/home/']);
});

test('remote probes report response drift, redirect escape, and configured selection errors', async () => {
  const drift = await probeStaticSiteRelease({
    manifest, origin: 'https://preview.test/', includePaths: ['index.html', 'assets/logo.svg'], maxRedirects: 0,
    fetchImpl: async (url) => String(url).endsWith('logo.svg')
      ? new Response('wrong', { headers: { 'content-type': 'text/plain' } })
      : new Response(null, { status: 302, headers: { location: 'https://elsewhere.test/' } }),
  });
  assert.equal(drift.valid, false);
  assert.ok(drift.diagnostics.some(({ code }) => code === 'SSC-203'));
  assert.ok(drift.diagnostics.some(({ code }) => code === 'SSC-206'));
  assert.ok(drift.diagnostics.some(({ code }) => code === 'SSC-208'));
  await assert.rejects(() => probeStaticSiteRelease({ manifest, includePaths: ['absent'] }), /names no manifest artifact/);
});

test('refuses a release manifest whose aggregate, URL, or digest bindings drift', async () => {
  await assert.rejects(() => probeStaticSiteRelease({ manifest: { ...manifest, byteCount: manifest.byteCount + 1 } }), /aggregate counts/);
  const artifacts = manifest.artifacts.map((artifact, index) => index === 0 ? { ...artifact, url: 'https://example.test/wrong' } : artifact);
  await assert.rejects(() => probeStaticSiteRelease({ manifest: { ...manifest, artifacts } }), /URL does not match/);
  await assert.rejects(() => probeStaticSiteRelease({ manifest: { ...manifest, profile: 'changed' } }), /digest does not identify/);
});

test('bounds remote bodies and checks expected delivery headers', async () => {
  const bounded = await probeStaticSiteRelease({
    manifest,
    origin: 'https://preview.test/',
    includePaths: ['index.html', 'assets/logo.svg'],
    maxBytes: 10,
    expectedHeaders: { 'x-content-type-options': 'nosniff', 'cache-control': /max-age=\d+/u },
    fetch: async (url) => String(url).endsWith('logo.svg')
      ? new Response('<svg/>', { headers: { 'content-type': 'image/svg+xml', 'x-content-type-options': 'nosniff', 'cache-control': 'public' } })
      : new Response(inventory.get('index.html').body, { headers: { 'content-type': 'text/html', 'x-content-type-options': 'nosniff', 'cache-control': 'max-age=60' } }),
  });
  assert.equal(bounded.passed, false);
  assert.ok(bounded.diagnostics.some(({ code, subject }) => code === 'SSC-210' && subject === 'index.html'));
  assert.ok(bounded.diagnostics.some(({ code, subject }) => code === 'SSC-211' && subject === 'assets/logo.svg'));
  assert.equal(bounded.probes.find(({ path }) => path === 'index.html').bytes, 0);
});

test('records explicit readiness probes without treating them as manifest artifacts', async () => {
  const result = await probeStaticSiteRelease({
    manifest,
    origin: 'https://preview.test/',
    includePaths: [],
    probePaths: ['/healthz', '/readyz'],
    fetch: async (url) => String(url).endsWith('/readyz')
      ? new Response(JSON.stringify({ status: 'fail' }), { status: 503, headers: { 'content-type': 'application/health+json' } })
      : new Response(JSON.stringify({ status: 'pass' }), { headers: { 'content-type': 'application/health+json' } }),
  });
  assert.equal(result.routeCount, 0);
  assert.equal(result.probeCount, 2);
  assert.equal(result.passed, false);
  assert.equal(result.runtimeProbes.find(({ path }) => path === '/healthz').passed, true);
  assert.equal(result.runtimeProbes.find(({ path }) => path === '/readyz').healthStatus, 'fail');
  assert.deepEqual(new Set(result.diagnostics.map(({ code }) => code)), new Set(['SSC-212', 'SSC-213']));
});

test('probe plan and transport bounds fail before network effects', async () => {
  const fetch = async () => { throw new Error('must not fetch'); };
  await assert.rejects(() => probeStaticSiteRelease({ manifest, fetch, fetchImpl: fetch }), /not both/u);
  await assert.rejects(() => probeStaticSiteRelease({ manifest, fetch, maxBytes: 0 }), /positive safe integer/u);
  await assert.rejects(() => probeStaticSiteRelease({ manifest, fetch, timeoutMilliseconds: 0 }), /through 300000/u);
  await assert.rejects(() => probeStaticSiteRelease({ manifest, fetch, probePaths: ['https://elsewhere.test/readyz'] }), /delivery origin/u);
  await assert.rejects(() => probeStaticSiteRelease({ manifest, fetch, expectedHeaders: { 'bad header': 'value' } }), /valid names/u);
});

test('packaged CLI emits one passing JSON assay for a staged origin', async () => {
  const root = await mkdtemp(join(tmpdir(), 'static-site-conformance-cli-'));
  const server = createServer((request, response) => {
    if (request.url === '/readyz') {
      response.setHeader('content-type', 'application/health+json');
      response.end(JSON.stringify({ status: 'pass' }));
      return;
    }
    const artifact = request.url === '/' ? inventory.get('index.html') : request.url === '/guide/' ? inventory.get('guide/index.html') : inventory.get('assets/logo.svg');
    response.setHeader('content-type', artifact.mediaType);
    response.end(artifact.body);
  });
  try {
    await new Promise((resolve, reject) => server.listen(0, '127.0.0.1', resolve).once('error', reject));
    const manifestPath = join(root, 'release-manifest.json');
    await writeFile(manifestPath, JSON.stringify(manifest));
    const address = server.address();
    const result = await child(process.execPath, [new URL('../scripts/probe-static-site-release.mjs', import.meta.url).pathname,
      '--manifest', manifestPath, '--origin', `http://127.0.0.1:${address.port}/`, '--probe', '/readyz']);
    assert.equal(result.status, 0, result.stderr);
    const observation = JSON.parse(result.stdout);
    assert.equal(observation.passed, true);
    assert.equal(observation.probeCount, 1);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    await rm(root, { recursive: true, force: true });
  }
});

function child(command, args) {
  return new Promise((resolve, reject) => {
    const process = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    const stdout = [], stderr = [];
    process.stdout.on('data', (chunk) => stdout.push(chunk));
    process.stderr.on('data', (chunk) => stderr.push(chunk));
    process.on('error', reject);
    process.on('close', (status) => resolve({ status, stdout: Buffer.concat(stdout).toString('utf8'), stderr: Buffer.concat(stderr).toString('utf8') }));
  });
}
