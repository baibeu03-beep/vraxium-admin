"use client";

// 댓글 수집 상태 표시(공용) — 프로세스 체크 목록 셀(compact)·액트 팝업(card) 공용.
//   "댓글 수집 상태"와 "사용자 매칭 결과"를 분리해 노출한다. org/mode 무관·정규/변동 동일 컴포넌트.
//   상태 판정은 서버 파생값(reviewerDebug.collectionKind, SoT=deriveCommentCollectionStatus)을 그대로 쓴다 —
//   여기서 count===0 같은 임의 판정을 다시 하지 않는다.

import { cn } from "@/lib/utils";
import {
  COMMENT_COLLECTION_LABEL,
  COMMENT_COLLECTION_DESCRIPTION,
  COMMENT_COLLECTION_TONE,
  type CommentCollectionStatusKind,
  type CommentCollectionTone,
  type CommentCollectionViewData,
} from "@/lib/adminProcessCheckTypes";

const TONE_CLASSES: Record<
  CommentCollectionTone,
  { text: string; dot: string; card: string }
> = {
  neutral: {
    text: "text-muted-foreground",
    dot: "bg-muted-foreground/50",
    card: "border-border bg-muted/30 text-muted-foreground",
  },
  warning: {
    text: "text-amber-700",
    dot: "bg-amber-500",
    card: "border-amber-300 bg-amber-50 text-amber-800 dark:bg-amber-950/30 dark:text-amber-200",
  },
  danger: {
    text: "text-rose-700",
    dot: "bg-rose-500",
    card: "border-rose-300 bg-rose-50 text-rose-700 dark:bg-rose-950/30 dark:text-rose-200",
  },
};

// 수집/매칭 카운트가 의미 있는 상태 — 실제로 수집이 완료된 collected_* 만. 미수집/오류/확인불가/수집중은
//   카운트가 의미 없어(0 이 "정상 0"처럼 오해될 수 있음) 라벨/설명만 보여준다.
const COUNTS_KINDS: ReadonlySet<CommentCollectionStatusKind> = new Set([
  "collected_matched",
  "collected_no_match",
  "collected_no_comments",
]);

// "수집 댓글 N개 · 매칭 사용자 M명" — 원본 수 미기록(레거시)이면 매칭 수만.
export function commentCollectionCountsText(data: CommentCollectionViewData): string {
  if (data.rawCommentCount == null) {
    return `매칭 사용자 ${data.matchedCrewCount}명`;
  }
  return `수집 댓글 ${data.rawCommentCount}개 · 매칭 사용자 ${data.matchedCrewCount}명`;
}

export default function CommentCollectionStatusView({
  debug,
  variant,
  kindOverride,
  className,
}: {
  debug: CommentCollectionViewData;
  variant: "compact" | "card";
  // 클라 전용 전이 상태(예: [댓글 다시 수집] 진행 중 = "collecting")를 강제 표시할 때.
  kindOverride?: CommentCollectionStatusKind;
  className?: string;
}) {
  const kind = kindOverride ?? debug.collectionKind;
  const tone = TONE_CLASSES[COMMENT_COLLECTION_TONE[kind]];
  const label = COMMENT_COLLECTION_LABEL[kind];
  const showCounts = COUNTS_KINDS.has(kind);
  const counts = commentCollectionCountsText(debug);

  if (variant === "compact") {
    // 목록 '상태' 셀 보조 — 상태 배지 아래에 (수집이 완료된 경우) 수집/매칭 카운트 + 상태 라벨 1줄.
    return (
      <div className={cn("mt-1 text-[11px] leading-tight", className)}>
        {showCounts && <div className="tabular-nums text-muted-foreground">{counts}</div>}
        <div className={cn("inline-flex items-center gap-1 font-medium", tone.text)}>
          <span className={cn("h-1.5 w-1.5 rounded-full", tone.dot)} aria-hidden />
          {label}
        </div>
      </div>
    );
  }

  // 팝업/피커 카드 — 제목 + 설명(요구 문구) + (수집 완료 시) 수집/매칭 카운트.
  return (
    <div className={cn("rounded-md border px-3 py-2 text-xs leading-relaxed", tone.card, className)}>
      <p className="font-semibold">{label}</p>
      <p>{COMMENT_COLLECTION_DESCRIPTION[kind]}</p>
      {showCounts && <p className="mt-1 tabular-nums opacity-90">{counts}</p>}
    </div>
  );
}
