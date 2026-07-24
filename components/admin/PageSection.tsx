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
//   divider     : "none"(기본) | "fade" | "line" | "sparkle" — 이 섹션 "위"에 놓일 구분선.
//   className   : 섹션 wrapper 확장(폭/여백 등).
//
//   ── 세로 간격(구분선 경계) — PageSection 이 "자체적으로" 책임진다(부모 값에 의존 X) ──────────
//   divider 가 있는 섹션은:
//     1) 부모 admin-section-stack 간격(32/40)을 음수 마진(-mt-8 md:-mt-10)으로 **상쇄**하고,
//     2) 구분선 블록이 위·아래로 각 48px(모바일)/56px(데스크톱)를 **직접** 부여한다(mt/mb 대칭).
//       → 위=아래 완전 대칭(각 48/56). 총 48+8(wave)+48=104 / 56+8+56=120.
//       구분선이 "독립된 경계"처럼 위·아래로 충분히 떨어져 보이도록(숨 쉬는 여백).
//   ⚠ 이 상쇄는 부모가 admin-section-stack(32/40)일 때 정확하다 — divider 를 쓰는 페이지는 이 stack 을
//      루트로 쓴다(SeasonParticipationsView 포함, 2026-07-24 -lg→stack 통일). divider 없는 섹션은 상쇄 없이
//      부모 stack 간격만 사용(불변).
//   ⚠ 폼 필드·카드 내부·표 행·제목↔본문 간격은 건드리지 않는다(오직 섹션 사이 + 구분선 주변만).
//   mode/org 분기 없음(순수 프레젠테이션).
type DividerOption = "none" | SeparatorVariant;

export default function PageSection({
  title,
  description,
  actions,
  as = "h2",
  divider = "none",
  id,
  className,
  children,
}: {
  title?: React.ReactNode;
  description?: React.ReactNode;
  actions?: React.ReactNode;
  as?: "h2" | "h3";
  divider?: DividerOption;
  id?: string;
  className?: string;
  children: React.ReactNode;
}) {
  // 헤더(제목/설명/액션)가 하나라도 있을 때만 헤더 블록을 렌더 — 없으면 자식이 이미 제목을 갖고 있다는 뜻.
  const hasHeader = title != null || description != null || actions != null;

  const hasDivider = divider !== "none";

  return (
    <section
      id={id}
      className={cn(
        "flex flex-col",
        // divider 가 있으면 부모 admin-section-stack 의 위쪽 gap(32/40)을 음수 마진으로 상쇄한다 →
        //   그 자리에 구분선 블록이 위·아래 각 48/56 을 "직접" 세팅해 대칭 경계를 만든다(부모값 비의존).
        hasDivider && "-mt-8 md:-mt-10",
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
