// POST /api/admin/pms/sync-pointlogs
//
//   PMS → Vraxium pointlogs 증분 동기화의 서버 트리거(버튼 없는 자동).
//   외부 스케줄러(매일 04:00 KST)가 내부키로 호출한다. 실제 로직 = lib/pmsPointlogsSync.
//
// 인증(엄격): x-internal-api-key == INTERNAL_API_KEY 만 허용(세션 폴백 없음).
//   INTERNAL_API_KEY 미설정 → 503 fail-closed.
//
// ON/OFF: ENABLE_PMS_INCREMENTAL_SYNC == "true" 일 때만 실행. 아니면 200 {skipped:true}
//   (cron 이 에러로 인식하지 않도록 200). PMS 종료 시 이 환경변수만 OFF → 자동 중단.
//   코드/구조 변경 없이 비활성화.
//
// body(선택): { apply?: boolean(기본 true), sources?: ("oranke"|"hrdb"|"olympus")[] }
//   apply:false = dry-run(write 0). 비상/검증용 수동 호출에 사용.
//
// 멱등: ledger UNIQUE(source_table,source_pk) + uwp 재합산 → 중복 호출 무해.
// ⚠ snapshot 재계산은 lib 내부 invalidateWeeklyCardsForUsers 에서만(이 라우트 직접 무접촉).

import type { NextRequest } from "next/server";
import { syncPmsPointlogsIncremental, PMS_SYNC_SOURCES } from "@/lib/pmsPointlogsSync";
import type { PmsSourceSystem } from "@/lib/pmsMigration";

export const maxDuration = 300;
export const dynamic = "force-dynamic";

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export async function POST(request: NextRequest) {
  // ── 인증: 내부 키 ──
  const expected = process.env.INTERNAL_API_KEY;
  if (!expected) {
    return Response.json(
      { success: false, error: "INTERNAL_API_KEY 미설정 — fail-closed." },
      { status: 503 },
    );
  }
  const provided = request.headers.get("x-internal-api-key");
  if (!provided || !timingSafeEqual(provided, expected)) {
    return Response.json({ success: false, error: "Unauthorized" }, { status: 401 });
  }

  // ── ON/OFF 게이트 ──
  if (process.env.ENABLE_PMS_INCREMENTAL_SYNC !== "true") {
    return Response.json({
      success: true,
      skipped: true,
      reason: "ENABLE_PMS_INCREMENTAL_SYNC 미활성 — 동기화 비활성화 상태.",
    });
  }

  // ── body ──
  let body: { apply?: boolean; sources?: unknown } = {};
  try {
    body = (await request.json()) as typeof body;
  } catch {
    body = {};
  }
  const apply = body.apply !== false; // 기본 true(자동 동기화). dry-run 은 명시적 {apply:false}.
  let sources: PmsSourceSystem[] = PMS_SYNC_SOURCES;
  if (Array.isArray(body.sources)) {
    const filtered = body.sources.filter((s): s is PmsSourceSystem =>
      typeof s === "string" && (PMS_SYNC_SOURCES as string[]).includes(s),
    );
    if (filtered.length) sources = filtered;
  }

  try {
    const report = await syncPmsPointlogsIncremental({ apply, sources });
    return Response.json({ success: true, report });
  } catch (e) {
    return Response.json(
      { success: false, error: e instanceof Error ? e.message : String(e) },
      { status: 500 },
    );
  }
}
