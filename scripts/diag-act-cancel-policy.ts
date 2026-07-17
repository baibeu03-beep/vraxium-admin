/**
 * (READ-ONLY 진단) 취소 액트 정책 조사 — 크루 페이지 액트 내역 목록의 기존 SoT 확인.
 *   1) 취소 상태 필드/테이블 + 컬럼 적용 여부
 *   2) 정규(regular)/변동(irregular) 각각의 취소 데이터 존재 여부
 *   3) 크루 페이지(고객) 표 vs 관리자 탭 표의 취소 액트 표시 방식(코드 SoT 실측)
 *   4) 요약에 포함/제외할 때의 실제 수치 차이
 *
 *   npx tsx --env-file=.env.local scripts/diag-act-cancel-policy.ts
 */
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { processPointAwardsHasCancelColumns } from "@/lib/processPointAwardsCancelState";
import { loadActLogsByStartDate } from "@/lib/cluster4ActLogsData";

function line(s = "") {
  console.log(s);
}

async function main() {
  // ── 1) 취소 컬럼 적용 여부 ───────────────────────────────────────────────
  const hasCancel = await processPointAwardsHasCancelColumns();
  line("═══ 1) 취소 상태 SoT ═══");
  line(`  테이블/필드 = process_point_awards.cancelled_at / cancelled_by / cancel_reason`);
  line(`  컬럼 적용(processPointAwardsHasCancelColumns): ${hasCancel}`);

  // ── 2) 정규/변동 취소 데이터 분포 ────────────────────────────────────────
  line();
  line("═══ 2) 취소 데이터 존재 여부(source 별) ═══");
  const cols = hasCancel
    ? "id,user_id,source,ref_id,year,week_number,point_check,point_advantage,point_penalty,cancelled_at"
    : "id,user_id,source,ref_id,year,week_number,point_check,point_advantage,point_penalty";
  const { data, error } = await supabaseAdmin.from("process_point_awards").select(cols);
  if (error) {
    line(`  ✗ ${error.message}`);
    return;
  }
  const rows = (data ?? []) as unknown as Array<{
    id: string;
    user_id: string;
    source: string;
    year: number;
    week_number: number;
    cancelled_at?: string | null;
  }>;
  line(`  process_point_awards 총 ${rows.length}행`);
  const bySource = new Map<string, { total: number; cancelled: number }>();
  for (const r of rows) {
    const e = bySource.get(r.source) ?? { total: 0, cancelled: 0 };
    e.total++;
    if (r.cancelled_at) e.cancelled++;
    bySource.set(r.source, e);
  }
  for (const [src, e] of [...bySource.entries()].sort()) {
    line(`   source=${src.padEnd(10)} 전체=${String(e.total).padStart(4)}  취소=${String(e.cancelled).padStart(3)}`);
  }
  const cancelled = rows.filter((r) => r.cancelled_at);
  line(`  ▶ 취소 원장 행 총계: ${cancelled.length}`);

  // ── 3) 크루 페이지(고객) vs 관리자 탭 — 코드 SoT 상 표시 차이 ─────────────
  line();
  line("═══ 3) 표시 방식(코드 SoT) ═══");
  line("  고객(크루 페이지 Detail Log): loadActLogsByStartDate(userId)            → includeCancelled 기본 false → 취소 액트 **목록에서 제외**");
  line("  관리자(액트 체크 내역 탭)   : loadActLogsByStartDate(userId,{includeCancelled:true}) → 취소 액트 **'취소됨' 으로 노출**");
  line("  포인트 합산(user_weekly_points): recomputeWeeklyPoints 가 cancelled_at IS NULL 로 **전 표면 합산 제외**");

  // ── 4) 취소 보유 사용자에서 포함/제외 수치 차이 실측 ──────────────────────
  line();
  line("═══ 4) 요약 포함/제외 시 수치 차이(취소 보유 사용자 실측) ═══");
  const usersWithCancel = [...new Set(cancelled.map((r) => r.user_id))];
  line(`  취소 원장 보유 사용자: ${usersWithCancel.length}명`);
  if (usersWithCancel.length === 0) {
    line("  ▶ 취소 데이터 0 → 포함/제외 정책이 현재 수치에 미치는 영향 **없음**(0건).");
  }
  for (const uid of usersWithCancel.slice(0, 5)) {
    const inc = await loadActLogsByStartDate(uid, { includeCancelled: true });
    const exc = await loadActLogsByStartDate(uid, { includeCancelled: false });
    const weeks = [...new Set([...inc.keys()])];
    for (const w of weeks) {
      const a = inc.get(w) ?? [];
      const b = exc.get(w) ?? [];
      if (a.length === b.length) continue;
      const aCancelled = a.filter((x) => x.cancelled);
      line(
        `   ${uid.slice(0, 8)} ${w}: 포함=${a.length}행(취소 ${aCancelled.length}) / 제외=${b.length}행  ` +
          `→ 차이 ${a.length - b.length}행 · 취소행 source=[${[...new Set(aCancelled.map((x) => x.source))].join(",")}]`,
      );
    }
  }
  line();
  line("완료(read-only).");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
