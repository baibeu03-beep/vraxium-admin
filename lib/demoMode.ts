import type { NextRequest } from "next/server";
import { isTestUser } from "@/lib/testUsers";

// 크루 페이지 데모/테스트 모드.
// ─────────────────────────────────────────────────────────────────────
// `?demoUserId={profile.user_id}` 로 접근 시, 로그인 세션 대신 지정한 테스트
// 유저의 데이터를 조회하게 한다. 안전장치:
//   1) 환경 게이트: NODE_ENV === 'production' 이면 기본 비활성. 단 ENABLE_DEMO_MODE
//      ='true' 가 명시되면 (스테이징 등) 강제 활성화.
//   2) 대상 제한: demoUserId 는 test_user_markers 에 등재된 테스트 유저만 허용.
//      실 운영 사용자 id 를 넣으면 403.
//   3) 쓰기 주체: 데모 쓰기(POST/PATCH)는 demoUserId 의 profile user 기준으로 저장된다.
//      (작성 기간/edit window 검증은 일반 고객과 동일하게 적용 — 데모라고 무조건 허용 X)
// 데모 모드가 꺼져 있으면 demoUserId 는 조용히 무시되고 일반 세션 인증으로 폴백한다.
// ─────────────────────────────────────────────────────────────────────

export class DemoModeError extends Error {
  status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = "DemoModeError";
    this.status = status;
  }
}

export function isDemoModeEnabled(): boolean {
  if (process.env.ENABLE_DEMO_MODE === "true") return true;
  return process.env.NODE_ENV !== "production";
}

function readDemoUserId(request: NextRequest): string | null {
  return request.nextUrl.searchParams.get("demoUserId")?.trim() || null;
}

// 읽기 경로용: 데모 모드 + 유효한 테스트 유저면 그 profile.user_id 를 반환.
//   - demoUserId 없음 → null (일반 인증 경로 진행)
//   - 데모 모드 off → null (demoUserId 무시, 일반 인증 경로 진행)
//   - 데모 모드 on + demoUserId 가 테스트 유저 아님 → DemoModeError(403)
export async function resolveDemoProfileUserId(
  request: NextRequest,
): Promise<string | null> {
  const demoUserId = readDemoUserId(request);
  if (!demoUserId) return null;
  if (!isDemoModeEnabled()) return null;

  const allowed = await isTestUser(demoUserId);
  if (!allowed) {
    throw new DemoModeError(
      403,
      "demoUserId is not a registered test user.",
    );
  }
  return demoUserId;
}
