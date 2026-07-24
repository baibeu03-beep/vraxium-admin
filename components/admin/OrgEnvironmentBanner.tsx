"use client";

import { usePathname, useSearchParams } from "next/navigation";
import { resolveAdminOrgFocus } from "@/lib/adminOrgContext";
import { adminEnvironmentTheme } from "@/lib/organizations";
import { cn } from "@/lib/utils";

// 조직 환경 배너 — 개별 조직 사이트에서 "지금 어떤 조직에서 작업 중인지"를 즉시 인지시키는 표식.
//
//   · **배치(2026-07-24 변경)**: 좌측 사이드바 상단 HOME/개별 헤더 박스 "바로 아래", `<nav>` 위에
//     **사이드바 폭을 꽉 채우는 평평한 색 띠(full-width flat band)** 로 둔다. 이전엔 우측 콘텐츠 영역
//     전체폭 상단 띠였으나, 조직 정체성을 HOME 배지와 같은 좌측 상단으로 모으기 위해 이동했다.
//     → 우측 본문에는 더 이상 렌더하지 않는다(중복 노출 없음).
//   · **떠 있는 알약(rounded pill+여백)이 아니라, 좌우 끝까지 배경색이 꽉 찬 평평한 띠** — 사이드바에
//     견고하게 박힌 느낌을 준다(둥근모서리/외부 margin 없음, bannerClass 배경이 edge-to-edge).
//   · org 컨텍스트 SoT = resolveAdminOrgFocus(pathname, ?org / /admin/crews/{org}) — 사이드바·
//     헤더 경로와 동일 출처. mode(운영/테스트)·demoUserId·actAsTestUserId 무관하게 동일 값/렌더.
//   · org 미상(통합 모드/무효 slug)이면 통합 배너(보라)를 동일 형태로 렌더. 단 조직 선택 런처(/admin)
//     에서는 렌더하지 않는다(아직 어떤 시스템에도 진입 전).
//   · 아이콘·명칭·대표색은 **공통 테마 SoT** adminEnvironmentTheme(org)(lib/organizations)에서만
//     가져온다 — 하드코딩 금지. 색은 라이트/다크 동시 정의(bannerClassName, 배경 opaque).
//     통합은 nameEn=null → "/ …" 접미를 붙이지 않는다(ko 만: "통합 검수 시스템").
//   · **collapsed**: 사이드바가 접히면 아이콘만(폭 꽉 찬 좁은 띠·중앙 정렬), 펼치면 아이콘 + 명칭.
//     어느 상태에서도 shrink-0 고정 띠라 레이아웃이 밀리거나 깨지지 않는다.
//   · 조직 판정 로직/DTO 변경 없음 — 위치·표현만 담당.
export default function OrgEnvironmentBanner({
  collapsed = false,
}: {
  collapsed?: boolean;
}) {
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const org = resolveAdminOrgFocus(pathname, searchParams);

  // 조직 선택 런처(/admin)에는 배너 미표시(아직 어떤 시스템에도 진입하지 않은 상태).
  //   그 외에는 개별(org)·통합(null) 모두 공통 테마로 렌더한다.
  if (!org && pathname === "/admin") return null;

  const theme = adminEnvironmentTheme(org);
  const label = theme.nameEn ? `${theme.nameKo} / ${theme.nameEn}` : theme.nameKo;
  const testAttrs = {
    "data-testid": "org-environment-banner",
    "data-org": org ?? undefined,
    "data-integrated": theme.isIntegrated ? true : undefined,
  } as const;

  // 접힘: 사이드바 폭이 좁아 라벨을 못 넣으므로 아이콘만(폭 꽉 찬 좁은 띠·중앙). 조직명은 title/aria.
  if (collapsed) {
    return (
      <div
        {...testAttrs}
        title={label}
        aria-label={label}
        className={cn(
          "flex min-h-11 w-full shrink-0 items-center justify-center border-b border-sidebar-border text-lg leading-none",
          theme.bannerClassName,
        )}
      >
        <span aria-hidden="true">{theme.icon}</span>
      </div>
    );
  }

  // 펼침: 사이드바 폭을 꽉 채우는 평평한 색 띠. 아이콘 + 명칭(통합은 ko 만). 긴 조직명은 truncate.
  return (
    <div
      {...testAttrs}
      className={cn(
        "flex min-h-11 w-full shrink-0 items-center gap-2 border-b border-sidebar-border px-4 text-sm font-bold",
        theme.bannerClassName,
      )}
    >
      <span className="text-lg leading-none" aria-hidden="true">
        {theme.icon}
      </span>
      <span className="min-w-0 truncate">
        {theme.nameKo}
        {theme.nameEn && (
          <span className="font-medium opacity-80"> / {theme.nameEn}</span>
        )}
      </span>
    </div>
  );
}
