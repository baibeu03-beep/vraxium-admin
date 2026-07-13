"use client";

// 라인 정보 목록 — "수정" 모달.
//   기존 수정 흐름을 그대로 재사용한다(신규 API/DTO 없음):
//     · 라인 필드(라인명/종류/코드/유닛/메인타이틀/조직/활성/info 포인트연결키)
//       → PATCH /api/admin/lines/registrations/[id] (parseLineRegistrationPatchBody · mirror sync · 게이트)
//     · Point.A/B → PUT /api/admin/lines/point-configs (cluster4_line_point_configs · 라인 등록 폼과 동일 SoT)
//   프리필 = 목록 행 DTO(즉시) + GET /[id] 상세(openedLineCount 게이트).
//   소속 허브 변경 금지(설계) · 라인코드/조직/(exp)종류 = 개설 라인 0건일 때만(openedLineCount 게이트).
//   mode/org/actAsTestUserId/demoUserId 무분기 — 위 API 는 admin 컨텍스트로 스코프(동일 DTO·동일 경로).

import { useCallback, useEffect, useState } from "react";
import { Loader2, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { cn } from "@/lib/utils";
import {
  experienceActivityTypeForLineType,
  EXPERIENCE_LINETYPE_TO_CONFIG_KEY,
  LINE_REGISTRATION_HUB_LABEL,
  LINE_REGISTRATION_LINE_TYPES,
  LINE_REGISTRATION_ORGS,
  LINE_REGISTRATION_ORG_LABEL,
  VARIABLE_MAIN_TITLE_NOTICE,
  type LineRegistrationDto,
  type LineRegistrationMainTitleMode,
} from "@/lib/adminLineRegistrationsTypes";

// 강화 포인트 select(0~20 + 미설정""). 라인 등록 폼과 동일.
const POINT_SELECT_OPTIONS: string[] = ["", ...Array.from({ length: 21 }, (_, i) => String(i))];

// 실무 정보 포인트 대상 활동유형(config_key = activity_types.id) — 라인 등록 폼과 동일 목록.
const INFO_ACTIVITY_TYPES: ReadonlyArray<{ id: string; label: string }> = [
  { id: "wisdom", label: "위즈덤" },
  { id: "essay", label: "에세이" },
  { id: "infodesk", label: "인포데스크" },
  { id: "calendar", label: "캘린더" },
  { id: "forum", label: "포럼" },
  { id: "session", label: "세션" },
  { id: "practical_lecture", label: "아카데미" },
  { id: "community", label: "커뮤니티" },
  { id: "etc_a", label: "기타A" },
];

// 라인 1건 → Point config_key 도출(deriveLineConfigKey 와 동일 규칙 — 서버 SoT 미러).
//   info=활동유형 id · experience=line_type→카테고리 · competency=line_code · career=null.
//   experience 매핑 SoT = adminLineRegistrationsTypes.EXPERIENCE_LINETYPE_TO_CONFIG_KEY.
function deriveConfigKey(
  hub: LineRegistrationDto["hub"],
  lineType: string,
  lineCode: string,
  pointActivityTypeId: string,
): string | null {
  if (hub === "competency") return lineCode.trim() || null;
  if (hub === "career") return lineCode.trim() || null; // career=line_code(역량과 동일, 2026-07-13)
  if (hub === "experience") return EXPERIENCE_LINETYPE_TO_CONFIG_KEY[lineType] ?? null;
  if (hub === "info") return pointActivityTypeId.trim() || null;
  return null;
}

type DetailDto = LineRegistrationDto & { openedLineCount: number };

export default function LineRegistrationEditModal({
  row,
  onClose,
  onSaved,
}: {
  row: LineRegistrationDto; // 목록 행(즉시 프리필)
  onClose: () => void;
  onSaved: (message: string) => void;
}) {
  const [detail, setDetail] = useState<DetailDto | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const isInfo = row.hub === "info";
  const isExperience = row.hub === "experience";
  // career 는 이 목록에 없으나 방어적으로 포인트/게이트만 비활성.
  const isCareer = row.hub === "career";

  // ── 폼 상태(프리필 = 목록 행) ──
  const [lineName, setLineName] = useState(row.lineName);
  const [lineType, setLineType] = useState(row.lineType);
  const [lineCode, setLineCode] = useState(row.lineCode);
  const [orgSlug, setOrgSlug] = useState(row.organizationSlug ?? "");
  const [unitLink, setUnitLink] = useState(row.unitLink === "-" ? "" : row.unitLink);
  const [mainTitleMode, setMainTitleMode] = useState<LineRegistrationMainTitleMode>(row.mainTitleMode);
  const [mainTitle, setMainTitle] = useState(row.mainTitle === "-" ? "" : row.mainTitle);
  const [isActive, setIsActive] = useState(row.isActive);
  const [pointActivityTypeId, setPointActivityTypeId] = useState(row.pointActivityTypeId ?? "");
  const [pointA, setPointA] = useState(row.pointA === null ? "" : String(row.pointA));
  const [pointB, setPointB] = useState(row.pointB === null ? "" : String(row.pointB));

  const opened = detail?.openedLineCount ?? 0;
  const gateLocked = opened > 0; // 라인코드/조직 · (exp)라인종류 잠금

  // 상세 로드 — 게이트(openedLineCount)/권한 확인용. 필드값은 목록 행으로 이미 프리필됨.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoading(true);
      setLoadError(null);
      try {
        const res = await fetch(`/api/admin/lines/registrations/${row.id}`, { cache: "no-store" });
        const json = await res.json().catch(() => ({}));
        if (!res.ok || !json.success) {
          throw new Error((json && typeof json.error === "string" && json.error) || `HTTP ${res.status}`);
        }
        if (!cancelled) setDetail(json.data as DetailDto);
      } catch (err) {
        if (!cancelled) setLoadError(err instanceof Error ? err.message : "상세를 불러오지 못했습니다");
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [row.id]);

  const lineTypeOptions = LINE_REGISTRATION_LINE_TYPES[row.hub] ?? [row.lineType];

  const handleSave = useCallback(async () => {
    setError(null);
    if (!lineName.trim()) {
      setError("라인명을 입력해주세요");
      return;
    }
    if (!lineCode.trim()) {
      setError("라인 코드를 입력해주세요");
      return;
    }
    if (mainTitleMode === "fixed" && !mainTitle.trim()) {
      setError("메인 타이틀을 입력해주세요 (변동이면 '변동'을 선택)");
      return;
    }
    // 소속 클럽 필수(2026-07-13) — 레거시 null 행도 조회/진입은 되지만 저장 시 유효 org 를 요구.
    if (!orgSlug) {
      setError("소속 클럽을 선택해주세요 (필수)");
      return;
    }

    // ── 라인 필드 부분 수정(PATCH) — 변경된 필드만. 허브는 전송하지 않음(수정 금지). ──
    const patch: Record<string, unknown> = {};
    if (lineName.trim() !== row.lineName) patch.line_name = lineName.trim();
    if (!isInfo && lineType !== row.lineType) patch.line_type = lineType;
    if (lineCode.trim() !== row.lineCode) patch.line_code = lineCode.trim();
    const nextOrg = orgSlug || null;
    if (nextOrg !== row.organizationSlug) patch.organization_slug = nextOrg;
    const nextUnit = unitLink.trim();
    const curUnit = row.unitLink === "-" ? "" : row.unitLink;
    if (nextUnit !== curUnit) patch.unit_link = nextUnit || null;
    if (mainTitleMode !== row.mainTitleMode) {
      patch.main_title_mode = mainTitleMode;
      if (mainTitleMode === "fixed") patch.main_title = mainTitle.trim();
    } else if (mainTitleMode === "fixed") {
      const curTitle = row.mainTitle === "-" ? "" : row.mainTitle;
      if (mainTitle.trim() !== curTitle) patch.main_title = mainTitle.trim();
    }
    if (isActive !== row.isActive) patch.is_active = isActive;
    if (isInfo && (pointActivityTypeId || null) !== (row.pointActivityTypeId ?? null)) {
      patch.point_activity_type_id = pointActivityTypeId || null;
    }

    // ── Point.A/B(config) 변경 여부 ──
    const nextA = pointA === "" ? null : Number(pointA);
    const nextB = pointB === "" ? null : Number(pointB);
    const pointChanged = !isCareer && (nextA !== row.pointA || nextB !== row.pointB);
    const configKey = deriveConfigKey(row.hub, lineType, lineCode.trim(), pointActivityTypeId);

    if (Object.keys(patch).length === 0 && !pointChanged) {
      setError("변경된 내용이 없습니다");
      return;
    }

    setSaving(true);
    try {
      let warning = "";
      // 1) 라인 필드 PATCH(있을 때만).
      if (Object.keys(patch).length > 0) {
        const res = await fetch(`/api/admin/lines/registrations/${row.id}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(patch),
        });
        const json = await res.json().catch(() => ({}));
        if (!res.ok || !json.success) {
          throw new Error((json && typeof json.error === "string" && json.error) || `HTTP ${res.status}`);
        }
        if (json.driftSync?.warning) warning = ` (동기화 경고: ${json.driftSync.warning})`;
      }
      // 2) Point.A/B → 기존 point-configs PUT(등록 폼과 동일 SoT). config_key 필요.
      if (pointChanged) {
        if (!configKey) {
          throw new Error(
            isInfo
              ? "Point.A/B 를 저장하려면 포인트 대상 활동유형을 먼저 선택하세요."
              : "이 라인의 Point config_key 를 도출할 수 없어 Point.A/B 를 저장할 수 없습니다.",
          );
        }
        const res = await fetch(`/api/admin/lines/point-configs`, {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            organization: row.organizationSlug ?? "common",
            hub: row.hub,
            config_key: configKey,
            point_a: nextA,
            point_b: nextB,
          }),
        });
        const json = await res.json().catch(() => ({}));
        if (!res.ok || !json.success) {
          throw new Error((json && typeof json.error === "string" && json.error) || `HTTP ${res.status}`);
        }
      }
      onSaved(`수정되었습니다 (${row.lineName})${warning}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "저장에 실패했습니다");
    } finally {
      setSaving(false);
    }
  }, [
    row, isInfo, isCareer, lineName, lineType, lineCode, orgSlug, unitLink,
    mainTitleMode, mainTitle, isActive, pointActivityTypeId, pointA, pointB, onSaved,
  ]);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4 sm:p-8">
      <div className="max-h-[90vh] modal-w-xl space-y-5 overflow-y-auto rounded-xl bg-background p-6 shadow-xl ring-1 ring-foreground/10">
        <div className="flex items-start justify-between gap-4">
          <div>
            <h2 className="text-lg font-semibold">라인 수정</h2>
            <p className="mt-0.5 text-xs text-muted-foreground">
              {row.hubLabel} · {row.lineCode}
            </p>
          </div>
          <button type="button" onClick={onClose} className="text-muted-foreground hover:text-foreground" aria-label="닫기">
            <X className="h-5 w-5" />
          </button>
        </div>

        {loadError ? (
          <div className="rounded-md border border-rose-200 bg-rose-50 px-3 py-2 text-sm text-rose-800">
            {loadError}
          </div>
        ) : null}

        {gateLocked ? (
          <div className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800">
            이미 개설된 라인이 {opened}건 있어 라인 코드 · 소속 클럽
            {isExperience ? " · 라인 종류" : ""}는 수정할 수 없습니다(비활성화 후 신규 등록).
          </div>
        ) : null}

        <div className="space-y-4">
          {/* 라인명 */}
          <div className="space-y-1.5">
            <Label>라인명</Label>
            <Input value={lineName} onChange={(e) => setLineName(e.target.value)} disabled={saving} />
          </div>

          {/* 허브(읽기 전용) · 라인 종류 */}
          <div className="grid grid-cols-1 gap-x-6 gap-y-4 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label>소속 허브</Label>
              <Input value={LINE_REGISTRATION_HUB_LABEL[row.hub]} disabled readOnly />
              <p className="text-xs text-muted-foreground">허브는 수정할 수 없습니다.</p>
            </div>
            <div className="space-y-1.5">
              <Label>라인 종류</Label>
              <select
                aria-label="라인 종류"
                className="h-9 w-full rounded-md border border-input bg-background px-3 text-sm disabled:cursor-not-allowed disabled:opacity-60"
                value={lineType}
                onChange={(e) => setLineType(e.target.value)}
                disabled={saving || isInfo || (isExperience && gateLocked)}
              >
                {lineTypeOptions.map((t) => (
                  <option key={t} value={t}>
                    {t}
                  </option>
                ))}
              </select>
            </div>
          </div>

          {/* 라인 코드 · 소속 조직 (게이트) */}
          <div className="grid grid-cols-1 gap-x-6 gap-y-4 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label>라인 코드</Label>
              <Input
                value={lineCode}
                onChange={(e) => setLineCode(e.target.value)}
                disabled={saving || gateLocked}
              />
            </div>
            <div className="space-y-1.5">
              <Label>
                소속 클럽 <span className="text-red-500" aria-hidden="true">*</span>
              </Label>
              <select
                aria-label="소속 클럽"
                aria-required="true"
                aria-invalid={!orgSlug}
                className={cn(
                  "h-9 w-full rounded-md border bg-background px-3 text-sm disabled:cursor-not-allowed disabled:opacity-60",
                  !orgSlug ? "border-rose-400" : "border-input",
                )}
                value={orgSlug}
                onChange={(e) => setOrgSlug(e.target.value)}
                disabled={saving || gateLocked}
              >
                <option value="">-</option>
                {LINE_REGISTRATION_ORGS.map((o) => (
                  <option key={o} value={o}>
                    {LINE_REGISTRATION_ORG_LABEL[o]}
                  </option>
                ))}
              </select>
              {!orgSlug && (
                <p className="text-xs text-rose-600">소속 클럽을 선택해야 저장할 수 있습니다.</p>
              )}
            </div>
          </div>

          {/* 유닛 링크 */}
          <div className="space-y-1.5">
            <Label>유닛 링크</Label>
            <Input
              value={unitLink}
              onChange={(e) => setUnitLink(e.target.value)}
              placeholder="유닛 링크를 입력하세요 (미입력 시 '-')"
              disabled={saving}
            />
          </div>

          {/* 메인 타이틀 (고정/변동) */}
          <div className="space-y-2">
            <Label>메인 타이틀</Label>
            <Input
              value={mainTitle}
              onChange={(e) => setMainTitle(e.target.value)}
              placeholder="메인 타이틀을 입력하세요"
              disabled={saving || mainTitleMode === "variable"}
            />
            <div className="flex items-center gap-4 text-sm">
              <label className="flex cursor-pointer items-center gap-1.5">
                <input
                  type="radio"
                  name="editMainTitleMode"
                  checked={mainTitleMode === "fixed"}
                  onChange={() => setMainTitleMode("fixed")}
                  disabled={saving}
                />
                고정
              </label>
              <label className="flex cursor-pointer items-center gap-1.5">
                <input
                  type="radio"
                  name="editMainTitleMode"
                  checked={mainTitleMode === "variable"}
                  onChange={() => setMainTitleMode("variable")}
                  disabled={saving}
                />
                변동
              </label>
            </div>
            {mainTitleMode === "variable" && (
              <p className="text-xs text-muted-foreground">{VARIABLE_MAIN_TITLE_NOTICE}</p>
            )}
          </div>

          {/* 강화 시 포인트 (Point.A / Point.B) — 기존 point-configs SoT */}
          <div className="space-y-3 rounded-lg border bg-muted/20 p-3">
            <h3 className="text-base font-semibold tracking-wide text-foreground">강화 시 포인트</h3>
            {isInfo && (
              <div className="space-y-1.5">
                <Label className="text-xs text-muted-foreground">포인트 대상 활동유형</Label>
                <select
                  aria-label="포인트 대상 활동유형"
                  className="h-9 w-full rounded-md border border-input bg-background px-3 text-sm"
                  value={pointActivityTypeId}
                  onChange={(e) => setPointActivityTypeId(e.target.value)}
                  disabled={saving}
                >
                  <option value="">-</option>
                  {INFO_ACTIVITY_TYPES.map((a) => (
                    <option key={a.id} value={a.id}>
                      {a.label} ({a.id})
                    </option>
                  ))}
                </select>
              </div>
            )}
            {/* 실무 경험 활동유형 — line_type 에서 파생(별도 저장 없음). 라인 종류 변경 시 즉시 반영. */}
            {isExperience && (() => {
              const at = experienceActivityTypeForLineType(lineType);
              return (
                <div className="space-y-1.5">
                  <Label className="text-xs text-muted-foreground">포인트 대상 활동유형</Label>
                  <div
                    aria-label="포인트 대상 활동유형"
                    data-experience-config-key={at?.configKey ?? ""}
                    className="flex h-9 w-full items-center rounded-md border border-input bg-muted/40 px-3 text-sm text-muted-foreground"
                  >
                    {at ? `${at.label} (${at.configKey})` : "-"}
                  </div>
                  <p className="text-xs text-muted-foreground">
                    라인 종류에 따라 자동 결정됩니다.
                  </p>
                </div>
              );
            })()}
            <div className="grid grid-cols-2 gap-x-6 gap-y-3">
              <div className="space-y-1.5">
                <Label className="text-xs text-muted-foreground">Point.A</Label>
                <select
                  aria-label="Point.A"
                  className="h-9 w-full rounded-md border border-input bg-background px-3 text-sm disabled:cursor-not-allowed disabled:opacity-60"
                  value={pointA}
                  onChange={(e) => setPointA(e.target.value)}
                  disabled={saving || isCareer}
                >
                  {POINT_SELECT_OPTIONS.map((v) => (
                    <option key={v} value={v}>
                      {v === "" ? "-" : v}
                    </option>
                  ))}
                </select>
              </div>
              <div className="space-y-1.5">
                <Label className="text-xs text-muted-foreground">Point.B</Label>
                <select
                  aria-label="Point.B"
                  className="h-9 w-full rounded-md border border-input bg-background px-3 text-sm disabled:cursor-not-allowed disabled:opacity-60"
                  value={pointB}
                  onChange={(e) => setPointB(e.target.value)}
                  disabled={saving || isCareer}
                >
                  {POINT_SELECT_OPTIONS.map((v) => (
                    <option key={v} value={v}>
                      {v === "" ? "-" : v}
                    </option>
                  ))}
                </select>
              </div>
            </div>
            <p className="text-xs text-muted-foreground">
              Point.A/B 는 (클럽·허브·유형) 공유 설정입니다 — 같은 유형의 다른 라인과 오픈 확인 계산에도 동일 값이 적용됩니다.
            </p>
          </div>

          {/* 활성 상태 */}
          <label className="flex cursor-pointer items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={isActive}
              onChange={(e) => setIsActive(e.target.checked)}
              disabled={saving}
            />
            활성(체크 해제 시 비활성 — 개설 검증에서 제외)
          </label>
        </div>

        {error ? (
          <div className="rounded-md border border-rose-200 bg-rose-50 px-3 py-2 text-sm text-rose-800">
            {error}
          </div>
        ) : null}

        <div className="flex items-center justify-end gap-2 border-t pt-4">
          <Button type="button" variant="outline" onClick={onClose} disabled={saving}>
            취소
          </Button>
          <Button type="button" onClick={() => void handleSave()} disabled={saving || loading}>
            {saving ? <Loader2 className="mr-1.5 h-4 w-4 animate-spin" /> : null}
            저장
          </Button>
        </div>
      </div>
    </div>
  );
}
