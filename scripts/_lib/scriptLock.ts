import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// diag/verify 스크립트 동시 실행 방지 락(파일 기반).
//
// 배경: 이번 장애는 코드 버그가 아니라 다수의 diag/verify 스크립트 + 대량 조회 API 가 동시에
// 떠 Supabase 연결풀/PostgREST 가 포화되어 발생했다. DB 를 건드리는 스크립트는 기본적으로
// 같은 락 키("vraxium-db-scripts")를 공유해 직렬화한다 → 한 번에 하나만 돈다.
//
// 사용(스크립트 맨 위):
//   import { acquireScriptLock } from "./_lib/scriptLock";
//   const lock = await acquireScriptLock("diag-uws-coverage-counts");
//   try { ...작업... } finally { lock.release(); }
//
//   - 이미 다른 스크립트가 실행 중이면(락 보유 + PID 생존 + 신선) 에러로 즉시 종료한다.
//   - 죽은 PID/오래된(STALE_MS 초과) 락은 자동 회수한다(좀비 락 방어).
//   - 장시간(WARN_AFTER_MS 초과) 실행 시 주기적으로 경고를 출력한다.
//   - process 종료(exit/SIGINT/SIGTERM/uncaught)시 락을 자동 해제한다.

// 같은 키를 공유하는 스크립트는 서로 동시에 못 돈다. DB 접근 스크립트 전부 이 기본 키를 쓴다.
const DEFAULT_LOCK_KEY = "vraxium-db-scripts";
// 이 시간보다 오래된 락은 좀비로 보고 회수한다(프로세스가 락 파일을 못 지우고 죽은 경우).
const STALE_MS = 30 * 60 * 1000; // 30분
// 이 시간을 넘겨 실행 중이면 경고를 출력하기 시작한다(장시간 루프 감지).
const WARN_AFTER_MS = 2 * 60 * 1000; // 2분
const WARN_EVERY_MS = 60 * 1000; // 이후 60초마다 반복 경고

type LockFile = { pid: number; name: string; startedAt: number; key: string };

export type ScriptLock = { release: () => void };

function lockDir(): string {
  const dir = join(tmpdir(), "vraxium-admin-script-locks");
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  return dir;
}

function lockPath(key: string): string {
  return join(lockDir(), `${key}.lock`);
}

function pidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    // signal 0 = 존재/권한 확인만(실제 시그널 안 보냄). ESRCH = 죽은 프로세스.
    process.kill(pid, 0);
    return true;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    // EPERM = 살아있지만 권한 없음(=생존으로 간주). ESRCH = 없음.
    return code === "EPERM";
  }
}

function readLock(path: string): LockFile | null {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as LockFile;
  } catch {
    return null;
  }
}

export type AcquireOptions = {
  // 같은 키끼리만 상호 배제. 기본=전 DB 스크립트 공유 키.
  key?: string;
  // true 면 락 점유 시 종료(exit 1) 대신 에러를 throw 한다(호출부가 처리).
  throwOnBusy?: boolean;
};

export async function acquireScriptLock(
  name: string,
  options: AcquireOptions = {},
): Promise<ScriptLock> {
  const key = options.key ?? DEFAULT_LOCK_KEY;
  const path = lockPath(key);

  const existing = readLock(path);
  if (existing) {
    const ageMs = Date.now() - existing.startedAt;
    const stale = ageMs > STALE_MS;
    const alive = pidAlive(existing.pid);
    if (alive && !stale) {
      const msg =
        `[scriptLock] 거부: 다른 스크립트가 이미 실행 중입니다 (key=${key}).\n` +
        `  실행 중: "${existing.name}" pid=${existing.pid} ` +
        `(${Math.round(ageMs / 1000)}s 경과)\n` +
        `  DB 포화 방지를 위해 동시에 하나만 실행됩니다. 끝난 뒤 다시 실행하세요.`;
      if (options.throwOnBusy) throw new Error(msg);
      console.error(msg);
      process.exit(1);
    }
    // 좀비 락(죽었거나 오래됨) — 회수.
    console.warn(
      `[scriptLock] 좀비 락 회수 (key=${key}): 이전 "${existing.name}" ` +
        `pid=${existing.pid} alive=${alive} stale=${stale}`,
    );
    try {
      rmSync(path, { force: true });
    } catch {
      /* 무시 */
    }
  }

  const startedAt = Date.now();
  const record: LockFile = { pid: process.pid, name, startedAt, key };
  // wx = 배타 생성. 경합으로 그 사이 누가 만들었으면 EEXIST → 한 번 더 거부 처리.
  try {
    writeFileSync(path, JSON.stringify(record), { flag: "wx" });
  } catch {
    const racer = readLock(path);
    const msg =
      `[scriptLock] 거부: 락 경합 (key=${key}). ` +
      `다른 스크립트가 방금 락을 잡았습니다${racer ? ` ("${racer.name}" pid=${racer.pid})` : ""}.`;
    if (options.throwOnBusy) throw new Error(msg);
    console.error(msg);
    process.exit(1);
  }

  console.log(`[scriptLock] 획득 (key=${key}) "${name}" pid=${process.pid}`);

  // 장시간 실행 경고 타이머.
  let warned = false;
  const warnTimer = setInterval(() => {
    const ageMs = Date.now() - startedAt;
    if (ageMs >= WARN_AFTER_MS) {
      warned = true;
      console.warn(
        `[scriptLock] ⚠ "${name}" 장시간 실행 중 (${Math.round(ageMs / 1000)}s). ` +
          `대량 루프라면 청크/동시성 제한을 확인하세요.`,
      );
    }
  }, WARN_EVERY_MS);
  // 타이머가 프로세스 종료를 막지 않도록.
  if (typeof warnTimer.unref === "function") warnTimer.unref();

  let released = false;
  const release = () => {
    if (released) return;
    released = true;
    clearInterval(warnTimer);
    const current = readLock(path);
    // 내 락일 때만 지운다(좀비 회수 후 남이 잡은 락을 실수로 지우지 않도록).
    if (current && current.pid === process.pid) {
      try {
        rmSync(path, { force: true });
      } catch {
        /* 무시 */
      }
    }
    const totalMs = Date.now() - startedAt;
    if (warned) {
      console.log(`[scriptLock] 해제 "${name}" (총 ${Math.round(totalMs / 1000)}s)`);
    }
  };

  // 어떤 경로로 죽어도 락을 해제(좀비 락 최소화).
  process.once("exit", release);
  process.once("SIGINT", () => {
    release();
    process.exit(130);
  });
  process.once("SIGTERM", () => {
    release();
    process.exit(143);
  });
  process.once("uncaughtException", (err) => {
    release();
    console.error("[scriptLock] uncaughtException →", err);
    process.exit(1);
  });

  return { release };
}
