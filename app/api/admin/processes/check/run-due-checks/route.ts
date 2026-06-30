// POST /api/admin/processes/check/run-due-checks
//
//   검수 시점(scheduled_check_at)이 지난 [체크 대기] 항목을 일괄 자동 검수한다.
//   외부 스케줄러(5~10분 간격)가 호출하는 "버튼 없는 자동" 서버 트리거.
//   실제 처리 로직은 lib/processCheckDueSweep(=로컬 워커 runOnce 의 서버 인프로세스판).
//
// 인증(엄격): x-internal-api-key == INTERNAL_API_KEY 만 허용. 내부 키가 없으면 절대 실행 안 함.
//   · 관리자 세션/쿠키 폴백 없음(배치 트리거는 사람 손이 아니라 스케줄러 전용).
//   · INTERNAL_API_KEY 미설정(환경 오설정) → 503 fail-closed(누구도 통과 못 함).
//
// 요청 바디(선택):
//   { orgs?: string[], modes?: ("operating"|"test")[], onlyIds?: string[], maxItems?: number }
//   미지정 = 전체 org/mode 의 만기 항목 처리. onlyIds = 특정 항목만(운영 미사용·진단용).
//
// 멱등: 같은 항목을 여러 번 호출해도 원장(process_point_awards) UNIQUE + 합산 재계산으로
//   포인트가 중복 적립되지 않는다. 완료 행은 status='pending' 폴링에서 제외되어 1회만 전이.
// ⚠ user_weekly_points/snapshot 변경은 적립 lib 내부에서만(여기 라우트는 직접 무접촉).

import type { NextRequest } from "next/server";
import { parseScopeMode } from "@/lib/userScopeShared";
import { runDueProcessCheckSweep } from "@/lib/processCheckDueSweep";
import { resolveStateScopeFromRequest } from "@/lib/operationalState";

export const maxDuration = 300; // 만기 항목 크롤링 직렬 처리 — 넉넉한 상한(초과분은 catch-up).
export const dynamic = "force-dynamic";

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

// 내부 키 검증 — 통과 시 null, 실패 시 거부 Response.
function authorizeInternal(request: NextRequest): Response | null {
  const expected = process.env.INTERNAL_API_KEY;
  if (!expected) {
    // 환경 오설정 — 키 자체가 없으면 누구도 통과시키지 않는다(fail-closed).
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
    body = {}; // 바디 없는 단순 호출 허용(전체 처리).
  }

  const orgs = readStringArray(body.orgs);
  // modes 는 운영/테스트만 허용(그 외 토큰 제거).
  const modesRaw = readStringArray(body.modes);
  const modes = modesRaw
    ? Array.from(new Set(modesRaw.map((m) => parseScopeMode(m))))
    : null;
  // QA 분기: ?mode=test → scope=qa. fail-safe — scope=qa 가 명시될 때만 QA sweep(테스트 항목 강제).
  //   미지정 = operating(기존 동작 불변). scope 는 body.modes 보다 우선(qa면 test 항목만).
  const scope = resolveStateScopeFromRequest(request);
  const onlyIds = readStringArray(body.onlyIds);
  const maxItems =
    typeof body.maxItems === "number" && Number.isFinite(body.maxItems)
      ? Math.max(1, Math.min(200, Math.floor(body.maxItems)))
      : undefined;

  const tStart = Date.now();
  try {
    const result = await runDueProcessCheckSweep({
      orgs,
      modes,
      scope,
      onlyIds,
      maxItems,
      log: (m) => console.log(`[run-due-checks] ${m}`),
    });
    console.log(
      `[run-due-checks] done due=${result.due} eligible=${result.eligible} ` +
        `ok=${result.succeeded} fail=${result.failed} capped=${result.capped} | ${Date.now() - tStart}ms`,
    );
    return Response.json({ success: true, data: result });
  } catch (error) {
    console.error("[run-due-checks] error", error);
    return Response.json(
      { success: false, error: error instanceof Error ? error.message : "sweep failed" },
      { status: 500 },
    );
  }
}
