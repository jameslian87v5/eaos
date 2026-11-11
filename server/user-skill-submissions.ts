/**
 * user-skill-submissions.ts — Octop absorption M7b: the submission ledger for
 * governed user skill packages.
 *
 * ONE PIPELINE: submission always enters the M3 importSkillZip validator
 * (bounded extraction → scanner → repackage → atomic quarantine install →
 * real resolveOne validation). This ledger only records review state and
 * provenance — it is NOT a second validator, NOT a per-user directory, and
 * NEVER gates resolution (entitlement does that).
 *
 * State machine (terminal states marked ✝):
 *   pending_review  — import succeeded; registry row enabled:false in quarantine
 *   quarantined     — the M3 pipeline REJECTED the package (zero residue);
 *                     the slug stays free → same slug is re-submittable
 *   approved ✝      — admin approved: skill enabled + submitter-only
 *                     user-scope entitlement
 *   rejected ✝      — admin rejected: registry row stays enabled:false, zero
 *                     entitlement; the slug stays OCCUPIED (re-submit → 409
 *                     until the skill is removed via admin governance)
 *
 * Store: JSON file (env USER_SKILL_SUBMISSIONS_FILE), atomic tmp+rename write,
 * fail-closed load (a malformed file throws — never silently reset).
 */
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { RequestContext } from "./request-context.js";

const PROJECT_ROOT = process.cwd();
const DATA_DIR = path.resolve(PROJECT_ROOT, "data");
// Env override keeps unit tests hermetic; unset in production → default path.
const SUBMISSIONS_FILE =
  process.env.USER_SKILL_SUBMISSIONS_FILE || path.resolve(DATA_DIR, "user-skill-submissions.json");

export type SubmissionStatus = "pending_review" | "quarantined" | "rejected" | "approved";

/** Secret-free package summary (mirrors the M3 review manifest). */
export interface SubmissionManifestSummary {
  sha256: string;
  fileCount: number;
  hasScripts: boolean;
  license: string | null;
  description: string;
  version: string;
  files: string[];
}

export interface UserSkillSubmission {
  id: string;
  slug: string;
  submitterUserId: string;
  orgId: string;
  status: SubmissionStatus;
  /** Categorical M3 rejection code (quarantined only). */
  errorCode?: string;
  /** Categorical admin rejection code (rejected only) — no free text. */
  reasonCode?: string;
  manifest?: SubmissionManifestSummary;
  createdAt: string;
  updatedAt: string;
  reviewedAt?: string;
  reviewedBy?: string;
}

interface SubmissionStore {
  version: 1;
  submissions: UserSkillSubmission[];
}

export class SubmissionStoreError extends Error {
  code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "SubmissionStoreError";
    this.code = code;
  }
}

/**
 * M7b fix round P1-3 / round 2: fixed submission caps (constants only — no
 * dynamic quota framework). An "open" record consumes a slot: pending_review
 * OR quarantined — a quarantined record still cost the request pipeline
 * (80MB body handling, extraction, scanning, ledger storage, admin queue
 * entry), so counting pending-only would let a user farm unlimited invalid
 * unique-slug submissions. approved/rejected never block a re-submit.
 */
export const SUBMISSION_CAPS = { perSubmitter: 5, perOrg: 20 } as const;

function readFromDisk(): SubmissionStore {
  if (!fs.existsSync(SUBMISSIONS_FILE)) return { version: 1, submissions: [] };
  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(SUBMISSIONS_FILE, "utf8"));
  } catch {
    throw new SubmissionStoreError("store_invalid", `${SUBMISSIONS_FILE} is malformed — refusing to overwrite the ledger`);
  }
  if (!parsed || typeof parsed !== "object" || !Array.isArray((parsed as SubmissionStore).submissions)) {
    throw new SubmissionStoreError("store_invalid", `${SUBMISSIONS_FILE} is not a submission store — refusing to overwrite the ledger`);
  }
  return parsed as SubmissionStore;
}

function writeToDisk(store: SubmissionStore): void {
  fs.mkdirSync(path.dirname(SUBMISSIONS_FILE), { recursive: true });
  const tmp = SUBMISSIONS_FILE + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(store, null, 2) + "\n");
  fs.renameSync(tmp, SUBMISSIONS_FILE);
}

export class UserSkillSubmissionService {
  /**
   * M7b fix round P1-1: fail-closed preflight — a malformed ledger must block
   * submission BEFORE the import installs a package (otherwise the request
   * fails after leaving an orphan quarantine dir + registry row). Throws
   * SubmissionStoreError("store_invalid") on bad bytes/shape.
   */
  assertHealthy(): void {
    readFromDisk();
  }

  /** Fix round 2: "open" records consume cap slots (pending + quarantined). */
  private static isOpen(s: UserSkillSubmission): boolean {
    return s.status === "pending_review" || s.status === "quarantined";
  }

  countOpenForSubmitter(userId: string): number {
    return readFromDisk().submissions.filter(
      (s) => UserSkillSubmissionService.isOpen(s) && s.submitterUserId === userId
    ).length;
  }

  countOpenForOrg(orgId: string): number {
    return readFromDisk().submissions.filter(
      (s) => UserSkillSubmissionService.isOpen(s) && s.orgId === orgId
    ).length;
  }

  listAll(): UserSkillSubmission[] {
    return readFromDisk().submissions;
  }

  /** Submitter-scoped read (the /api/my-skills contract). */
  listForSubmitter(userId: string): UserSkillSubmission[] {
    return this.listAll().filter((s) => s.submitterUserId === userId);
  }

  /** org_admin review-queue read: own-org records only. */
  listForOrg(orgId: string): UserSkillSubmission[] {
    return this.listAll().filter((s) => s.orgId === orgId);
  }

  getById(id: string): UserSkillSubmission | undefined {
    return this.listAll().find((s) => s.id === id);
  }

  createSubmission(args: {
    ctx: RequestContext;
    slug: string;
    /** Pre-generated id when the registry row must reference it before this write. */
    id?: string;
    manifest?: SubmissionManifestSummary;
  }): UserSkillSubmission {
    const now = new Date().toISOString();
    const record: UserSkillSubmission = {
      id: args.id ?? `m7b-${randomUUID()}`,
      slug: args.slug,
      submitterUserId: args.ctx.userId,
      orgId: args.ctx.orgId,
      status: "pending_review",
      ...(args.manifest ? { manifest: args.manifest } : {}),
      createdAt: now,
      updatedAt: now,
    };
    const store = readFromDisk();
    store.submissions.push(record);
    writeToDisk(store);
    return record;
  }

  /** Record a package the M3 pipeline rejected (zero package residue). */
  recordQuarantined(args: { ctx: RequestContext; slug: string; errorCode: string }): UserSkillSubmission {
    const now = new Date().toISOString();
    const record: UserSkillSubmission = {
      id: `m7b-${randomUUID()}`,
      slug: args.slug,
      submitterUserId: args.ctx.userId,
      orgId: args.ctx.orgId,
      status: "quarantined",
      errorCode: args.errorCode,
      createdAt: now,
      updatedAt: now,
    };
    const store = readFromDisk();
    store.submissions.push(record);
    writeToDisk(store);
    return record;
  }

  /**
   * Terminal transition (approve/reject). Throws SubmissionStoreError on an
   * illegal transition — the caller compensates any external writes BEFORE
   * calling this (this store write is the commit point).
   */
  markReviewed(args: {
    id: string;
    status: "approved" | "rejected";
    reviewer: RequestContext;
    reasonCode?: string;
  }): UserSkillSubmission {
    const store = readFromDisk();
    const rec = store.submissions.find((s) => s.id === args.id);
    if (!rec) throw new SubmissionStoreError("not_found", `submission ${args.id} not found`);
    if (rec.status !== "pending_review") {
      throw new SubmissionStoreError(
        "invalid_state",
        `submission ${args.id} is "${rec.status}" — only pending_review can be reviewed`
      );
    }
    rec.status = args.status;
    rec.reviewedAt = new Date().toISOString();
    rec.reviewedBy = args.reviewer.userId;
    if (args.status === "rejected" && args.reasonCode) rec.reasonCode = args.reasonCode.slice(0, 64);
    rec.updatedAt = rec.reviewedAt;
    writeToDisk(store);
    return rec;
  }
}

export const userSkillSubmissionService = new UserSkillSubmissionService();
