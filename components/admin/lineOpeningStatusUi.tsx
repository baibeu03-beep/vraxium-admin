"use client";

import type { ReactNode } from "react";
import { CheckCircle2, CircleDashed } from "lucide-react";
import { cn } from "@/lib/utils";
import SectionDivider from "@/components/admin/SectionDivider";
import { lineManagementBoxClass } from "@/components/admin/lineManagementTone";
import type { StatusToken, StatusTokenKind } from "@/lib/lineOpeningStatusEngine";

// 라인 개설 상태창 공용 표현 프리미티브.
//   기존: 상태 문장마다 별도 박스(rounded-md border + bg-green/amber/muted + px-3 py-2).
//   변경: 카드 외곽선만 유지하고, 내부 문장은 단순 bullet 목록으로 통일한다.
//   bullet 정책(2026-07-24): bullet 은 '상태 표시'가 아니라 '목록 구분' 역할만 한다.
//     - 상태마다 다르던 bullet 색(green/amber/muted)을 전면 폐지하고, 모든 bullet 을
//       동일한 중립색(bg-muted-foreground/50) 고정 크기 작은 원으로 통일한다(라이트·다크 자동 대응).
//     - `●` 글자 대신 고정 크기 원형 요소(size-1)를 쓴다 — 페이지/폰트마다 크기가 달라지는 문제 방지.
//     - 상태 구분은 오직 문구·배지·텍스트 강조 색(statusTokenClass)으로만 표현한다(bullet 로는 구분 안함).
//   문장 내부 강조는 역할(토큰 kind)별 공통 토큰 스타일(statusTokenClass)로 통일한다 —
//     날짜·주차=rose / 팀·라인=blue / 개설 완료·크루 기입=green / 개설 필요=amber / 해당 기간 아님=gray.
//     페이지마다 개별 색을 만들지 않고 이 SoT 하나만 쓴다(라이트·다크 모두 가독성 확보).
//   실무 정보/경험/역량 + 프로세스 체크가 동일 컴포넌트를 재사용해 하위 페이지 UI 를 일치시킨다.

// tone 은 하위호환용으로 남겨둔 API(호출부가 계속 전달) — 더 이상 bullet 색/모양을 바꾸지 않는다.
//   상태 구분은 문구·배지·statusTokenClass 로만 하므로 tone 값은 렌더에 영향을 주지 않는다.
export type StatusTone = "neutral" | "positive" | "warning";

// 토큰 역할(kind) → 강조 클래스 SoT. 라이트/다크 모두 가독성 확보. 상태창 전 페이지 공용.
//   빨간색을 모든 중요 정보에 공통 사용하지 않는다 — 역할별로 색을 분리한다.
export function statusTokenClass(kind: StatusTokenKind): string {
  switch (kind) {
    case "date": // 날짜·주차명 — 로즈.
      return "font-semibold text-rose-600 dark:text-rose-400";
    case "team": // 팀·라인명 — 블루.
      return "font-semibold text-blue-600 dark:text-blue-400";
    case "openDone": // 개설 완료 — 연한 초록 하이라이트.
      return "rounded bg-emerald-500/10 px-1 font-semibold text-emerald-700 dark:text-emerald-400";
    case "openNeed": // 개설 필요 — 연한 앰버 하이라이트.
      return "rounded bg-amber-500/10 px-1 font-semibold text-amber-700 dark:text-amber-400";
    case "crewOk": // 크루 기입 가능 — 초록 강조.
      return "font-semibold text-emerald-700 dark:text-emerald-400";
    case "periodNone": // 해당 기간 아님·휴식·미오픈 — 보조 텍스트(회색).
      return "font-medium text-muted-foreground";
    case "accent": // 온라인/오프라인 등 보조 강조 — 인디고.
      return "font-semibold text-indigo-600 dark:text-indigo-400";
    default:
      return "";
  }
}

// 역할별 토큰 배열 렌더러(공통) — 상태창 전 페이지가 동일 강조 규칙을 쓴다.
export function StatusTokens({ tokens }: { tokens: ReadonlyArray<StatusToken> }) {
  return (
    <>
      {tokens.map((tk, i) => {
        const cls = statusTokenClass(tk.kind);
        return cls ? (
          <span key={i} className={cls}>
            {tk.text}
          </span>
        ) : (
          <span key={i}>{tk.text}</span>
        );
      })}
    </>
  );
}

export function StatusList({
  children,
  className,
}: {
  children: ReactNode;
  className?: string;
}) {
  return <ul className={cn("space-y-2", className)}>{children}</ul>;
}

export function StatusListItem({
  children,
}: {
  // tone 은 하위호환용 API — 호출부가 계속 전달하지만 렌더에 사용하지 않는다(상태 구분=문구·배지·강조 색만).
  tone?: StatusTone;
  children: ReactNode;
}) {
  return (
    <li className="flex items-start gap-2 text-foreground">
      {/* 목록 구분용 중립 bullet — 상태와 무관한 동일 색·고정 크기(라이트/다크 자동 대응).
          mt-[0.6em] 로 첫 줄 텍스트 중앙에 맞춘다(em 기준이라 폰트 크기와 무관하게 정렬 유지). */}
      <span
        aria-hidden="true"
        className="mt-[0.6em] size-1 shrink-0 rounded-full bg-muted-foreground/50"
      />
      <span className="min-w-0">{children}</span>
    </li>
  );
}

// 상태창·로그창(모니터링, 상단)과 '라인 개설'(실행/입력, 하단) 두 독립 업무 섹션을 분리하는 공용 구분선.
//   실무 정보/경험/역량 세 화면의 [라인 개설] 탭이 모두 이 하나를 쓴다(경계당 구분선 1개).
//   ⚠ 두 섹션 사이의 '바깥' 여백만 만든다 — 상태창 내부 간격이나 라인 개설 폼 내부 padding 은 건드리지 않는다.
//   여백은 margin 이 아니라 padding 으로 준다: 소비 부모가 대부분 space-y-* 컨테이너라
//     자식 margin-top 이 space-y 규칙(더 높은 specificity)에 덮인다 → 위/아래 비대칭 발생.
//     padding 은 덮이지 않으므로 space-y 안에서도 구분선 위/아래가 대칭으로 유지된다.
//     (같은 이유로 PageSection 의 음수 마진 상쇄 방식은 여기서 못 쓴다 — 부모가 gap 이 아니라 space-y 라
//      상쇄할 rowGap 자체가 없다. 그래서 이 컴포넌트가 자체 padding 으로 동일 리듬을 만든다.)
//   실효 여백(부모 space-y-4=16px 기준) = padding + 16 → 모바일 48px · 데스크톱 56px.
//     이는 /admin/periods/register 의 PageSection divider 경계(48/56 대칭)와 픽셀 동일한 SoT 값이다.
//   여백·variant 계산은 공용 SectionDivider 에 위임한다(값 중복 정의 금지) — 이 래퍼는
//     "line-opening 세 화면의 그 경계" 라는 의미 이름만 유지한다.
export function LineOpeningSectionDivider() {
  return <SectionDivider parentSpaceY="space-y-4" />;
}

// 개설 완료(잠금) 배너 — 실무 정보/경험/역량 세 화면의 [라인 개설] 탭 공용 SoT.
//   "개설 완료" 상태를 사용자가 즉시 인지하고, 왜 입력이 잠겼는지·어떻게 푸는지(=[개설 취소])를
//   한 곳에서 같은 문구·같은 시각으로 안내한다. 화면마다 배지를 따로 만들지 않는다.
//   ⚠ 표시 전용 — 개설 여부 판정(서버 SoT)이나 disabled 조건 계산은 각 화면이 소유한다.
export const LINE_OPENING_OPENED_NOTICE_DESCRIPTION =
  "아래는 이 주차에 저장된 개설 정보입니다(읽기 전용). 수정하려면 [개설 취소] 후 다시 개설하세요.";

// 미오픈(아직 오픈되지 않음) 안내 — 위 [개설 완료] 배너의 짝. 라인 개설·프로세스 체크 공용 SoT.
//   빈 데이터/오류로 오해하지 않도록 "왜 비어 있는지"를 한 문장으로 못 박는다.
//   ⚠ 미오픈은 실패가 아니다 — 빨강(danger)이 아니라 앰버(warning) tone 을 쓴다(라이트/다크 동시 대응).
//   ⚠ 표시 전용 — 오픈 여부 판정은 서버 SoT(lib/weekOpenGate → DTO)가 소유한다.
//     프로세스 체크에서는 `resolveProcessCheckOpenState(hub, acts)` 결과가 "not_open" 일 때만 띄운다.
export const LINE_OPENING_NOT_OPEN_TITLE = "아직 오픈되지 않았습니다.";

export function LineOpeningNotOpenNotice({
  title = LINE_OPENING_NOT_OPEN_TITLE,
  description,
  className,
}: {
  /** 기본 문구를 화면 성격에 맞게 구체화할 때만 전달. */
  title?: string;
  description?: ReactNode;
  className?: string;
}) {
  return (
    <div
      // role="status" — 주차/스코프 전환으로 미오픈이 된 사실을 보조기기에도 알린다.
      role="status"
      className={cn(
        "flex items-start gap-2 rounded-md border px-3 py-2.5",
        lineManagementBoxClass("warning"),
        className,
      )}
    >
      <CircleDashed className="mt-0.5 h-5 w-5 shrink-0" aria-hidden="true" />
      <div className="min-w-0">
        <p className="text-sm font-semibold">{title}</p>
        {description && <p className="text-xs opacity-90">{description}</p>}
      </div>
    </div>
  );
}

export function LineOpeningOpenedNotice({
  description = LINE_OPENING_OPENED_NOTICE_DESCRIPTION,
  className,
}: {
  description?: string;
  className?: string;
}) {
  return (
    <div
      // role="status" — 개설 직후 상태 전환(편집 가능 → 읽기 전용)을 보조기기에도 알린다.
      role="status"
      className={cn(
        "flex items-start gap-2 rounded-md border border-emerald-300 bg-emerald-50 px-3 py-2.5 dark:border-emerald-800 dark:bg-emerald-950/40",
        className,
      )}
    >
      <CheckCircle2 className="mt-0.5 h-5 w-5 shrink-0 text-emerald-600 dark:text-emerald-400" />
      <div className="min-w-0">
        <p className="text-sm font-semibold text-emerald-800 dark:text-emerald-300">
          개설 완료
        </p>
        <p className="text-xs text-emerald-700/90 dark:text-emerald-400/90">{description}</p>
      </div>
    </div>
  );
}
