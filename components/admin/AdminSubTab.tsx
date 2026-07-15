"use client";

import { cn } from "@/lib/utils";

// 관리자 하위 탭(서브 탭) 공통 버튼 — 선택/비선택 시각 대비를 강하게 통일한다(공통 variant).
//   기존에 실무 경험/역량/경력 매니저가 각자 복제하던 TabButton(선택 = border-b-2 + text-primary,
//   배경 차이 없음 → 약함)을 하나로 통일하고 대비를 보강한다.
//
//   · 선택: primary 하단 강조선 + primary 연한 배경 + 굵은 primary 글자(색상 외 비색상 표현 병행).
//   · 비선택: muted 유지 + hover 는 선택보다 약하게(bg-muted/60).
//   · 잠금(disabled): 선택과 혼동되지 않도록 opacity/cursor-not-allowed + hover 무력화.
//   · 레이아웃 시프트 방지: 비선택도 border-b-2(투명)로 두께를 예약.
//   · 접근성: role="tab" + aria-selected(true/false), 잠금 시 aria-disabled + native disabled.
//   · 다크 모드: primary 토큰 사용이라 라이트/다크 모두 명확.
export default function AdminSubTab({
  label,
  active,
  onClick,
  disabled,
}: {
  label: string;
  active: boolean;
  onClick: () => void;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      role="tab"
      aria-selected={active}
      aria-disabled={disabled || undefined}
      disabled={disabled}
      onClick={onClick}
      className={cn(
        "relative rounded-t-md border-b-2 px-4 py-2 text-sm transition-colors",
        active
          ? "border-primary bg-primary/10 font-semibold text-primary"
          : "border-transparent font-medium text-muted-foreground hover:bg-muted/60 hover:text-foreground",
        disabled &&
          "cursor-not-allowed opacity-50 hover:bg-transparent hover:text-muted-foreground",
      )}
    >
      {label}
    </button>
  );
}
