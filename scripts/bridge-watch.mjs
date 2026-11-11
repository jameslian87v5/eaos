#!/usr/bin/env node
import { mkdir, readFile, readdir, rename, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';

const root = process.cwd();
const bridgeDir = path.join(root, '.codex-bridge');
const controlPath = path.join(bridgeDir, 'control.json');
const pollMs = Number(process.env.BRIDGE_POLL_MS ?? 1500);
const dirs = ['queue', 'inflight', 'done', 'acks', 'reviews', 'artifacts', 'logs'];

const defaultControl = {
  mode: 'manual',
  paused: false,
  target: 'tmux:codex',
  maxInflight: 1,
  approvedEventIds: [],
  injectTemplate:
    'Bridge event {{id}} is ready.\n\n' +
    'You are Codex in the bridge receiver role.\n' +
    'Read {{eventPath}}.\n' +
    'Inspect referenced files and current git diff if relevant.\n' +
    'Write BOTH files before marking this handled:\n' +
    '1. {{reviewPath}}\n' +
    '2. {{ackPath}}\n\n' +
    'Do not only answer in chat. Keep the review concise and actionable.'
};

async function ensureBridge() {
  await mkdir(bridgeDir, { recursive: true });
  await Promise.all(dirs.map((dir) => mkdir(path.join(bridgeDir, dir), { recursive: true })));
  if (!existsSync(controlPath)) {
    await writeJson(controlPath, defaultControl);
  }
}

async function readJson(filePath, fallback = null) {
  try {
    return JSON.parse(await readFile(filePath, 'utf8'));
  } catch (error) {
    if (fallback !== null) return fallback;
    throw error;
  }
}

async function writeJson(filePath, value) {
  await writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

async function listJsonNames(dir) {
  try {
    return (await readdir(path.join(bridgeDir, dir))).filter((name) => name.endsWith('.json')).sort();
  } catch {
    return [];
  }
}

async function appendLog(message) {
  const line = `${new Date().toISOString()} ${message}\n`;
  await writeFile(path.join(bridgeDir, 'logs', 'watcher.log'), line, { flag: 'a' });
}

async function updateControl(update) {
  const control = { ...defaultControl, ...(await readJson(controlPath, defaultControl)) };
  const next = update(control);
  await writeJson(controlPath, next);
  return next;
}

async function processAcks() {
  const inflight = await listJsonNames('inflight');
  for (const name of inflight) {
    const id = name.replace(/\.json$/, '');
    if (!existsSync(path.join(bridgeDir, 'acks', `${id}.json`))) continue;
    await rename(path.join(bridgeDir, 'inflight', name), path.join(bridgeDir, 'done', name));
    await appendLog(`done ${id}`);
  }
}

async function maybeInjectNext() {
  const control = { ...defaultControl, ...(await readJson(controlPath, defaultControl)) };
  if (control.paused) return;

  const inflight = await listJsonNames('inflight');
  if (inflight.length >= control.maxInflight) return;

  const queue = await listJsonNames('queue');
  if (!queue.length) return;

  const approved = new Set(control.approvedEventIds ?? []);
  const codexQueue = [];
  for (const name of queue) {
    const event = await readJson(path.join(bridgeDir, 'queue', name), {});
    if ((event.to || 'codex') === 'codex') codexQueue.push(name);
  }
  if (!codexQueue.length) return;

  const nextName =
    control.mode === 'auto'
      ? codexQueue[0]
      : codexQueue.find((name) => approved.has(name.replace(/\.json$/, '')));

  if (!nextName) return;

  const id = nextName.replace(/\.json$/, '');
  const from = path.join(bridgeDir, 'queue', nextName);
  const to = path.join(bridgeDir, 'inflight', nextName);
  const event = await readJson(from, {});
  await rename(from, to);
  await updateControl((current) => ({
    ...current,
    approvedEventIds: (current.approvedEventIds ?? []).filter((eventId) => eventId !== id)
  }));

  const paths = {
    eventPath: `.codex-bridge/inflight/${nextName}`,
    ackPath: `.codex-bridge/acks/${id}.json`,
    reviewPath: `.codex-bridge/reviews/${id}.review.md`
  };
  const message = renderTemplate(control.injectTemplate || defaultControl.injectTemplate, {
    id,
    from: event.from || '',
    to: event.to || '',
    type: event.type || '',
    requestedAction: event.requestedAction || '',
    summary: event.summary || '',
    ...paths
  });
  inject(control.target, message);
  await appendLog(`injected ${id} target=${control.target}`);
}

function renderTemplate(template, values) {
  return template.replace(/\{\{(\w+)\}\}/g, (_match, key) => {
    const value = values[key];
    return value === undefined || value === null ? '' : String(value);
  });
}

function inject(target, message) {
  if (target === 'noop') return;
  if (!target.startsWith('tmux:')) {
    throw new Error(`unsupported target: ${target}`);
  }
  const tmuxTarget = target.slice('tmux:'.length);
  const result = spawnSync('tmux', ['send-keys', '-t', tmuxTarget, message, 'C-m'], {
    encoding: 'utf8'
  });
  if (result.status !== 0) {
    throw new Error(result.stderr.trim() || `tmux send-keys failed with status ${result.status}`);
  }
}

async function tick() {
  await processAcks();
  await maybeInjectNext();
}

async function main() {
  await ensureBridge();
  if (process.argv.includes('--once')) {
    await tick();
    return;
  }

  console.log(`bridge watcher running: ${bridgeDir}`);
  console.log(`poll=${pollMs}ms`);
  await appendLog('watcher started');

  while (true) {
    try {
      await tick();
    } catch (error) {
      console.error(error.message);
      await appendLog(`error ${error.message}`);
    }
    await new Promise((resolve) => setTimeout(resolve, pollMs));
  }
}

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
