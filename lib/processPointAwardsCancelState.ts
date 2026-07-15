import { supabaseAdmin } from "@/lib/supabaseAdmin";

// ── 소프트 취소(cancelled_at) 컬럼 적용 여부 — 1회 프로브 후 캐시 ──────────────
//   마이그레이션(2026-07-15_process_point_awards_soft_cancel) 미적용 환경에서 취소 필터를 걸면
//   42703 로 포인트 합산·actLogs 조회가 전부 깨진다. 따라서 컬럼이 실재할 때만 취소 제외 필터를
//   적용하고, 미적용 시엔 기존 동작(취소 개념 없음) 그대로 → 회귀 무손실.
//
//   포인트 원장(process_point_awards)을 읽는 여러 모듈(processPointAccrual·cluster4ActLogsData 등)이
//   공유하므로 순환 import 를 피해 이 얇은 전용 모듈에 둔다(의존성 = supabaseAdmin 뿐).
let _hasCancelCols: boolean | null = null;

export async function processPointAwardsHasCancelColumns(): Promise<boolean> {
  if (_hasCancelCols !== null) return _hasCancelCols;
  const res = await supabaseAdmin
    .from("process_point_awards")
    .select("cancelled_at")
    .limit(1);
  if (!res.error) {
    _hasCancelCols = true;
    return true;
  }
  const code = (res.error as { code?: string }).code;
  if (code === "42703") {
    // 컬럼 부재(마이그레이션 전) — 확정 false 로 캐시.
    _hasCancelCols = false;
    return false;
  }
  // 테이블 부재(PGRST205) 또는 일시 오류 — 캐시하지 않고 보수적으로 취소 필터 미적용.
  return false;
}
