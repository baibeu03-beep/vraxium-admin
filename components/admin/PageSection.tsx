import { cn } from "@/lib/utils";
import { Separator, type SeparatorVariant } from "@/components/ui/separator";
import SectionHeading from "@/components/admin/SectionHeading";

// 어드민 "주요 섹션" 묶음 — (선택)상단 구분선 · (선택)섹션 제목·설명·액션 · 본문 · 다음 섹션과의
// 큰 세로 간격을 함께 관리한다. 목적: 페이지마다 `<h2>제목</h2>` + `<div className="my-6 border-t"/>` 를
// 손으로 반복하지 않고 섹션 구조를 통일한다.
//
//   title       : 섹션 제목(**선택**). 이미 자식 컴포넌트가 제목을 렌더하는 경우엔 title 을 주지 않는다
//                 (중복 렌더 금지 — 제목은 화면당 한 번). title 없으면 헤더 블록 자체를 렌더하지 않는다.
//   description : 선택 설명문(제목 아래 muted). title 없이도 렌더 가능.
//   actions     : 선택 우측 액션(제목 라인 오른쪽, 좁으면 래핑).
//   as          : "h2"(기본, 주요 섹션) | "h3"(하위 섹션).
//   divider     : "none"(기본) | "fade" | "line" | "sparkle" | "wave" | "wave-dot" — 이 섹션 "위"에 놓일 구분선.
//   parentGap   : 부모 컨테이너의 세로 gap 토큰(기본 "stack"). divider 상쇄값 계산에만 쓰인다.
//   className   : 섹션 wrapper 확장(폭/여백 등).
//
//   ── 세로 간격(구분선 경계) ────────────────────────────────────────────────────
//   divider 가 있는 섹션은:
//     1) 부모 컨테이너의 위쪽 gap 을 음수 마진으로 **상쇄**하고(PARENT_GAP_OFFSET),
//     2) 구분선 블록이 위·아래로 각 48px(모바일)/56px(데스크톱)를 **직접** 부여한다(mt/mb 대칭).
//       → 부모 gap 이 얼마든 위=아래 완전 대칭(각 48/56). 총 48+8(wave)+48=104 / 56+8+56=120.
//       구분선이 "독립된 경계"처럼 위·아래로 충분히 떨어져 보이도록(숨 쉬는 여백).
//   상쇄값은 부모 gap 과 짝이 맞아야 정확하다 → 부모가 admin-section-stack 이 아니면 parentGap 을
//     명시한다(예: 중첩 탭 내부의 `flex flex-col gap-6` → parentGap="gap-6"). 부모 레이아웃을
//     admin-section-stack 으로 강제 변경하지 않고 이 prop 으로 맞추는 것이 원칙 —
//     중첩 탭/서브패널의 기존 세로 리듬은 불변([[project_admin-section-vertical-rhythm-sot]] 의 의도적 제외).
//   divider 없는 섹션은 상쇄 없이 부모 gap 만 사용(parentGap 무시).
//   ⚠ 폼 필드·카드 내부·표 행·제목↔본문 간격은 건드리지 않는다(오직 섹션 사이 + 구분선 주변만).
//   mode/org 분기 없음(순수 프레젠테이션).
type DividerOption = "none" | SeparatorVariant;

// 부모 컨테이너의 세로 gap 토큰 → 상쇄용 음수 마진. 정적 문자열이라 purge 안전.
//   "stack"    = admin-section-stack    (32px → 40px@md)  ← 기본값(기존 동작 유지)
//   "stack-lg" = admin-section-stack-lg (40px → 48px@md)
//   "gap-6"    = Tailwind gap-6         (24px · 반응형 없음)
type ParentGap = "stack" | "stack-lg" | "gap-6";

const PARENT_GAP_OFFSET: Record<ParentGap, string> = {
  stack: "-mt-8 md:-mt-10",
  "stack-lg": "-mt-10 md:-mt-12",
  "gap-6": "-mt-6",
};

export default function PageSection({
  title,
  description,
  actions,
  as = "h2",
  divider = "none",
  parentGap = "stack",
  id,
  tabIndex,
  className,
  children,
}: {
  title?: React.ReactNode;
  description?: React.ReactNode;
  actions?: React.ReactNode;
  as?: "h2" | "h3";
  divider?: DividerOption;
  parentGap?: ParentGap;
  id?: string;
  tabIndex?: number;
  className?: string;
  children: React.ReactNode;
}) {
  // 헤더(제목/설명/액션)가 하나라도 있을 때만 헤더 블록을 렌더 — 없으면 자식이 이미 제목을 갖고 있다는 뜻.
  const hasHeader = title != null || description != null || actions != null;

  const hasDivider = divider !== "none";

  return (
    <section
      id={id}
      tabIndex={tabIndex}
      className={cn(
        "flex flex-col",
        // divider 가 있으면 부모 컨테이너의 위쪽 gap 을 음수 마진으로 상쇄한다 →
        //   그 자리에 구분선 블록이 위·아래 각 48/56 을 "직접" 세팅해 대칭 경계를 만든다.
        hasDivider && PARENT_GAP_OFFSET[parentGap],
        className,
      )}
    >
      {hasDivider ? (
        // 구분선 위(mt) · 아래(mb) 여백을 대칭으로 직접 부여: 48px(모바일)/56px(데스크톱).
        //   위 상쇄(-mt-8/-10)로 부모 gap 을 0 으로 만든 뒤 mt-12/14 가 실제 위 여백이 된다.
        //   보이는 구분선은 이 한 개뿐(자식이 별도 구분선을 렌더하지 않는 큰 섹션 경계 전용).
        <div className="mt-12 mb-12 md:mt-14 md:mb-14">
          <Separator variant={divider} />
        </div>
      ) : null}

      {hasHeader ? (
        <div className="mb-3 flex flex-col gap-1">
          <div className="flex flex-wrap items-center justify-between gap-2">
            {title != null ? <SectionHeading as={as}>{title}</SectionHeading> : null}
            {actions != null ? (
              <div className="flex flex-wrap items-center gap-2">{actions}</div>
            ) : null}
          </div>
          {description != null ? (
            <p className="text-sm text-muted-foreground">{description}</p>
          ) : null}
        </div>
      ) : null}

      <div>{children}</div>
    </section>
  );
}
