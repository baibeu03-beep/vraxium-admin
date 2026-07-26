/**
 * 5단계 — 실행 전 백업 확보 + **파일 백업만으로 복원 가능한지** 검증 (READ-ONLY · DB write 0).
 *   npx tsx --env-file=.env.local scripts/recover-uwp-backup-verify.ts
 *
 * 이 환경에는 DDL/트랜잭션 실행 경로가 없다(exec_sql RPC 부재 · pg 드라이버 부재 · psql 부재 ·
 * DATABASE_URL 부재). 따라서 DB 내부 백업표는 만들 수 없고, 파일 백업이 유일한 사본이다.
 * 그 파일 백업이 "복원에 충분한가" 를 다음 4가지로 증명한다:
 *   ① 컬럼 완전성 — 라이브 테이블의 전 컬럼이 백업에 존재하는가
 *   ② 행 완전성   — PK 집합이 라이브와 정확히 일치하는가
 *   ③ 값 일치     — 현재 라이브 값과 백업 값이 일치하는가(드리프트 없음)
 *   ④ 복원 가능성 — 백업만으로 각 행의 모든 컬럼을 재구성할 수 있는가(누락 필드 0)
 * 추가로 복구 대상 11,508행만 따로 떼어 별도 백업 파일로 저장한다.
 */
import { readFileSync, writeFileSync, readdirSync, existsSync, statSync } from "fs";
import { createHash } from "crypto";
import { supabaseAdmin } from "@/lib/supabaseAdmin";

const STAMP = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);

async function pageAll<T>(b: (f: number, t: number) => PromiseLike<{ data: unknown; error: { message: string } | null }>, page = 1000): Promise<T[]> {
  const o: T[] = [];
  for (let f = 0; ; f += page) {
    const { data, error } = await b(f, f + page - 1);
    if (error) throw new Error(error.message);
    const r = (data ?? []) as T[];
    o.push(...r);
    if (r.length < page) break;
  }
  return o;
}

const sha = (s: string) => createHash("sha256").update(s).digest("hex").slice(0, 16);

async function main() {
  const dirs = readdirSync("backups").filter((d) => d.startsWith("uwp-baseline-freeze-")).sort();
  if (dirs.length === 0) throw new Error("동결 백업 없음 — npm run freeze:uwp-baseline 먼저 실행");
  const markerDir = `backups/${dirs[0]}`;   // §2 마커 보유(마이그 이전)
  const latestDir = `backups/${dirs[dirs.length - 1]}`; // 현재 상태(legacy_* 포함)
  console.log(`마커 동결본 : ${markerDir}`);
  console.log(`최신 동결본 : ${latestDir}\n`);

  // ── 라이브 ──
  const live = await pageAll<Record<string, unknown>>((f, t) =>
    supabaseAdmin.from("user_weekly_points").select("*").order("id").range(f, t));
  const liveCols = Object.keys(live[0] ?? {}).sort();
  const liveById = new Map(live.map((r) => [String(r.id), r]));

  // ── 백업 ──
  const backup = JSON.parse(readFileSync(`${latestDir}/user_weekly_points.json`, "utf8")) as Array<Record<string, unknown>>;
  const backupCols = Object.keys(backup[0] ?? {}).sort();
  const backupById = new Map(backup.map((r) => [String(r.id), r]));

  console.log("═══ ① 컬럼 완전성 ═══");
  const missingCols = liveCols.filter((c) => !backupCols.includes(c));
  console.log(`  라이브 컬럼 ${liveCols.length}: ${liveCols.join(", ")}`);
  console.log(`  백업 컬럼   ${backupCols.length}`);
  console.log(`  백업에 없는 라이브 컬럼: ${missingCols.length} ${missingCols.length === 0 ? "✅" : "❌ " + missingCols.join(",")}`);

  console.log("\n═══ ② 행 완전성(PK 집합) ═══");
  const onlyLive = [...liveById.keys()].filter((k) => !backupById.has(k));
  const onlyBackup = [...backupById.keys()].filter((k) => !liveById.has(k));
  console.log(`  라이브 ${live.length}행 · 백업 ${backup.length}행`);
  console.log(`  백업 누락(라이브에만): ${onlyLive.length} ${onlyLive.length === 0 ? "✅" : "❌"}`);
  console.log(`  백업 잉여(백업에만):   ${onlyBackup.length} ${onlyBackup.length === 0 ? "✅" : "⚠ 복원 시 추가 생성됨"}`);

  console.log("\n═══ ③ 값 일치(드리프트) ═══");
  let diff = 0;
  const diffCols = new Map<string, number>();
  for (const [id, l] of liveById) {
    const b = backupById.get(id);
    if (!b) continue;
    for (const c of liveCols) {
      if (JSON.stringify(l[c] ?? null) !== JSON.stringify(b[c] ?? null)) {
        diff++;
        diffCols.set(c, (diffCols.get(c) ?? 0) + 1);
      }
    }
  }
  console.log(`  값이 다른 (행,컬럼) 쌍: ${diff} ${diff === 0 ? "✅ 완전 일치" : "→ " + JSON.stringify([...diffCols])}`);

  console.log("\n═══ ④ 복원 가능성 ═══");
  const REQUIRED = ["id", "user_id", "year", "week_number", "week_start_date", "points", "advantages", "penalty", "checks_migrated"];
  const nullish = REQUIRED.filter((c) => backup.some((r) => r[c] === undefined));
  console.log(`  복원 필수 컬럼 ${REQUIRED.length}개 전 행 보유: ${nullish.length === 0 ? "✅" : "❌ " + nullish.join(",")}`);
  const hasLegacy = backupCols.includes("legacy_points");
  console.log(`  legacy_* 계층 컬럼 포함: ${hasLegacy ? "✅ (계층 복원 가능)" : "⚠ 없음 — 마이그 이전 동결본"}`);
  console.log(`  → 백업만으로 user_weekly_points 전 행·전 컬럼 재구성 ${missingCols.length === 0 && onlyLive.length === 0 && nullish.length === 0 ? "✅ 가능" : "❌ 불가"}`);

  // ── 마커 동결본 검증 ──
  console.log("\n═══ §2 마커 동결본 ═══");
  const marker = JSON.parse(readFileSync(`${markerDir}/user_weekly_points.json`, "utf8")) as Array<{ id: string; updated_at: string | null }>;
  const markerHits = marker.filter((r) => String(r.updated_at ?? "").startsWith("2026-07-25T04:52:05"));
  console.log(`  §2 wipe 마커 보유 행: ${markerHits.length} ${markerHits.length === 13110 ? "✅ (라이브에서는 소실됨 — 이 파일이 유일 원천)" : "❌"}`);

  // ── 복구 대상 11,508행 별도 백업 ──
  console.log("\n═══ 복구 대상 별도 백업 ═══");
  const dryFile = "claudedocs/" + readdirSync("claudedocs").filter((x) => x.startsWith("recover-uwp-dryrun-") && x.endsWith(".json")).sort().pop()!;
  const { rows: dry } = JSON.parse(readFileSync(dryFile, "utf8")) as {
    rows: Array<{ uwp_row_id: string | null; user_id: string; display_name: string; week_start_date: string; wiped: boolean; checks_migrated: boolean; has_award: boolean; cur_a: number; cur_adv: number; cur_pen: number; exp_a: number; exp_adv: number; exp_pen: number }>;
  };
  const scope = dry.filter((r) => r.wiped && r.checks_migrated && !r.has_award && r.cur_a === 0 && r.cur_adv === 0 && r.cur_pen === 0 && (r.exp_a !== 0 || r.exp_adv !== 0 || r.exp_pen !== 0));
  const scopeRows = scope.map((r) => ({
    ...(liveById.get(String(r.uwp_row_id)) ?? {}),
    _target_points: r.exp_a, _target_advantages: r.exp_adv, _target_penalty: r.exp_pen,
    _display_name: r.display_name,
  }));
  const scopeFile = `backups/uwp-recovery-scope-${STAMP}.json`;
  const scopeJson = JSON.stringify({
    generatedAt: new Date().toISOString(),
    dryRunSource: dryFile,
    rows: scopeRows.length,
    users: new Set(scope.map((r) => r.user_id)).size,
    preSum: { a: 0, adv: 0, pen: 0 },
    targetSum: { a: scope.reduce((s, r) => s + r.exp_a, 0), adv: scope.reduce((s, r) => s + r.exp_adv, 0), pen: scope.reduce((s, r) => s + r.exp_pen, 0) },
    data: scopeRows,
  }, null, 1);
  writeFileSync(scopeFile, scopeJson, "utf8");
  console.log(`  ${scopeRows.length}행 / ${new Set(scope.map((r) => r.user_id)).size}명 → ${scopeFile}`);
  console.log(`  라이브 행 매칭 실패: ${scopeRows.filter((r) => !("id" in r)).length} (0 이어야 함)`);

  // ── manifest / checksum ──
  const files = [
    `${markerDir}/user_weekly_points.json`, `${markerDir}/process_point_awards.json`,
    `${markerDir}/roster_card_stats.json`, `${markerDir}/user_cumulative_points.json`,
    `${markerDir}/weekly_card_points.json`, `${markerDir}/weekly_card_snapshots.json.gz`,
    `${latestDir}/user_weekly_points.json`, `${latestDir}/process_point_awards.json`,
    `${latestDir}/roster_card_stats.json`, `${latestDir}/user_cumulative_points.json`,
    `${latestDir}/weekly_card_points.json`, `${latestDir}/weekly_card_snapshots.json.gz`,
    scopeFile,
  ].filter(existsSync);
  console.log("\n═══ manifest / checksum ═══");
  const manifest = files.map((f) => {
    const buf = readFileSync(f);
    return { file: f, bytes: statSync(f).size, sha256_16: sha(buf.toString("binary")) };
  });
  for (const m of manifest) console.log(`  ${String(m.bytes).padStart(9)}  ${m.sha256_16}  ${m.file}`);
  const manifestFile = `backups/uwp-recovery-manifest-${STAMP}.json`;
  writeFileSync(manifestFile, JSON.stringify({ generatedAt: new Date().toISOString(), markerDir, latestDir, files: manifest }, null, 1), "utf8");
  console.log(`\n→ ${manifestFile}`);

  const ok = missingCols.length === 0 && onlyLive.length === 0 && nullish.length === 0 && diff === 0 && markerHits.length === 13110;
  console.log(`\n${ok ? "✅ 파일 백업만으로 복원 충분" : "❌ 복원 불충분 — 중단"}`);
  console.log("=== DONE (writes: 0) ===");
  process.exit(ok ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });
