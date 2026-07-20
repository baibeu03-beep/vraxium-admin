"use client";

import { usePathname, useSearchParams } from "next/navigation";
import { resolveAdminOrgFocus } from "@/lib/adminOrgContext";
import { organizationMeta, INTEGRATED_ENVIRONMENT_META } from "@/lib/organizations";
import { cn } from "@/lib/utils";

// 조직 환경 배너 — 개별 조직 사이트에서 "지금 어떤 조직에서 작업 중인지"를 콘텐츠 영역 최상단에
//   즉시 인지시키는 **전체폭 상단 띠(bar)**. 카드가 아니라 평평한 full-width bar 다.
//
//   · org 컨텍스트 SoT = resolveAdminOrgFocus(pathname, ?org / /admin/crews/{org}) — 사이드바·
//     헤더 경로와 동일 출처. mode(운영/테스트)·demoUserId·actAsTestUserId 무관하게 동일 값/렌더.
//   · org 미상(통합 모드/무효 slug)이면 아무것도 렌더하지 않는다(임의 조직 폴백 금지).
//   · 조직명(ko/en)·아이콘·대표색은 lib/organizations 통합 SoT(ORGANIZATION_META) 한 곳만 참조
//     — 하드코딩 금지. 색은 라이트/다크 동시 정의(bannerClass, 배경 opaque).
//   · **배치**: main(스크롤 컨테이너) "바깥", Header 아래 전용 슬롯(app/(portal)/layout.tsx)에 둔다.
//     → main 의 p-6 padding 밖이라 콘텐츠 영역 좌우 끝까지 꽉 차고(전체폭), main 이 아래에서 스크롤돼도
//     배너는 항상 콘텐츠 최상단에 남는다(sticky 와 동일 효과 — 별도 position 불필요, 더 안전한 구조).
//   · **카드 스타일 제거**: rounded/border/shadow/ring/외부 margin 없음. 평평한 bar. bg 만 조직 대표색.
//   · z-index: main 바깥이라 콘텐츠와 겹치지 않음(오버레이 Dialog/Toast 등과도 무관).
export default function OrgEnvironmentBanner() {
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const org = resolveAdminOrgFocus(pathname, searchParams);
  const orgMeta = organizationMeta(org);

  // org(개별 조직) 배너 우선. org 미상(통합 검수 시스템)이면 통합 배너를 표시하되,
  //   조직 선택 런처(/admin)에는 표시하지 않는다(아직 어떤 시스템에도 진입하지 않은 상태).
  const isHomeLauncher = pathname === "/admin";
  const meta = orgMeta ?? (isHomeLauncher ? null : INTEGRATED_ENVIRONMENT_META);
  if (!meta) return null;

  return (
    <div
      data-testid="org-environment-banner"
      data-org={org ?? undefined}
      data-integrated={orgMeta ? undefined : true}
      // 전체폭 평평한 bar. min-h-12(48px)·items-center 로 수직 중앙 · px-6 로 콘텐츠(main p-6)와 좌측 정렬.
      // shrink-0: flex 컬럼에서 높이 고정(위아래 빈틈/layout shift 없음). 좌측 정렬 · text-lg font-bold.
      // bg 는 bannerClass(opaque)만 — 카드 잔재(rounded/border/shadow) 없음.
      className={cn(
        "flex min-h-12 w-full shrink-0 items-center gap-2.5 px-6 text-lg font-bold",
        meta.bannerClass,
      )}
    >
      <span className="text-xl leading-none" aria-hidden="true">
        {meta.icon}
      </span>
      <span className="min-w-0 truncate">
        {meta.ko} <span className="font-medium opacity-80">/ {meta.en}</span>
      </span>
    </div>
  );
}
