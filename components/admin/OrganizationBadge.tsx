import { cn } from "@/lib/utils";
import {
  ORGANIZATION_TEXT_CLASS,
  ORGANIZATION_LABEL_KO,
  isOrganizationSlug,
} from "@/lib/organizations";

// 현재 조직 식별 라벨 — 사이드바 상단 "개별/통합" 배지 옆에 조직명(한글)을 표시.
//   · 라벨/색은 lib/organizations 단일 SoT(ORGANIZATION_LABEL_KO / ORGANIZATION_TEXT_CLASS) 재사용.
//   · orgSlug 는 어드민 org 컨텍스트(orgFocus: path /admin/crews/{org} 또는 ?org) 를 그대로 받는다
//     — mode(운영/테스트)·demoUserId·actAsTestUserId 무관하게 동일 값/동일 렌더(별도 계산 없음).
//   · org 미상(null/무효/통합)이면 아무것도 렌더하지 않는다(임의 조직명 폴백 금지).
//   · 배경/테두리/둥근 배지 없이 텍스트만 — 개별/통합 배지(text-sm)보다 한 단계 작은 text-xs 로
//     조직 대표색 글자만 표시(보조 강조). 배지가 아니라 작은 조직명 라벨처럼 보이게 한다.
export default function OrganizationBadge({
  orgSlug,
  className,
}: {
  orgSlug: string | null | undefined;
  className?: string;
}) {
  if (!isOrganizationSlug(orgSlug)) return null;
  return (
    <span
      className={cn(
        "text-xs font-medium",
        ORGANIZATION_TEXT_CLASS[orgSlug],
        className,
      )}
    >
      {ORGANIZATION_LABEL_KO[orgSlug]}
    </span>
  );
}
