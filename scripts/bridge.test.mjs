import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile, copyFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

const sourceRoot = path.resolve(import.meta.dirname, '..');

async function makeWorkspace() {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'codex-bridge-test-'));
  await mkdir(path.join(dir, 'scripts'), { recursive: true });
  await copyFile(path.join(sourceRoot, 'scripts', 'bridge.mjs'), path.join(dir, 'scripts', 'bridge.mjs'));
  await copyFile(path.join(sourceRoot, 'scripts', 'bridge-watch.mjs'), path.join(dir, 'scripts', 'bridge-watch.mjs'));
  return dir;
}

async function readJson(filePath) {
  return JSON.parse(await readFile(filePath, 'utf8'));
}

test('send writes bidirectional events to queue with explicit from and to fields', async () => {
  const workspace = await makeWorkspace();
  try {
    const result = spawnSync(
      process.execPath,
      ['scripts/bridge.mjs', 'send', '--from', 'codex', '--to', 'cascade', '--action', 'review', '--subject', 'Bridge direction', '--body', 'Use shared queue'],
      { cwd: workspace, encoding: 'utf8' }
    );

    assert.equal(result.status, 0, result.stderr);
    const [name] = await readdir(path.join(workspace, '.codex-bridge', 'queue'));
    const event = await readJson(path.join(workspace, '.codex-bridge', 'queue', name));

    assert.equal(event.from, 'codex');
    assert.equal(event.to, 'cascade');
    assert.equal(event.requestedAction, 'review');
    assert.equal(event.summary, 'Bridge direction');
    assert.equal(event.body, 'Use shared queue');
    assert.equal(existsSync(path.join(workspace, '.codex-bridge', 'to-cascade')), false);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test('send includes bodyFile when provided', async () => {
  const workspace = await makeWorkspace();
  try {
    const bodyFile = '.codex-bridge/artifacts/evt_manual.request.md';
    const result = spawnSync(
      process.execPath,
      ['scripts/bridge.mjs', 'send', '--from', 'codex', '--to', 'cascade', '--action', 'implement', '--subject', 'Detailed request', '--body-file', bodyFile],
      { cwd: workspace, encoding: 'utf8' }
    );

    assert.equal(result.status, 0, result.stderr);
    const [name] = await readdir(path.join(workspace, '.codex-bridge', 'queue'));
    const event = await readJson(path.join(workspace, '.codex-bridge', 'queue', name));

    assert.equal(event.bodyFile, bodyFile);
    assert.equal(event.body, '');
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test('send includes threadId and replyTo when provided', async () => {
  const workspace = await makeWorkspace();
  try {
    const result = spawnSync(
      process.execPath,
      [
        'scripts/bridge.mjs',
        'send',
        '--from',
        'codex-b',
        '--to',
        'codex-a',
        '--action',
        'answer',
        '--subject',
        'Clarification',
        '--thread-id',
        'bridge-design-discussion',
        '--reply-to',
        'evt_001'
      ],
      { cwd: workspace, encoding: 'utf8' }
    );

    assert.equal(result.status, 0, result.stderr);
    const [name] = await readdir(path.join(workspace, '.codex-bridge', 'queue'));
    const event = await readJson(path.join(workspace, '.codex-bridge', 'queue', name));

    assert.equal(event.threadId, 'bridge-design-discussion');
    assert.equal(event.replyTo, 'evt_001');
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test('target command updates the watcher target in control.json', async () => {
  const workspace = await makeWorkspace();
  try {
    const result = spawnSync(process.execPath, ['scripts/bridge.mjs', 'target', 'tmux:codex-reviewer'], {
      cwd: workspace,
      encoding: 'utf8'
    });

    assert.equal(result.status, 0, result.stderr);
    const control = await readJson(path.join(workspace, '.codex-bridge', 'control.json'));
    assert.equal(control.target, 'tmux:codex-reviewer');
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test('watcher tick only moves approved queue events addressed to codex', async () => {
  const workspace = await makeWorkspace();
  try {
    const bridgeDir = path.join(workspace, '.codex-bridge');
    await mkdir(path.join(bridgeDir, 'queue'), { recursive: true });
    await mkdir(path.join(bridgeDir, 'inflight'), { recursive: true });
    await mkdir(path.join(bridgeDir, 'done'), { recursive: true });
    await mkdir(path.join(bridgeDir, 'acks'), { recursive: true });
    await mkdir(path.join(bridgeDir, 'reviews'), { recursive: true });
    await mkdir(path.join(bridgeDir, 'artifacts'), { recursive: true });
    await mkdir(path.join(bridgeDir, 'logs'), { recursive: true });

    await writeFile(
      path.join(bridgeDir, 'control.json'),
      JSON.stringify({
        mode: 'manual',
        paused: false,
        target: 'noop',
        maxInflight: 1,
        approvedEventIds: ['evt_cascade', 'evt_codex']
      }, null, 2)
    );
    await writeFile(
      path.join(bridgeDir, 'queue', 'evt_cascade.json'),
      JSON.stringify({ id: 'evt_cascade', from: 'codex', to: 'cascade', summary: 'for cascade' }, null, 2)
    );
    await writeFile(
      path.join(bridgeDir, 'queue', 'evt_codex.json'),
      JSON.stringify({ id: 'evt_codex', from: 'cascade', to: 'codex', summary: 'for codex' }, null, 2)
    );

    const result = spawnSync(process.execPath, ['scripts/bridge-watch.mjs', '--once'], {
      cwd: workspace,
      encoding: 'utf8'
    });

    assert.equal(result.status, 0, result.stderr);
    assert.equal(existsSync(path.join(bridgeDir, 'queue', 'evt_cascade.json')), true);
    assert.equal(existsSync(path.join(bridgeDir, 'queue', 'evt_codex.json')), false);
    assert.equal(existsSync(path.join(bridgeDir, 'inflight', 'evt_codex.json')), true);
    assert.equal(existsSync(path.join(bridgeDir, 'inflight', 'evt_cascade.json')), false);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});
