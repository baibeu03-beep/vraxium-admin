"use client";

// /admin/processes/register — 통합 > 허브별 프로세스 > 프로세스 등록 (마스터 카탈로그 Phase).
//
// 액트/라인급 "마스터"만 등록한다 (POST /api/admin/processes/{line-groups,acts}).
// 사용자 수행기록 · user_weekly_points 자동 합산 · 주차 성장 계산 · snapshot · checkGate 판정은
// 일절 건드리지 않는다 — point.check 를 "정의"하는 카탈로그이며 계산 반영은 별도 Phase.
//
// 3단 구조: 허브급(탭 자체가 값) → 라인급(칩, 최대 12개) → 액트(폼 등록).

import { useCallback, useEffect, useState } from "react";
import { Loader2, X } from "lucide-react";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import {
  PROCESS_ACT_TYPE_LABEL,
  PROCESS_ACT_TYPE_OPTIONS,
  PROCESS_CAFE_LABEL,
  PROCESS_CAFE_OPTIONS,
  PROCESS_CHECK_TARGET_LABEL,
  PROCESS_CHECK_TARGET_OPTIONS,
  PROCESS_DOW_LABELS,
  PROCESS_DURATION_OPTIONS,
  PROCESS_HUBS,
  PROCESS_HUB_LABEL,
  PROCESS_LINE_GROUP_MAX,
  PROCESS_NAME_MAX,
  PROCESS_POINT_OPTIONS,
  PROCESS_TIME_OPTIONS,
  PROCESS_WEEK_REFS,
  PROCESS_WEEK_REF_LABEL,
  type ProcessActDto,
  type ProcessActType,
  type ProcessCafe,
  type ProcessCheckTarget,
  type ProcessHub,
  type ProcessLineGroupDto,
  type ProcessWeekRef,
} from "@/lib/adminProcessesTypes";

type Banner = { kind: "success" | "error"; message: string } | null;

const SELECT_CLS =
  "h-9 w-full rounded-md border border-input bg-background px-3 text-sm disabled:cursor-not-allowed disabled:opacity-60";

function FormRow({
  label,
  required,
  children,
  alignTop,
}: {
  label: string;
  required?: boolean;
  children: React.ReactNode;
  alignTop?: boolean;
}) {
  return (
    <div
      className={cn(
        "grid grid-cols-[96px_minmax(0,1fr)] gap-3",
        alignTop ? "items-start" : "items-center",
      )}
    >
      <Label className={cn("text-sm text-foreground", alignTop && "pt-2")}>
        {label}
        {required && <span className="ml-0.5 text-red-500">*</span>}
      </Label>
      <div className="min-w-0">{children}</div>
    </div>
  );
}

// 주/요일/시간 3종 묶음 입력 (신청 시점 · 검수 시점 공용).
function WhenInput({
  week,
  dow,
  time,
  onWeek,
  onDow,
  onTime,
  disabled,
  idPrefix,
}: {
  week: ProcessWeekRef;
  dow: number;
  time: string;
  onWeek: (v: ProcessWeekRef) => void;
  onDow: (v: number) => void;
  onTime: (v: string) => void;
  disabled?: boolean;
  idPrefix: string;
}) {
  return (
    <div className="grid grid-cols-3 gap-2">
      <select
        aria-label={`${idPrefix} 주`}
        className={SELECT_CLS}
        value={week}
        onChange={(e) => onWeek(e.target.value as ProcessWeekRef)}
        disabled={disabled}
      >
        {PROCESS_WEEK_REFS.map((w) => (
          <option key={w} value={w}>
            {PROCESS_WEEK_REF_LABEL[w]}
          </option>
        ))}
      </select>
      <select
        aria-label={`${idPrefix} 요일`}
        className={SELECT_CLS}
        value={dow}
        onChange={(e) => onDow(Number(e.target.value))}
        disabled={disabled}
      >
        {PROCESS_DOW_LABELS.map((d, i) => (
          <option key={i} value={i}>
            {d}
          </option>
        ))}
      </select>
      <select
        aria-label={`${idPrefix} 시간`}
        className={SELECT_CLS}
        value={time}
        onChange={(e) => onTime(e.target.value)}
        disabled={disabled}
      >
        {PROCESS_TIME_OPTIONS.map((t) => (
          <option key={t} value={t}>
            {t}
          </option>
        ))}
      </select>
    </div>
  );
}

export default function ProcessRegisterManager() {
  const [activeHub, setActiveHub] = useState<ProcessHub>("club");
  const [banner, setBanner] = useState<Banner>(null);

  // ── 허브 데이터 ──
  const [lineGroups, setLineGroups] = useState<ProcessLineGroupDto[]>([]);
  const [acts, setActs] = useState<ProcessActDto[]>([]);
  const [loading, setLoading] = useState(false);

  // ── 라인급 등록/삭제 ──
  const [newGroupName, setNewGroupName] = useState("");
  const [addingGroup, setAddingGroup] = useState(false);

  // ── 액트 폼 ──
  const [actName, setActName] = useState("");
  const [lineGroupId, setLineGroupId] = useState<string>("");
  const [duration, setDuration] = useState<number>(PROCESS_DURATION_OPTIONS[0]);
  const [occurWeek, setOccurWeek] = useState<ProcessWeekRef>("N");
  const [occurDow, setOccurDow] = useState(0);
  const [occurTime, setOccurTime] = useState(PROCESS_TIME_OPTIONS[0]);
  const [checkWeek, setCheckWeek] = useState<ProcessWeekRef>("N");
  const [checkDow, setCheckDow] = useState(0);
  const [checkTime, setCheckTime] = useState(PROCESS_TIME_OPTIONS[0]);
  const [pointCheck, setPointCheck] = useState(0);
  const [pointAdvantage, setPointAdvantage] = useState(0);
  const [pointPenalty, setPointPenalty] = useState(0);
  const [cafe, setCafe] = useState<ProcessCafe>("occur");
  const [checkTarget, setCheckTarget] = useState<ProcessCheckTarget>("check");
  const [actType, setActType] = useState<ProcessActType>("required");
  const [overview, setOverview] = useState("");
  const [remarks, setRemarks] = useState("");
  const [saving, setSaving] = useState(false);

  // 액트 폼만 초기화 — 라인급/허브는 유지 (DB 통신 없음).
  const resetActForm = useCallback(() => {
    setActName("");
    setLineGroupId("");
    setDuration(PROCESS_DURATION_OPTIONS[0]);
    setOccurWeek("N");
    setOccurDow(0);
    setOccurTime(PROCESS_TIME_OPTIONS[0]);
    setCheckWeek("N");
    setCheckDow(0);
    setCheckTime(PROCESS_TIME_OPTIONS[0]);
    setPointCheck(0);
    setPointAdvantage(0);
    setPointPenalty(0);
    setCafe("occur");
    setCheckTarget("check");
    setActType("required");
    setOverview("");
    setRemarks("");
  }, []);

  const loadHub = useCallback(async (hub: ProcessHub) => {
    setLoading(true);
    try {
      const [gRes, aRes] = await Promise.all([
        fetch(`/api/admin/processes/line-groups?hub=${hub}`),
        fetch(`/api/admin/processes/acts?hub=${hub}`),
      ]);
      const gJson = await gRes.json().catch(() => ({}));
      const aJson = await aRes.json().catch(() => ({}));
      if (!gRes.ok || !gJson.success) {
        throw new Error(gJson.error || `라인급 조회 실패 (HTTP ${gRes.status})`);
      }
      setLineGroups((gJson.data ?? []) as ProcessLineGroupDto[]);
      setActs(aRes.ok && aJson.success ? ((aJson.data ?? []) as ProcessActDto[]) : []);
    } catch (err) {
      setLineGroups([]);
      setActs([]);
      setBanner({
        kind: "error",
        message: err instanceof Error ? err.message : "데이터 조회에 실패했습니다",
      });
    } finally {
      setLoading(false);
    }
  }, []);

  // 허브 전환 시 데이터 재조회 + 액트 폼 초기화.
  useEffect(() => {
    void loadHub(activeHub);
    resetActForm();
    setNewGroupName("");
  }, [activeHub, loadHub, resetActForm]);

  const handleTabChange = useCallback((hub: ProcessHub) => {
    setBanner(null);
    setActiveHub(hub);
  }, []);

  const handleAddGroup = useCallback(async () => {
    const name = newGroupName.trim();
    if (!name) {
      setBanner({ kind: "error", message: "라인급명을 입력해주세요" });
      return;
    }
    if (lineGroups.length >= PROCESS_LINE_GROUP_MAX) {
      setBanner({
        kind: "error",
        message: `라인급은 최대 ${PROCESS_LINE_GROUP_MAX}개까지 등록할 수 있습니다`,
      });
      return;
    }
    setAddingGroup(true);
    setBanner(null);
    try {
      const res = await fetch("/api/admin/processes/line-groups", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ hub: activeHub, name }),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok || !json.success) {
        throw new Error(json.error || `HTTP ${res.status}`);
      }
      setNewGroupName("");
      await loadHub(activeHub);
      setBanner({ kind: "success", message: `라인급 "${name}" 이(가) 등록되었습니다` });
    } catch (err) {
      setBanner({
        kind: "error",
        message: err instanceof Error ? err.message : "라인급 등록에 실패했습니다",
      });
    } finally {
      setAddingGroup(false);
    }
  }, [activeHub, newGroupName, lineGroups.length, loadHub]);

  const handleDeleteGroup = useCallback(
    async (group: ProcessLineGroupDto) => {
      // 산하 액트가 있으면 서버가 409 로 차단 — 클라이언트에서도 사전 안내.
      if (group.actCount > 0) {
        window.alert(
          "산하 등록된 액트가 존재합니다.\n\n산하 등록된 액트가 없어야, 이 라인 급을 삭제할 수 있습니다.\n\n액트 삭제는 통합 > 허브별 프로세스 > 프로세스 정보 에서 진행해주세요.",
        );
        return;
      }
      if (!window.confirm(`라인급 "${group.name}" 을(를) 삭제할까요?`)) return;
      setBanner(null);
      try {
        const res = await fetch(`/api/admin/processes/line-groups/${group.id}`, {
          method: "DELETE",
        });
        const json = await res.json().catch(() => ({}));
        if (!res.ok || !json.success) {
          // 409 = 산하 액트 존재 (경합 시) — 서버 문구를 그대로 노출.
          if (res.status === 409) {
            window.alert(json.error || "산하 액트가 존재하여 삭제할 수 없습니다");
            await loadHub(activeHub);
            return;
          }
          throw new Error(json.error || `HTTP ${res.status}`);
        }
        if (lineGroupId === group.id) setLineGroupId("");
        await loadHub(activeHub);
        setBanner({ kind: "success", message: `라인급 "${group.name}" 이(가) 삭제되었습니다` });
      } catch (err) {
        setBanner({
          kind: "error",
          message: err instanceof Error ? err.message : "라인급 삭제에 실패했습니다",
        });
      }
    },
    [activeHub, lineGroupId, loadHub],
  );

  const handleSubmitAct = useCallback(async () => {
    if (!actName.trim()) {
      setBanner({ kind: "error", message: "액트명을 입력해주세요" });
      return;
    }
    if (!lineGroupId) {
      setBanner({ kind: "error", message: "소속 라인급을 선택해주세요" });
      return;
    }
    setSaving(true);
    setBanner(null);
    try {
      const res = await fetch("/api/admin/processes/acts", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          line_group_id: lineGroupId,
          hub: activeHub,
          act_name: actName.trim(),
          duration_minutes: duration,
          occur_week: occurWeek,
          occur_dow: occurDow,
          occur_time: occurTime,
          check_week: checkWeek,
          check_dow: checkDow,
          check_time: checkTime,
          point_check: pointCheck,
          point_advantage: pointAdvantage,
          point_penalty: pointPenalty,
          cafe,
          check_target: checkTarget,
          act_type: actType,
          overview: overview.trim() || null,
          remarks: remarks.trim() || null,
        }),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok || !json.success) {
        throw new Error(json.error || `HTTP ${res.status}`);
      }
      const saved = json.data as ProcessActDto;
      resetActForm();
      await loadHub(activeHub);
      setBanner({
        kind: "success",
        message: `액트가 등록되었습니다 (${saved.hubLabel} · ${saved.lineGroupName ?? "-"} · ${saved.actName})`,
      });
    } catch (err) {
      setBanner({
        kind: "error",
        message: err instanceof Error ? err.message : "액트 등록에 실패했습니다",
      });
    } finally {
      setSaving(false);
    }
  }, [
    activeHub, actName, lineGroupId, duration, occurWeek, occurDow, occurTime,
    checkWeek, checkDow, checkTime, pointCheck, pointAdvantage, pointPenalty,
    cafe, checkTarget, actType, overview, remarks, resetActForm, loadHub,
  ]);

  return (
    // 입력 폼 화면 — 전체 폭 대신 max-w-6xl(≈1152px) 중앙 정렬(테이블형 아님).
    // w-full 유지로 모바일/태블릿 반응형은 그대로(좌우 여백은 (portal) layout p-6).
    <div className="mx-auto flex w-full max-w-6xl flex-col gap-4">
      {/* 헤더 탭 (5개 허브급) */}
      <div className="flex flex-wrap gap-1 border-b">
        {PROCESS_HUBS.map((h) => (
          <button
            key={h}
            type="button"
            onClick={() => handleTabChange(h)}
            className={cn(
              "rounded-t-md px-4 py-2 text-sm font-medium transition-colors",
              activeHub === h
                ? "border-b-2 border-primary text-primary"
                : "text-muted-foreground hover:text-foreground",
            )}
          >
            {PROCESS_HUB_LABEL[h]} 급
          </button>
        ))}
      </div>

      {banner && (
        <div
          className={cn(
            "flex items-center justify-between rounded-md border px-3 py-2 text-sm",
            banner.kind === "success"
              ? "border-emerald-200 bg-emerald-50 text-emerald-800"
              : "border-rose-200 bg-rose-50 text-rose-800",
          )}
        >
          <span className="whitespace-pre-line">{banner.message}</span>
          <button type="button" onClick={() => setBanner(null)} className="hover:opacity-70">
            <X className="h-4 w-4" />
          </button>
        </div>
      )}

      <Card>
        <CardHeader>
          <CardTitle>프로세스 등록 — {PROCESS_HUB_LABEL[activeHub]} 급</CardTitle>
        </CardHeader>
        <CardContent className="space-y-6">
          {/* [1] 소속 허브급 — 탭 자체가 값 (표시만) */}
          <FormRow label="소속 허브급">
            <span className="inline-flex h-9 items-center rounded-md bg-muted px-3 text-sm font-medium">
              {PROCESS_HUB_LABEL[activeHub]} 급
            </span>
          </FormRow>

          {/* [2] 액트명 */}
          <FormRow label="액트명" required>
            <Input
              value={actName}
              onChange={(e) => setActName(e.target.value)}
              maxLength={PROCESS_NAME_MAX}
              placeholder="예) [브리핑] 클럽 시작"
            />
          </FormRow>

          {/* [3] 소속 라인급 — 등록 + 칩 목록(체크박스 단일 선택 + 삭제) */}
          <FormRow label="소속 라인급" required alignTop>
            <div className="space-y-3">
              <div className="flex gap-2">
                <Input
                  value={newGroupName}
                  onChange={(e) => setNewGroupName(e.target.value)}
                  maxLength={PROCESS_NAME_MAX}
                  placeholder={`라인급명 (최대 ${PROCESS_LINE_GROUP_MAX}개)`}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") {
                      e.preventDefault();
                      void handleAddGroup();
                    }
                  }}
                  disabled={addingGroup || lineGroups.length >= PROCESS_LINE_GROUP_MAX}
                />
                <Button
                  type="button"
                  variant="outline"
                  className="shrink-0"
                  onClick={() => void handleAddGroup()}
                  disabled={addingGroup || lineGroups.length >= PROCESS_LINE_GROUP_MAX}
                >
                  {addingGroup && <Loader2 className="mr-1.5 h-4 w-4 animate-spin" />}
                  등록
                </Button>
              </div>

              {loading ? (
                <p className="text-xs text-muted-foreground">불러오는 중...</p>
              ) : lineGroups.length === 0 ? (
                <p className="text-xs text-muted-foreground">
                  등록된 라인급이 없습니다. 위에서 먼저 라인급을 등록해주세요.
                </p>
              ) : (
                <div className="flex flex-wrap gap-2">
                  {lineGroups.map((g) => {
                    const selected = lineGroupId === g.id;
                    return (
                      <div
                        key={g.id}
                        className={cn(
                          "flex items-center gap-2 rounded-full border px-3 py-1.5 text-sm",
                          selected
                            ? "border-primary bg-primary/10"
                            : "border-border bg-background",
                        )}
                      >
                        <input
                          type="checkbox"
                          aria-label={`${g.name} 선택`}
                          checked={selected}
                          // 단일 선택 — 체크 시 해당 라인급, 해제 시 선택 없음.
                          onChange={() => setLineGroupId(selected ? "" : g.id)}
                        />
                        <span>{g.name}</span>
                        <span className="text-xs text-muted-foreground">
                          (액트 {g.actCount})
                        </span>
                        <button
                          type="button"
                          aria-label={`${g.name} 삭제`}
                          className="text-muted-foreground hover:text-red-500"
                          onClick={() => void handleDeleteGroup(g)}
                        >
                          <X className="h-3.5 w-3.5" />
                        </button>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          </FormRow>

          {/* [4] 소요 시간 */}
          <FormRow label="소요 시간" required>
            <select
              aria-label="소요 시간"
              className={cn(SELECT_CLS, "max-w-[160px]")}
              value={duration}
              onChange={(e) => setDuration(Number(e.target.value))}
            >
              {PROCESS_DURATION_OPTIONS.map((m) => (
                <option key={m} value={m}>
                  {m}m
                </option>
              ))}
            </select>
          </FormRow>

          {/* [5] 신청 시점 */}
          <FormRow label="신청 시점" required>
            <WhenInput
              week={occurWeek}
              dow={occurDow}
              time={occurTime}
              onWeek={setOccurWeek}
              onDow={setOccurDow}
              onTime={setOccurTime}
              idPrefix="발생"
            />
          </FormRow>

          {/* [6] 검수 시점 */}
          <FormRow label="검수 시점" required>
            <WhenInput
              week={checkWeek}
              dow={checkDow}
              time={checkTime}
              onWeek={setCheckWeek}
              onDow={setCheckDow}
              onTime={setCheckTime}
              idPrefix="체크"
            />
          </FormRow>

          {/* [7] 포인트 — A check / B advantage / C penalty (0~20) */}
          <FormRow label="포인트" required alignTop>
            <div className="grid grid-cols-3 gap-2">
              {(
                [
                  { label: "A · point.check", value: pointCheck, set: setPointCheck },
                  { label: "B · point.advantage", value: pointAdvantage, set: setPointAdvantage },
                  { label: "C · point.penalty", value: pointPenalty, set: setPointPenalty },
                ] as const
              ).map((p) => (
                <div key={p.label} className="space-y-1">
                  <span className="text-xs text-muted-foreground">{p.label}</span>
                  <select
                    aria-label={p.label}
                    className={SELECT_CLS}
                    value={p.value}
                    onChange={(e) => p.set(Number(e.target.value))}
                  >
                    {PROCESS_POINT_OPTIONS.map((n) => (
                      <option key={n} value={n}>
                        {n}
                      </option>
                    ))}
                  </select>
                </div>
              ))}
            </div>
          </FormRow>

          {/* [8] 카페 | [9] 체크 대상 | [10] 액트 종류 */}
          <div className="grid grid-cols-1 gap-x-8 gap-y-4 lg:grid-cols-3">
            <FormRow label="카페" required>
              <select
                aria-label="카페"
                className={SELECT_CLS}
                value={cafe}
                onChange={(e) => setCafe(e.target.value as ProcessCafe)}
              >
                {PROCESS_CAFE_OPTIONS.map((c) => (
                  <option key={c} value={c}>
                    {PROCESS_CAFE_LABEL[c]}
                  </option>
                ))}
              </select>
            </FormRow>
            <FormRow label="체크 대상" required>
              <select
                aria-label="체크 대상"
                className={SELECT_CLS}
                value={checkTarget}
                onChange={(e) => setCheckTarget(e.target.value as ProcessCheckTarget)}
              >
                {PROCESS_CHECK_TARGET_OPTIONS.map((c) => (
                  <option key={c} value={c}>
                    {PROCESS_CHECK_TARGET_LABEL[c]}
                  </option>
                ))}
              </select>
            </FormRow>
            <FormRow label="액트 종류" required>
              <select
                aria-label="액트 종류"
                className={SELECT_CLS}
                value={actType}
                onChange={(e) => setActType(e.target.value as ProcessActType)}
              >
                {PROCESS_ACT_TYPE_OPTIONS.map((t) => (
                  <option key={t} value={t}>
                    {PROCESS_ACT_TYPE_LABEL[t]}
                  </option>
                ))}
              </select>
            </FormRow>
          </div>

          {/* [11] 개요 */}
          <FormRow label="개요" alignTop>
            <textarea
              aria-label="개요"
              className="min-h-[96px] w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
              value={overview}
              onChange={(e) => setOverview(e.target.value)}
              placeholder="액트 개요 (150자 이상 권장, 제한은 엄격하지 않음)"
            />
          </FormRow>

          {/* [12] 비고 */}
          <FormRow label="비고" alignTop>
            <textarea
              aria-label="비고"
              className="min-h-[96px] w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
              value={remarks}
              onChange={(e) => setRemarks(e.target.value)}
              placeholder="비고"
            />
          </FormRow>

          {/* 버튼 — 초기화(로컬만) · 등록(DB 저장) */}
          <div className="flex items-center justify-end gap-2 border-t pt-4">
            <Button type="button" onClick={() => void handleSubmitAct()} disabled={saving}>
              {saving && <Loader2 className="mr-1.5 h-4 w-4 animate-spin" />}
              등록
            </Button>
            <Button
              type="button"
              variant="outline"
              onClick={resetActForm}
              disabled={saving}
            >
              초기화
            </Button>
          </div>
        </CardContent>
      </Card>

      {/* 등록된 액트 (확인용) — 본 허브급 산하 */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">
            등록된 액트 — {PROCESS_HUB_LABEL[activeHub]} 급 ({acts.length})
          </CardTitle>
        </CardHeader>
        <CardContent>
          {loading ? (
            <p className="text-sm text-muted-foreground">불러오는 중...</p>
          ) : acts.length === 0 ? (
            <p className="text-sm text-muted-foreground">등록된 액트가 없습니다.</p>
          ) : (
            <div className="space-y-1.5">
              {acts.map((a) => (
                <div
                  key={a.id}
                  className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-md border px-3 py-2 text-sm"
                >
                  <span className="font-medium">{a.actName}</span>
                  <span className="text-xs text-muted-foreground">
                    [{a.lineGroupName ?? "-"}] · {PROCESS_ACT_TYPE_LABEL[a.actType]} ·{" "}
                    {a.durationMinutes}m · A{a.pointCheck}/B{a.pointAdvantage}/C{a.pointPenalty}
                  </span>
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
