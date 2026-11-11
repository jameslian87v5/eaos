/**
 * registered-api-service.ts — Phase 6 (A3) CRUD for registered_apis table.
 *
 * Admin registers internal HTTP APIs here. The capability-installer then
 * generates a stdio-wrapper MCP package from the stored metadata.
 */

import { v4 as uuidv4 } from "uuid";
import db from "./database.js";
import type { RegisteredApi, ApiRegistrationInput } from "./types.js";

const DEFAULT_ORG_ID = "default-org";

// Same name rule as mcp-config.ts — prevents path traversal in mcp/<name>/
const VALID_API_NAME = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/;

// ─── Prepared statements ──────────────────────────────────────

const stmts = {
  insert: db.prepare(`
    INSERT INTO registered_apis (id, org_id, name, display_name, description, api_url, method, request_params_schema, response_mapping, timeout_ms, status, created_at, updated_at)
    VALUES (@id, @orgId, @name, @displayName, @description, @apiUrl, @method, @requestParamsSchema, @responseMapping, @timeoutMs, @status, @createdAt, @updatedAt)
  `),
  getById: db.prepare(`SELECT * FROM registered_apis WHERE id = @id`),
  getByName: db.prepare(`SELECT * FROM registered_apis WHERE org_id = @orgId AND name = @name`),
  listAll: db.prepare(`SELECT * FROM registered_apis ORDER BY created_at DESC`),
  listByOrg: db.prepare(`SELECT * FROM registered_apis WHERE org_id = @orgId ORDER BY created_at DESC`),
  update: db.prepare(`
    UPDATE registered_apis
    SET display_name = @displayName, description = @description, api_url = @apiUrl,
        method = @method, request_params_schema = @requestParamsSchema,
        response_mapping = @responseMapping, timeout_ms = @timeoutMs,
        status = @status, updated_at = @updatedAt
    WHERE id = @id
  `),
  delete: db.prepare(`DELETE FROM registered_apis WHERE id = @id`),
};

// ─── Row parser ───────────────────────────────────────────────

function parseRow(row: any): RegisteredApi {
  return {
    id: row.id,
    orgId: row.org_id,
    name: row.name,
    displayName: row.display_name ?? null,
    description: row.description ?? null,
    apiUrl: row.api_url,
    method: row.method as "GET" | "POST",
    requestParamsSchema: row.request_params_schema ? JSON.parse(row.request_params_schema) : null,
    responseMapping: row.response_mapping ? JSON.parse(row.response_mapping) : null,
    timeoutMs: row.timeout_ms,
    status: row.status as "active" | "disabled",
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

// ─── Service ──────────────────────────────────────────────────

class RegisteredApiService {
  validateInput(input: ApiRegistrationInput): void {
    if (!input.name || !VALID_API_NAME.test(input.name)) {
      throw new Error(`Invalid API name "${input.name}": must match ${VALID_API_NAME}`);
    }
    if (!input.apiUrl) {
      throw new Error("apiUrl is required");
    }
    this.validateUrl(input.apiUrl);
    if (input.method && input.method !== "GET" && input.method !== "POST") {
      throw new Error("method must be GET or POST");
    }
    this.validateSchemaFields(input.requestParamsSchema, input.responseMapping);
  }

  private validateUrl(apiUrl: string): void {
    try {
      const url = new URL(apiUrl);
      if (url.protocol !== "http:" && url.protocol !== "https:") {
        throw new Error("apiUrl must be http or https");
      }
    } catch (e) {
      if (e instanceof Error && e.message.includes("apiUrl must be")) throw e;
      throw new Error("apiUrl must be a valid http(s) URL");
    }
  }

  private validateSchemaFields(
    requestParamsSchema: Record<string, unknown> | null | undefined,
    responseMapping: Record<string, string> | null | undefined,
  ): void {
    if (requestParamsSchema !== undefined && requestParamsSchema !== null) {
      const schema = requestParamsSchema;
      if (typeof schema !== "object" || Array.isArray(schema)) {
        throw new Error("requestParamsSchema must be a JSON object");
      }
      if (schema.type !== undefined && schema.type !== "object") {
        throw new Error("requestParamsSchema.type must be 'object'");
      }
      if (schema.properties !== undefined && (typeof schema.properties !== "object" || Array.isArray(schema.properties))) {
        throw new Error("requestParamsSchema.properties must be a JSON object");
      }
    }
    if (responseMapping !== undefined && responseMapping !== null) {
      const mapping = responseMapping;
      if (typeof mapping !== "object" || Array.isArray(mapping)) {
        throw new Error("responseMapping must be a JSON object");
      }
      for (const [k, v] of Object.entries(mapping)) {
        if (typeof v !== "string") {
          throw new Error(`responseMapping.${k} must be a string`);
        }
      }
    }
  }

  create(input: ApiRegistrationInput): RegisteredApi {
    this.validateInput(input);
    const existing = stmts.getByName.get({ orgId: DEFAULT_ORG_ID, name: input.name });
    if (existing) {
      throw new Error(`API name "${input.name}" already exists`);
    }
    const id = uuidv4();
    const now = new Date().toISOString();
    const timeoutMs = Math.max(1000, Math.min(120000, input.timeoutMs ?? 30000));
    db.prepare(`
      INSERT INTO registered_apis (id, org_id, name, display_name, description, api_url, method, request_params_schema, response_mapping, timeout_ms, status, created_at, updated_at)
      VALUES (@id, @orgId, @name, @displayName, @description, @apiUrl, @method, @requestParamsSchema, @responseMapping, @timeoutMs, @status, @createdAt, @updatedAt)
    `).run({
      id,
      orgId: DEFAULT_ORG_ID,
      name: input.name,
      displayName: input.displayName ?? null,
      description: input.description ?? null,
      apiUrl: input.apiUrl,
      method: input.method ?? "GET",
      requestParamsSchema: input.requestParamsSchema ? JSON.stringify(input.requestParamsSchema) : null,
      responseMapping: input.responseMapping ? JSON.stringify(input.responseMapping) : null,
      timeoutMs,
      status: "active",
      createdAt: now,
      updatedAt: now,
    });
    return parseRow(stmts.getById.get({ id }));
  }

  getById(id: string): RegisteredApi | null {
    const row = stmts.getById.get({ id });
    return row ? parseRow(row) : null;
  }

  getByName(name: string): RegisteredApi | null {
    const row = stmts.getByName.get({ orgId: DEFAULT_ORG_ID, name });
    return row ? parseRow(row) : null;
  }

  listAll(): RegisteredApi[] {
    return stmts.listAll.all().map(parseRow);
  }

  update(id: string, input: Partial<ApiRegistrationInput> & { status?: "active" | "disabled" }): RegisteredApi | null {
    const existing = stmts.getById.get({ id }) as any;
    if (!existing) return null;
    const now = new Date().toISOString();
    const apiUrl = input.apiUrl ?? existing.api_url;
    if (input.apiUrl) {
      this.validateUrl(apiUrl);
    }
    // Validate schema fields if provided (same rules as create)
    this.validateSchemaFields(input.requestParamsSchema, input.responseMapping);
    const method = input.method ?? existing.method;
    const timeoutMs = input.timeoutMs !== undefined
      ? Math.max(1000, Math.min(120000, input.timeoutMs))
      : existing.timeout_ms;
    stmts.update.run({
      id,
      displayName: input.displayName ?? existing.display_name,
      description: input.description ?? existing.description,
      apiUrl,
      method,
      requestParamsSchema: input.requestParamsSchema !== undefined
        ? (input.requestParamsSchema ? JSON.stringify(input.requestParamsSchema) : null)
        : existing.request_params_schema,
      responseMapping: input.responseMapping !== undefined
        ? (input.responseMapping ? JSON.stringify(input.responseMapping) : null)
        : existing.response_mapping,
      timeoutMs,
      status: input.status ?? existing.status,
      updatedAt: now,
    });
    return parseRow(stmts.getById.get({ id }));
  }

  delete(id: string): boolean {
    const result = stmts.delete.run({ id });
    return result.changes > 0;
  }

  /**
   * Restore a previous DB row (used by admin route for update rollback).
   * Overwrites all fields for the given id with the snapshot values.
   */
  restore(snapshot: RegisteredApi): void {
    const now = new Date().toISOString();
    stmts.update.run({
      id: snapshot.id,
      displayName: snapshot.displayName,
      description: snapshot.description,
      apiUrl: snapshot.apiUrl,
      method: snapshot.method,
      requestParamsSchema: snapshot.requestParamsSchema ? JSON.stringify(snapshot.requestParamsSchema) : null,
      responseMapping: snapshot.responseMapping ? JSON.stringify(snapshot.responseMapping) : null,
      timeoutMs: snapshot.timeoutMs,
      status: snapshot.status,
      updatedAt: now,
    });
  }
}

export const registeredApiService = new RegisteredApiService();
