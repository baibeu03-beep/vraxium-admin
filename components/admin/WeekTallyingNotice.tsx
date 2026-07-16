import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

// ─────────────────────────────────────────────────────────────────────
// 성장 결과 "집계 중"(미확정) 주차의 조회 전용 안내 배너 — 단일 SoT.
//   · 라인 강화 내역 / 액트 체크 내역 두 화면이 동일 문구·동일 디자인·동일 조건으로 공유.
//     문구나 정책이 바뀌면 이 파일 한 곳만 고치면 두 화면에 함께 반영된다.
//   · 표시 조건 = 성장 결과 미확정(!confirmed). confirmed = isCrewWeekEditable(주차 상태)
//     로 두 화면 모두 동일하게 산출된다(shared/growth.contracts). confirmed=true 면 렌더 없음.
//   · children = 화면별 보조 문구(예: 라인 강화 내역의 "미판정 라인 N개")를 배너 안에 이어 붙일 때 사용.
// ─────────────────────────────────────────────────────────────────────
export default function WeekTallyingNotice({
  confirmed,
  className,
  children,
}: {
  confirmed: boolean;
  className?: string;
  children?: ReactNode;
}) {
  if (confirmed) return null;
  return (
    <div
      className={cn(
        "rounded-md border border-amber-300 bg-amber-50 px-4 py-3 text-sm leading-relaxed text-amber-800 dark:border-amber-500/40 dark:bg-amber-500/10 dark:text-amber-200",
        className,
      )}
    >
      <p>현재 주차는 성장 결과가 집계 중 상태이므로 데이터를 수정할 수 없습니다.</p>
      <p>성장 결과가 확정된 이후 수정할 수 있으며, 지금은 조회만 가능합니다.</p>
      {children}
    </div>
  );
}
