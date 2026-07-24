"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { Eye, EyeOff, Plus, Search, X } from "lucide-react";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { TableSkeletonRows } from "@/components/ui/table-skeleton";
import { useReportLoading } from "@/components/admin/loadingBannerContext";
import { cn } from "@/lib/utils";
import { useStickyColumns } from "@/components/ui/sticky-columns";
import { Checkbox, checkedTextClass } from "@/components/ui/checkbox";
import {
  ORGANIZATIONS,
  organizationLabelKo,
  type OrganizationSlug,
} from "@/lib/organizations";
import { useAdminDevMode } from "@/components/admin/useAdminDevMode";
import AdminHelpIconButton from "@/components/admin/AdminHelpIconButton";
import { ADMIN_SHARED_HELP_KEYS } from "@/lib/adminSharedHelpKeys";
import { appendModeQuery, readScopeMode } from "@/lib/userScopeShared";
import { useActionToast } from "@/lib/actionToast";
import { formatDepartmentName } from "@/components/admin/fieldKit";
import MemberEditDrawer, {
  type EditableMember,
} from "@/components/admin/MemberEditDrawer";
import { apiErrorFrom, getApiErrorMessage } from "@/lib/apiError";

type Crew = {
  id?: string | number;
  legacyUserId: string;
  userId?: string | null;
  displayName: string;
  name?: string;
  age?: number | null;
  birthDate?: string | null;
  gender?: string | null;
  contactPhone?: string | null;
  contactEmail?: string | null;
  authEmail?: string | null;
  status?: string | null;
  growthStatus?: string | null;
  suspendedWeekId?: string | null;
  schoolName?: string | null;
  departmentName?: string | null;
  majorName?: string | null;
  university?: string | null;
  major?: string | null;
  universityMajor?: string | null;
  teamName: string | null;
  team?: string | null;
  partName: string | null;
  part?: string | null;
  membershipLevel?: string | null;
  membershipState?: string | null;
  approvedWeeks?: number | null;
  cumulativeWeeks: number | null;
  profilePhotoUrl?: string | null;
  isVisible: boolean;
  adminNote: string | null;
  organizationSlug: string | null;
  role?: string | null;
  updatedAt?: string;
};

const ALL = "__all__";
const VISIBILITY_OPTIONS_OPERATOR = [
  { value: ALL, label: "전체" },
  { value: "visible", label: "공개" },
  { value: "hidden", label: "숨김" },
];
const VISIBILITY_OPTIONS_DEV = [
  { value: ALL, label: "All" },
  { value: "visible", label: "Visible" },
  { value: "hidden", label: "Hidden" },
];

type FormState = {
  legacy_user_id: string;
  display_name: string;
  team_name: string;
  part_name: string;
  cumulative_weeks: string;
  is_visible: boolean;
  admin_note: string;
  organization_slug: OrganizationSlug;
};

type Banner = { kind: "success" | "error"; message: string } | null;

function formatValue(value?: string | number | null) {
  if (value == null || value === "") return "-";
  return String(value);
}

function formatBirthDate(crew: Crew) {
  if (!crew.birthDate) return "-";
  return crew.age == null ? crew.birthDate : `${crew.birthDate} (${crew.age})`;
}

function createEmptyForm(organization: OrganizationSlug): FormState {
  return {
    legacy_user_id: "",
    display_name: "",
    team_name: "",
    part_name: "",
    cumulative_weeks: "0",
    is_visible: true,
    admin_note: "",
    organization_slug: organization,
  };
}

export default function CrewManager({
  organization,
}: {
  organization: OrganizationSlug;
}) {
  const devMode = useAdminDevMode();
  // 운영/테스트 모드 — URL ?mode=test 면 test, 그 외 operating(기본). ?mode 는 URL 직접 진입으로만 설정.
  const searchParams = useSearchParams();
  const mode = readScopeMode(searchParams);
  // 왼쪽 2열 고정(상태·이름) — 공통 sticky 계약. col-1 실측폭으로 col-2 offset.
  const sticky = useStickyColumns({ headerSticky: true });
  const [data, setData] = useState<Crew[]>([]);
  const [loading, setLoading] = useState(true);
  useReportLoading(loading); // 전역 로딩 배너 보고
  const [search, setSearch] = useState("");
  const [team, setTeam] = useState<string>(ALL);
  const [part, setPart] = useState<string>(ALL);
  const [visibility, setVisibility] = useState<string>(ALL);
  const t = useActionToast();
  const [banner, setBanner] = useState<Banner>(null);
  const [modalOpen, setModalOpen] = useState(false);
  const [editing, setEditing] = useState<Crew | null>(null);
  const [editingMember, setEditingMember] = useState<EditableMember | null>(null);
  const [form, setForm] = useState<FormState>(() => createEmptyForm(organization));
  const [submitting, setSubmitting] = useState(false);

  const refresh = useCallback(async (org: OrganizationSlug) => {
    setLoading(true);
    try {
      const res = await fetch(
        appendModeQuery(
          `/api/admin/crews?organization=${encodeURIComponent(org)}`,
          mode,
        ),
        { cache: "no-store" },
      );
      const json = await res.json();
      if (!res.ok || !json.success) {
        throw apiErrorFrom(res, json, "크루 목록을 불러오지 못했습니다.");
      }
      setData((json.data ?? []) as Crew[]);
    } catch (err) {
      console.error("[crews] load failed", err);
      setBanner({
        kind: "error",
        message: getApiErrorMessage(err, "크루 목록을 불러오지 못했습니다."),
      });
    } finally {
      setLoading(false);
    }
  }, [mode]);

  useEffect(() => {
    const timeoutId = window.setTimeout(() => {
      void refresh(organization);
    }, 0);
    return () => window.clearTimeout(timeoutId);
  }, [organization, refresh]);

  useEffect(() => {
    if (!banner) return;
    const timer = window.setTimeout(() => setBanner(null), 4000);
    return () => window.clearTimeout(timer);
  }, [banner]);

  const teams = useMemo(
    () =>
      Array.from(new Set(data.map((crew) => crew.teamName).filter(Boolean))) as string[],
    [data],
  );

  const parts = useMemo(
    () =>
      Array.from(new Set(data.map((crew) => crew.partName).filter(Boolean))) as string[],
    [data],
  );

  const filtered = useMemo(() => {
    const query = search.trim().toLowerCase();
    return data.filter((crew) => {
      if (team !== ALL && crew.teamName !== team) return false;
      if (part !== ALL && crew.partName !== part) return false;
      if (visibility === "visible" && !crew.isVisible) return false;
      if (visibility === "hidden" && crew.isVisible) return false;
      if (query && !crew.displayName.toLowerCase().includes(query)) return false;
      return true;
    });
  }, [data, part, search, team, visibility]);

  const visibleCount = useMemo(
    () => data.filter((crew) => crew.isVisible).length,
    [data],
  );

  const openCreate = () => {
    setEditing(null);
    setForm(createEmptyForm(organization));
    setModalOpen(true);
  };

  // Edit 진입은 row 안의 "Cluster1" / "Cluster 2" 텍스트 링크로 대체했다.
  // 기존 modal은 legacy_crew_import staging 신규 등록(Add) 전용으로 유지.

  const closeModal = () => {
    if (submitting) return;
    setModalOpen(false);
  };

  const handleSubmit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (submitting) return;

    if (!form.legacy_user_id.trim()) {
      setBanner({
        kind: "error",
        message: devMode ? "legacy_user_id is required." : "회원 ID를 입력해 주세요.",
      });
      return;
    }

    if (!form.display_name.trim()) {
      setBanner({
        kind: "error",
        message: devMode ? "display_name is required." : "이름을 입력해 주세요.",
      });
      return;
    }

    const weeks = Number(form.cumulative_weeks);
    const payload: Record<string, unknown> = {
      legacy_user_id: form.legacy_user_id.trim(),
      display_name: form.display_name.trim(),
      team_name: form.team_name.trim() || null,
      part_name: form.part_name.trim() || null,
      cumulative_weeks: Number.isFinite(weeks) ? weeks : 0,
      is_visible: form.is_visible,
      admin_note: form.admin_note.trim() || null,
      organization_slug: form.organization_slug,
    };

    setSubmitting(true);
    try {
      const url = editing
        ? `/api/admin/crews/${encodeURIComponent(String(editing.legacyUserId))}`
        : "/api/admin/crews";
      const method = editing ? "PATCH" : "POST";

      const res = await fetch(url, {
        method,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const json = await res.json();
      if (!res.ok || !json.success) {
        throw apiErrorFrom(res, json, "크루를 저장하지 못했습니다.");
      }

      if (json.warning) console.warn(json.warning);
      t.success(editing ? "update" : "create");
      setModalOpen(false);
      await refresh(organization);
    } catch (err) {
      console.error("[crews] save failed", err);
      t.apiError(editing ? "update" : "create", err, "크루를 저장하지 못했습니다.");
    } finally {
      setSubmitting(false);
    }
  };

  const toggleVisibility = async (crew: Crew) => {
    const next = !crew.isVisible;
    try {
      const res = await fetch(
        `/api/admin/crews/${encodeURIComponent(String(crew.legacyUserId))}`,
        {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ is_visible: next }),
        },
      );
      const json = await res.json();
      if (!res.ok || !json.success) {
        throw apiErrorFrom(res, json, "노출 상태를 변경하지 못했습니다.");
      }
      t.success("update");
      await refresh(organization);
    } catch (err) {
      console.error("[crews] visibility toggle failed", err);
      t.apiError("update", err, "노출 상태를 변경하지 못했습니다.");
    }
  };

  // 멤버 정보 수정(MemberEditDrawer)은 /admin/members 와 동일한 흐름.
  // PATCH /api/admin/members/:userId 로 user_profiles 를 수정하므로
  // 저장 후에는 crew 목록을 다시 불러와 organization/연락처 변경을 반영한다.
  const handleMemberSaved = (_updated: EditableMember) => {
    setEditingMember(null);
    t.success("save");
    void refresh(organization);
  };

  return (
    <div className="flex flex-col gap-6">
      {banner && (
        <div
          role="status"
          className={cn(
            "rounded-md border px-3 py-2 text-sm",
            banner.kind === "success"
              ? "border-emerald-300 bg-emerald-50 text-emerald-900"
              : "border-destructive/40 bg-destructive/10 text-destructive",
          )}
        >
          {banner.message}
        </div>
      )}

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-4">
        <StatCard
          label={devMode ? "Organization" : "소속"}
          value={organizationLabelKo(organization)}
          isText
        />
        <StatCard label={devMode ? "Total Crews" : "전체 인원"} value={data.length} />
        <StatCard label={devMode ? "Visible" : "공개"} value={visibleCount} />
        <StatCard label={devMode ? "Filtered" : "검색 결과"} value={filtered.length} />
      </div>

      <Card>
        <CardHeader className="flex flex-row items-center justify-between">
          <CardTitle>
            {organizationLabelKo(organization)} {devMode ? "Crews" : "크루"}
          </CardTitle>
          <Button onClick={openCreate} size="sm">
            <Plus className="h-4 w-4" />
            {devMode ? "Add Crew" : "크루 추가"}
          </Button>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          <div className="flex flex-wrap items-center gap-2">
            <span className="inline-flex items-center gap-1">
              <div className="relative w-full sm:w-64">
                <Search className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
                <Input
                  value={search}
                  onChange={(event) => setSearch(event.target.value)}
                  placeholder={devMode ? "Search name" : "이름으로 검색"}
                  className="pl-8"
                />
              </div>
              <AdminHelpIconButton
                helpKey="admin.crews.manager.filter.search"
                title="검색"
                size="xs"
              />
            </span>

            <span className="inline-flex items-center gap-1">
              <Select value={team} onValueChange={(value) => setTeam(value ?? ALL)}>
                <SelectTrigger className="w-40">
                  <SelectValue placeholder={devMode ? "All teams" : "전체 팀"} />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={ALL}>{devMode ? "All teams" : "전체 팀"}</SelectItem>
                  {teams.map((value) => (
                    <SelectItem key={value} value={value}>
                      {value}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <AdminHelpIconButton
                helpKey="admin.crews.manager.filter.team"
                title="팀 필터"
                size="xs"
              />
            </span>

            <span className="inline-flex items-center gap-1">
              <Select value={part} onValueChange={(value) => setPart(value ?? ALL)}>
                <SelectTrigger className="w-40">
                  <SelectValue placeholder={devMode ? "All parts" : "전체 파트"} />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={ALL}>{devMode ? "All parts" : "전체 파트"}</SelectItem>
                  {parts.map((value) => (
                    <SelectItem key={value} value={value}>
                      {value}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <AdminHelpIconButton
                helpKey="admin.crews.manager.filter.part"
                title="파트 필터"
                size="xs"
              />
            </span>

            <span className="inline-flex items-center gap-1">
              <Select
                value={visibility}
                onValueChange={(value) => setVisibility(value ?? ALL)}
              >
                <SelectTrigger className="w-32">
                  <SelectValue placeholder={devMode ? "Visibility" : "공개 여부"} />
                </SelectTrigger>
                <SelectContent>
                  {(devMode ? VISIBILITY_OPTIONS_DEV : VISIBILITY_OPTIONS_OPERATOR).map(
                    (option) => (
                      <SelectItem key={option.value} value={option.value}>
                        {option.label}
                      </SelectItem>
                    ),
                  )}
                </SelectContent>
              </Select>
              <AdminHelpIconButton
                helpKey="admin.crews.manager.filter.visibility"
                title="공개 여부"
                size="xs"
              />
            </span>
          </div>

          <div className="rounded-md border">
            <Table containerRef={sticky.ref} regionClassName={sticky.regionClassName} stickyLeft>
              <TableHeader>
                <TableRow>
                  <TableHead
                    {...sticky.col(1)}
                    className={cn("w-16", sticky.col(1).className)}
                  >
                    <span className="inline-flex items-center justify-center gap-1">
                      {devMode ? "Status" : "상태"}
                      <AdminHelpIconButton
                        helpKey="admin.crews.manager.column.status"
                        title="상태(공개 여부)"
                        size="xs"
                      />
                    </span>
                  </TableHead>
                  <TableHead {...sticky.col(2)} className={sticky.col(2).className}>
                    {devMode ? "Name" : "이름"}
                  </TableHead>
                  <TableHead>{devMode ? "Gender" : "성별"}</TableHead>
                  <TableHead>{devMode ? "Birth Date" : "생년월일"}</TableHead>
                  <TableHead>{devMode ? "Contact" : "연락처"}</TableHead>
                  <TableHead>{devMode ? "Email" : "이메일"}</TableHead>
                  <TableHead>{devMode ? "School" : "학교"}</TableHead>
                  <TableHead>{devMode ? "Department" : "학과"}</TableHead>
                  <TableHead>
                    <span className="inline-flex items-center justify-center gap-1">
                      {devMode ? "Team" : "팀"}
                      <AdminHelpIconButton
                        helpKey="admin.crews.manager.column.team"
                        title="팀"
                        size="xs"
                      />
                    </span>
                  </TableHead>
                  <TableHead>
                    <span className="inline-flex items-center justify-center gap-1">
                      {devMode ? "Part" : "파트"}
                      <AdminHelpIconButton
                        helpKey="admin.crews.manager.column.part"
                        title="파트"
                        size="xs"
                      />
                    </span>
                  </TableHead>
                  <TableHead>
                    <span className="inline-flex items-center justify-center gap-1">
                      {devMode ? "Level" : "단계"}
                      <AdminHelpIconButton
                        helpKey="admin.crews.manager.column.level"
                        title="단계(등급)"
                        size="xs"
                      />
                    </span>
                  </TableHead>
                  <TableHead>
                    <span className="inline-flex items-center justify-center gap-1">
                      {devMode ? "State" : "활동 상태"}
                      <AdminHelpIconButton
                        helpKey="admin.crews.manager.column.state"
                        title="활동 상태"
                        size="xs"
                      />
                    </span>
                  </TableHead>
                  <TableHead>
                    <span className="inline-flex items-center justify-center gap-1">
                      {devMode ? "Cumulative" : "누적 주차"}
                      <AdminHelpIconButton
                        helpKey="admin.crews.manager.column.cumulativeWeeks"
                        title="누적 주차"
                        size="xs"
                      />
                    </span>
                  </TableHead>
                  <TableHead>
                    <span className="inline-flex items-center justify-center gap-1">
                      {devMode ? "Approved" : "승인 주차"}
                      <AdminHelpIconButton
                        helpKey="admin.crews.manager.column.approvedWeeks"
                        title="승인 주차"
                        size="xs"
                      />
                    </span>
                  </TableHead>
                  <TableHead>
                    <span className="inline-flex items-center justify-center gap-1">
                      {devMode ? "Organization" : "소속"}
                      <AdminHelpIconButton
                        helpKey={ADMIN_SHARED_HELP_KEYS.crew.organization}
                        title="소속"
                        size="xs"
                      />
                    </span>
                  </TableHead>
                  <TableHead>
                    <span className="inline-flex items-center justify-center gap-1">
                      {devMode ? "Admin Note" : "운영 메모"}
                      <AdminHelpIconButton
                        helpKey="admin.crews.manager.column.adminNote"
                        title="운영 메모"
                        size="xs"
                      />
                    </span>
                  </TableHead>
                  <TableHead className="w-[640px]">
                    <span className="inline-flex items-center justify-center gap-1">
                      {devMode ? "Actions" : "바로가기"}
                      <AdminHelpIconButton
                        helpKey="admin.crews.manager.column.actions"
                        title="바로가기"
                        size="xs"
                      />
                    </span>
                  </TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {filtered.map((crew) => (
                  <TableRow
                    key={String(crew.legacyUserId)}
                    className={cn(!crew.isVisible && "opacity-60")}
                  >
                    <TableCell
                      {...sticky.col(1)}
                      className={cn("w-16", sticky.col(1).className)}
                    >
                      <span
                        className={cn(
                          "inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium",
                          crew.isVisible
                            ? "bg-emerald-100 text-emerald-900"
                            : "bg-muted text-muted-foreground",
                        )}
                      >
                        {crew.isVisible
                          ? devMode
                            ? "Visible"
                            : "공개"
                          : devMode
                            ? "Hidden"
                            : "숨김"}
                      </span>
                    </TableCell>
                    <TableCell
                      {...sticky.col(2)}
                      className={cn("font-medium", sticky.col(2).className)}
                    >
                      {crew.displayName}
                    </TableCell>
                    <TableCell>{formatValue(crew.gender)}</TableCell>
                    <TableCell>{formatBirthDate(crew)}</TableCell>
                    <TableCell>{formatValue(crew.contactPhone)}</TableCell>
                    <TableCell>{formatValue(crew.contactEmail)}</TableCell>
                    <TableCell>{formatValue(crew.schoolName)}</TableCell>
                    <TableCell>{formatDepartmentName(crew.departmentName ?? crew.majorName)}</TableCell>
                    <TableCell>{formatValue(crew.teamName)}</TableCell>
                    <TableCell>{formatValue(crew.partName)}</TableCell>
                    <TableCell>{formatValue(crew.membershipLevel)}</TableCell>
                    <TableCell>{formatValue(crew.membershipState)}</TableCell>
                    <TableCell>
                      {formatValue(crew.cumulativeWeeks)}
                    </TableCell>
                    <TableCell>
                      {formatValue(crew.approvedWeeks)}
                    </TableCell>
                    <TableCell>{formatValue(crew.organizationSlug)}</TableCell>
                    <TableCell
                      className="max-w-[240px] truncate text-muted-foreground"
                      title={crew.adminNote ?? ""}
                    >
                      {crew.adminNote ?? ""}
                    </TableCell>
                    <TableCell>
                      <div className="flex flex-nowrap items-center gap-1 whitespace-nowrap">
                        <Link
                          href={
                            `/admin/crews/${encodeURIComponent(
                              organization,
                            )}/${encodeURIComponent(
                              String(crew.userId ?? crew.legacyUserId),
                            )}` + (devMode ? "?dev=true" : "")
                          }
                          className="rounded-md border px-2 py-1 text-xs hover:bg-muted"
                        >
                          Cluster1
                        </Link>
                        <Link
                          href={
                            `/admin/crews/${encodeURIComponent(
                              organization,
                            )}/${encodeURIComponent(
                              String(crew.userId ?? crew.legacyUserId),
                            )}/cluster2` + (devMode ? "?dev=true" : "")
                          }
                          className="rounded-md border px-2 py-1 text-xs hover:bg-muted"
                        >
                          Cluster 2
                        </Link>
                        <Link
                          href={
                            `/admin/crews/${encodeURIComponent(
                              organization,
                            )}/${encodeURIComponent(
                              String(crew.userId ?? crew.legacyUserId),
                            )}/cluster3` + (devMode ? "?dev=true" : "")
                          }
                          className="rounded-md border px-2 py-1 text-xs hover:bg-muted"
                        >
                          Cluster 3
                        </Link>
                        {crew.organizationSlug ? (
                          <Link
                            href={
                              `/admin/crews/${encodeURIComponent(
                                crew.organizationSlug,
                              )}/${encodeURIComponent(
                                String(crew.userId ?? crew.legacyUserId),
                              )}/cluster4` + (devMode ? "?dev=true" : "")
                            }
                            className="rounded-md border px-2 py-1 text-xs hover:bg-muted"
                          >
                            Cluster 4
                          </Link>
                        ) : (
                          <span
                            aria-disabled
                            title={
                              devMode
                                ? "organization_slug is missing for this crew."
                                : "organization_slug 가 없어 진입할 수 없습니다."
                            }
                            className="cursor-not-allowed rounded-md border border-dashed px-2 py-1 text-xs text-muted-foreground"
                          >
                            Cluster 4
                          </span>
                        )}
                        <Button
                          variant="ghost"
                          size="icon-sm"
                          onClick={() => toggleVisibility(crew)}
                          aria-label={crew.isVisible ? "Hide" : "Show"}
                        >
                          {crew.isVisible ? (
                            <EyeOff className="h-3.5 w-3.5" />
                          ) : (
                            <Eye className="h-3.5 w-3.5" />
                          )}
                        </Button>
                        {crew.userId ? (
                          <Link
                            href={
                              `/admin/members/${encodeURIComponent(
                                crew.userId,
                              )}/weekly-status` + (devMode ? "?dev=true" : "")
                            }
                            title={
                              devMode
                                ? "이 사용자의 주차 상태 조회로 이동"
                                : "이 회원의 주차 상태 조회로 이동"
                            }
                            className="rounded-md border px-2 py-1 text-xs hover:bg-muted"
                          >
                            주차 상태
                          </Link>
                        ) : (
                          <span
                            aria-disabled
                            title={
                              devMode
                                ? "user_id 가 없어 주차 상태를 조회할 수 없습니다."
                                : "user_id 가 없어 주차 상태를 조회할 수 없는 회원입니다."
                            }
                            className="cursor-not-allowed rounded-md border border-dashed px-2 py-1 text-xs text-muted-foreground"
                          >
                            주차 상태
                          </span>
                        )}
                        <Link
                          href={
                            `/admin/settings/edit-windows?q=${encodeURIComponent(
                              String(crew.userId ?? crew.legacyUserId),
                            )}` + (devMode ? "&dev=true" : "")
                          }
                          title={
                            devMode
                              ? "이 사용자의 작성 기간 관리로 이동"
                              : "이 회원의 작성 기간 관리로 이동"
                          }
                          className="rounded-md border px-2 py-1 text-xs hover:bg-muted"
                        >
                          작성 기간
                        </Link>
                        <button
                          type="button"
                          onClick={() =>
                            setEditingMember({
                              userId: String(crew.userId ?? crew.legacyUserId),
                              displayName: crew.displayName,
                              authEmail: crew.authEmail ?? null,
                              organizationSlug: crew.organizationSlug,
                              status: crew.status ?? null,
                              growthStatus: crew.growthStatus ?? null,
                              // crew 목록은 suspended_week_id 를 싣지 않을 수 있다(undefined→null).
                              //   드로어가 주차 후보를 별도 로드하므로 미리보기만 비어 있을 뿐 기능엔 영향 없다.
                              suspendedWeekId: crew.suspendedWeekId ?? null,
                              contactEmail: crew.contactEmail ?? null,
                              contactPhone: crew.contactPhone ?? null,
                              role: crew.role ?? null,
                              currentTeamName: crew.teamName ?? null,
                              currentPartName: crew.partName ?? null,
                            })
                          }
                          className="rounded-md border bg-foreground px-2 py-1 text-xs text-background hover:opacity-90"
                        >
                          멤버 정보 수정
                        </button>
                      </div>
                    </TableCell>
                  </TableRow>
                ))}

                {!loading && filtered.length === 0 && (
                  <TableRow>
                    <TableCell
                      colSpan={17}
                      className="h-24 text-center text-muted-foreground"
                    >
                      {devMode ? "No crews found." : "검색 결과가 없습니다."}
                    </TableCell>
                  </TableRow>
                )}

                {loading && filtered.length === 0 && (
                  <TableSkeletonRows columns={17} rows={8} />
                )}
              </TableBody>
            </Table>
          </div>
        </CardContent>
      </Card>

      {modalOpen && (
        <CrewFormModal
          editing={editing}
          form={form}
          setForm={setForm}
          submitting={submitting}
          organization={organization}
          devMode={devMode}
          onClose={closeModal}
          onSubmit={handleSubmit}
        />
      )}

      <MemberEditDrawer
        member={editingMember}
        onClose={() => setEditingMember(null)}
        onSaved={handleMemberSaved}
      />
    </div>
  );
}

function StatCard({
  label,
  value,
  isText,
}: {
  label: string;
  value: number | string;
  isText?: boolean;
}) {
  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-sm font-medium text-muted-foreground">
          {label}
        </CardTitle>
      </CardHeader>
      <CardContent>
        <div className={cn("font-semibold", isText ? "text-xl" : "text-2xl")}>
          {value}
        </div>
      </CardContent>
    </Card>
  );
}

type ModalProps = {
  editing: Crew | null;
  form: FormState;
  setForm: React.Dispatch<React.SetStateAction<FormState>>;
  submitting: boolean;
  organization: OrganizationSlug;
  devMode: boolean;
  onClose: () => void;
  onSubmit: (event: React.FormEvent) => void;
};

function CrewFormModal({
  editing,
  form,
  setForm,
  submitting,
  organization,
  devMode,
  onClose,
  onSubmit,
}: ModalProps) {
  const isEdit = Boolean(editing);

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label={isEdit ? "Edit crew" : "Add crew"}
        className="modal-w-2xl rounded-xl bg-background p-5 shadow-lg ring-1 ring-foreground/10"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="mb-4 flex items-center justify-between">
          <h2 className="text-base font-semibold">
            {isEdit
              ? devMode
                ? "Edit Crew"
                : "멤버 수정"
              : devMode
                ? "Add Crew"
                : "멤버 추가"}{" "}
            <span className="text-sm font-normal text-muted-foreground">
              @ {organizationLabelKo(organization)}
            </span>
          </h2>
          <Button
            variant="ghost"
            size="icon-sm"
            onClick={onClose}
            aria-label={devMode ? "Close" : "닫기"}
            disabled={submitting}
          >
            <X className="h-4 w-4" />
          </Button>
        </div>

        <form onSubmit={onSubmit} className="flex flex-col gap-4">
          {editing && (
            <div className="grid grid-cols-1 gap-3 rounded-lg border bg-muted/20 p-3 text-sm sm:grid-cols-2 lg:grid-cols-3">
              <ReadonlyField label={devMode ? "Name" : "이름"} value={editing.displayName} />
              <ReadonlyField label={devMode ? "Gender" : "성별"} value={editing.gender} />
              <ReadonlyField
                label={devMode ? "Birth Date" : "생년월일"}
                value={formatBirthDate(editing)}
              />
              <ReadonlyField label={devMode ? "Contact" : "연락처"} value={editing.contactPhone} />
              <ReadonlyField label={devMode ? "Email" : "이메일"} value={editing.contactEmail} />
              <ReadonlyField
                label={devMode ? "School / Department" : "학교 / 학과"}
                value={formatDepartmentName(
                  editing.universityMajor ?? editing.schoolName ?? editing.departmentName
                )}
              />
              <ReadonlyField label={devMode ? "Team" : "팀"} value={editing.teamName} />
              <ReadonlyField label={devMode ? "Part" : "파트"} value={editing.partName} />
              <ReadonlyField label={devMode ? "Level" : "단계"} value={editing.membershipLevel} />
              <ReadonlyField
                label={devMode ? "State" : "활동 상태"}
                value={editing.membershipState}
              />
              <ReadonlyField
                label={devMode ? "Cumulative Weeks" : "누적 주차"}
                value={editing.cumulativeWeeks}
              />
              <ReadonlyField
                label={devMode ? "Approved Weeks" : "승인 주차"}
                value={editing.approvedWeeks}
              />
              <ReadonlyField
                label={devMode ? "Organization" : "소속"}
                value={editing.organizationSlug}
              />
            </div>
          )}

          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <Field label={devMode ? "legacy_user_id" : "회원 ID"} required>
              <Input
                value={form.legacy_user_id}
                onChange={(event) =>
                  setForm((current) => ({
                    ...current,
                    legacy_user_id: event.target.value,
                  }))
                }
                disabled={isEdit}
                placeholder={
                  devMode ? "Mapped user_profiles account id" : "연결할 회원 계정 ID"
                }
                required
              />
            </Field>

            <Field label={devMode ? "Display Name" : "이름"} required>
              <Input
                value={form.display_name}
                onChange={(event) =>
                  setForm((current) => ({
                    ...current,
                    display_name: event.target.value,
                  }))
                }
                required
              />
            </Field>

            <Field label={devMode ? "Team" : "팀"}>
              <Input
                value={form.team_name}
                onChange={(event) =>
                  setForm((current) => ({
                    ...current,
                    team_name: event.target.value,
                  }))
                }
              />
            </Field>

            <Field label={devMode ? "Part" : "파트"}>
              <Input
                value={form.part_name}
                onChange={(event) =>
                  setForm((current) => ({
                    ...current,
                    part_name: event.target.value,
                  }))
                }
              />
            </Field>

            <Field label={devMode ? "Organization" : "소속"} required>
              <Select
                value={form.organization_slug}
                onValueChange={(value) =>
                  setForm((current) => ({
                    ...current,
                    organization_slug: value as OrganizationSlug,
                  }))
                }
              >
                <SelectTrigger>
                  <SelectValue placeholder={devMode ? "Select organization" : "소속 선택"} />
                </SelectTrigger>
                <SelectContent>
                  {ORGANIZATIONS.map((slug) => (
                    <SelectItem key={slug} value={slug}>
                      {organizationLabelKo(slug)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </Field>

            <Field label={devMode ? "Cumulative Weeks" : "누적 주차"}>
              <Input
                type="number"
                inputMode="numeric"
                value={form.cumulative_weeks}
                onChange={(event) =>
                  setForm((current) => ({
                    ...current,
                    cumulative_weeks: event.target.value,
                  }))
                }
                min={0}
              />
            </Field>

            <Field label={devMode ? "Visibility" : "공개 여부"}>
              <label className="mt-1 inline-flex items-center gap-2 text-sm">
                <Checkbox
                  checked={form.is_visible}
                  onChange={(event) =>
                    setForm((current) => ({
                      ...current,
                      is_visible: event.target.checked,
                    }))
                  }
                />
                <span className={checkedTextClass(form.is_visible)}>
                  {devMode ? "Expose on user app `/crews`" : "회원 앱의 '크루' 페이지에 공개"}
                </span>
              </label>
            </Field>
          </div>

          <Field label={devMode ? "Admin Note" : "운영 메모"}>
            <textarea
              value={form.admin_note}
              onChange={(event) =>
                setForm((current) => ({
                  ...current,
                  admin_note: event.target.value,
                }))
              }
              rows={3}
              className="w-full resize-y rounded-lg border border-input bg-transparent px-2.5 py-1.5 text-sm outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50"
              placeholder={
                devMode
                  ? "Internal note not shown to end users"
                  : "회원에게는 보이지 않는 내부 메모"
              }
            />
          </Field>

          <div className="mt-2 flex justify-end gap-2">
            <Button
              type="button"
              variant="ghost"
              onClick={onClose}
              disabled={submitting}
            >
              {devMode ? "Cancel" : "취소"}
            </Button>
            <Button type="submit" disabled={submitting}>
              {submitting
                ? devMode
                  ? "Saving..."
                  : "저장 중..."
                : devMode
                  ? "Save"
                  : "저장"}
            </Button>
          </div>
        </form>
      </div>
    </div>
  );
}

function Field({
  label,
  required,
  children,
}: {
  label: string;
  required?: boolean;
  children: React.ReactNode;
}) {
  return (
    <div className="flex flex-col gap-1.5">
      <Label>
        {label}
        {required && <span className="text-destructive">*</span>}
      </Label>
      {children}
    </div>
  );
}

function ReadonlyField({
  label,
  value,
}: {
  label: string;
  value?: string | number | null;
}) {
  return (
    <div className="flex flex-col gap-1">
      <span className="text-xs text-muted-foreground">{label}</span>
      <span className="font-medium">{formatValue(value)}</span>
    </div>
  );
}
