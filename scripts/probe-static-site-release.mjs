#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
import process from 'node:process';
import { probeStaticSiteRelease } from '../src/static-site-conformance.mjs';

function required(name) {
  const index = process.argv.indexOf(name);
  if (index < 0 || !process.argv[index + 1]) throw new TypeError(`${name} is required`);
  return process.argv[index + 1];
}
function optionalNumber(name) {
  const index = process.argv.indexOf(name);
  if (index < 0) return undefined;
  if (!process.argv[index + 1]) throw new TypeError(`${name} requires a value`);
  return Number(process.argv[index + 1]);
}
function repeated(name) {
  return process.argv.flatMap((value, index) => value === name && process.argv[index + 1] ? [process.argv[index + 1]] : []);
}

try {
  const manifest = JSON.parse(await readFile(required('--manifest'), 'utf8'));
  const concurrency = optionalNumber('--concurrency');
  const maxBytes = optionalNumber('--max-bytes');
  const timeoutMilliseconds = optionalNumber('--timeout-ms');
  const result = await probeStaticSiteRelease({
    manifest,
    origin: required('--origin'),
    fetch: globalThis.fetch,
    probePaths: repeated('--probe'),
    ...(concurrency === undefined ? {} : { concurrency }),
    ...(maxBytes === undefined ? {} : { maxBytes }),
    ...(timeoutMilliseconds === undefined ? {} : { timeoutMilliseconds }),
  });
  process.stdout.write(`${JSON.stringify(result)}\n`);
  if (!result.passed) process.exitCode = 1;
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 2;
}
