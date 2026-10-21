#!/usr/bin/env node
/**
 * Node test runner: `node tests/run-node.js [filter]`
 * Loads the classic-script sources into a vm sandbox (no DOM), then the harness and test files.
 */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { performance } = require('perf_hooks');

const root = path.resolve(__dirname, '..');
const filter = process.argv[2] || '';

const sandbox = {
  console, setTimeout, clearTimeout, setInterval, clearInterval, performance,
  TextEncoder, TextDecoder, URL, Blob: globalThis.Blob, atob, btoa,
  crypto: require('crypto').webcrypto
};
sandbox.globalThis = sandbox;
vm.createContext(sandbox);

function load(rel) {
  const file = path.join(root, rel);
  if (!fs.existsSync(file)) return false;
  vm.runInContext(fs.readFileSync(file, 'utf8'), sandbox, { filename: rel });
  return true;
}

load('tests/manifest.js');
const manifest = sandbox.VLabTestManifest;
const skipped = [];
for (const src of manifest.sources) {
  try {
    if (!load(src)) skipped.push(src);
  } catch (e) {
    console.error('\x1b[31mERROR loading ' + src + '\x1b[0m\n' + (e.stack || e));
    process.exitCode = 1;
  }
}
load('tests/harness.js');
for (const t of manifest.tests) {
  if (filter && !t.includes(filter)) continue;
  sandbox.VLabTest.currentFile = t;
  try {
    if (!load(t)) skipped.push(t);
  } catch (e) {
    console.error('\x1b[31mERROR loading ' + t + '\x1b[0m\n' + (e.stack || e));
    process.exitCode = 1;
  }
}

sandbox.VLabTest.run((r) => {
  if (!r.ok) console.log('\x1b[31m✗ ' + r.file + ' › ' + r.name + '\x1b[0m\n  ' + String(r.error).split('\n').slice(0, 4).join('\n  '));
  else if (process.env.VERBOSE) console.log('\x1b[32m✓\x1b[0m ' + r.file + ' › ' + r.name);
}).then((s) => {
  if (skipped.length) console.log('\x1b[33mSkipped (missing): ' + skipped.join(', ') + '\x1b[0m');
  console.log((s.failed ? '\x1b[31m' : '\x1b[32m') + s.passed + ' passed, ' + s.failed + ' failed\x1b[0m');
  if (s.failed) process.exitCode = 1;
});
