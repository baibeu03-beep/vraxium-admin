// 라인 관리(정보 탭) 표의 "적용 클럽"·"소속 허브" 배지 스타일 SoT.
//   표시 전용 — 원본 organization_slug/hub 저장값은 무수정. 색상 매핑은 여기 한 곳에만 둔다
//   (중복 조건문 방지). 정의되지 않은 값은 기본(zinc) 배지로 폴백한다.
//
//   · 적용 클럽 = 둥근(rounded-md) 밝은 배지 + 진한(검정 계열) 글자.
//   · 소속 허브 = 각진(rounded-sm) 차분한 배지 + 흰 글자.
import type { ReactNode } from "react";
import { COMMON_CLUB_LABEL, type LineRegistrationHub } from "@/lib/adminLineRegistrationsTypes";

// 적용 클럽 색상 — 키 = lineRegistrationDisplayClub 반환값(공통/encre/oranke/phalanx/-/…).
//   밝은 배경 + 검정 계열 글자(다크 모드에서도 대비 유지: 밝은 배경 위 진한 글자).
const CLUB_BADGE_CLASS: Record<string, string> = {
  [COMMON_CLUB_LABEL]: "bg-violet-200 text-zinc-950", // 공통 = 보라
  encre: "bg-red-200 text-zinc-950", // 엥크레 = 빨강
  oranke: "bg-amber-200 text-zinc-950", // 오랑캐 = 노랑
  phalanx: "bg-emerald-200 text-zinc-950", // 팔랑크스 = 초록
};
const CLUB_BADGE_FALLBACK = "bg-zinc-200 text-zinc-900";

// 소속 허브 색상 — 키 = hub enum. 연한 파스텔 배경 + 같은 계열 진한(*-800) 글자.
//   적용 클럽 배지보다 은은하게(존재감 낮게) — 행 가독성을 해치지 않는 강조만 유지한다.
//   계열(빨강/노랑/초록/파랑)은 유지하되 채도·명도를 낮춘다.
const HUB_BADGE_CLASS: Record<LineRegistrationHub, string> = {
  info: "bg-red-100 text-red-800", // 실무 정보 = 빨강(파스텔)
  experience: "bg-amber-100 text-amber-800", // 실무 경험 = 노랑/황토(파스텔)
  competency: "bg-emerald-100 text-emerald-800", // 실무 역량 = 초록(파스텔)
  career: "bg-sky-100 text-sky-800", // 실무 경력 = 파랑(파스텔)
};
const HUB_BADGE_FALLBACK = "bg-zinc-100 text-zinc-700";

// 적용 클럽 배지 — value = 색상 키(displayClub), children = 표시 라벨(clubKo 결과).
export function ClubBadge({ value, children }: { value: string; children: ReactNode }) {
  const cls = CLUB_BADGE_CLASS[value] ?? CLUB_BADGE_FALLBACK;
  return (
    <span
      data-club-badge={value}
      className={"inline-block rounded-md px-2.5 py-0.5 text-xs font-semibold " + cls}
    >
      {children}
    </span>
  );
}

// 소속 허브 배지 — hub = 색상 키(enum), children = 표시 라벨(hubLabel).
export function HubBadge({ hub, children }: { hub: LineRegistrationHub; children: ReactNode }) {
  const cls = (HUB_BADGE_CLASS as Record<string, string>)[hub] ?? HUB_BADGE_FALLBACK;
  return (
    <span
      data-hub-badge={hub}
      className={"inline-block rounded-sm px-2.5 py-0.5 text-xs font-semibold " + cls}
    >
      {children}
    </span>
  );
}
