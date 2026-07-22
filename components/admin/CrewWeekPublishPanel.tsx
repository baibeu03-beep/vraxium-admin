"use client";

import { useCallback, useEffect, useState } from "react";
import { useSearchParams } from "next/navigation";
import { Button } from "@/components/ui/button";
import { StatusBadge } from "@/components/ui/status-badge";
import { adminDialog } from "@/components/ui/admin-dialog";
import { pushToast } from "@/components/ui/toast";
import { readScopeMode } from "@/lib/userScopeShared";
import { apiErrorFrom, getApiErrorMessage } from "@/lib/apiError";
import type { OrganizationSlug } from "@/lib/organizations";
import type { CrewWeeklyResultDisplayStatus } from "@/lib/crewWeeklyResultTypes";

// [3] 예비 검수 · [4] 공표 / 공표 취소 — 세 동작을 **각각 다른 업무**로 구현한다.
//   · 예비 검수      = 서버 live 계산 결과를 화면 state 에만 보관. 저장 0 · 다른 화면 무영향.
//   · 예비 검수 취소 = 화면 state 만 비운다. 공표 결과·원천 무영향.
//   · 공표           = 서버가 원천을 재조회·재계산해 snapshot 저장(클라 숫자 미전송).
//   · 공표 모달의 "취소" = 모달만 닫는다(아무 상태도 바꾸지 않음).
//   · 공표 취소      = 이미 공표된 결과를 철회(reverted_at) → 집계 중으로 복귀.

type Metrics = {
  memberCount: number | null;
  seasonRestCount: number | null;
  personalRestCount: number | null;
  growthChallengeCount: number | null;
  growthSuccessCount: number | null;
  growthFailureCount: number | null;
  growthSuccessRatePercent: number | null;
  growthChallengeRatePercent: number | null;
  criterionPointA: number | null;
};

type CrewRow = {
  userId: string;
  crewDisplayName: string | null;
  crewCode: string | null;
  teamName: string | null;
  partName: string | null;
  result: "success" | "failure" | "rest" | "not_applicable" | "pending";
  reasonCode: string;
  earnedPointA: number | null;
  criterionPointA: number | null;
};

type Readiness = Record<
  | "memberCount" | "seasonRestCount" | "personalRestCount" | "growthChallengeCount"
  | "growthSuccessCount" | "growthFailureCount" | "growthSuccessRatePercent"
  | "growthChallengeRatePercent",
  "ready" | "partial" | "unavailable"
>;

type PreviewDto = Metrics & {
  crewResults: CrewRow[];
  calculatedAt: string;
  calculationVersion: number;
  metricsReadiness: Readiness;
};
type PublishedDto = PreviewDto & {
  runId: string;
  publishedAt: string;
  publishedBy: string | null;
  snapshotUnavailable: boolean;
};

const RESULT_LABEL: Record<CrewRow["result"], string> = {
  success: "성장 성공",
  failure: "성장 실패",
  rest: "휴식",
  not_applicable: "대상 아님",
  pending: "미확정",
};

// null = 아직 계산 불가/미집계 → "-".  0 = 계산 완료 후 실제 0 → "0".
//   ⚠ `value ?? 0` 같은 폴백을 절대 쓰지 않는다(둘을 섞으면 미집계가 0으로 위장된다).
function formatMetric(value: number | null, unit: "명" | "%"): string {
  return value === null ? "-" : `${value}${unit}`;
}

function MetricGrid({
  m,
  readiness,
}: {
  m: Metrics | null;
  readiness: Readiness | null;
}) {
  // [5] 종합 인덱스 — 최초 진입(예비·공표 모두 없음)에는 m=null 이라 전 항목 "-".
  //   자동 계산하지 않는다(진입 시 preview API 호출 없음).
  const items: Array<[keyof Readiness, string, "명" | "%"]> = [
    ["memberCount", "소속 크루", "명"],
    ["seasonRestCount", "시즌 휴식", "명"],
    ["personalRestCount", "개인 휴식", "명"],
    ["growthChallengeCount", "성장 도전", "명"],
    ["growthSuccessCount", "성장 성공", "명"],
    ["growthFailureCount", "성장 실패", "명"],
    ["growthChallengeRatePercent", "성장 도전율", "%"],
    ["growthSuccessRatePercent", "성장 성공률", "%"],
  ];
  return (
    <div className="grid grid-cols-2 gap-2 sm:grid-cols-4" data-metric-grid>
      {items.map(([key, label, unit]) => {
        const value = m ? ((m as unknown as Record<string, number | null>)[key] ?? null) : null;
        const state = readiness?.[key] ?? "unavailable";
        return (
          <div key={key} className="rounded-md border px-3 py-2 text-center">
            <div className="text-xs text-muted-foreground">{label}</div>
            <div
              className="text-2xl font-bold tabular-nums"
              data-metric={key}
              data-readiness={state}
              title={
                value === null
                  ? "아직 집계되지 않았습니다(계산 불가). 실제 0과 다릅니다."
                  : undefined
              }
            >
              {formatMetric(value, unit)}
            </div>
          </div>
        );
      })}
    </div>
  );
}

function CrewTable({ rows }: { rows: CrewRow[] }) {
  if (rows.length === 0) return null;
  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[48rem] border-separate border-spacing-0 text-sm">
        <thead>
          <tr>
            {["크루", "팀", "파트", "결과", "기준 Po.A", "획득 Po.A", "판정 근거"].map((h) => (
              <th key={h} className="whitespace-nowrap border-b bg-muted/60 px-3 py-2 font-semibold">
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((c, i) => (
            <tr key={c.userId} className={i % 2 === 1 ? "bg-muted/30" : ""} data-crew-row={c.userId}>
              <td className="whitespace-nowrap border-b px-3 py-2 text-center">
                {c.crewDisplayName ?? c.crewCode ?? c.userId.slice(0, 8)}
              </td>
              <td className="whitespace-nowrap border-b px-3 py-2 text-center">{c.teamName ?? "-"}</td>
              <td className="whitespace-nowrap border-b px-3 py-2 text-center">{c.partName ?? "-"}</td>
              <td className="whitespace-nowrap border-b px-3 py-2 text-center">
                <StatusBadge label={RESULT_LABEL[c.result]} size="sm" />
              </td>
              <td className="whitespace-nowrap border-b px-3 py-2 text-center tabular-nums">
                {c.criterionPointA ?? "-"}
              </td>
              <td className="whitespace-nowrap border-b px-3 py-2 text-center tabular-nums">
                {c.earnedPointA ?? "-"}
              </td>
              <td className="whitespace-nowrap border-b px-3 py-2 text-center text-xs text-muted-foreground">
                {c.reasonCode}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export default function CrewWeekPublishPanel({
  organizationSlug,
  weekId,
  displayStatus,
  weekEnded,
  onChanged,
}: {
  organizationSlug: OrganizationSlug;
  weekId: string;
  displayStatus: CrewWeeklyResultDisplayStatus | null;
  /** 주차가 실제로 종료됐는가 — 진행 중 주차는 공표 금지(서버도 422로 차단). */
  weekEnded: boolean;
  onChanged?: () => void;
}) {
  const searchParams = useSearchParams();
  const mode = readScopeMode(searchParams);
  const qs = mode === "test" ? "?mode=test" : "";
  const base = `/api/admin/team-parts/info/crew-week-results/${organizationSlug}/${weekId}`;

  const [preview, setPreview] = useState<PreviewDto | null>(null);
  const [published, setPublished] = useState<PublishedDto | null>(null);
  const [busy, setBusy] = useState<null | "preview" | "publish" | "unpublish">(null);

  const loadPublished = useCallback(async () => {
    try {
      const res = await fetch(`${base}${qs}`, { cache: "no-store" });
      const json = await res.json();
      if (!res.ok || !json.success) throw apiErrorFrom(res, json, `조회 실패 (${res.status})`);
      setPublished((json.data?.published as PublishedDto | null) ?? null);
    } catch {
      setPublished(null);
    }
  }, [base, qs]);

  useEffect(() => {
    // 외부(API)와 동기화하는 정석 effect — 공표 상태는 서버가 소유한다.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void loadPublished();
  }, [loadPublished]);

  // [3] 예비 검수 — 매번 서버에서 최신 원천으로 재계산(캐시 금지).
  const onPreview = async () => {
    setBusy("preview");
    try {
      const res = await fetch(`${base}${qs ? `${qs}&` : "?"}action=preview`, { cache: "no-store" });
      const json = await res.json();
      if (!res.ok || !json.success) throw apiErrorFrom(res, json, `예비 검수 실패 (${res.status})`);
      setPreview(json.data.preview as PreviewDto);
      await adminDialog.alert({
        variant: "info",
        title: "예비 결과 도출",
        description:
          "누적된 데이터를 기준으로 예비 결과를 도출했습니다. 이 결과는 확인용이며, 다른 페이지에는 공표되지 않았습니다.",
      });
    } catch (e) {
      pushToast("error", getApiErrorMessage(e, "예비 검수 실패"));
    } finally {
      setBusy(null);
    }
  };

  // 예비 결과만 화면에서 제거 — DB/공표 상태 무영향.
  const onCancelPreview = () => setPreview(null);

  // [4] 공표 — 확인 모달의 "취소"는 아무것도 하지 않는다.
  const onPublish = async () => {
    const ok = await adminDialog.confirm({
      variant: "warning",
      title: "활동 결과 확정",
      description:
        "해당 주차 활동 결과를 확정하시겠습니까? 확정하면 크루 페이지를 포함한 관련 화면에 공표됩니다.",
      confirmLabel: "확인",
      cancelLabel: "취소",
    });
    if (!ok) return; // 모달만 닫힘 — 상태 변경 없음
    setBusy("publish");
    try {
      // ⚠ 예비 숫자를 보내지 않는다. 서버가 최신 원천으로 다시 계산한다.
      const res = await fetch(`${base}${qs}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "publish" }),
      });
      const json = await res.json();
      if (!res.ok || !json.success) throw apiErrorFrom(res, json, `공표 실패 (${res.status})`);
      setPublished(json.data.published as PublishedDto);
      setPreview(null);
      pushToast("success", "공표되었습니다.");
      onChanged?.();
    } catch (e) {
      pushToast("error", getApiErrorMessage(e, "공표 실패"));
    } finally {
      setBusy(null);
    }
  };

  // [4] 공표 취소 — 모달 취소와 완전히 다른 업무 동작.
  const onUnpublish = async () => {
    const ok = await adminDialog.confirm({
      variant: "danger",
      title: "공표 취소",
      description:
        "해당 주차의 공표를 취소하시겠습니까? 취소하면 크루 페이지를 포함한 관련 화면에서 확정 결과가 더 이상 노출되지 않습니다.",
      confirmLabel: "공표 취소",
      cancelLabel: "돌아가기",
    });
    if (!ok) return;
    setBusy("unpublish");
    try {
      const res = await fetch(`${base}${qs}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "unpublish" }),
      });
      const json = await res.json();
      if (!res.ok || !json.success) throw apiErrorFrom(res, json, `공표 취소 실패 (${res.status})`);
      setPublished(null);
      pushToast("success", "공표가 취소되었습니다.");
      onChanged?.();
    } catch (e) {
      pushToast("error", getApiErrorMessage(e, "공표 취소 실패"));
    } finally {
      setBusy(null);
    }
  };

  // 버튼 상태표 — 진행 중에는 예비만 허용(공표는 서버도 422). 검수 완료면 공표 취소 가능.
  const canPublish = weekEnded && (preview != null || published != null) && busy == null;
  const canUnpublish = published != null && busy == null;

  return (
    <div className="admin-section-stack-lg" data-crew-week-publish>
      <div className="flex flex-wrap items-center gap-2">
        <Button type="button" onClick={onPreview} disabled={busy != null} data-action-preview>
          {busy === "preview" ? "계산 중…" : "클럽 활동 검수(예비)"}
        </Button>
        {preview ? (
          <Button type="button" variant="outline" onClick={onCancelPreview} data-action-preview-cancel>
            예비 검수 취소
          </Button>
        ) : null}
        <Button
          type="button"
          onClick={onPublish}
          disabled={!canPublish}
          data-action-publish
          title={weekEnded ? undefined : "진행 중인 주차는 공표할 수 없습니다."}
        >
          {published ? "클럽 활동 검수(재공표)" : "클럽 활동 검수(공표)"}
        </Button>
        {canUnpublish ? (
          <Button type="button" variant="destructive" onClick={onUnpublish} data-action-unpublish>
            공표 취소
          </Button>
        ) : null}
      </div>

      {/* [5] 주차 종합 인덱스 — 항상 렌더한다(최초 진입 = 전부 "-").
          표시 우선순위: ① 새 예비 결과 → ② 활성 공표 snapshot → ③ 둘 다 없으면 "-".
          예비와 공표를 **절대 섞지 않는다** — 배지와 제목으로 출처를 명시한다. */}
      <section className="rounded-lg border p-4" data-summary-index>
        <div className="mb-3 flex flex-wrap items-center gap-2">
          <strong className="text-base">이번 주 크루 종합 결과</strong>
          {preview ? (
            <>
              <StatusBadge label="집계 중" size="sm" />
              <span data-summary-source="preview" className="text-sm font-semibold">
                새 예비 결과
              </span>
              <span className="text-xs text-muted-foreground">
                계산 시각 {new Date(preview.calculatedAt).toLocaleString("ko-KR")} · 아직 공표되지 않았습니다.
              </span>
            </>
          ) : published ? (
            <>
              <StatusBadge label="검수 완료" size="sm" />
              <span data-summary-source="published" className="text-sm font-semibold">
                현재 공표 결과
              </span>
              <span className="text-xs text-muted-foreground">
                공표 시각 {new Date(published.publishedAt).toLocaleString("ko-KR")} · 결과 버전{" "}
                {published.calculationVersion} · run {published.runId.slice(0, 8)}
              </span>
            </>
          ) : (
            <span data-summary-source="none" className="text-xs text-muted-foreground">
              [클럽 활동 검수(예비)] 를 실행하면 결과가 표시됩니다.
            </span>
          )}
        </div>
        <MetricGrid
          m={preview ?? published}
          readiness={(preview ?? published)?.metricsReadiness ?? null}
        />
        {published && preview ? (
          <p className="mt-2 text-xs text-amber-800" data-summary-both>
            ⚠ 현재 공표 중인 결과와 새 예비 결과가 함께 존재합니다. 위 값은 <strong>새 예비 결과</strong>이며
            아직 공표되지 않았습니다. 공표 결과는 아래에서 확인하세요.
          </p>
        ) : null}
      </section>

      {/* 공표 중인 결과(크루 행 포함) — 예비와 별도 블록. */}
      {published ? (
        <section className="rounded-lg border border-emerald-300 bg-emerald-50/40 p-4" data-published-block>
          <div className="mb-2 flex flex-wrap items-center gap-2">
            <StatusBadge label="검수 완료" size="sm" />
            <strong>현재 공표 결과</strong>
            <span className="text-xs text-muted-foreground">
              공표 시각 {new Date(published.publishedAt).toLocaleString("ko-KR")} · run{" "}
              {published.runId.slice(0, 8)}
            </span>
          </div>
          {published.snapshotUnavailable ? (
            <p className="text-sm text-amber-800">
              이 공표본은 snapshot 이전에 생성되어 확정 지표를 표시할 수 없습니다(legacy).
            </p>
          ) : (
            <CrewTable rows={published.crewResults} />
          )}
        </section>
      ) : null}

      {/* 예비 결과(크루 행) */}
      {preview ? (
        <section className="rounded-lg border border-dashed border-violet-300 bg-violet-50/40 p-4" data-preview-block>
          <div className="mb-2 flex flex-wrap items-center gap-2">
            <StatusBadge label="집계 중" size="sm" />
            <strong>예비 결과</strong>
            <span className="text-xs text-muted-foreground">
              계산 시각 {new Date(preview.calculatedAt).toLocaleString("ko-KR")} · 아직 공표되지 않음
            </span>
          </div>
          <CrewTable rows={preview.crewResults} />
        </section>
      ) : null}

      {!published && !preview ? (
        <p className="text-sm text-muted-foreground">
          [클럽 활동 검수(예비)] 를 눌러 현재 누적 데이터 기준 결과를 확인할 수 있습니다.
          {displayStatus === "in_progress"
            ? " 진행 중인 주차는 공표할 수 없습니다."
            : null}
        </p>
      ) : null}
    </div>
  );
}
