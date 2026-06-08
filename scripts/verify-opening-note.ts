/**
 * 검증: 실무 정보 라인 개설 [섹션 0] 개설/검수 기록(opening_review_note).
 *
 *   npx tsx --env-file=.env.local scripts/verify-opening-note.ts
 *
 * - direct function 라운드트립: get(초기) → set("…") → get("…") → set(null) → get(null).
 * - snapshot 무영향: note set 전/후 한 사용자 snapshot updated_at(+ dto_version) 불변 단언.
 *   (note 쓰기는 invalidate 미호출 → 재계산 미발생.)
 * - 마이그레이션 미적용 시(컬럼 없음) graceful 안내 후 종료.
 */
import { config } from "dotenv";
config({ path: ".env.local" });

import { createClient } from "@supabase/supabase-js";
import {
  getCluster4LineOpeningNote,
  setCluster4LineOpeningNote,
} from "@/lib/adminCluster4LinesData";

const sb = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
);

let failures = 0;
function assert(label: string, cond: boolean, detail?: unknown) {
  if (!cond) failures++;
  console.log(`  ${cond ? "✅" : "❌"} ${label}${detail !== undefined ? ` — ${JSON.stringify(detail)}` : ""}`);
}

async function main() {
  console.log("════════ opening_review_note 검증 ════════");

  // 0. 컬럼 존재 확인.
  const colProbe = await sb
    .from("cluster4_lines")
    .select("id,opening_review_note")
    .limit(1);
  if (colProbe.error) {
    console.log(
      `\n⚠ opening_review_note 컬럼이 아직 없습니다 (${colProbe.error.message}).\n` +
        "  → db/migrations/2026-06-08_cluster4_lines_add_opening_review_note.sql 를 먼저 적용하세요.\n" +
        "  마이그레이션 적용 후 본 스크립트를 다시 실행하면 전체 검증이 수행됩니다.",
    );
    return;
  }
  console.log("  ✅ opening_review_note 컬럼 존재");

  // 1. 테스트 대상: 활성 info 라인 1건 + 어드민 1명.
  const lineRes = await sb
    .from("cluster4_lines")
    .select("id,opening_review_note")
    .eq("part_type", "info")
    .eq("is_active", true)
    .limit(1);
  const lineId: string | undefined = lineRes.data?.[0]?.id;
  if (!lineId) {
    console.log("  ⚠ 활성 info 라인이 없어 라운드트립 검증을 건너뜁니다.");
    return;
  }
  const admRes = await sb.from("admin_users").select("id").limit(1);
  const adminId: string | undefined = admRes.data?.[0]?.id;
  if (!adminId) {
    console.log("  ⚠ admin_users 가 없어 검증을 건너뜁니다.");
    return;
  }
  const original = lineRes.data?.[0]?.opening_review_note ?? null;
  console.log(`\n  대상 라인 ${lineId} (원래 note=${JSON.stringify(original)})`);

  // 2. snapshot 베이스라인(임의 1건).
  const snapRes = await sb
    .from("cluster4_weekly_card_snapshots")
    .select("*")
    .limit(1);
  const snapRow = snapRes.data?.[0] as Record<string, unknown> | undefined;
  const snapUserId = snapRow?.user_id as string | undefined;
  const verKey = snapRow
    ? ["dto_version", "version", "snapshot_version"].find((k) => k in snapRow)
    : undefined;
  const before = {
    updated_at: snapRow?.updated_at,
    version: verKey ? snapRow?.[verKey] : undefined,
  };
  console.log(`  snapshot 베이스라인 user=${snapUserId?.slice(0, 8)} updated_at=${before.updated_at} ${verKey ?? "(no-ver)"}=${before.version}`);

  // 3. 라운드트립.
  const t0 = await getCluster4LineOpeningNote(lineId);
  assert("get 초기 동작", t0.id === lineId);

  const TEST = "검증 테스트 메모 — verify-opening-note";
  const t1 = await setCluster4LineOpeningNote(lineId, TEST, adminId);
  assert("set 후 반환 note 일치", t1.openingReviewNote === TEST, t1.openingReviewNote);
  const t2 = await getCluster4LineOpeningNote(lineId);
  assert("재조회 note 일치(영속)", t2.openingReviewNote === TEST, t2.openingReviewNote);

  // 4. snapshot 불변 확인 (note set 후).
  if (snapUserId) {
    const after = await sb
      .from("cluster4_weekly_card_snapshots")
      .select("*")
      .eq("user_id", snapUserId)
      .limit(1);
    const arow = after.data?.[0] as Record<string, unknown> | undefined;
    assert(
      "snapshot updated_at 불변",
      arow?.updated_at === before.updated_at,
      { before: before.updated_at, after: arow?.updated_at },
    );
    if (verKey) {
      assert(
        `snapshot ${verKey} 불변`,
        arow?.[verKey] === before.version,
        { before: before.version, after: arow?.[verKey] },
      );
    }
  }

  // 5. 초기화(원복).
  const t3 = await setCluster4LineOpeningNote(lineId, null, adminId);
  assert("null set 후 초기화", t3.openingReviewNote === null);
  // 원래 값이 null 이 아니었다면 원복.
  if (original !== null) {
    await setCluster4LineOpeningNote(lineId, original, adminId);
    console.log(`  (원래 note 값 복원: ${JSON.stringify(original)})`);
  }

  console.log("\n════════ 결과 ════════");
  if (failures > 0) {
    console.log(`❌ 검증 실패 ${failures}건.`);
    process.exit(1);
  }
  console.log("✅ opening_review_note 검증 전부 통과 (direct 라운드트립 + snapshot 불변).");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
