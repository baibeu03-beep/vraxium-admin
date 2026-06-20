import type { NextRequest } from "next/server";
import { pageSlugToOrganization } from "@/lib/organizations";
import { fetchUserOrganizationSlug } from "@/lib/userOrg";

// =============================================================
// 분기형(slug/org) 고객 페이지 공통 접근 게이트 — 단일 출처.
//
// 문제: /cluster-4-entertainment, /cluster-4-planning 처럼 URL slug 만 바꿔도
//   실제 소속이 아닌 org-브랜드 페이지가 열린다. 프론트 리다이렉트가 아니라
//   실제 HTTP API 응답에서 차단해야 한다(요구사항 #2·#3).
//
// 정책:
//   - requestedSlug(?pageSlug=) 가 사용자의 실제 org 와 불일치하면 403.
//   - slug 가 없거나(구버전 클라이언트) 인식 불가하거나 사용자 org 미상이면 통과
//     (fail-open) — 기존 정상 사용자 무영향(요구사항 #8).
//   - mode=test / 일반 / demoUserId 모두 동일 적용(요구사항 #4·#5). 게이트는
//     "어느 userId 의 데이터를 보여주는가(page owner)"에만 의존하며 mode 로 분기하지 않는다.
//   - 사용자 org 해석은 lib/userOrg 의 fetchUserOrganizationSlug 단일 함수를 쓴다.
//     snapshot 생성(라인 org 필터)과 동일 함수 → 두 경로의 접근 정책이 갈라지지 않는다(요구사항 #7).
//
// 향후 확장: pageType 별로 라인/팀 등 다른 분기 축을 추가할 수 있도록 시그니처를
//   유지한다. 현재 in-scope 페이지(cluster-4/3/1)는 전부 org 축으로 분기한다.
// =============================================================

export class PageAccessError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = "PageAccessError";
    this.status = status;
  }
}

export type PageType = "cluster4" | "cluster3" | "cluster1";

export type AssertPageAccessParams = {
  // 데이터를 보여줄 대상(page owner)의 profile user_id. 본인/foreign-viewer 무관하게
  // 페이지 소유자 기준으로 판정한다(slug 는 소유자의 org 브랜드를 가리키므로).
  userId: string | null;
  // 진단/로그용. 판정 분기에는 사용하지 않는다(요구사항 #4 — mode 동일 적용).
  mode?: string | null;
  demoUserId?: string | null;
  pageType: PageType;
  // ?pageSlug= 로 받은 페이지 slug(canonical marketing/entertainment/planning 또는 legacy).
  requestedSlug?: string | null;
};

// 요청에서 페이지 slug 를 읽는다(?pageSlug=). 라우트는 이 값을 그대로 헬퍼에 넘긴다.
export function readPageSlug(request: NextRequest): string | null {
  return request.nextUrl.searchParams.get("pageSlug")?.trim() || null;
}

// 불일치 시 PageAccessError(403) 를 throw 한다. 통과 시 void. 데이터 조회 "전"에 호출한다.
export async function assertPageAccessBySlug(
  params: AssertPageAccessParams,
): Promise<void> {
  const { userId, requestedSlug, pageType } = params;

  // 구버전 클라이언트(slug 미전송) → 기존 동작 유지(통과).
  if (!requestedSlug) return;

  const { org: expectedOrg, recognized } = pageSlugToOrganization(requestedSlug);
  // 인식 불가 slug → 어떤 org 제약도 부여하지 않음(통과). 임의 문자열로 권한이 늘지 않는다.
  if (!recognized || !expectedOrg) return;

  // 대상 미상 → 비교 불가(통과).
  if (!userId) return;

  const actualOrg = await fetchUserOrganizationSlug(userId);
  // 사용자 org 미상(데이터 누락 등) → 불일치를 증명할 수 없으므로 통과(정상 사용자 보호).
  if (actualOrg === null) return;

  if (expectedOrg !== actualOrg) {
    throw new PageAccessError(
      403,
      `Page slug '${requestedSlug}' (${expectedOrg}) does not match user organization '${actualOrg}'. [${pageType}]`,
    );
  }
}
