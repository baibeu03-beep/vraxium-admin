// converge-all-snapshots.ts
// 전 사용자 cluster4_weekly_card_snapshots → 현재 코드의 WEEKLY_CARDS_DTO_VERSION 으로 수렴.
//   ⚠ 버전 번호 하드코딩 없음 — 모든 기준은 코드의 WEEKLY_CARDS_DTO_VERSION(=LATEST) 을 따른다.
//   (DB 백필 아님 — 파생 캐시 재생성. target/원천 데이터는 건드리지 않는다.)
//   lineAvailability 청크 수정(2026-06-20) 이후의 정상 계산으로 전원 재작성한다 — 이미 v24 로
//   재작성됐던 행(buggy 코드 시점)도 강제 포함해 올바른 결과로 덮어쓴다(전수 force recompute).
//
//   실행(읽기 전용 분포만): DRY_RUN=1 npx tsx --env-file=.env.local scripts/converge-all-snapshots.ts
//   실행(수렴 write):              npx tsx --env-file=.env.local scripts/converge-all-snapshots.ts
import { config } from "dotenv";
config({ path: ".env.local" });
import { writeFileSync } from "fs";
import { createClient } from "@supabase/supabase-js";
import { getCluster4WeeklyCardsForProfileUser } from "@/lib/cluster4WeeklyCardsData";
import {
  WEEKLY_CARDS_DTO_VERSION,
  recomputeWeeklyCardsSnapshotsForUsers,
  readWeeklyCardsSnapshot,
} from "@/lib/cluster4WeeklyCardsSnapshot";

const sb = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
);
const TABLE = "cluster4_weekly_card_snapshots";
const LATEST = WEEKLY_CARDS_DTO_VERSION; // ← 단일 기준(코드 상수). 절대 하드코딩하지 않는다.
const DRY_RUN = process.env.DRY_RUN === "1";
const CONCURRENCY = Number(process.env.CONCURRENCY ?? 4);

function canonical(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(canonical);
  if (v && typeof v === "object") {
    const o = v as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(o).sort()) out[k] = canonical(o[k]);
    return out;
  }
  return v;
}
const canonEqual = (a: unknown, b: unknown) =>
  JSON.stringify(canonical(a)) === JSON.stringify(canonical(b));

type Row = { user_id: string; dto_version: number; is_stale: boolean; card_count: number };

async function scanAll(): Promise<Row[]> {
  const rows: Row[] = [];
  const PAGE = 1000;
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await sb
      .from(TABLE)
      .select("user_id,dto_version,is_stale,card_count")
      .order("user_id", { ascending: true })
      .range(from, from + PAGE - 1);
    if (error) throw new Error(error.message);
    const batch = (data ?? []) as Row[];
    rows.push(...batch);
    if (batch.length < PAGE) break;
  }
  return rows;
}

async function distribution(label: string) {
  const rows = await scanAll();
  const { data: markers } = await sb.from("test_user_markers").select("user_id");
  const testSet = new Set((markers ?? []).map((m: { user_id: string }) => m.user_id));

  const byVer = new Map<number, { test: number; real: number }>();
  for (const r of rows) {
    const b = byVer.get(r.dto_version) ?? { test: 0, real: 0 };
    if (testSet.has(r.user_id)) b.test++; else b.real++;
    byVer.set(r.dto_version, b);
  }
  const latest = rows.filter((r) => r.dto_version === LATEST);
  const nonLatest = rows.filter((r) => r.dto_version !== LATEST);
  const stale = rows.filter((r) => r.is_stale).length;
  const emptyCards = rows.filter((r) => r.card_count === 0).length;
  const latestTest = latest.filter((r) => testSet.has(r.user_id)).length;
  const latestReal = latest.length - latestTest;
  const nonLatestReal = nonLatest.filter((r) => !testSet.has(r.user_id)).length;

  console.log(`\n──────── 분포 (${label}) ────────`);
  console.log(`전체 snapshot 수 : ${rows.length}`);
  for (const v of Array.from(byVer.keys()).sort((a, b) => b - a)) {
    const b = byVer.get(v)!;
    console.log(`  v${v}: ${b.test + b.real}  (test ${b.test} / real ${b.real})${v === LATEST ? "  ← LATEST" : ""}`);
  }
  console.log(`LATEST(v${LATEST}) 수 : ${latest.length}  (test ${latestTest} / real ${latestReal})`);
  console.log(`non-LATEST 수    : ${nonLatest.length}  (real ${nonLatestReal})`);
  console.log(`is_stale 수      : ${stale}`);
  console.log(`card_count==0    : ${emptyCards} (miss-like)`);
  return { rows, total: rows.length, latest: latest.length, nonLatest: nonLatest.length, stale, emptyCards, latestTest, latestReal, nonLatestReal, testSet };
}

async function main() {
  console.log("════════════ 전 사용자 snapshot → 현재 DTO 버전 수렴 (전수 force) ════════════");
  console.log(`기준: WEEKLY_CARDS_DTO_VERSION = ${LATEST} (코드 상수 — 하드코딩 없음) | concurrency=${CONCURRENCY}`);
  console.log(`모드: ${DRY_RUN ? "DRY-RUN (읽기 전용, write 0)" : "WRITE (전수 재작성)"}`);

  const before = await distribution("수렴 전");
  const allIds = before.rows.map((r) => r.user_id);
  const nonLatestIdsBefore = before.rows.filter((r) => r.dto_version !== LATEST).map((r) => r.user_id);

  if (DRY_RUN) {
    console.log(`\n[DRY-RUN] 전수 재작성 대상 = ${allIds.length}행 (non-LATEST ${nonLatestIdsBefore.length} 포함, 이미 LATEST 도 강제 재작성).`);
    console.log(`[DRY-RUN] write 없이 종료.`);
    return;
  }

  // ── 쓰기: 전 사용자 강제 recompute (수정된 lineAvailability 코드로 정상 재작성) ──
  const t0 = Date.now();
  const res = await recomputeWeeklyCardsSnapshotsForUsers(allIds, { concurrency: CONCURRENCY });
  const durSec = Math.round((Date.now() - t0) / 1000);
  console.log(
    `\n쓰기 완료(${durSec}s): requested=${res.requested} recomputed=${res.recomputed} failed=${res.failed}`,
  );
  if (res.failedUserIds.length) {
    console.log(`실패 사용자(${res.failedUserIds.length}):`);
    for (const id of res.failedUserIds) console.log(`  - ${id}`);
    writeFileSync("claudedocs/converge-all-snapshots-failed-ids.json", JSON.stringify(res.failedUserIds, null, 2));
    console.log(`  (목록 저장: claudedocs/converge-all-snapshots-failed-ids.json)`);
  }

  const after = await distribution("수렴 후");

  // ── 검증: 직전 non-LATEST 표본 direct(실시간) vs 저장된 snapshot.cards ──
  const N = Math.min(20, nonLatestIdsBefore.length);
  const step = nonLatestIdsBefore.length > 0 ? Math.max(1, Math.floor(nonLatestIdsBefore.length / Math.max(1, N))) : 1;
  const chosen: string[] = [];
  for (let i = 0; i < nonLatestIdsBefore.length && chosen.length < N; i += step) chosen.push(nonLatestIdsBefore[i]);

  console.log(`\n──────── direct == 저장본 검증 (직전 non-LATEST 표본 ${chosen.length}명) ────────`);
  let okCount = 0;
  const mismatches: string[] = [];
  for (const uid of chosen) {
    try {
      const snap = await readWeeklyCardsSnapshot(uid);
      const stored = snap.status === "hit" || snap.status === "stale" ? snap.cards : [];
      const snapOk = snap.status === "hit";
      const direct = await getCluster4WeeklyCardsForProfileUser(uid);
      const eq = canonEqual(direct, stored);
      if (eq && snapOk) okCount++;
      else mismatches.push(`${uid} (snap=${snap.status} direct=${direct.length} stored=${stored.length})`);
    } catch (e) {
      mismatches.push(`${uid} (compute throw: ${e instanceof Error ? e.message : e})`);
    }
  }

  const done = after.nonLatest === 0 && after.stale === 0 && mismatches.length === 0 && res.failed === 0;
  console.log("\n════════════════════ 최종 보고 ════════════════════");
  console.log(`기준 버전             : v${LATEST}`);
  console.log(`전체 snapshot 수      : ${before.total} → ${after.total}`);
  console.log(`LATEST(v${LATEST}) 수      : ${before.latest} → ${after.latest}`);
  console.log(`non-LATEST 수         : ${before.nonLatest} → ${after.nonLatest}`);
  console.log(`실사용자 LATEST 수    : ${before.latestReal} → ${after.latestReal}`);
  console.log(`테스트 LATEST 수      : ${before.latestTest} → ${after.latestTest}`);
  console.log(`is_stale 수           : ${before.stale} → ${after.stale}`);
  console.log(`card_count==0(miss)   : ${before.emptyCards} → ${after.emptyCards}`);
  console.log(`재계산 요청/성공/실패 : ${res.requested} / ${res.recomputed} / ${res.failed}`);
  console.log(`direct==저장본 표본    : ${okCount}/${chosen.length} 일치${mismatches.length ? " | 불일치: " + mismatches.join(" ; ") : ""}`);
  console.log(`\n완료 기준 (non-LATEST=0 ∧ is_stale=0 ∧ 실패=0 ∧ 표본 정합): ${done ? "충족 ✅" : "미충족 ❌"}`);
  if (after.emptyCards > 0) {
    console.log(`⚠ card_count==0 ${after.emptyCards}건 — 프로필 부재/계산 불가 사용자 가능. 개별 확인 필요.`);
  }
}

main().catch((e) => { console.error("fatal", e); process.exit(1); });
