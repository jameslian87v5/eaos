/**
 * FileWorkspaceService — centralised workspace file path management.
 *
 * All path rules for /workspace/input, /workspace/output, /workspace/tmp
 * are concentrated here. No other module should compose workspace paths.
 *
 * Security invariants:
 *   - Every API call must include userId + chatId ownership verification.
 *   - File paths must NEVER escape the per-chat workspace root.
 *   - Uploaded files go to /workspace/input only — never /root/.claude or /opt/agent/*.
 *   - Workspace files must NEVER be treated as skill/plugin/mcp/config sources.
 */

import { v4 as uuidv4 } from "uuid";
import path from "path";
import fs from "fs";
import db from "./database.js";
import { writeFileToVolume, readFileFromVolume, listFilesInVolume } from "./docker-runtime.js";

const RUNTIME_MODE = process.env.RUNTIME_MODE || "local";

// ─── Types ──────────────────────────────────────────────────

export type WorkspacePaths = {
  root: string;
  inputDir: string;
  outputDir: string;
  tmpDir: string;
};

export type WorkspaceFileKind = "input" | "output";

export interface FileRecord {
  id: string;
  userId: string;
  chatId: string;
  kind: WorkspaceFileKind;
  filename: string;
  path: string;
  mimeType: string | null;
  sizeBytes: number;
  createdAt: string;
}

export interface DownloadHandle {
  absolutePath: string;
  filename: string;
  mimeType: string | null;
}

// ─── DB Schema ─────────────────────────────────────────────
// M5: workspace_files table + UNIQUE(chat_id, kind, filename) index are
// declared in database.ts (canonical schema, imported first everywhere) so
// quota-service can prepare statements at module load before this module
// runs. Nothing to init here.

// ─── Prepared statements ────────────────────────────────────

const stmtInsert = db.prepare(`
  INSERT INTO workspace_files (id, user_id, chat_id, kind, filename, path, mime_type, size_bytes)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  ON CONFLICT(chat_id, kind, filename) DO UPDATE SET
    size_bytes = excluded.size_bytes,
    mime_type = excluded.mime_type,
    path = excluded.path
`);

// M5: read the current registered size of an input file (for the storage quota
// delta calc — overwrite returns delta = new - old, not a full add).
const stmtGetInputSize = db.prepare(
  `SELECT size_bytes FROM workspace_files WHERE chat_id = ? AND kind = 'input' AND filename = ?`
);

const stmtList = db.prepare(`
  SELECT id, user_id as userId, chat_id as chatId, kind, filename, path, mime_type as mimeType,
         size_bytes as sizeBytes, created_at as createdAt
  FROM workspace_files
  WHERE user_id = ? AND chat_id = ?
  ORDER BY created_at DESC
`);

const stmtGetById = db.prepare(`
  SELECT id, user_id as userId, chat_id as chatId, kind, filename, path, mime_type as mimeType,
         size_bytes as sizeBytes, created_at as createdAt
  FROM workspace_files
  WHERE id = ? AND user_id = ? AND chat_id = ?
`);

const stmtDeleteByChat = db.prepare(`DELETE FROM workspace_files WHERE chat_id = ?`);

// ─── Service ────────────────────────────────────────────────

// Base directory on the HOST for workspace volumes (Docker bind mount source).
// In Docker mode, we use named volumes — this is for local-dev file storage.
const LOCAL_WORKSPACE_ROOT = process.env.WORKSPACE_ROOT
  || path.resolve(process.cwd(), "data", "workspaces");

class FileWorkspaceService {
  /**
   * Get canonical workspace paths for a chat.
   * All paths are relative to the workspace volume root.
   */
  getWorkspacePaths(chatId: string): WorkspacePaths {
    const root = `/workspace`;
    return {
      root,
      inputDir: `${root}/input`,
      outputDir: `${root}/output`,
      tmpDir: `${root}/tmp`,
    };
  }

  /**
   * Resolve the HOST filesystem directory for a chat (local-dev mode).
   * In Docker mode the files live inside the named volume.
   */
  getHostDir(chatId: string): string {
    const sanitized = chatId.replace(/[^a-zA-Z0-9\-]/g, "");
    return path.join(LOCAL_WORKSPACE_ROOT, sanitized);
  }

  /**
   * Upload a file to /workspace/input.
   * In Docker mode: writes into the named volume via helper container.
   * In local mode: writes to host filesystem.
   */
  async uploadInput(
    userId: string,
    chatId: string,
    filename: string,
    content: Buffer,
    mimeType?: string | null
  ): Promise<FileRecord> {
    // Path traversal protection
    const safeName = this.sanitizeFilename(filename);
    const containerPath = `/workspace/input/${safeName}`;

    if (RUNTIME_MODE === "docker") {
      // Write directly into the named volume so the agent container can see it
      await writeFileToVolume(chatId, containerPath, content);
    } else {
      // Local mode: write to host filesystem
      const hostDir = path.join(this.getHostDir(chatId), "input");
      fs.mkdirSync(hostDir, { recursive: true });
      const diskPath = path.join(hostDir, safeName);
      if (!diskPath.startsWith(hostDir)) {
        throw new Error("Path traversal detected");
      }
      fs.writeFileSync(diskPath, content);
    }

    const id = uuidv4();
    const record: FileRecord = {
      id,
      userId,
      chatId,
      kind: "input",
      filename: safeName,
      path: containerPath,
      mimeType: mimeType || null,
      sizeBytes: content.length,
      createdAt: new Date().toISOString(),
    };

    stmtInsert.run(id, userId, chatId, "input", safeName, containerPath, record.mimeType, record.sizeBytes);
    return record;
  }

  /**
   * M5: write an input file to the workspace volume/host WITHOUT touching the
   * `workspace_files` registry. Used by the upload route AFTER the transactional
   * quota reservation (which UPSERTs the registry row). The reservation is the
   * source of truth; if this fs write fails the registry over-counts (safe
   * ceiling — reconciled on the next overwrite). Exposed so the route can split
   * the atomic DB reservation from the non-atomic fs write.
   */
  async writeInputFile(chatId: string, filename: string, content: Buffer): Promise<void> {
    const safeName = this.sanitizeFilename(filename);
    const containerPath = `/workspace/input/${safeName}`;
    if (RUNTIME_MODE === "docker") {
      await writeFileToVolume(chatId, containerPath, content);
    } else {
      const hostDir = path.join(this.getHostDir(chatId), "input");
      fs.mkdirSync(hostDir, { recursive: true });
      const diskPath = path.join(hostDir, safeName);
      if (!diskPath.startsWith(hostDir)) throw new Error("Path traversal detected");
      fs.writeFileSync(diskPath, content);
    }
  }

  /** M5: current registered size of an input file (for the overwrite delta). */
  getInputFileSize(chatId: string, filename: string): number {
    const row = stmtGetInputSize.get(chatId, this.sanitizeFilename(filename)) as { size_bytes: number } | undefined;
    return row?.size_bytes ?? 0;
  }

  /** M5: upsert an input-file registry row (used by the transactional quota
   *  reservation so concurrent uploads serialize at the DB writer). */
  upsertInputRecord(userId: string, chatId: string, filename: string, mimeType: string | null, sizeBytes: number): void {
    const safeName = this.sanitizeFilename(filename);
    stmtInsert.run(uuidv4(), userId, chatId, "input", safeName, `/workspace/input/${safeName}`, mimeType, sizeBytes);
  }

  /**
   * Register an output file produced by the agent.
   */
  registerOutput(userId: string, chatId: string, containerPath: string, filename: string, sizeBytes: number): FileRecord {
    const safeName = this.sanitizeFilename(filename);
    const id = uuidv4();
    const record: FileRecord = {
      id,
      userId,
      chatId,
      kind: "output",
      filename: safeName,
      path: containerPath,
      mimeType: null,
      sizeBytes,
      createdAt: new Date().toISOString(),
    };
    stmtInsert.run(id, userId, chatId, "output", safeName, containerPath, null, sizeBytes);
    return record;
  }

  /**
   * List all files for a chat (input + output).
   * Caller must have verified userId owns chatId.
   */
  listFiles(userId: string, chatId: string): FileRecord[] {
    return stmtList.all(userId, chatId) as FileRecord[];
  }

  /**
   * Get download handle for a specific file.
   * Returns null if not found or ownership mismatch.
   * In Docker mode, reads from the named volume.
   */
  async getDownload(userId: string, chatId: string, fileId: string): Promise<DownloadHandle | null> {
    const record = stmtGetById.get(fileId, userId, chatId) as FileRecord | undefined;
    if (!record) return null;

    if (RUNTIME_MODE === "docker") {
      // Read from volume and write to a temp file for express download
      const data = await readFileFromVolume(chatId, record.path);
      if (!data) return null;
      const tmpDir = path.join(LOCAL_WORKSPACE_ROOT, ".tmp");
      fs.mkdirSync(tmpDir, { recursive: true });
      const tmpPath = path.join(tmpDir, `${record.id}-${record.filename}`);
      fs.writeFileSync(tmpPath, data);
      return {
        absolutePath: tmpPath,
        filename: record.filename,
        mimeType: record.mimeType,
      };
    }

    // Local mode: read from host filesystem
    const kind = record.kind;
    const hostDir = path.join(this.getHostDir(chatId), kind);
    const absolutePath = path.join(hostDir, record.filename);
    if (!fs.existsSync(absolutePath)) return null;

    return {
      absolutePath,
      filename: record.filename,
      mimeType: record.mimeType,
    };
  }

  /**
   * Scan /workspace/output inside the named volume for new files not yet in the DB.
   * Registers any new files found and returns the new records.
   * No-op in local mode (output files are tracked via registerOutput calls).
   */
  async scanOutputFiles(userId: string, chatId: string): Promise<FileRecord[]> {
    if (RUNTIME_MODE !== "docker") return [];

    const existing = stmtList.all(userId, chatId) as FileRecord[];
    const existingPaths = new Set(
      existing.filter((f) => f.kind === "output").map((f) => f.path)
    );

    const volumeFiles = await listFilesInVolume(chatId, "/workspace/output");
    const newRecords: FileRecord[] = [];

    for (const vf of volumeFiles) {
      const containerPath = `/workspace/output/${vf.name}`;
      if (!existingPaths.has(containerPath)) {
        const record = this.registerOutput(userId, chatId, containerPath, vf.name, vf.size);
        newRecords.push(record);
      }
    }

    return newRecords;
  }

  /**
   * Delete all file records for a chat (called on chat deletion).
   */
  deleteByChat(chatId: string): void {
    stmtDeleteByChat.run(chatId);
    // Also remove host files
    const hostDir = this.getHostDir(chatId);
    if (fs.existsSync(hostDir)) {
      fs.rmSync(hostDir, { recursive: true, force: true });
    }
  }

  // ─── Private helpers ────────────────────────────────────────

  /**
   * Sanitize filename: strip path components and dangerous characters.
   */
  private sanitizeFilename(name: string): string {
    // Take only the basename (no directory traversal)
    let safe = path.basename(name);
    // Remove any remaining path separators and null bytes
    safe = safe.replace(/[\x00/\\]/g, "");
    // Fallback if empty
    if (!safe || safe === "." || safe === "..") {
      safe = `file-${uuidv4().slice(0, 8)}`;
    }
    return safe;
  }
}

export const fileWorkspaceService = new FileWorkspaceService();
