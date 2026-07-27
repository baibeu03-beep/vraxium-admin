import { cn } from "@/lib/utils";
import { Separator, type SeparatorVariant } from "@/components/ui/separator";

// 큰 섹션 경계 구분선 — **부모가 `space-y-*` 컨테이너일 때** 쓰는 형태.
//
//   어드민 경계 여백 SoT(가시 간격) = 모바일 48px / 데스크톱 56px, 위·아래 대칭.
//   이를 만드는 방법은 부모 레이아웃에 따라 둘로 갈린다:
//     · 부모가 flex `gap`(admin-section-stack 등) → `PageSection divider=` 사용.
//       부모 gap 을 음수 마진으로 상쇄하고 구분선 블록이 mt/mb 로 48/56 을 직접 준다.
//     · 부모가 `space-y-*`(margin 기반)  → **이 컴포넌트**.
//       space-y 는 자식의 margin-top 을 덮어쓰므로(더 높은 specificity) 음수 마진 상쇄가 통하지 않는다.
//       대신 덮이지 않는 padding 으로 여백을 만든다: `부모 space-y 값 + padding = 48/56`.
//
//   parentSpaceY 별 padding(정적 문자열이라 purge 안전):
//     space-y-4(16px) → py-8  md:py-10  (32/40 + 16 = 48/56)
//     space-y-6(24px) → py-6  md:py-8   (24/32 + 24 = 48/56)
//
//   ⚠ 형제로 놓는다(감싸지 않는다). 감싸면 감싼 자식이 space-y 바깥으로 빠져 아래쪽 여백이 달라진다.
//   ⚠ 두 섹션 사이의 '바깥' 여백만 만든다 — 카드/폼/표 내부 간격과 구조적 border 는 건드리지 않는다.
//   장식이므로 aria-hidden(섹션 구분은 제목·문맥이 이미 전달). mode/org 분기 없음(순수 프레젠테이션).
type ParentSpaceY = "space-y-4" | "space-y-6";

const PARENT_SPACE_Y_PADDING: Record<ParentSpaceY, string> = {
  "space-y-4": "py-8 md:py-10",
  "space-y-6": "py-6 md:py-8",
};

export default function SectionDivider({
  parentSpaceY = "space-y-6",
  variant = "wave-dot",
  className,
}: {
  parentSpaceY?: ParentSpaceY;
  variant?: SeparatorVariant;
  className?: string;
}) {
  return (
    <div
      aria-hidden="true"
      className={cn(PARENT_SPACE_Y_PADDING[parentSpaceY], className)}
    >
      <Separator variant={variant} />
    </div>
  );
}
