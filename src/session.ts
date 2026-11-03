/**
 * session.ts — the run-fast session store: meta/out files under ~/.run-fast.
 *
 * Every run (foreground, detached) persists its full output to a session file
 * and its status to a JSON meta file, so nothing is ever lost and a killed
 * process can be recovered via `kairos attach|logs|cancel <id>`. Corrupt or
 * truncated meta rows (crash/OOM/SIGKILL mid-write) are skipped, never allowed
 * to take down `list`/`purge`.
 */
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";

export const SESSION_DIR = sessionDir();

/** Resolve the session store dir. Honors KAIROS_SESSION_DIR (tests) else ~/.run-fast. */
export function sessionDir(): string {
  return (
    process.env.KAIROS_SESSION_DIR ||
    join(process.env.HOME || "/tmp", ".run-fast")
  );
}

export interface SessionMeta {
  id: string;
  cmd: string;
  startTime: number;
  endTime: number | null;
  exitCode: number | null;
  state: "running" | "done";
}

function metaPath(id: string) {
  return join(sessionDir(), `${id}.json`);
}
export function outPath(id: string) {
  return join(sessionDir(), `${id}.out`);
}

export function getSessions(): SessionMeta[] {
  if (!existsSync(sessionDir())) return [];
  const now = Date.now();
  const sessions: SessionMeta[] = [];
  for (const f of readdirSync(sessionDir())) {
    if (!f.endsWith(".json")) continue;
    let raw = "";
    try {
      raw = readFileSync(join(sessionDir(), f), "utf-8");
      if (!raw.trim()) continue;
      const parsed = JSON.parse(raw) as Partial<SessionMeta>;
      if (
        !parsed ||
        typeof parsed.id !== "string" ||
        parsed.id !== f.replace(/\.json$/, "")
      )
        continue;
      sessions.push({
        id: parsed.id,
        cmd: String(parsed.cmd ?? ""),
        startTime:
          typeof parsed.startTime === "number" ? parsed.startTime : now,
        endTime: parsed.endTime == null ? null : Number(parsed.endTime),
        exitCode: parsed.exitCode == null ? null : Number(parsed.exitCode),
        state:
          parsed.state === "running" || parsed.state === "done"
            ? parsed.state
            : "done",
      });
    } catch {
      continue;
    }
  }
  return sessions.sort((a, b) => a.startTime - b.startTime);
}

export function writeMeta(id: string, m: SessionMeta) {
  mkdirSync(sessionDir(), { recursive: true });
  writeFileSync(metaPath(id), JSON.stringify(m));
}

export function readMeta(id: string): SessionMeta | null {
  try {
    return JSON.parse(readFileSync(metaPath(id), "utf-8")) as SessionMeta;
  } catch {
    return null;
  }
}

export function deleteSession(id: string) {
  try {
    rmSync(metaPath(id));
    rmSync(outPath(id));
  } catch {}
}

export function genId(name?: string) {
  if (name) return `rf-${name}`;
  return "rf-" + crypto.randomUUID().slice(0, 8);
}