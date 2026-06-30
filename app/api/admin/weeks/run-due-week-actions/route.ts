// POST /api/admin/weeks/run-due-week-actions
//
//   운영 자동 fallback — 데드라인(공표=N+1 목 14:00 KST · 검수=N+1 금 16:00 KST)이 지났는데
//   수동 미실행인 주차를 자동으로 공표/검수한다. 수동 버튼과 **동일한 Action Service**
//   (publishWeekResult / markWeekResultReviewed, scope=operating)를 호출한다.
//   "버튼 없는 자동" 서버 트리거 — 외부 스케줄러(GitHub Actions)가 호출.
//
// 인증(엄격): x-internal-api-key == INTERNAL_API_KEY 만 허용(run-due-checks 와 동일 패턴).
//   세션/쿠키 폴백 없음. INTERNAL_API_KEY 미설정 → 503 fail-closed.
//
// ⚠ scope=operating 고정 — QA(qa_weeks_state) 오버레이는 절대 건드리지 않는다(mode 파라미터 미수용).
//   이미 수동/이전-자동 처리된 주차는 Action Service 409 가드로 skip(멱등). 운영 데이터는
//   "due + 미처리" 주차에만 변경되며 week_auto_action_log 에 변경 범위를 남긴다.

import type { NextRequest } from "next/server";
import { runDueWeekActionsSweep } from "@/lib/dueWeekActionsSweep";

export const maxDuration = 300;
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
  const out = v.filter((x): x is string => typeof x === "string" && x.trim().length > 0).map((x) => x.trim());
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
    body = {}; // 바디 없는 단순 호출 허용(전체 due 처리).
  }

  const onlyIds = readStringArray(body.onlyIds); // 진단/검증 전용(운영 미사용)
  const dryRun = body.dryRun === true;           // 진단/검증 전용(due 식별만·무변경)
  const maxItems =
    typeof body.maxItems === "number" && Number.isFinite(body.maxItems)
      ? Math.max(1, Math.min(200, Math.floor(body.maxItems)))
      : undefined;

  const tStart = Date.now();
  try {
    const result = await runDueWeekActionsSweep({
      onlyIds,
      maxItems,
      dryRun,
      log: (m) => console.log(`[run-due-week-actions] ${m}`),
    });
    console.log(
      `[run-due-week-actions] done publish(due=${result.publish.due} done=${result.publish.done} skip=${result.publish.skipped} fail=${result.publish.failed}) ` +
        `review(due=${result.review.due} done=${result.review.done} skip=${result.review.skipped} fail=${result.review.failed}) capped=${result.capped} | ${Date.now() - tStart}ms`,
    );
    return Response.json({ success: true, data: result });
  } catch (error) {
    console.error("[run-due-week-actions] error", error);
    return Response.json(
      { success: false, error: error instanceof Error ? error.message : "sweep failed" },
      { status: 500 },
    );
  }
}
