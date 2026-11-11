import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { realpathRoots, isPathAllowed, resolveToolPath } from "./workspace-guard.js";

// ── Fixtures: a temp "workspace root" + sibling chat dir + escape symlink ──
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "ws-guard-"));
const ROOT = path.join(TMP, "ws"); // this chat's workspace
const SIBLING = path.join(TMP, "other-chat"); // another tenant
fs.mkdirSync(path.join(ROOT, "sub"), { recursive: true });
fs.mkdirSync(SIBLING, { recursive: true });
fs.writeFileSync(path.join(ROOT, "file.txt"), "x");
fs.writeFileSync(path.join(SIBLING, "secret.txt"), "y");

// In-workspace symlink pointing OUTSIDE (→ os.tmpdir) — symlink-escape attempt.
// Symlink support varies by platform/permissions; skip the case if unavailable.
try {
  fs.symlinkSync(os.tmpdir(), path.join(ROOT, "escape-link"));
} catch {
  /* ignore */
}
const hasSymlink = fs.existsSync(path.join(ROOT, "escape-link"));

const realRoots = realpathRoots([ROOT]);
assert.equal(realRoots.length, 1, "workspace root must realpath to one entry");

// 1. allow in-workspace path (existing file)
assert.equal(isPathAllowed(path.join(ROOT, "file.txt"), realRoots).ok, true);
// 1b. allow in-workspace new file under existing dir (ENOENT → parent check)
assert.equal(isPathAllowed(path.join(ROOT, "sub", "deep.txt"), realRoots).ok, true);

// 2. deny ../ traversal escape
assert.equal(
  isPathAllowed(path.join(ROOT, "..", "other-chat", "secret.txt"), realRoots).ok,
  false,
);

// 3. deny absolute host path (/etc/passwd exists on mac/linux → resolves outside)
assert.equal(isPathAllowed("/etc/passwd", realRoots).ok, false);

// 4. deny symlink escape: in-workspace symlink → /tmp resolves outside
if (hasSymlink) {
  assert.equal(isPathAllowed(path.join(ROOT, "escape-link"), realRoots).ok, false);
}

// 5. deny sibling chat dir (cross-tenant)
assert.equal(isPathAllowed(path.join(SIBLING, "secret.txt"), realRoots).ok, false);

// 6. prefix-collision: a dir whose name starts with the root name is NOT under it
const evilRoot = path.join(TMP, "ws-evil");
fs.mkdirSync(evilRoot, { recursive: true });
fs.writeFileSync(path.join(evilRoot, "x"), "z");
assert.equal(isPathAllowed(path.join(evilRoot, "x"), realRoots).ok, false);

// 7. allow when path is under a SECOND configured root (multi-root)
const realRoots2 = realpathRoots([ROOT, evilRoot]);
assert.equal(isPathAllowed(path.join(evilRoot, "x"), realRoots2).ok, true);
assert.equal(isPathAllowed(path.join(ROOT, "file.txt"), realRoots2).ok, true);

// 8. Write new file: inside root → allow (parent check); outside root → deny
assert.equal(isPathAllowed(path.join(ROOT, "brand-new.txt"), realRoots).ok, true);
assert.equal(isPathAllowed(path.join(SIBLING, "new-outside.txt"), realRoots).ok, false);

// 9. empty roots → deny everything (deny-default)
assert.equal(isPathAllowed(path.join(ROOT, "file.txt"), []).ok, false);

// 10. non-existent root → realpathRoots drops it → effectively deny
assert.equal(realpathRoots([path.join(TMP, "does-not-exist")]).length, 0);

// 11. relative target resolved against SDK cwd (workspace root) — Codex review
// evt_20260724013725: the hook must resolveToolPath(target, cwd) BEFORE
// isPathAllowed, matching the SDK's cwd semantics (not process.cwd()).
// in-workspace relative (existing file)
assert.equal(isPathAllowed(resolveToolPath("file.txt", ROOT), realRoots).ok, true);
// in-workspace relative (nested new file under existing dir)
assert.equal(
  isPathAllowed(resolveToolPath(path.join("sub", "deep.txt"), ROOT), realRoots).ok,
  true,
);
// relative traversal escaping the workspace via ..
assert.equal(
  isPathAllowed(
    resolveToolPath(path.join("..", "other-chat", "secret.txt"), ROOT),
    realRoots,
  ).ok,
  false,
);
// absolute target is passed through unchanged by resolveToolPath
assert.equal(resolveToolPath("/etc/passwd", ROOT), "/etc/passwd");

// cleanup
fs.rmSync(TMP, { recursive: true, force: true });

console.log("workspace-guard tests passed");
