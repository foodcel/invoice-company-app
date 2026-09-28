import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const script = resolve(dirname(fileURLToPath(import.meta.url)), '../scripts/create-update-manifest.mjs');

test('release manifest points at the exact signed Windows installer', async () => {
  const folder = await mkdtemp(join(tmpdir(), 'invoice-manifest-'));
  try {
    const installer = join(folder, 'Hermitage-setup.exe');
    const signature = `${installer}.sig`;
    const output = join(folder, 'latest.json');
    await writeFile(installer, Buffer.alloc(2048, 7));
    await writeFile(signature, 'signed-test-data\n');
    const result = spawnSync(process.execPath, [script, '0.1.0', 'owner/invoice-company-app', installer, signature, output], { encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    const feed = JSON.parse(await readFile(output, 'utf8'));
    assert.equal(feed.version, '0.1.0');
    assert.equal(feed.platforms['windows-x86_64'].signature, 'signed-test-data');
    assert.equal(feed.platforms['windows-x86_64'].url, 'https://github.com/owner/invoice-company-app/releases/download/v0.1.0/Hermitage-setup.exe');
    assert.ok(!JSON.stringify(feed).includes(folder));
  } finally {
    const base = resolve(tmpdir()).toLowerCase();
    const target = resolve(folder).toLowerCase();
    assert.ok(target.startsWith(`${base}\\`) || target.startsWith(`${base}/`), 'Cleanup must remain within the temporary directory');
    await rm(folder, { recursive: true, force: true });
  }
});

test('release manifest rejects an installer name GitHub may rewrite', async () => {
  const folder = await mkdtemp(join(tmpdir(), 'invoice-manifest-'));
  try {
    const installer = join(folder, 'Soumissions et factures.exe');
    const signature = `${installer}.sig`;
    const output = join(folder, 'latest.json');
    await writeFile(installer, Buffer.alloc(2048, 7));
    await writeFile(signature, 'signed-test-data\n');
    const result = spawnSync(process.execPath, [script, '0.1.0', 'owner/invoice-company-app', installer, signature, output], { encoding: 'utf8' });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /asset name must use only ASCII/);
  } finally {
    const base = resolve(tmpdir()).toLowerCase();
    const target = resolve(folder).toLowerCase();
    assert.ok(target.startsWith(`${base}\\`) || target.startsWith(`${base}/`));
    await rm(folder, { recursive: true, force: true });
  }
});
