import { cn } from "@/lib/utils";
import { Separator, type SeparatorVariant } from "@/components/ui/separator";
import SectionHeading from "@/components/admin/SectionHeading";

// 어드민 "주요 섹션" 묶음 — 섹션 제목·설명·우측 액션·(선택)구분선·본문을 함께 관리한다.
//   목적: 페이지마다 `<h2 …>제목</h2>` + `<div className="my-6 border-t" />` 를 손으로
//         반복하는 대신, 섹션 구조 자체를 통일한다. 제목 위계(h2 섹션)와 시맨틱을 보장하고,
//         "모든 제목 아래 자동 구분선"이 아니라 필요한 섹션만 divider prop 으로 선택 적용한다.
//
//   title       : 섹션 제목(필수) — SectionHeading(as) 로 렌더.
//   description : 선택 설명문(제목 아래 muted).
//   actions     : 선택 우측 액션(제목 라인 오른쪽, 좁으면 래핑).
//   as          : "h2"(기본, 주요 섹션) | "h3"(하위 섹션).
//   divider     : "none"(기본) | "fade" | "line" | "sparkle" — 이 섹션 "위"에 놓일 구분선.
//                 성격이 크게 다른 최상위 영역 경계에서만 fade/sparkle 를 제한적으로 쓴다.
//                 (섹션 간 기본 간격은 admin-section-stack 여백이 담당 — 구분선은 강조 옵션.)
//   className   : 섹션 wrapper 확장(폭/여백 등). 내부 본문 간격은 children 이 담당.
//
//   ⚠ 섹션 사이 세로 리듬은 부모의 admin-section-stack(AdminSectionStack)이 담당한다 —
//     이 컴포넌트에 섹션 간 margin 을 넣지 않는다. divider 는 그 간격 안의 "선"일 뿐.
//   mode/org 분기 없음(순수 프레젠테이션 — 어느 조직/모드에서도 동일 렌더/DTO 경로).
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
  title: React.ReactNode;
  description?: React.ReactNode;
  actions?: React.ReactNode;
  as?: "h2" | "h3";
  divider?: DividerOption;
  id?: string;
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <section id={id} className={cn("flex flex-col gap-3", className)}>
      {divider !== "none" ? <Separator variant={divider} /> : null}
      <div className="flex flex-col gap-1">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <SectionHeading as={as}>{title}</SectionHeading>
          {actions ? (
            <div className="flex flex-wrap items-center gap-2">{actions}</div>
          ) : null}
        </div>
        {description ? (
          <p className="text-sm text-muted-foreground">{description}</p>
        ) : null}
      </div>
      <div>{children}</div>
    </section>
  );
}
