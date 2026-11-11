#!/usr/bin/env node
import { mkdir, readFile, readdir, rename, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const bridgeDir = path.join(root, '.codex-bridge');
const controlPath = path.join(bridgeDir, 'control.json');
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

function eventFileName(id) {
  return id.endsWith('.json') ? id : `${id}.json`;
}

async function commandStatus() {
  const control = await readJson(controlPath, defaultControl);
  const sections = await Promise.all(dirs.slice(0, 5).map(async (dir) => [dir, await listJsonNames(dir)]));

  console.log(`mode=${control.mode} paused=${control.paused} target=${control.target}`);
  console.log(`approved=${(control.approvedEventIds ?? []).join(',') || '-'}`);
  for (const [dir, names] of sections) {
    console.log(`${dir}: ${names.length}${names.length ? ` (${names.join(', ')})` : ''}`);
  }
}

async function updateControl(update) {
  const control = { ...defaultControl, ...(await readJson(controlPath, defaultControl)) };
  const next = update(control);
  await writeJson(controlPath, next);
  return next;
}

async function commandApprove(id) {
  const cleanId = id.replace(/\.json$/, '');
  const control = await updateControl((current) => {
    const approved = new Set(current.approvedEventIds ?? []);
    approved.add(cleanId);
    return { ...current, approvedEventIds: [...approved].sort() };
  });
  console.log(`approved ${cleanId}; approved=${control.approvedEventIds.join(',')}`);
}

async function commandReject(id) {
  const name = eventFileName(id);
  const from = path.join(bridgeDir, 'queue', name);
  const to = path.join(bridgeDir, 'done', name);
  if (!existsSync(from)) {
    throw new Error(`queue event not found: ${name}`);
  }
  await rename(from, to);
  await updateControl((current) => ({
    ...current,
    approvedEventIds: (current.approvedEventIds ?? []).filter((eventId) => eventId !== id.replace(/\.json$/, ''))
  }));
  console.log(`rejected ${name}; moved to done`);
}

async function commandAck(id) {
  const cleanId = id.replace(/\.json$/, '');
  await writeJson(path.join(bridgeDir, 'acks', `${cleanId}.json`), {
    id: cleanId,
    status: 'acked',
    createdAt: new Date().toISOString()
  });
  console.log(`ack written for ${cleanId}`);
}

async function commandTarget(target) {
  if (!target) throw new Error('target requires a value, for example tmux:codex-reviewer');
  if (target !== 'noop' && !target.startsWith('tmux:')) {
    throw new Error('target must start with tmux:');
  }
  const control = await updateControl((current) => ({ ...current, target }));
  console.log(`target=${control.target}`);
}

async function commandSend(args) {
  const to = readArg(args, '--to') ?? 'codex';
  const from = readArg(args, '--from') ?? (to === 'codex' ? 'cascade' : 'codex');
  const action = readArg(args, '--action') ?? 'review';
  const subject = readArg(args, '--subject') ?? 'Manual bridge event';
  const body = readArg(args, '--body') ?? '';
  const bodyFile = readArg(args, '--body-file');
  const threadId = readArg(args, '--thread-id');
  const replyTo = readArg(args, '--reply-to');
  const id = `evt_${new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14)}`;
  const event = {
    id,
    from,
    to,
    type: 'manual',
    requestedAction: action,
    summary: subject,
    body,
    changedFiles: [],
    artifacts: [],
    createdAt: new Date().toISOString()
  };
  if (bodyFile) event.bodyFile = bodyFile;
  if (threadId) event.threadId = threadId;
  if (replyTo) event.replyTo = replyTo;
  await writeJson(path.join(bridgeDir, 'queue', `${id}.json`), event);
  console.log(`queued ${id}`);
}

function readArg(args, key) {
  const index = args.indexOf(key);
  return index >= 0 ? args[index + 1] : undefined;
}

async function main() {
  await ensureBridge();
  const [command, ...args] = process.argv.slice(2);

  switch (command) {
    case undefined:
    case 'status':
      await commandStatus();
      break;
    case 'init':
      console.log(`initialized ${bridgeDir}`);
      break;
    case 'pause':
      await updateControl((current) => ({ ...current, paused: true }));
      console.log('paused');
      break;
    case 'resume':
      await updateControl((current) => ({ ...current, paused: false }));
      console.log('resumed');
      break;
    case 'mode': {
      const mode = args[0];
      if (!['manual', 'auto'].includes(mode)) throw new Error('mode must be manual or auto');
      await updateControl((current) => ({ ...current, mode }));
      console.log(`mode=${mode}`);
      break;
    }
    case 'approve':
      if (!args[0]) throw new Error('approve requires event id');
      await commandApprove(args[0]);
      break;
    case 'reject':
      if (!args[0]) throw new Error('reject requires event id');
      await commandReject(args[0]);
      break;
    case 'ack':
      if (!args[0]) throw new Error('ack requires event id');
      await commandAck(args[0]);
      break;
    case 'target':
      await commandTarget(args[0]);
      break;
    case 'send':
      await commandSend(args);
      break;
    default:
      throw new Error(`unknown command: ${command}`);
  }
}

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
