/**
 * logger.ts — lightweight stdout/stderr tee to a daily log file.
 *
 * No dependency, no call-site changes. On import it wraps process.stdout/stderr
 * `.write` so EVERY console output is ALSO appended — timestamped,
 * line-buffered — to `logs/server-YYYY-MM-DD.log` (auto-rolls daily; `*.log` is
 * gitignored). Must be imported first in server.ts to capture all output.
 *
 * Failures are swallowed: logging must never break the server. If `logs/` can't
 * be written, output still goes to the terminal (the original write always runs).
 */
import fs from "node:fs";
import path from "node:path";

const LOG_DIR = path.resolve(process.cwd(), "logs");
let currentDay = "";
let stream: fs.WriteStream | null = null;

function getStream(): fs.WriteStream | null {
  try {
    const day = new Date().toISOString().slice(0, 10);
    if (day !== currentDay || !stream) {
      if (stream) stream.end();
      fs.mkdirSync(LOG_DIR, { recursive: true });
      currentDay = day;
      stream = fs.createWriteStream(path.join(LOG_DIR, `server-${day}.log`), { flags: "a" });
    }
    return stream;
  } catch {
    return null;
  }
}

const ts = () => new Date().toISOString();

function attachTee(io: NodeJS.WriteStream, label: "OUT" | "ERR") {
  const orig = io.write.bind(io) as (chunk: unknown, ...args: unknown[]) => boolean;
  let pending = "";
  (io as { write: unknown }).write = function (chunk: unknown, ...rest: unknown[]): boolean {
    try {
      pending += typeof chunk === "string" ? chunk : String(chunk ?? "");
      let idx: number;
      while ((idx = pending.indexOf("\n")) >= 0) {
        const line = pending.slice(0, idx);
        pending = pending.slice(idx + 1);
        getStream()?.write(`${ts()} ${label} ${line}\n`);
      }
    } catch {
      /* never let logging throw into the app */
    }
    return orig(chunk, ...rest);
  };
}

try {
  attachTee(process.stdout, "OUT");
  attachTee(process.stderr, "ERR");
  getStream()?.write(`${ts()} === logger attached → ${path.join(LOG_DIR, `server-${currentDay}.log`)} ===\n`);
} catch {
  /* swallow */
}

// P0-2: register fatal-exception handlers HERE, not in server.ts. logger.ts is
// the first import in server.ts, so this runs BEFORE the static imports that pull
// in database.ts (which opens SQLite synchronously at module-eval time). Without
// this ordering, a DB-open failure during import would surface as a raw
// SqliteError stack instead of a clean [FATAL] line. The tee above is already
// attached, so these are captured to the log file too.
// Render a fatal as a single clean line (Name: message), no stack — matches the
// [FATAL] style used for listen errors and keeps boot failures legible.
function fatalMsg(x: unknown): string {
  return x instanceof Error ? `${x.name}: ${x.message}` : String(x);
}
process.on("uncaughtException", (err) => {
  console.error(`[FATAL] Uncaught exception: ${fatalMsg(err)}`);
  process.exit(1);
});
process.on("unhandledRejection", (reason) => {
  console.error(`[FATAL] Unhandled promise rejection: ${fatalMsg(reason)}`);
  process.exit(1);
});
