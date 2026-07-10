import { cn } from "@/lib/utils";

// 어드민 페이지의 "주요 섹션" 사이 세로 리듬(vertical rhythm)을 전역 통일하는 공용 스택.
// 목적: 페이지마다 제각각인 top-level 섹션 wrapper(gap-4 / gap-5 / gap-6 / space-y-*)를
//       하나의 SoT 로 모아, 섹션과 섹션 사이 간격만 한 단계 넓히고 반응형으로 일관화한다.
//
//   size="default" → gap-4 md:gap-5  (모바일 16px · 데스크톱 20px)  ← 일반 주요 섹션 스택
//   size="lg"      → gap-5 md:gap-6  (모바일 20px · 데스크톱 24px)  ← 페이지 전체를 이루는
//                                                                    큰 섹션 묶음(허브/탭 등)
//
// 범위: 오직 "독립적인 주요 블록(헤더·안내 섹션·카드·표 묶음)" 사이 간격만 담당한다.
//   - 카드 내부의 제목/버튼/폼 필드/표 행/라벨 간격은 이 컴포넌트로 조정하지 않는다.
//   - CardHeader 의 padding·height 를 대신하지 않는다(헤더↔본문 간격은 Card 기본값 유지).
//   - 가로 간격·최대 너비는 담당하지 않는다. 폭 관련 클래스는 className 으로 넘긴다.
// club/org/mode 쿼리에 따라 분기하지 않으므로 어떤 조직·모드에서도 동일한 간격을 낸다.
export default function AdminSectionStack({
  children,
  className,
  size = "default",
}: {
  children: React.ReactNode;
  className?: string;
  size?: "default" | "lg";
}) {
  return (
    <div
      className={cn(
        // 간격 정의(display:flex + column + 반응형 gap)는 globals.css 의
        // @utility admin-section-stack{,-lg} 가 단일 출처. 여기선 그 클래스만 붙인다.
        size === "lg" ? "admin-section-stack-lg" : "admin-section-stack",
        className,
      )}
    >
      {children}
    </div>
  );
}
