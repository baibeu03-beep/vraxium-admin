// POST /api/admin/cluster4/lines/run-due-closes
//
//   submission_closes_at(개설+48h 또는 수동 조기 마감)이 지난 info/competency 라인의 강화 결과를
//   일괄 확정·지급한다. 외부 스케줄러(5~10분 간격)가 호출하는 "버튼 없는 자동" 서버 트리거.
//   실제 처리 로직은 lib/cluster4LineCloseDueSweep(=finalizeLineResultAwards 반복).
//
// 인증(엄격): x-internal-api-key == INTERNAL_API_KEY 만 허용. 세션/쿠키 폴백 없음.
//   · INTERNAL_API_KEY 미설정 → 503 fail-closed. (프로세스 체크 run-due-checks 와 동일 정책.)
//
// 요청 바디(선택): { maxItems?: number, onlyLineIds?: string[] }.
//   미지정 = 만기 라인 전체(capped 초과분은 다음 폴링 catch-up).
//
// 멱등: finalizeLineResultAwards 는 원장 upsert(onConflict=source,ref_id,user_id) + result_finalized_at
//   마커로 재처리를 막는다. 수동 "2차 기입 마감"과 겹쳐도 중복 지급 없음.

import type { NextRequest } from "next/server";
import { runDueLineCloseSweep } from "@/lib/cluster4LineCloseDueSweep";

export const maxDuration = 300; // 만기 라인 직렬 처리(대상자 snapshot 재계산 포함) — 넉넉한 상한.
export const dynamic = "force-dynamic";

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

function authorizeInternal(request: NextRequest): Response | null {
  const expected = process.env.INTERNAL_API_KEY;
  if (!expected) {
    return Response.json(
      { success: false, error: "INTERNAL_API_KEY 미설정 — 서버 환경 변수를 설정해주세요." },
      { status: 503 },
    );
  }
  const key = request.headers.get("x-internal-api-key");
  if (key && timingSafeEqual(key, expected)) return null;
  return Response.json({ success: false, error: "Unauthorized" }, { status: 401 });
}

function readStringArray(v: unknown): string[] | null {
  if (!Array.isArray(v)) return null;
  const out = v
    .filter((x): x is string => typeof x === "string" && x.trim().length > 0)
    .map((x) => x.trim());
  return out.length ? out : null;
}

export async function POST(request: NextRequest) {
  const denied = authorizeInternal(request);
  if (denied) return denied;

  let body: Record<string, unknown> = {};
  try {
    const parsed = await request.json();
    if (parsed && typeof parsed === "object") body = parsed as Record<string, unknown>;
  } catch {
    body = {};
  }

  const onlyLineIds = readStringArray(body.onlyLineIds);
  const maxItems =
    typeof body.maxItems === "number" && Number.isFinite(body.maxItems)
      ? Math.max(1, Math.min(200, Math.floor(body.maxItems)))
      : undefined;

  const tStart = Date.now();
  try {
    const result = await runDueLineCloseSweep({ maxItems, onlyLineIds: onlyLineIds ?? undefined });
    console.log(
      `[run-due-closes] done found=${result.found} processed=${result.processed} ` +
        `capped=${result.capped} fallback=${result.usedFallback} | ${Date.now() - tStart}ms`,
    );
    return Response.json({ success: true, data: result });
  } catch (error) {
    console.error("[run-due-closes] error", error);
    return Response.json(
      { success: false, error: error instanceof Error ? error.message : "sweep failed" },
      { status: 500 },
    );
  }
}
