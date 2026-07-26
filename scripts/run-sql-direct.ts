/**
 * 직접 DB 연결로 .sql 파일을 **분할 없이 한 번에** 실행한다 (Supabase SQL Editor 크기 제한 우회).
 *
 *   npx tsx --env-file=.env.local scripts/run-sql-direct.ts <file.sql>            # preview(연결·검증만, 실행 안 함)
 *   npx tsx --env-file=.env.local scripts/run-sql-direct.ts <file.sql> --run      # 실제 실행
 *
 * 연결 문자열: .env.local 의 SUPABASE_DB_URL (파일은 .gitignore 의 `.env*.local` 로 이미 제외됨).
 *   ⚠ 이 스크립트는 연결 문자열·비밀번호를 **어떤 경로로도 출력하지 않는다**(호스트/DB명/포트만 마스킹 표기).
 *   ⚠ 오류 메시지에 문자열이 섞여 나올 가능성까지 차단하기 위해 출력 전 마스킹 필터를 건다.
 *
 * 실행 계약:
 *   · 파일 전체를 simple query 프로토콜로 1회 전송한다 — 임의 분할 없음.
 *   · 파일이 스스로 begin;/commit; 을 갖는다. 중간에 raise exception 이 나면 배치가 중단되고
 *     트랜잭션은 ROLLBACK 된다(commit 도달 불가).
 *   · RAISE NOTICE 는 전부 수집해 순서대로 출력한다([backup]/[plan]/[update]/[verify]).
 */
import { readFileSync, existsSync } from "fs";
import { Client } from "pg";

const args = process.argv.slice(2);
const file = args.find((a) => !a.startsWith("--"));
const RUN = args.includes("--run");

function readDbUrl(): string {
  // process.env 우선(--env-file 로 주입) · 없으면 .env.local 직접 파싱(값 안의 '#' 절단 트랩 회피).
  const fromEnv = process.env.SUPABASE_DB_URL;
  if (fromEnv) return fromEnv.trim();
  try {
    const raw = readFileSync(".env.local", "utf8");
    const m = raw.match(/^SUPABASE_DB_URL=(.+)$/m);
    if (m) return m[1].trim();
  } catch {
    /* noop */
  }
  throw new Error(
    "SUPABASE_DB_URL 미설정 — .env.local 에 다음 형식으로 추가할 것(값은 출력하지 말 것):\n" +
      "  SUPABASE_DB_URL=postgresql://postgres.<PROJECT_REF>:<PASSWORD>@aws-0-<REGION>.pooler.supabase.com:5432/postgres",
  );
}

/** 로그에 연결 문자열/비밀번호가 새지 않도록 마스킹. */
function makeMasker(url: string) {
  const secrets = new Set<string>();
  secrets.add(url);
  try {
    const u = new URL(url);
    if (u.password) secrets.add(decodeURIComponent(u.password));
    if (u.password) secrets.add(u.password);
  } catch {
    /* noop */
  }
  return (s: string) => {
    let out = s;
    for (const sec of secrets) if (sec && sec.length > 3) out = out.split(sec).join("«REDACTED»");
    return out;
  };
}

async function main() {
  if (!file) throw new Error("사용법: run-sql-direct.ts <file.sql> [--run]");
  if (!existsSync(file)) throw new Error(`파일 없음: ${file}`);
  const sql = readFileSync(file, "utf8");

  const url = readDbUrl();
  const mask = makeMasker(url);

  // 자리표시자 잔존 검출 — 템플릿을 그대로 붙여넣은 경우를 명확히 알린다(가장 흔한 실수).
  const placeholders = [...url.matchAll(/<([^>]{1,40})>|\[([^\]]{1,40})\]|\{\{?([^}]{1,40})\}?\}/g)].map(
    (m) => m[0],
  );
  if (placeholders.length > 0) {
    throw new Error(
      `SUPABASE_DB_URL 에 치환되지 않은 자리표시자가 ${placeholders.length}개 남아 있다: ${placeholders.join(" ")}\n` +
        "  Supabase Dashboard → Project Settings → Database → Connection string → Session pooler 의\n" +
        "  **실제 값**으로 교체할 것(대괄호/꺾쇠 포함해서 통째로 치환). 비밀번호에 @ : / ? # % 가 있으면 URL 인코딩 필요.",
    );
  }

  let host = "?", port = "?", db = "?", user = "?";
  try {
    const u = new URL(url);
    host = u.hostname;
    port = u.port || "5432";
    db = u.pathname.replace(/^\//, "");
    user = u.username.replace(/^(.{4}).*$/, "$1***");
  } catch {
    // WHATWG URL 이 거부해도 pg 자체 파서(pg-connection-string)가 받으면 진행한다.
    try {
      const { parse } = require("pg-connection-string") as { parse: (s: string) => Record<string, unknown> };
      const c = parse(url);
      host = String(c.host ?? "?");
      port = String(c.port ?? "5432");
      db = String(c.database ?? "?");
      user = String(c.user ?? "?").replace(/^(.{4}).*$/, "$1***");
    } catch {
      throw new Error(
        "SUPABASE_DB_URL 을 해석할 수 없다 — postgresql://USER:PASSWORD@HOST:5432/postgres 형태여야 한다.\n" +
          "  (값은 여기에 출력하지 않는다. .env.local 의 해당 줄만 다시 확인할 것)",
      );
    }
  }

  console.log(`파일   : ${file} (${(sql.length / 1048576).toFixed(2)} MB, ${sql.split("\n").length} 라인)`);
  console.log(`연결   : ${host.replace(/^([^.]{0,6})[^.]*/, "$1***")}:${port} db=${db} user=${user}`);
  if (port === "6543") {
    console.warn("⚠ 6543 = transaction pooler. 다중문 트랜잭션/DO 블록은 **session pooler(5432)** 또는 직접 연결을 쓸 것.");
  }
  if (!RUN) {
    console.log("\npreview — 연결/실행하지 않았다. 실제 실행은 --run");
    return;
  }

  const client = new Client({ connectionString: url, ssl: { rejectUnauthorized: false }, statement_timeout: 0, query_timeout: 0 });
  const notices: string[] = [];
  client.on("notice", (n) => {
    const line = `${n.severity ?? "NOTICE"}: ${n.message ?? ""}`;
    notices.push(line);
    console.log("  " + mask(line));
  });

  const t0 = Date.now();
  try {
    await client.connect();
    const v = await client.query("select current_database() db, version() v");
    console.log(`접속 성공 — db=${v.rows[0].db} ${String(v.rows[0].v).split(",")[0]}`);
    console.log(`\n── 실행 시작 (분할 없음 · 파일 1회 전송) ──`);
    await client.query(sql);
    console.log(`\n✅ 실행 완료 (${((Date.now() - t0) / 1000).toFixed(1)}s) — COMMIT 도달`);
    console.log(`NOTICE ${notices.length}건 수집`);
  } catch (e) {
    const err = e as { message?: string; where?: string; detail?: string; code?: string };
    console.error(`\n❌ 실행 실패 (${((Date.now() - t0) / 1000).toFixed(1)}s) — 트랜잭션 ROLLBACK`);
    console.error("  code   :", err.code ?? "-");
    console.error("  message:", mask(String(err.message ?? e)));
    if (err.detail) console.error("  detail :", mask(err.detail));
    if (err.where) console.error("  where  :", mask(err.where).slice(0, 500));
    process.exitCode = 1;
  } finally {
    await client.end().catch(() => {});
  }
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
