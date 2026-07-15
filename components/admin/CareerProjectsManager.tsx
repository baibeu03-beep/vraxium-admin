"use client";

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  Pencil,
  Plus,
  RefreshCw,
  Search,
  Trash2,
  X,
} from "lucide-react";
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
import AdminHelp from "@/components/admin/AdminHelp";
import AdminHelpIconButton from "@/components/admin/AdminHelpIconButton";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { LoadingState } from "@/components/ui/loading-state";
import { TableSkeletonRows } from "@/components/ui/table-skeleton";
import { cn } from "@/lib/utils";
import { formatAdminDateTime } from "@/lib/adminDateTime";
import { CONFIRM, useConfirm } from "@/components/ui/confirm-dialog";
import { useReportLoading } from "@/components/admin/loadingBannerContext";
import { useActionToast } from "@/lib/actionToast";
import {
  stringifyJsonField,
  type CareerProjectDto,
  type CareerProjectWeekStateDto,
} from "@/lib/adminCareerProjectsTypes";

const PAGE_SIZE = 50;

type ListResponseData = {
  rows: CareerProjectDto[];
  total: number;
  limit: number;
  offset: number;
  isSuperAdmin: boolean;
};

type EditorState =
  | { mode: "create" }
  | { mode: "edit"; project: CareerProjectDto };

// 비어있을 수 있는 텍스트 / 날짜 표시 헬퍼.
function fmt(value: string | null | undefined) {
  return value?.trim() ? value : "-";
}

// createdAt·updatedAt 등 메타 시각 — 항상 서울 표준시(KST) "YYYY-MM-DD HH:mm:ss".
function fmtDate(value: string | null | undefined) {
  return formatAdminDateTime(value, { fallback: "-" });
}

// weeks 테이블의 컬럼은 환경마다 다를 수 있어 (label/name/week_no/season_no 등)
// 가장 흔한 후보를 순차 시도하고 모두 없으면 id 단축으로 폴백한다.
function weekLabel(row: Record<string, unknown>): string {
  const candidates = ["label", "name", "title", "code"] as const;
  for (const key of candidates) {
    const value = row[key];
    if (typeof value === "string" && value.trim().length > 0) return value;
  }
  const seasonNo = row.season_no ?? row.season ?? null;
  const weekNo = row.week_no ?? row.week_index ?? row.weekNo ?? null;
  if (seasonNo != null && weekNo != null) return `S${seasonNo} · W${weekNo}`;
  if (weekNo != null) return `Week ${weekNo}`;
  const id = row.id;
  if (typeof id === "string") return `Week ${id.slice(0, 8)}`;
  return "(unknown week)";
}

function weekStartsAt(row: Record<string, unknown>): number {
  const candidates = ["opens_at", "starts_at", "start_at", "start_date"] as const;
  for (const key of candidates) {
    const value = row[key];
    if (typeof value === "string") {
      const t = new Date(value).getTime();
      if (!Number.isNaN(t)) return t;
    }
  }
  const seasonNo = Number(row.season_no ?? row.season ?? 0);
  const weekNo = Number(row.week_no ?? row.week_index ?? 0);
  return seasonNo * 10000 + weekNo;
}

function emptyUpsertInput(): UpsertFormState {
  return {
    companyName: "",
    companyLogoUrl: "",
    jobPosition: "",
    projectName: "",
    projectDescription: "",
    lineCode: "",
    lineName: "",
    outputLinks: "[]",
    outputImages: "[]",
    companyHomepageLinks: "[]",
    secondaryInfoDeadline: "",
    supervisorName: "",
    supervisorPosition: "",
    supervisorDepartment: "",
    supervisorCompany: "",
    supervisorProfileImg: "",
  };
}

type UpsertFormState = {
  companyName: string;
  companyLogoUrl: string;
  jobPosition: string;
  projectName: string;
  projectDescription: string;
  lineCode: string;
  lineName: string;
  outputLinks: string;
  outputImages: string;
  companyHomepageLinks: string;
  secondaryInfoDeadline: string;
  supervisorName: string;
  supervisorPosition: string;
  supervisorDepartment: string;
  supervisorCompany: string;
  supervisorProfileImg: string;
};

function projectToForm(project: CareerProjectDto): UpsertFormState {
  return {
    companyName: project.companyName ?? "",
    companyLogoUrl: project.companyLogoUrl ?? "",
    jobPosition: project.jobPosition ?? "",
    projectName: project.projectName ?? "",
    projectDescription: project.projectDescription ?? "",
    lineCode: project.lineCode ?? "",
    lineName: project.lineName ?? "",
    outputLinks: stringifyJsonField(project.outputLinks),
    outputImages: stringifyJsonField(project.outputImages),
    companyHomepageLinks: stringifyJsonField(project.companyHomepageLinks),
    secondaryInfoDeadline: project.secondaryInfoDeadline
      ? toLocalDatetime(project.secondaryInfoDeadline)
      : "",
    supervisorName: project.supervisorName ?? "",
    supervisorPosition: project.supervisorPosition ?? "",
    supervisorDepartment: project.supervisorDepartment ?? "",
    supervisorCompany: project.supervisorCompany ?? "",
    supervisorProfileImg: project.supervisorProfileImg ?? "",
  };
}

function toLocalDatetime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const pad = (n: number) => String(n).padStart(2, "0");
  return (
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}` +
    `T${pad(d.getHours())}:${pad(d.getMinutes())}`
  );
}

function formToPayload(form: UpsertFormState): Record<string, unknown> {
  return {
    company_name: form.companyName,
    company_logo_url: form.companyLogoUrl,
    job_position: form.jobPosition,
    project_name: form.projectName,
    project_description: form.projectDescription,
    line_code: form.lineCode,
    line_name: form.lineName,
    output_links: form.outputLinks,
    output_images: form.outputImages,
    company_homepage_links: form.companyHomepageLinks,
    secondary_info_deadline: form.secondaryInfoDeadline
      ? new Date(form.secondaryInfoDeadline).toISOString()
      : null,
    supervisor_name: form.supervisorName,
    supervisor_position: form.supervisorPosition,
    supervisor_department: form.supervisorDepartment,
    supervisor_company: form.supervisorCompany,
    supervisor_profile_img: form.supervisorProfileImg,
  };
}

export default function CareerProjectsManager() {
  const confirm = useConfirm();
  const [query, setQuery] = useState("");
  const [debouncedQuery, setDebouncedQuery] = useState("");
  const [rows, setRows] = useState<CareerProjectDto[]>([]);
  const [total, setTotal] = useState(0);
  const [offset, setOffset] = useState(0);
  const [isSuperAdmin, setIsSuperAdmin] = useState(false);
  const [loading, setLoading] = useState(true);
  useReportLoading(loading);
  const [error, setError] = useState<string | null>(null);
  const t = useActionToast();
  const [refreshTick, setRefreshTick] = useState(0);
  const [editor, setEditor] = useState<EditorState | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);

  // 검색어 디바운스 — query 변경 시 첫 페이지로 리셋도 함께 처리.
  useEffect(() => {
    const handle = window.setTimeout(() => {
      setDebouncedQuery((prev) => {
        const next = query.trim();
        if (prev !== next) {
          setOffset(0);
        }
        return next;
      });
    }, 300);
    return () => window.clearTimeout(handle);
  }, [query]);

  // 목록 로드
  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      setLoading(true);
      setError(null);
      try {
        const url = new URL(
          "/api/admin/career-projects",
          window.location.origin,
        );
        if (debouncedQuery) url.searchParams.set("q", debouncedQuery);
        url.searchParams.set("limit", String(PAGE_SIZE));
        url.searchParams.set("offset", String(offset));
        const res = await fetch(url.toString(), { cache: "no-store" });
        const json = await res.json();
        if (!res.ok || !json.success) {
          throw new Error(
            (json && typeof json.error === "string" && json.error) ||
              `HTTP ${res.status}`,
          );
        }
        if (cancelled) return;
        const data = json.data as ListResponseData;
        setRows(data.rows);
        setTotal(data.total);
        setIsSuperAdmin(Boolean(data.isSuperAdmin));
      } catch (err) {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : "목록을 불러오지 못했습니다");
      } finally {
        if (!cancelled) setLoading(false);
      }
    };
    void load();
    return () => {
      cancelled = true;
    };
  }, [debouncedQuery, offset, refreshTick]);

  const refresh = useCallback(() => setRefreshTick((n) => n + 1), []);

  const handleDelete = useCallback(
    async (project: CareerProjectDto) => {
      const label = project.projectName ?? project.companyName ?? project.id;
      if (
        !(await confirm({
          ...CONFIRM.delete,
          description:
            `'${label}' 실무 경력 항목을 삭제하시겠어요?\n` +
            `이 동작은 되돌릴 수 없으며, 사용 중인 항목은 차단됩니다.`,
        }))
      ) {
        return;
      }
      setDeletingId(project.id);
      try {
        const res = await fetch(
          `/api/admin/career-projects/${encodeURIComponent(project.id)}`,
          { method: "DELETE" },
        );
        const json = await res.json().catch(() => ({}));
        if (!res.ok || !json.success) {
          const message =
            (json && typeof json.error === "string" && json.error) ||
            `HTTP ${res.status}`;
          throw new Error(message);
        }
        t.success("delete", "실무 경력 항목이 삭제되었습니다.");
        refresh();
      } catch (err) {
        console.error(err);
        t.error("delete");
      } finally {
        setDeletingId(null);
      }
    },
    [confirm, refresh, t],
  );

  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const currentPage = Math.floor(offset / PAGE_SIZE) + 1;

  return (
    <div className="flex flex-col gap-4">
      <div className="flex justify-end">
        <AdminHelp />
      </div>
      <Card>
        <CardHeader>
          <div className="flex items-start justify-between gap-3">
            <div>
              <CardTitle>실무 경력</CardTitle>
              <CardDescription>
                실무 경력 마스터 + 주차 스케줄링.
                Super Admin 만 생성·수정·삭제할 수 있어요.
              </CardDescription>
            </div>
            <div className="flex items-center gap-2">
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={refresh}
                disabled={loading}
                title="다시 불러오기"
              >
                <RefreshCw
                  className={cn("h-4 w-4", loading && "animate-spin")}
                />
                <span className="ml-1.5">새로고침</span>
              </Button>
              {isSuperAdmin && (
                <Button
                  type="button"
                  size="sm"
                  onClick={() => setEditor({ mode: "create" })}
                >
                  <Plus className="h-4 w-4" />
                  <span className="ml-1.5">새 실무 경력</span>
                </Button>
              )}
            </div>
          </div>
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
          <div className="flex items-center gap-2">
            <div className="relative flex-1">
              <Search className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
              <Input
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder="회사명 · 프로젝트명 · 직무 · 라인 검색"
                className="pl-8"
              />
              {query && (
                <button
                  type="button"
                  onClick={() => setQuery("")}
                  className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
                  title="검색어 지우기"
                >
                  <X className="h-4 w-4" />
                </button>
              )}
            </div>
          </div>

          {error ? (
            <div className="rounded-md border border-rose-200 bg-rose-50 px-3 py-2 text-sm text-rose-800">
              {error}
            </div>
          ) : (
            <div className="overflow-x-auto rounded-md border">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead className="w-[36%]">
                      <span className="inline-flex items-center gap-1">
                        <span>회사 · 프로젝트 · 직무</span>
                        <AdminHelpIconButton helpKey="admin.careerProjects.column.company" title="회사 · 프로젝트 · 직무" size="xs" />
                      </span>
                    </TableHead>
                    <TableHead>
                      <span className="inline-flex items-center gap-1">
                        <span>라인</span>
                        <AdminHelpIconButton helpKey="admin.careerProjects.column.line" title="라인" size="xs" />
                      </span>
                    </TableHead>
                    <TableHead>
                      <span className="inline-flex items-center gap-1">
                        <span>주차</span>
                        <AdminHelpIconButton helpKey="admin.careerProjects.column.weeks" title="주차" size="xs" />
                      </span>
                    </TableHead>
                    <TableHead>
                      <span className="inline-flex items-center gap-1">
                        <span>생성</span>
                        <AdminHelpIconButton helpKey="admin.careerProjects.column.createdAt" title="생성일" size="xs" />
                      </span>
                    </TableHead>
                    <TableHead>
                      <span className="inline-flex items-center gap-1">
                        <span>수정</span>
                        <AdminHelpIconButton helpKey="admin.careerProjects.column.updatedAt" title="수정일" size="xs" />
                      </span>
                    </TableHead>
                    <TableHead>
                      <span className="inline-flex items-center gap-1">
                        <span>액션</span>
                        <AdminHelpIconButton helpKey="admin.careerProjects.column.actions" title="액션" size="xs" />
                      </span>
                    </TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {loading && rows.length === 0 && (
                    <TableSkeletonRows columns={6} rows={6} />
                  )}
                  {rows.length === 0 && !loading ? (
                    <TableRow>
                      <TableCell
                        colSpan={6}
                        className="py-10 text-center text-muted-foreground"
                      >
                        조회 결과가 없습니다.
                      </TableCell>
                    </TableRow>
                  ) : (
                    rows.map((row) => (
                      <TableRow key={row.id}>
                        <TableCell className="align-top">
                          <div className="flex items-start gap-2">
                            {row.companyLogoUrl ? (
                              // eslint-disable-next-line @next/next/no-img-element
                              <img
                                src={row.companyLogoUrl}
                                alt=""
                                className="h-8 w-8 shrink-0 rounded border bg-white object-contain"
                              />
                            ) : (
                              <div className="h-8 w-8 shrink-0 rounded border bg-muted/30" />
                            )}
                            <div className="min-w-0">
                              <div className="truncate font-medium">
                                {fmt(row.companyName)}
                              </div>
                              <div className="truncate text-sm text-muted-foreground">
                                {fmt(row.projectName)}
                              </div>
                              <div className="truncate text-xs text-muted-foreground">
                                {fmt(row.jobPosition)}
                              </div>
                            </div>
                          </div>
                        </TableCell>
                        <TableCell className="align-top">
                          <div className="text-sm">{fmt(row.lineCode)}</div>
                          <div className="text-xs text-muted-foreground">
                            {fmt(row.lineName)}
                          </div>
                        </TableCell>
                        <TableCell className="align-top">
                          <span className="inline-flex items-center rounded-md border bg-muted/40 px-2 py-0.5 text-xs">
                            {row.weekCount}개 주차
                          </span>
                        </TableCell>
                        <TableCell className="align-top text-xs text-muted-foreground">
                          {fmtDate(row.createdAt)}
                        </TableCell>
                        <TableCell className="align-top text-xs text-muted-foreground">
                          {fmtDate(row.updatedAt)}
                        </TableCell>
                        <TableCell className="align-top">
                          <div className="flex justify-end gap-1.5">
                            <Button
                              type="button"
                              variant="outline"
                              size="sm"
                              onClick={() =>
                                setEditor({ mode: "edit", project: row })
                              }
                            >
                              <Pencil className="h-3.5 w-3.5" />
                              <span className="ml-1.5">
                                {isSuperAdmin ? "편집" : "보기"}
                              </span>
                            </Button>
                            {isSuperAdmin && (
                              <Button
                                type="button"
                                variant="outline"
                                size="sm"
                                onClick={() => void handleDelete(row)}
                                loading={deletingId === row.id}
                                className="text-rose-700 hover:bg-rose-50 hover:text-rose-800"
                              >
                                {deletingId !== row.id && (
                                  <Trash2 className="h-3.5 w-3.5" />
                                )}
                                <span className="ml-1.5">삭제</span>
                              </Button>
                            )}
                          </div>
                        </TableCell>
                      </TableRow>
                    ))
                  )}
                </TableBody>
              </Table>
            </div>
          )}

          <div className="flex items-center justify-between text-sm text-muted-foreground">
            <div>
              {loading ? (
                <LoadingState active variant="inline" />
              ) : (
                `총 ${total.toLocaleString()}개 · ${currentPage}/${totalPages} 페이지`
              )}
            </div>
            <div className="flex items-center gap-1.5">
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => setOffset(Math.max(0, offset - PAGE_SIZE))}
                disabled={offset === 0 || loading}
              >
                이전
              </Button>
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => setOffset(offset + PAGE_SIZE)}
                disabled={offset + PAGE_SIZE >= total || loading}
              >
                다음
              </Button>
            </div>
          </div>
        </CardContent>
      </Card>

      {editor && (
        <CareerProjectEditor
          state={editor}
          isSuperAdmin={isSuperAdmin}
          onClose={() => setEditor(null)}
          onSaved={(message) => {
            t.success("save", message);
            refresh();
          }}
          onError={(message) => {
            console.error(message);
            t.error("save");
          }}
        />
      )}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────
// Editor (Create / Edit) — owner 가 아니면 read-only.
// ─────────────────────────────────────────────────────────────────────────

type EditorProps = {
  state: EditorState;
  isSuperAdmin: boolean;
  onClose: () => void;
  onSaved: (message: string) => void;
  onError: (message: string) => void;
};

function CareerProjectEditor({
  state,
  isSuperAdmin,
  onClose,
  onSaved,
  onError,
}: EditorProps) {
  const isEdit = state.mode === "edit";
  const projectId = isEdit ? state.project.id : null;
  const [form, setForm] = useState<UpsertFormState>(() =>
    isEdit ? projectToForm(state.project) : emptyUpsertInput(),
  );
  const [saving, setSaving] = useState(false);
  const dialogRef = useRef<HTMLDivElement>(null);

  // ESC 로 닫기
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const readOnly = !isSuperAdmin;

  const handleField = useCallback(
    <K extends keyof UpsertFormState>(key: K, value: UpsertFormState[K]) => {
      setForm((prev) => ({ ...prev, [key]: value }));
    },
    [],
  );

  const handleSave = useCallback(async () => {
    if (readOnly) return;
    setSaving(true);
    try {
      const payload = formToPayload(form);
      const url = isEdit
        ? `/api/admin/career-projects/${encodeURIComponent(projectId!)}`
        : `/api/admin/career-projects`;
      const res = await fetch(url, {
        method: isEdit ? "PATCH" : "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok || !json.success) {
        const message =
          (json && typeof json.error === "string" && json.error) ||
          `HTTP ${res.status}`;
        throw new Error(message);
      }
      onSaved(
        isEdit ? "실무 경력 항목이 수정되었습니다." : "실무 경력 항목이 추가되었습니다.",
      );
      onClose();
    } catch (err) {
      onError(err instanceof Error ? err.message : "저장에 실패했습니다");
    } finally {
      setSaving(false);
    }
  }, [form, isEdit, projectId, readOnly, onSaved, onError, onClose]);

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-3"
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        className="flex max-h-[92vh] modal-w-2xl flex-col overflow-hidden rounded-lg border bg-background shadow-xl"
      >
        <div className="flex items-center justify-between border-b px-5 py-3">
          <div>
            <h2 className="text-base font-semibold">
              {isEdit ? "실무 경력 편집" : "새 실무 경력"}
            </h2>
            {isEdit && (
              <p className="text-xs text-muted-foreground">
                id: <span className="font-mono">{projectId}</span>
              </p>
            )}
          </div>
          <button
            type="button"
            onClick={onClose}
            className="rounded-md p-1 text-muted-foreground hover:bg-muted hover:text-foreground"
            aria-label="닫기"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="grid flex-1 grid-cols-1 gap-0 overflow-hidden lg:grid-cols-[1fr_360px]">
          <div className="overflow-y-auto p-5">
            <ProjectForm
              form={form}
              onChange={handleField}
              readOnly={readOnly}
            />
          </div>
          {isEdit && projectId ? (
            <div className="border-t lg:border-l lg:border-t-0">
              <WeekScheduler
                projectId={projectId}
                readOnly={readOnly}
                onError={onError}
              />
            </div>
          ) : (
            <div className="flex items-center justify-center border-t bg-muted/30 p-5 text-sm text-muted-foreground lg:border-l lg:border-t-0">
              주차 스케줄링은 생성 이후에 설정할 수 있습니다.
            </div>
          )}
        </div>

        <div className="flex items-center justify-end gap-2 border-t bg-muted/30 px-5 py-3">
          <Button type="button" variant="outline" size="sm" onClick={onClose}>
            {readOnly ? "닫기" : "취소"}
          </Button>
          {!readOnly && (
            <Button
              type="button"
              size="sm"
              onClick={() => void handleSave()}
              loading={saving}
            >
              <span>{isEdit ? "변경 사항 저장" : "추가"}</span>
            </Button>
          )}
        </div>
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────
// Form fields
// ─────────────────────────────────────────────────────────────────────────

type FormProps = {
  form: UpsertFormState;
  onChange: <K extends keyof UpsertFormState>(
    key: K,
    value: UpsertFormState[K],
  ) => void;
  readOnly: boolean;
};

function ProjectForm({ form, onChange, readOnly }: FormProps) {
  return (
    <div className="flex flex-col gap-5">
      <section className="flex flex-col gap-3">
        <h3 className="inline-flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
          회사 · 직무
          <AdminHelpIconButton helpKey="admin.careerProjects.section.company" title="회사 · 직무" size="sm" />
        </h3>
        <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
          <Field
            label="회사명"
            value={form.companyName}
            onChange={(value) => onChange("companyName", value)}
            disabled={readOnly}
            helpKey="admin.careerProjects.field.companyName"
          />
          <Field
            label="회사 로고 URL"
            value={form.companyLogoUrl}
            onChange={(value) => onChange("companyLogoUrl", value)}
            disabled={readOnly}
            placeholder="https://…"
            helpKey="admin.careerProjects.field.companyLogoUrl"
          />
          <Field
            label="직무"
            value={form.jobPosition}
            onChange={(value) => onChange("jobPosition", value)}
            disabled={readOnly}
            helpKey="admin.careerProjects.field.jobPosition"
          />
        </div>
      </section>

      <section className="flex flex-col gap-3">
        <h3 className="inline-flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
          프로젝트
          <AdminHelpIconButton helpKey="admin.careerProjects.section.project" title="프로젝트" size="sm" />
        </h3>
        <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
          <Field
            label="프로젝트명"
            value={form.projectName}
            onChange={(value) => onChange("projectName", value)}
            disabled={readOnly}
            helpKey="admin.careerProjects.field.projectName"
          />
          <Field
            label="라인 코드"
            value={form.lineCode}
            onChange={(value) => onChange("lineCode", value)}
            disabled={readOnly}
            helpKey="admin.careerProjects.field.lineCode"
          />
          <Field
            label="라인명"
            value={form.lineName}
            onChange={(value) => onChange("lineName", value)}
            disabled={readOnly}
            helpKey="admin.careerProjects.field.lineName"
          />
          <Field
            label="2차 정보 마감(secondary_info_deadline)"
            value={form.secondaryInfoDeadline}
            onChange={(value) => onChange("secondaryInfoDeadline", value)}
            disabled={readOnly}
            type="datetime-local"
            helpKey="admin.careerProjects.field.secondaryInfoDeadline"
          />
        </div>
        <TextareaField
          label="프로젝트 설명"
          value={form.projectDescription}
          onChange={(value) => onChange("projectDescription", value)}
          disabled={readOnly}
          rows={3}
          helpKey="admin.careerProjects.field.projectDescription"
        />
      </section>

      <section className="flex flex-col gap-3">
        <h3 className="inline-flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
          슈퍼바이저
          <AdminHelpIconButton helpKey="admin.careerProjects.section.supervisor" title="슈퍼바이저" size="sm" />
        </h3>
        <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
          <Field
            label="이름"
            value={form.supervisorName}
            onChange={(value) => onChange("supervisorName", value)}
            disabled={readOnly}
            helpKey="admin.careerProjects.field.supervisorName"
          />
          <Field
            label="직책"
            value={form.supervisorPosition}
            onChange={(value) => onChange("supervisorPosition", value)}
            disabled={readOnly}
            helpKey="admin.careerProjects.field.supervisorPosition"
          />
          <Field
            label="부서"
            value={form.supervisorDepartment}
            onChange={(value) => onChange("supervisorDepartment", value)}
            disabled={readOnly}
            helpKey="admin.careerProjects.field.supervisorDepartment"
          />
          <Field
            label="회사"
            value={form.supervisorCompany}
            onChange={(value) => onChange("supervisorCompany", value)}
            disabled={readOnly}
            helpKey="admin.careerProjects.field.supervisorCompany"
          />
          <Field
            label="프로필 이미지 URL"
            value={form.supervisorProfileImg}
            onChange={(value) => onChange("supervisorProfileImg", value)}
            disabled={readOnly}
            placeholder="https://…"
            helpKey="admin.careerProjects.field.supervisorProfileImg"
          />
        </div>
      </section>

      <section className="flex flex-col gap-3">
        <h3 className="inline-flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
          2차 정보 (JSON)
          <AdminHelpIconButton helpKey="admin.careerProjects.section.secondaryInfo" title="2차 정보 (JSON)" size="sm" />
        </h3>
        <p className="text-xs text-muted-foreground">
          각 필드는 유효한 JSON 문자열이어야 합니다. 비우면 빈 배열로 저장됩니다.
        </p>
        <TextareaField
          label="output_links"
          value={form.outputLinks}
          onChange={(value) => onChange("outputLinks", value)}
          disabled={readOnly}
          rows={4}
          mono
          helpKey="admin.careerProjects.field.outputLinks"
        />
        <TextareaField
          label="output_images"
          value={form.outputImages}
          onChange={(value) => onChange("outputImages", value)}
          disabled={readOnly}
          rows={4}
          mono
          helpKey="admin.careerProjects.field.outputImages"
        />
        <TextareaField
          label="company_homepage_links"
          value={form.companyHomepageLinks}
          onChange={(value) => onChange("companyHomepageLinks", value)}
          disabled={readOnly}
          rows={4}
          mono
          helpKey="admin.careerProjects.field.companyHomepageLinks"
        />
      </section>
    </div>
  );
}

function Field({
  label,
  value,
  onChange,
  disabled,
  placeholder,
  type = "text",
  helpKey,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  disabled?: boolean;
  placeholder?: string;
  type?: string;
  helpKey?: string;
}) {
  return (
    <div className="flex flex-col gap-1.5">
      <Label className="inline-flex items-center gap-1 text-xs">
        {label}
        {helpKey && <AdminHelpIconButton helpKey={helpKey} title={label} size="xs" />}
      </Label>
      <Input
        value={value}
        onChange={(event) => onChange(event.target.value)}
        disabled={disabled}
        placeholder={placeholder}
        type={type}
      />
    </div>
  );
}

function TextareaField({
  label,
  value,
  onChange,
  disabled,
  rows = 3,
  mono = false,
  helpKey,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  disabled?: boolean;
  rows?: number;
  mono?: boolean;
  helpKey?: string;
}) {
  return (
    <div className="flex flex-col gap-1.5">
      <Label className="inline-flex items-center gap-1 text-xs">
        {label}
        {helpKey && <AdminHelpIconButton helpKey={helpKey} title={label} size="xs" />}
      </Label>
      <textarea
        value={value}
        onChange={(event) => onChange(event.target.value)}
        disabled={disabled}
        rows={rows}
        className={cn(
          "flex w-full rounded-md border border-input bg-transparent px-3 py-2 text-sm shadow-sm placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-60",
          mono && "font-mono text-[12px] leading-relaxed",
        )}
      />
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────
// Week Scheduler — 우측 패널.
// ─────────────────────────────────────────────────────────────────────────

function WeekScheduler({
  projectId,
  readOnly,
  onError,
}: {
  projectId: string;
  readOnly: boolean;
  onError: (message: string) => void;
}) {
  const [states, setStates] = useState<CareerProjectWeekStateDto[] | null>(null);
  const [loading, setLoading] = useState(true);
  useReportLoading(loading);
  const [pending, setPending] = useState<Set<string>>(new Set());
  const [reloadTick, setReloadTick] = useState(0);

  // 주차 상태 로드 — useEffect 안에서 정의하여 effect-내 setState 경고 회피.
  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      setLoading(true);
      try {
        const res = await fetch(
          `/api/admin/career-projects/${encodeURIComponent(projectId)}/weeks`,
          { cache: "no-store" },
        );
        const json = await res.json();
        if (!res.ok || !json.success) {
          throw new Error(
            (json && typeof json.error === "string" && json.error) ||
              `HTTP ${res.status}`,
          );
        }
        if (cancelled) return;
        const next = (json.data?.states ?? []) as CareerProjectWeekStateDto[];
        next.sort((a, b) => weekStartsAt(a.weekRow) - weekStartsAt(b.weekRow));
        setStates(next);
      } catch (err) {
        if (cancelled) return;
        onError(err instanceof Error ? err.message : "주차 목록 로드 실패");
        setStates([]);
      } finally {
        if (!cancelled) setLoading(false);
      }
    };
    void load();
    return () => {
      cancelled = true;
    };
  }, [projectId, reloadTick, onError]);

  const callPatch = useCallback(
    async (weekId: string, body: Record<string, unknown>) => {
      setPending((prev) => {
        const next = new Set(prev);
        next.add(weekId);
        return next;
      });
      try {
        const res = await fetch(
          `/api/admin/career-projects/${encodeURIComponent(projectId)}/weeks`,
          {
            method: "PATCH",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(body),
          },
        );
        const json = await res.json().catch(() => ({}));
        if (!res.ok || !json.success) {
          const message =
            (json && typeof json.error === "string" && json.error) ||
            `HTTP ${res.status}`;
          throw new Error(message);
        }
        setReloadTick((n) => n + 1);
      } catch (err) {
        onError(err instanceof Error ? err.message : "주차 업데이트 실패");
      } finally {
        setPending((prev) => {
          const next = new Set(prev);
          next.delete(weekId);
          return next;
        });
      }
    },
    [projectId, onError],
  );

  const attachedCount = useMemo(
    () => (states ?? []).filter((s) => s.attached).length,
    [states],
  );
  const activeCount = useMemo(
    () => (states ?? []).filter((s) => s.attached && s.isActive).length,
    [states],
  );

  return (
    <div className="flex h-full max-h-[80vh] flex-col">
      <div className="border-b px-5 py-3">
        <h3 className="inline-flex items-center gap-1.5 text-sm font-semibold">
          주차 스케줄
          <AdminHelpIconButton helpKey="admin.careerProjects.section.weekSchedule" title="주차 스케줄" size="sm" />
        </h3>
        <p className="text-xs text-muted-foreground">
          전체 주차 위에 연결/활성 상태를 토글합니다. 연결: 행 존재, 활성: is_active=true.
        </p>
        <div className="mt-2 flex gap-3 text-xs text-muted-foreground">
          <span className="inline-flex items-center gap-1">
            연결 {attachedCount}
            <AdminHelpIconButton helpKey="admin.careerProjects.stat.attached" title="연결" size="xs" />
          </span>
          <span className="inline-flex items-center gap-1">
            활성 {activeCount}
            <AdminHelpIconButton helpKey="admin.careerProjects.stat.active" title="활성" size="xs" />
          </span>
        </div>
      </div>
      <div className="flex-1 overflow-y-auto p-3">
        {loading || states === null ? (
          <LoadingState active />
        ) : states.length === 0 ? (
          <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
            등록된 주차가 없습니다.
          </div>
        ) : (
          <ul className="flex flex-col gap-1">
            {states.map((state) => {
              const isPending = pending.has(state.weekId);
              return (
                <li
                  key={state.weekId}
                  className={cn(
                    "flex items-center justify-between rounded-md border px-2 py-1.5 text-sm",
                    state.attached
                      ? state.isActive
                        ? "border-emerald-200 bg-emerald-50/60"
                        : "border-border bg-muted/60"
                      : "border-border bg-background",
                  )}
                >
                  <div className="min-w-0">
                    <div className="truncate font-medium">
                      {weekLabel(state.weekRow)}
                    </div>
                    <div className="truncate text-[11px] font-mono text-muted-foreground">
                      {state.weekId.slice(0, 8)}
                    </div>
                  </div>
                  <div className="flex items-center gap-1.5">
                    {state.attached ? (
                      <>
                        <Button
                          type="button"
                          variant="outline"
                          size="sm"
                          disabled={readOnly || isPending}
                          onClick={() =>
                            void callPatch(state.weekId, {
                              action: "set_active",
                              week_id: state.weekId,
                              is_active: !state.isActive,
                            })
                          }
                        >
                          {state.isActive ? "비활성" : "활성"}
                        </Button>
                        <Button
                          type="button"
                          variant="outline"
                          size="sm"
                          disabled={readOnly || isPending}
                          onClick={() =>
                            void callPatch(state.weekId, {
                              action: "detach",
                              week_id: state.weekId,
                            })
                          }
                          className="text-rose-700 hover:bg-rose-50 hover:text-rose-800"
                        >
                          연결 해제
                        </Button>
                      </>
                    ) : (
                      <Button
                        type="button"
                        size="sm"
                        disabled={readOnly || isPending}
                        onClick={() =>
                          void callPatch(state.weekId, {
                            action: "attach",
                            week_id: state.weekId,
                            is_active: true,
                          })
                        }
                      >
                        연결
                      </Button>
                    )}
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </div>
  );
}
