import { NextRequest } from "next/server";
import {
  ADMIN_WRITE_ROLES,
  requireAdmin,
  toAdminErrorResponse,
} from "@/lib/adminAuth";
import { accrueForCompletedAct, type AccrualSource } from "@/lib/processPointAccrual";
import { publicErrorMessage } from "@/lib/apiError";

// 프로세스 체크 완료 → 포인트 적립 트리거 (worker(.mjs)→TS 적립 로직 브리지).
//   POST { source: 'regular'|'irregular', ref_id }  → accrueForCompletedAct
//   적립 로직(era 경계·org/mode 스코프·ledger 멱등·user_weekly_points 재계산·snapshot 무효화)은
//   lib/processPointAccrual 단일 SoT 재사용. 워커가 완료 직후 호출(admin 쿠키).
//   ⚠ user_weekly_points/snapshot 외 부수효과 없음. 회수(취소)는 별도(미구현 단계).
export async function POST(request: NextRequest) {
  try {
    await requireAdmin(ADMIN_WRITE_ROLES);
  } catch (error) {
    const response = toAdminErrorResponse(error);
    if (response) return response;
    throw error;
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json({ success: false, error: "요청 형식이 올바르지 않습니다." }, { status: 400 });
  }

  const b = (body ?? {}) as Record<string, unknown>;
  const source = b.source;
  const refId = typeof b.ref_id === "string" ? b.ref_id : typeof b.refId === "string" ? b.refId : null;
  if ((source !== "regular" && source !== "irregular") || !refId) {
    return Response.json(
      { success: false, error: "source('regular'|'irregular') + ref_id(uuid) 가 필요합니다" },
      { status: 400 },
    );
  }

  try {
    const result = await accrueForCompletedAct(source as AccrualSource, refId);
    return Response.json({ success: true, data: result });
  } catch (error) {
    const status = (error as { status?: number })?.status ?? 500;
    return Response.json(
      { success: false, error: publicErrorMessage(error, status, "적립 처리에 실패했습니다.") },
      { status },
    );
  }
}
