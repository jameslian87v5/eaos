import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { addBookmarkForPath, buildStateForRoot, removeBookmarkForPath } from './bridge-console.mjs';

test('console state includes Codex sessions and bridge bookmarks', async () => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), 'bridge-console-test-workspace-'));
  const codexHome = await mkdtemp(path.join(os.tmpdir(), 'bridge-console-test-codex-'));

  try {
    await mkdir(path.join(workspace, '.codex-bridge'), { recursive: true });
    await mkdir(codexHome, { recursive: true });
    await mkdir(path.join(codexHome, 'sessions', '2026', '06', '16'), { recursive: true });
    await writeFile(
      path.join(codexHome, 'sessions', '2026', '06', '16', 'rollout-2026-06-16T01-00-00-019ecfff-1111-7222-8333-aaaaaaaaaaaa.jsonl'),
      [
        JSON.stringify({
          timestamp: '2026-06-16T01:00:00.000Z',
          type: 'session_meta',
          payload: {
            id: '019ecfff-1111-7222-8333-aaaaaaaaaaaa',
            cwd: workspace,
            timestamp: '2026-06-16T01:00:00.000Z',
            model: 'gpt-5.5'
          }
        }),
        JSON.stringify({
          timestamp: '2026-06-16T01:01:00.000Z',
          type: 'response_item',
          payload: {
            role: 'user',
            text: 'AGENTS.md instructions for workspace root'
          }
        }),
        JSON.stringify({
          timestamp: '2026-06-16T01:02:00.000Z',
          type: 'event_msg',
          payload: {
            type: 'user_message',
            message: 'First real user question'
          }
        }),
        JSON.stringify({
          timestamp: '2026-06-16T01:03:00.000Z',
          type: 'event_msg',
          payload: {
            type: 'agent_message',
            message: 'Acknowledged'
          }
        }),
        JSON.stringify({
          timestamp: '2026-06-16T01:04:00.000Z',
          type: 'event_msg',
          payload: {
            type: 'user_message',
            message: 'Final user follow-up'
          }
        })
      ].join('\n') + '\n'
    );
    await writeFile(
      path.join(codexHome, 'sessions', '2026', '06', '16', 'rollout-2026-06-16T02-00-00-019ecfff-1111-7222-8333-bbbbbbbbbbbb.jsonl'),
      JSON.stringify({
        timestamp: '2026-06-16T02:00:00.000Z',
        type: 'session_meta',
        payload: {
          id: '019ecfff-1111-7222-8333-bbbbbbbbbbbb',
          cwd: '/other/workspace',
          timestamp: '2026-06-16T02:00:00.000Z'
        }
      }) + '\n'
    );
    await writeFile(
      path.join(codexHome, 'session_index.jsonl'),
      [
        JSON.stringify({
          id: '019e9d4e-c2b0-7423-adde-39148e74bb07',
          thread_name: 'Codex Companion Task: Bridge protocol design',
          updated_at: '2026-06-16T01:02:03.000Z'
        }),
        JSON.stringify({
          id: '019e9d62-74cc-77d0-af28-97b9be1757c0',
          thread_name: 'Codex Companion Task: Older task',
          updated_at: '2026-06-15T01:02:03.000Z'
        })
      ].join('\n') + '\n'
    );
    await writeFile(
      path.join(workspace, '.codex-bridge', 'session-bookmarks.json'),
      JSON.stringify([
        {
          label: 'bridge-before-routing',
          sessionId: '019e9d4e-c2b0-7423-adde-39148e74bb07',
          notes: 'Before routing changes',
          createdAt: '2026-06-16T02:00:00.000Z'
        }
      ], null, 2)
    );

    const state = await buildStateForRoot({
      bridgeDir: path.join(workspace, '.codex-bridge'),
      codexHome,
      workspaceRoot: workspace
    });
    assert.equal(state.codex.source, 'sessions');
    assert.equal(state.codex.sessions.length, 1);
    assert.equal(state.codex.sessions[0].id, '019ecfff-1111-7222-8333-aaaaaaaaaaaa');
    assert.equal(state.codex.sessions[0].firstUserMessage, 'First real user question');
    assert.equal(state.codex.sessions[0].lastUserMessage, 'Final user follow-up');
    assert.equal(state.codex.sessions[0].threadName, 'First real user question');
    assert.equal(state.codex.sessions[0].createdAt, '2026-06-16T01:00:00.000Z');
    assert.equal(state.codex.bookmarks.length, 1);
    assert.equal(state.codex.bookmarks[0].label, 'bridge-before-routing');
  } finally {
    await rm(workspace, { recursive: true, force: true });
    await rm(codexHome, { recursive: true, force: true });
  }
});

test('bookmark helpers add, replace, and remove project-local session bookmarks', async () => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), 'bridge-console-test-bookmarks-'));
  try {
    const bookmarksPath = path.join(workspace, 'session-bookmarks.json');
    await writeFile(bookmarksPath, '[]\n');

    await addBookmarkForPath(bookmarksPath, {
      label: 'checkpoint',
      sessionId: 'session-a',
      notes: 'first'
    });
    await addBookmarkForPath(bookmarksPath, {
      label: 'checkpoint',
      sessionId: 'session-b',
      notes: 'replacement'
    });

    let bookmarks = JSON.parse(await readFile(bookmarksPath, 'utf8'));
    assert.equal(bookmarks.length, 1);
    assert.equal(bookmarks[0].sessionId, 'session-b');

    await removeBookmarkForPath(bookmarksPath, 'checkpoint');
    bookmarks = JSON.parse(await readFile(bookmarksPath, 'utf8'));
    assert.deepEqual(bookmarks, []);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});
