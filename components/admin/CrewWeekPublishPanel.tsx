"use client";

import { useCallback, useEffect, useState } from "react";
import { useSearchParams } from "next/navigation";
import { Button } from "@/components/ui/button";
import { StatusBadge } from "@/components/ui/status-badge";
import { adminDialog } from "@/components/ui/admin-dialog";
import { pushToast } from "@/components/ui/toast";
import { readScopeMode } from "@/lib/userScopeShared";
import { apiErrorFrom, getApiErrorMessage } from "@/lib/apiError";
import {
  ORGANIZATION_ACCENT,
  ORGANIZATION_COLUMN,
  ORGANIZATION_TEXT_CLASS,
  type OrganizationSlug,
} from "@/lib/organizations";
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

// 지표 의미색 — 조직색(페이지 테마)과 **역할이 다르다**. 성공=green·실패=red·도전=blue·휴식=gray.
//   조직색은 아래 org 프롭으로 "소속 크루" 카드와 강조선에만 쓴다.
type Tone = "org" | "gray" | "blue" | "green" | "red";

const TONE_CLS: Record<Exclude<Tone, "org">, { card: string; value: string; bar: string }> = {
  gray: { card: "border-zinc-300 bg-zinc-50/70", value: "text-zinc-700", bar: "bg-zinc-400" },
  blue: { card: "border-sky-300 bg-sky-50/70", value: "text-sky-700", bar: "bg-sky-500" },
  green: { card: "border-emerald-300 bg-emerald-50/70", value: "text-emerald-700", bar: "bg-emerald-500" },
  red: { card: "border-rose-300 bg-rose-50/70", value: "text-rose-700", bar: "bg-rose-500" },
};

function MetricCard({
  label,
  value,
  unit,
  readiness,
  tone,
  org,
}: {
  label: string;
  value: number | null;
  unit: "명" | "%";
  readiness: "ready" | "partial" | "unavailable";
  tone: Tone;
  org: OrganizationSlug;
}) {
  const cls =
    tone === "org"
      ? {
          card: `${ORGANIZATION_COLUMN[org].edge} ${ORGANIZATION_COLUMN[org].cell}`,
          value: ORGANIZATION_TEXT_CLASS[org],
          bar: "",
        }
      : TONE_CLS[tone];
  return (
    <div className={`rounded-lg border-2 px-3 py-4 text-center ${cls.card}`}>
      <div className="text-sm font-semibold text-muted-foreground">{label}</div>
      <div
        className={`mt-1 text-3xl font-extrabold tabular-nums ${cls.value}`}
        data-metric={label}
        data-readiness={readiness}
        title={value === null ? "아직 집계되지 않았습니다(계산 불가). 실제 0과 다릅니다." : undefined}
      >
        {formatMetric(value, unit)}
      </div>
    </div>
  );
}

// 비율 카드 — 큰 숫자 + progress bar. null 이면 bar 를 0 처럼 보이게 하지 않는다.
function RateCard({
  label,
  value,
  readiness,
  tone,
}: {
  label: string;
  value: number | null;
  readiness: "ready" | "partial" | "unavailable";
  tone: "green" | "blue";
}) {
  const cls = TONE_CLS[tone];
  const isNull = value === null;
  return (
    <div className={`rounded-xl border-2 px-5 py-5 ${cls.card}`}>
      <div className="flex items-baseline justify-between gap-3">
        <span className="text-base font-bold text-muted-foreground">{label}</span>
        <span
          className={`text-4xl font-extrabold tabular-nums ${cls.value}`}
          data-metric={label}
          data-readiness={readiness}
          title={isNull ? "아직 집계되지 않았습니다(계산 불가). 실제 0과 다릅니다." : undefined}
        >
          {formatMetric(value, "%")}
        </span>
      </div>
      <div
        className="mt-3 h-3 w-full overflow-hidden rounded-full bg-white/70"
        role="progressbar"
        aria-label={label}
        // null 은 값 미정 — aria-valuenow 를 0 으로 지어내지 않는다.
        aria-valuenow={isNull ? undefined : value}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuetext={isNull ? "집계되지 않음" : `${value}%`}
        data-bar-empty={isNull ? "true" : "false"}
      >
        {isNull ? (
          <div className="h-full w-full bg-[repeating-linear-gradient(45deg,transparent,transparent_6px,rgba(0,0,0,.06)_6px,rgba(0,0,0,.06)_12px)]" />
        ) : (
          <div className={`h-full ${cls.bar}`} style={{ width: `${value}%` }} />
        )}
      </div>
    </div>
  );
}

// [5] 주차 종합 결과 — 상단 비율 2열 + 하단 크루(3×2) | 팀(준비 중) 2그룹.
function SummaryIndex({
  m,
  readiness,
  org,
}: {
  m: Metrics | null;
  readiness: Readiness | null;
  org: OrganizationSlug;
}) {
  const v = (k: keyof Readiness) =>
    m ? ((m as unknown as Record<string, number | null>)[k] ?? null) : null;
  const r = (k: keyof Readiness) => readiness?.[k] ?? "unavailable";

  const crew: Array<[keyof Readiness, string, Tone]> = [
    ["memberCount", "소속 크루", "org"],
    ["seasonRestCount", "시즌 휴식", "gray"],
    ["personalRestCount", "개인 휴식", "gray"],
    ["growthChallengeCount", "성장 도전", "blue"],
    ["growthSuccessCount", "성장 성공", "green"],
    ["growthFailureCount", "성장 실패", "red"],
  ];

  return (
    <div className="space-y-6" data-metric-grid>
      {/* 상단 — 성장 성공률 | 성장 도전율 (1행 2열) */}
      <div className="grid gap-4 sm:grid-cols-2">
        <RateCard
          label="성장 성공률"
          value={v("growthSuccessRatePercent")}
          readiness={r("growthSuccessRatePercent")}
          tone="green"
        />
        <RateCard
          label="성장 도전율"
          value={v("growthChallengeRatePercent")}
          readiness={r("growthChallengeRatePercent")}
          tone="blue"
        />
      </div>

      {/* 하단 — 크루 활동 결과 | 팀 활동 결과 */}
      <div className="grid gap-6 lg:grid-cols-2">
        <section data-group="crew">
          <h3 className="mb-2 text-lg font-bold">크루 활동 결과</h3>
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
            {crew.map(([key, label, tone]) => (
              <MetricCard
                key={key}
                label={label}
                value={v(key)}
                unit="명"
                readiness={r(key)}
                tone={tone}
                org={org}
              />
            ))}
          </div>
        </section>

        <section data-group="team">
          <h3 className="mb-2 flex items-center gap-2 text-lg font-bold">
            팀 활동 결과
            <StatusBadge label="준비 중" size="sm" tone="neutral" />
          </h3>
          {/* ⚠ 팀 지표는 SoT 미확정 — 0 을 표시하거나 크루 데이터에서 유추하지 않는다. */}
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
            {["팀 수", "파트 수"].map((label) => (
              <div
                key={label}
                className="rounded-lg border-2 border-zinc-200 bg-zinc-50/60 px-3 py-4 text-center"
              >
                <div className="text-sm font-semibold text-muted-foreground">{label}</div>
                <div className="mt-1 text-3xl font-extrabold text-zinc-400" data-team-metric={label}>
                  -
                </div>
              </div>
            ))}
            {/* 전적 — 2행을 세로로 차지 */}
            <div className="sm:row-span-2 flex flex-col items-center justify-center rounded-lg border-2 border-dashed border-zinc-300 bg-zinc-50/60 px-3 py-4 text-center">
              <div className="text-sm font-semibold text-muted-foreground">전적</div>
              <div className="mt-1 text-base font-bold text-zinc-400" data-team-metric="전적">
                준비 중
              </div>
            </div>
            {["승리 팀 수", "패배 팀 수"].map((label) => (
              <div
                key={label}
                className="rounded-lg border-2 border-zinc-200 bg-zinc-50/60 px-3 py-4 text-center"
              >
                <div className="text-sm font-semibold text-muted-foreground">{label}</div>
                <div className="mt-1 text-3xl font-extrabold text-zinc-400" data-team-metric={label}>
                  -
                </div>
              </div>
            ))}
          </div>
        </section>
      </div>
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
  criterionPointA,
  weekEnded,
  onChanged,
}: {
  /** 주차 확정 기준 포인트 A(좌측 상태 열에 표시). */
  criterionPointA?: number | null;
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
    <div className="admin-section-stack-lg min-w-0" data-crew-week-publish>
      {/* [2]+[3][4] — 데스크톱에서 한 행 2열: 좌=진행 상태·기준 Po.A / 우=버튼 2행 1열. */}
      <div className="grid min-w-0 gap-5 lg:grid-cols-[minmax(0,1fr)_18rem]">
        <div className="min-w-0 space-y-3">
          <nav aria-label="검수 진행 상태" className="flex flex-wrap items-center gap-2" data-review-steps>
            {(
              [
                ["in_progress", "진행 중"],
                ["aggregating", "집계 중"],
                ["completed", "검수 완료"],
              ] as const
            ).map(([key, label], i) => {
              const active = displayStatus === key;
              return (
                <span key={key} className="flex items-center gap-2">
                  {i > 0 ? <span aria-hidden className="text-muted-foreground">···</span> : null}
                  <span
                    aria-current={active ? "step" : undefined}
                    data-step={key}
                    data-active={active ? "true" : "false"}
                    className={
                      "rounded-lg border-2 px-3 py-2 text-base font-bold sm:px-5 sm:py-3 sm:text-lg " +
                      (active
                        ? `${ORGANIZATION_ACCENT[organizationSlug].solid}`
                        : "border-input text-muted-foreground")
                    }
                  >
                    {/* 색만으로 상태를 표현하지 않는다 — 현재 단계에 텍스트 마커를 함께 준다. */}
                    {label}
                    {active ? <span className="ml-1 text-xs sm:text-sm">(현재)</span> : null}
                  </span>
                </span>
              );
            })}
          </nav>
          <div className="flex flex-wrap items-center gap-3 rounded-lg border-2 px-4 py-3 sm:inline-flex sm:px-5">
            <span className="text-sm font-semibold text-muted-foreground sm:text-base">
              주차 &lt;성장 성공&gt; 단감 기준
            </span>
            <strong className="text-3xl font-extrabold tabular-nums" data-criterion-point-a>
              {criterionPointA ?? "-"}
            </strong>
          </div>
        </div>

        {/* 버튼 2행 1열 · 동일 너비 · 크게 */}
        <div className="grid min-w-0 content-start gap-3">
          <Button
            type="button"
            onClick={onPreview}
            disabled={busy != null}
            data-action-preview
            className={`h-13 w-full py-3 text-base font-bold ${ORGANIZATION_ACCENT[organizationSlug].button}`}
          >
            {busy === "preview" ? "계산 중…" : "클럽 활동 검수(예비)"}
          </Button>
          {canUnpublish ? (
            <Button
              type="button"
              variant="destructive"
              onClick={onUnpublish}
              data-action-unpublish
              className="h-13 w-full py-3 text-base font-bold"
            >
              공표 취소
            </Button>
          ) : (
            <Button
              type="button"
              onClick={onPublish}
              disabled={!canPublish}
              data-action-publish
              title={weekEnded ? undefined : "진행 중인 주차는 공표할 수 없습니다."}
              className={`h-13 w-full py-3 text-base font-bold ${ORGANIZATION_ACCENT[organizationSlug].button}`}
            >
              {published ? "클럽 활동 검수(재공표)" : "클럽 활동 검수(공표)"}
            </Button>
          )}
          {preview ? (
            <Button
              type="button"
              variant="outline"
              onClick={onCancelPreview}
              data-action-preview-cancel
              className="w-full text-base font-semibold"
            >
              예비 검수 취소
            </Button>
          ) : null}
          {canUnpublish && (preview != null || published != null) && weekEnded ? (
            <Button
              type="button"
              variant="outline"
              onClick={onPublish}
              disabled={!canPublish}
              data-action-publish
              className="w-full text-base font-semibold"
            >
              재공표
            </Button>
          ) : null}
        </div>
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
        <SummaryIndex
          m={preview ?? published}
          readiness={(preview ?? published)?.metricsReadiness ?? null}
          org={organizationSlug}
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
