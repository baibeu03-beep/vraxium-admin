"use client";

// 4허브 공통 — 개설된 라인 검색·필터 + 와이드 테이블 + 대상자 보기 + 상세/편집.
// competency / career / (필요 시 info·experience) 매니저에서 재사용한다.
// 데이터는 GET /api/admin/cluster4/lines?partType=&detailed=1 (append-only) 로 자체 조회.

import { Fragment, useCallback, useEffect, useMemo, useState } from "react";
import { Loader2, Check, X, Search, ChevronDown, ChevronRight, Pencil } from "lucide-react";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Button } from "@/components/ui/button";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { cn } from "@/lib/utils";
import type {
  Cluster4LineDetail,
  Cluster4LinePartType,
} from "@/lib/adminCluster4LinesTypes";
import {
  buildOutputLinksFromForm,
  OUTPUT_LINK_LABEL_PLACEHOLDER,
  OUTPUT_LINK_URL_PLACEHOLDER,
} from "@/lib/cluster4OutputLinks";
import {
  EnhancementStatusBadge,
  SubmissionStatusBadge,
  ENHANCEMENT_FILTER_OPTIONS,
  matchesEnhancementFilter,
  type EnhancementFilter,
} from "@/components/admin/cluster4/enhancementBadges";

type StatusFilter = "all" | "active" | "inactive";

const EDIT_REASON_LABEL: Record<string, string> = {
  ok: "편집 가능",
  ok_override: "오버라이드",
  target_missing: "대상 없음",
  not_owner: "비대상",
  line_inactive: "라인 비활성",
  window_not_open: "기간 전",
  window_closed: "마감",
  unsupported_target_mode: "rule 대상",
};

const DAY_NAMES = ["일", "월", "화", "수", "목", "금", "토"] as const;

function fmtDateShort(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return `${d.getFullYear()}. ${d.getMonth() + 1}. ${d.getDate()}. (${DAY_NAMES[d.getDay()]})`;
}

function isoToLocalInput(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function localInputToIso(local: string): string | null {
  if (!local) return null;
  const d = new Date(local);
  if (Number.isNaN(d.getTime())) return null;
  return d.toISOString();
}

function CanEditBadge({ canEdit, reason }: { canEdit: boolean; reason: string }) {
  return (
    <span
      className={cn(
        "inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium",
        canEdit ? "bg-green-100 text-green-800" : "bg-gray-100 text-gray-600",
      )}
    >
      {EDIT_REASON_LABEL[reason] ?? reason}
    </span>
  );
}

// ──────────────────────────────────────────────────────────────
// Detail / Edit modal
// ──────────────────────────────────────────────────────────────

function LineDetailModal({
  line,
  nameColumnLabel,
  editable,
  onClose,
  onSaved,
}: {
  line: Cluster4LineDetail;
  nameColumnLabel: string;
  editable: boolean;
  onClose: () => void;
  onSaved: (message: string) => void;
}) {
  const [mainTitle, setMainTitle] = useState(line.mainTitle);
  // output_links 우선 prefill (DTO 가 이미 jsonb→legacy fallback 해석). 슬롯 순서 보존.
  const [outputLink1, setOutputLink1] = useState(line.outputLinks[0]?.url ?? line.outputLink1 ?? "");
  const [outputLabel1, setOutputLabel1] = useState(line.outputLinks[0]?.label ?? "");
  const [outputLink2, setOutputLink2] = useState(line.outputLinks[1]?.url ?? line.outputLink2 ?? "");
  const [outputLabel2, setOutputLabel2] = useState(line.outputLinks[1]?.label ?? "");
  const [opensAt, setOpensAt] = useState(isoToLocalInput(line.submissionOpensAt));
  const [closesAt, setClosesAt] = useState(isoToLocalInput(line.submissionClosesAt));
  const [isActive, setIsActive] = useState(line.isActive);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleSave = useCallback(async () => {
    if (!mainTitle.trim()) {
      setError("메인 타이틀을 입력해주세요");
      return;
    }
    const built = buildOutputLinksFromForm([
      { url: outputLink1, label: outputLabel1 },
      { url: outputLink2, label: outputLabel2 },
    ]);
    if (!built.ok) {
      setError(built.error);
      return;
    }
    const outputLinks = built.value;
    const opensIso = localInputToIso(opensAt);
    const closesIso = localInputToIso(closesAt);
    if (!opensIso || !closesIso) {
      setError("기입 기간을 올바르게 입력해주세요");
      return;
    }
    if (new Date(opensIso).getTime() > new Date(closesIso).getTime()) {
      setError("기입 시작은 마감보다 이후일 수 없습니다");
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const res = await fetch(`/api/admin/cluster4/lines/${line.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          main_title: mainTitle.trim(),
          // output_links 우선 저장 + 레거시 컬럼 backward-compat mirror.
          output_links: outputLinks,
          output_link_1: outputLinks[0]?.url ?? null,
          output_link_2: outputLinks[1]?.url ?? null,
          submission_opens_at: opensIso,
          submission_closes_at: closesIso,
          is_active: isActive,
        }),
      });
      const json = await res.json();
      if (!json.success) {
        setError(json.error ?? "저장에 실패했습니다");
        return;
      }
      onSaved("라인 정보가 수정되었습니다");
    } catch {
      setError("저장 중 오류가 발생했습니다");
    } finally {
      setSaving(false);
    }
  }, [
    line.id,
    mainTitle,
    outputLink1,
    outputLabel1,
    outputLink2,
    outputLabel2,
    opensAt,
    closesAt,
    isActive,
    onSaved,
  ]);

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black/40 p-4 sm:p-8"
      onClick={onClose}
    >
      <div
        className="w-full max-w-3xl space-y-6 rounded-lg bg-background p-6 shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-start justify-between gap-4">
          <div className="min-w-0">
            <p className="text-xs text-muted-foreground">
              {nameColumnLabel} · {line.weekLabel ?? "주차 미상"}
              {line.lineCode ? ` · ${line.lineCode}` : ""}
            </p>
            <h2 className="truncate text-lg font-bold">{line.mainTitle}</h2>
            <p className="font-mono text-xs text-muted-foreground">lineId: {line.id}</p>
          </div>
          <Button variant="ghost" size="icon" onClick={onClose}>
            <X className="h-5 w-5" />
          </Button>
        </div>

        {error && (
          <div className="rounded-md border border-red-300 bg-red-50 px-3 py-2 text-sm text-red-800">
            {error}
          </div>
        )}

        <section className="space-y-4">
          <h3 className="text-sm font-semibold">
            라인 기본 정보 {editable ? "(편집)" : "(읽기 전용)"}
          </h3>
          <div className="space-y-2">
            <Label htmlFor="d-title">메인 타이틀</Label>
            <Input
              id="d-title"
              value={mainTitle}
              onChange={(e) => setMainTitle(e.target.value)}
              disabled={!editable}
            />
          </div>
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="space-y-2">
              <div className="space-y-1">
                <Label htmlFor="d-link1" className="text-xs text-muted-foreground">
                  Output Link 1 URL
                </Label>
                <Input
                  id="d-link1"
                  value={outputLink1}
                  onChange={(e) => setOutputLink1(e.target.value)}
                  placeholder={OUTPUT_LINK_URL_PLACEHOLDER}
                  disabled={!editable}
                />
              </div>
              <div className="space-y-1">
                <Label htmlFor="d-label1" className="text-xs text-muted-foreground">
                  Link 1 설명
                </Label>
                <Input
                  id="d-label1"
                  value={outputLabel1}
                  onChange={(e) => setOutputLabel1(e.target.value)}
                  placeholder={OUTPUT_LINK_LABEL_PLACEHOLDER}
                  disabled={!editable}
                />
              </div>
            </div>
            <div className="space-y-2">
              <div className="space-y-1">
                <Label htmlFor="d-link2" className="text-xs text-muted-foreground">
                  Output Link 2 URL
                </Label>
                <Input
                  id="d-link2"
                  value={outputLink2}
                  onChange={(e) => setOutputLink2(e.target.value)}
                  placeholder={OUTPUT_LINK_URL_PLACEHOLDER}
                  disabled={!editable}
                />
              </div>
              <div className="space-y-1">
                <Label htmlFor="d-label2" className="text-xs text-muted-foreground">
                  Link 2 설명
                </Label>
                <Input
                  id="d-label2"
                  value={outputLabel2}
                  onChange={(e) => setOutputLabel2(e.target.value)}
                  placeholder={OUTPUT_LINK_LABEL_PLACEHOLDER}
                  disabled={!editable}
                />
              </div>
            </div>
          </div>
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="space-y-1">
              <Label htmlFor="d-opens" className="text-xs text-muted-foreground">
                기입 시작
              </Label>
              <Input
                id="d-opens"
                type="datetime-local"
                value={opensAt}
                onChange={(e) => setOpensAt(e.target.value)}
                disabled={!editable}
              />
            </div>
            <div className="space-y-1">
              <Label htmlFor="d-closes" className="text-xs text-muted-foreground">
                기입 마감
              </Label>
              <Input
                id="d-closes"
                type="datetime-local"
                value={closesAt}
                onChange={(e) => setClosesAt(e.target.value)}
                disabled={!editable}
              />
            </div>
          </div>
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              className="rounded border-gray-300"
              checked={isActive}
              onChange={(e) => setIsActive(e.target.checked)}
              disabled={!editable}
            />
            활성 라인 (is_active)
          </label>

          {line.outputImages.length > 0 && (
            <div className="space-y-1">
              <Label className="text-xs text-muted-foreground">
                Output 이미지 (읽기 전용)
              </Label>
              <div className="flex flex-wrap gap-2">
                {line.outputImages.map((url) => (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img
                    key={url}
                    src={url}
                    alt="output"
                    className="h-16 w-16 rounded border object-cover"
                  />
                ))}
              </div>
            </div>
          )}
        </section>

        <section className="space-y-2">
          <div className="flex items-center justify-between">
            <h3 className="text-sm font-semibold">
              대상자 ({line.targets.length}명) · 기입 {line.submittedCount} / 미기입{" "}
              {line.pendingCount} · 편집가능 {line.canEditCount}
            </h3>
            <span className="text-xs text-muted-foreground">
              대상 추가/제거는 안전을 위해 읽기 전용입니다
            </span>
          </div>
          <div className="max-h-72 overflow-y-auto rounded-md border">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>이름</TableHead>
                  <TableHead>조직</TableHead>
                  <TableHead className="text-center">강화 상태</TableHead>
                  <TableHead className="text-center">라인칸 기입 상태</TableHead>
                  <TableHead>canEdit</TableHead>
                  <TableHead>lineTargetId / submissionId</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {line.targets.map((t) => (
                  <TableRow key={t.lineTargetId}>
                    <TableCell className="font-medium">{t.displayName}</TableCell>
                    <TableCell className="text-xs text-muted-foreground">
                      {t.organizationSlug ?? "—"}
                    </TableCell>
                    <TableCell className="text-center">
                      <EnhancementStatusBadge
                        status={t.enhancementStatus}
                        reason={t.enhancementReason}
                      />
                    </TableCell>
                    <TableCell className="text-center">
                      <SubmissionStatusBadge status={t.submissionStatus} />
                      {t.submitted && t.submittedAt ? (
                        <span className="ml-1 text-[11px] text-muted-foreground">
                          · {fmtDateShort(t.submittedAt)}
                        </span>
                      ) : null}
                    </TableCell>
                    <TableCell>
                      <CanEditBadge canEdit={t.canEdit} reason={t.editReason} />
                    </TableCell>
                    <TableCell className="font-mono text-[11px] text-muted-foreground">
                      <div className="truncate">{t.lineTargetId}</div>
                      <div className="truncate">{t.submissionId ?? "—"}</div>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        </section>

        <div className="flex justify-end gap-3 border-t pt-4">
          <Button variant="outline" onClick={onClose} disabled={saving}>
            닫기
          </Button>
          {editable && (
            <Button onClick={handleSave} disabled={saving}>
              {saving && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              라인 정보 저장
            </Button>
          )}
        </div>
      </div>
    </div>
  );
}

// ──────────────────────────────────────────────────────────────
// Main table
// ──────────────────────────────────────────────────────────────

type OrgOption = { slug: string; name: string };

export default function Cluster4LineTable({
  partType,
  title,
  nameColumnLabel = "라인명",
  editable = true,
  refreshSignal = 0,
  weekId,
}: {
  partType: Cluster4LinePartType;
  title: string;
  nameColumnLabel?: string;
  editable?: boolean;
  refreshSignal?: number;
  // 부모(매니저)의 선택 주차. 지정되면 서버에서 해당 주차 라인만 조회하고
  // 내부 주차 드롭다운은 숨긴다. 미지정 시 전체 주차 + 내부 드롭다운 필터.
  weekId?: string;
}) {
  const [rows, setRows] = useState<Cluster4LineDetail[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [orgNames, setOrgNames] = useState<Record<string, string>>({});

  // Filters
  const [orgFilter, setOrgFilter] = useState("");
  const [weekFilter, setWeekFilter] = useState("");
  const [nameQuery, setNameQuery] = useState("");
  const [targetQuery, setTargetQuery] = useState("");
  const [statusFilter, setStatusFilter] = useState<StatusFilter>("all");
  const [enhancementFilter, setEnhancementFilter] = useState<EnhancementFilter>("all");

  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [detailId, setDetailId] = useState<string | null>(null);

  const fetchRows = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const qs = new URLSearchParams({
        partType,
        detailed: "1",
        limit: "500",
      });
      // 선택 주차가 지정되면 서버에서 해당 주차 라인만 조회한다.
      if (weekId) qs.set("weekId", weekId);
      const res = await fetch(`/api/admin/cluster4/lines?${qs.toString()}`);
      const json = await res.json();
      if (json.success) {
        setRows(json.data.rows ?? []);
      } else {
        setRows([]);
        setError(json.error ?? "라인 목록을 불러오지 못했습니다");
      }
    } catch (e) {
      console.error("[Cluster4LineTable] fetch failed", e);
      setError("라인 목록을 불러오지 못했습니다");
      setRows([]);
    } finally {
      setLoading(false);
    }
  }, [partType, weekId]);

  useEffect(() => {
    void (async () => {
      await fetchRows();
    })();
  }, [fetchRows, refreshSignal]);

  useEffect(() => {
    void (async () => {
      try {
        const res = await fetch("/api/admin/organizations");
        const json = await res.json();
        const list: OrgOption[] = json.organizations ?? [];
        const map: Record<string, string> = {};
        for (const o of list) map[o.slug] = o.name;
        setOrgNames(map);
      } catch {
        // org 이름 매핑 실패는 무시 (slug 그대로 표시).
      }
    })();
  }, []);

  // Filter option sources — 표시된 라인에서 직접 도출(누락 방지).
  const weekOptions = useMemo(() => {
    const seen = new Map<string, string>();
    for (const r of rows) {
      if (r.weekId) seen.set(r.weekId, r.weekLabel ?? r.weekId);
    }
    return Array.from(seen, ([id, label]) => ({ id, label }));
  }, [rows]);

  const orgOptions = useMemo(() => {
    const set = new Set<string>();
    for (const r of rows) {
      for (const t of r.targets) {
        if (t.organizationSlug) set.add(t.organizationSlug);
      }
    }
    return Array.from(set, (slug) => ({ slug, name: orgNames[slug] ?? slug }));
  }, [rows, orgNames]);

  const filteredRows = useMemo(() => {
    const nq = nameQuery.trim().toLowerCase();
    const tq = targetQuery.trim().toLowerCase();
    return rows.filter((r) => {
      if (statusFilter === "active" && !r.isActive) return false;
      if (statusFilter === "inactive" && r.isActive) return false;
      // 라인 단위 강화 상태 = 대표 대상자(첫 행) 값. 대상자 0명이면 null.
      if (
        !matchesEnhancementFilter(
          enhancementFilter,
          r.targets[0]?.enhancementStatus ?? null,
        )
      )
        return false;
      if (weekFilter && r.weekId !== weekFilter) return false;
      if (orgFilter && !r.targets.some((t) => t.organizationSlug === orgFilter))
        return false;
      if (nq) {
        const hay = `${r.mainTitle} ${r.lineCode ?? ""}`.toLowerCase();
        if (!hay.includes(nq)) return false;
      }
      if (tq && !r.targets.some((t) => t.displayName.toLowerCase().includes(tq)))
        return false;
      return true;
    });
  }, [rows, statusFilter, enhancementFilter, weekFilter, orgFilter, nameQuery, targetQuery]);

  const detailLine = useMemo(
    () => rows.find((r) => r.id === detailId) ?? null,
    [rows, detailId],
  );

  const resetFilters = useCallback(() => {
    setOrgFilter("");
    setWeekFilter("");
    setNameQuery("");
    setTargetQuery("");
    setStatusFilter("all");
    setEnhancementFilter("all");
  }, []);

  const hasFilter =
    !!orgFilter ||
    !!weekFilter ||
    !!nameQuery ||
    !!targetQuery ||
    statusFilter !== "all" ||
    enhancementFilter !== "all";

  return (
    <Card className="min-w-0">
      <CardHeader className="pb-3">
        <CardTitle className="text-base">{title}</CardTitle>
        <CardDescription>
          {loading
            ? "불러오는 중..."
            : `총 ${rows.length}개 · 필터 결과 ${filteredRows.length}개`}
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {/* Filter bar */}
        <div className="grid gap-3 rounded-md border bg-muted/30 p-3 md:grid-cols-2 xl:grid-cols-3">
          <div className="space-y-1">
            <Label className="text-xs text-muted-foreground">조직</Label>
            <select
              className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
              value={orgFilter}
              onChange={(e) => setOrgFilter(e.target.value)}
            >
              <option value="">전체 조직</option>
              {orgOptions.map((o) => (
                <option key={o.slug} value={o.slug}>
                  {o.name}
                </option>
              ))}
            </select>
          </div>
          {!weekId && (
            <div className="space-y-1">
              <Label className="text-xs text-muted-foreground">주차</Label>
              <select
                className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
                value={weekFilter}
                onChange={(e) => setWeekFilter(e.target.value)}
              >
                <option value="">전체 주차</option>
                {weekOptions.map((w) => (
                  <option key={w.id} value={w.id}>
                    {w.label}
                  </option>
                ))}
              </select>
            </div>
          )}
          <div className="space-y-1">
            <Label className="text-xs text-muted-foreground">상태</Label>
            <select
              className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
              value={statusFilter}
              onChange={(e) => setStatusFilter(e.target.value as StatusFilter)}
            >
              <option value="all">전체 상태</option>
              <option value="active">활성</option>
              <option value="inactive">비활성</option>
            </select>
          </div>
          <div className="space-y-1">
            <Label className="text-xs text-muted-foreground">강화 상태</Label>
            <select
              className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
              value={enhancementFilter}
              onChange={(e) =>
                setEnhancementFilter(e.target.value as EnhancementFilter)
              }
            >
              {ENHANCEMENT_FILTER_OPTIONS.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </select>
          </div>
          <div className="space-y-1">
            <Label className="text-xs text-muted-foreground">{nameColumnLabel} 검색</Label>
            <div className="relative">
              <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
              <Input
                className="pl-9"
                placeholder={`${nameColumnLabel}/코드 검색...`}
                value={nameQuery}
                onChange={(e) => setNameQuery(e.target.value)}
              />
            </div>
          </div>
          <div className="space-y-1">
            <Label className="text-xs text-muted-foreground">대상자 검색</Label>
            <div className="relative">
              <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
              <Input
                className="pl-9"
                placeholder="대상자 이름 검색..."
                value={targetQuery}
                onChange={(e) => setTargetQuery(e.target.value)}
              />
            </div>
          </div>
          <div className="flex items-end">
            <Button
              variant="outline"
              size="sm"
              onClick={resetFilters}
              disabled={!hasFilter}
            >
              필터 초기화
            </Button>
          </div>
        </div>

        {error && (
          <div className="rounded-md border border-red-300 bg-red-50 px-3 py-2 text-sm text-red-800">
            {error}
          </div>
        )}

        {loading ? (
          <div className="flex items-center justify-center py-12">
            <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
          </div>
        ) : filteredRows.length === 0 ? (
          <p className="py-10 text-center text-sm text-muted-foreground">
            {rows.length === 0 ? "개설된 라인이 없습니다." : "필터 결과가 없습니다."}
          </p>
        ) : (
          <div className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="w-8" />
                  <TableHead>주차</TableHead>
                  <TableHead>{nameColumnLabel}</TableHead>
                  <TableHead className="text-center">강화 상태</TableHead>
                  <TableHead className="text-center">대상</TableHead>
                  <TableHead className="text-center">기입/미기입</TableHead>
                  <TableHead className="text-center">편집가능</TableHead>
                  <TableHead className="whitespace-nowrap">기입 기간</TableHead>
                  <TableHead className="text-center">활성</TableHead>
                  <TableHead className="whitespace-nowrap">생성일</TableHead>
                  <TableHead className="text-right">동작</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {filteredRows.map((line) => {
                  const expanded = expandedId === line.id;
                  const names = line.targets.map((t) => t.displayName);
                  const preview = names.slice(0, 3).join(", ");
                  const extra = names.length > 3 ? ` 외 ${names.length - 3}명` : "";
                  return (
                    <Fragment key={line.id}>
                      <TableRow
                        className="cursor-pointer"
                        onClick={() =>
                          setExpandedId((prev) => (prev === line.id ? null : line.id))
                        }
                      >
                        <TableCell>
                          {expanded ? (
                            <ChevronDown className="h-4 w-4 text-muted-foreground" />
                          ) : (
                            <ChevronRight className="h-4 w-4 text-muted-foreground" />
                          )}
                        </TableCell>
                        <TableCell className="whitespace-nowrap text-xs">
                          {line.weekLabel ?? "—"}
                        </TableCell>
                        <TableCell className="max-w-[260px]">
                          <div className="truncate font-medium">{line.mainTitle}</div>
                          <div className="truncate font-mono text-[10px] text-muted-foreground">
                            {line.lineCode ?? line.id}
                          </div>
                        </TableCell>
                        <TableCell className="text-center">
                          {line.targets[0] ? (
                            <EnhancementStatusBadge
                              status={line.targets[0].enhancementStatus}
                              reason={line.targets[0].enhancementReason}
                            />
                          ) : (
                            <span className="text-xs text-muted-foreground">—</span>
                          )}
                        </TableCell>
                        <TableCell className="text-center">{line.targetCount}명</TableCell>
                        <TableCell className="text-center text-xs">
                          <span className="text-green-700">{line.submittedCount}</span>
                          {" / "}
                          <span className="text-orange-600">{line.pendingCount}</span>
                        </TableCell>
                        <TableCell className="text-center">{line.canEditCount}</TableCell>
                        <TableCell className="whitespace-nowrap text-[11px] text-muted-foreground">
                          {fmtDateShort(line.submissionOpensAt)}
                          <br />~ {fmtDateShort(line.submissionClosesAt)}
                        </TableCell>
                        <TableCell className="text-center">
                          {line.isActive ? (
                            <Check className="mx-auto h-4 w-4 text-green-600" />
                          ) : (
                            <X className="mx-auto h-4 w-4 text-muted-foreground" />
                          )}
                        </TableCell>
                        <TableCell className="whitespace-nowrap text-xs text-muted-foreground">
                          {fmtDateShort(line.createdAt)}
                        </TableCell>
                        <TableCell
                          className="text-right"
                          onClick={(e) => e.stopPropagation()}
                        >
                          <Button
                            variant="outline"
                            size="sm"
                            onClick={() => setDetailId(line.id)}
                          >
                            <Pencil className="mr-1 h-3 w-3" /> 상세
                          </Button>
                        </TableCell>
                      </TableRow>
                      {expanded && (
                        <TableRow className="bg-muted/20">
                          <TableCell />
                          <TableCell colSpan={10} className="py-2">
                            <div className="mb-1 text-xs font-medium text-muted-foreground">
                              대상자 {line.targets.length}명 ({preview}
                              {extra})
                            </div>
                            <div className="flex flex-wrap gap-2">
                              {line.targets.map((t) => (
                                <span
                                  key={t.lineTargetId}
                                  className="inline-flex items-center gap-1 rounded-md border bg-background px-2 py-1 text-xs"
                                >
                                  <span className="font-medium">{t.displayName}</span>
                                  {t.organizationSlug && (
                                    <span className="text-muted-foreground">
                                      · {orgNames[t.organizationSlug] ?? t.organizationSlug}
                                    </span>
                                  )}
                                  <EnhancementStatusBadge
                                    status={t.enhancementStatus}
                                    reason={t.enhancementReason}
                                    className="ml-1"
                                  />
                                  <SubmissionStatusBadge status={t.submissionStatus} />
                                  <CanEditBadge canEdit={t.canEdit} reason={t.editReason} />
                                </span>
                              ))}
                            </div>
                          </TableCell>
                        </TableRow>
                      )}
                    </Fragment>
                  );
                })}
              </TableBody>
            </Table>
          </div>
        )}
      </CardContent>

      {detailLine && (
        <LineDetailModal
          line={detailLine}
          nameColumnLabel={nameColumnLabel}
          editable={editable}
          onClose={() => setDetailId(null)}
          onSaved={() => {
            setDetailId(null);
            void fetchRows();
          }}
        />
      )}
    </Card>
  );
}
