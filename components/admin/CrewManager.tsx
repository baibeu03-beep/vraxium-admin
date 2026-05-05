"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { Eye, EyeOff, Pencil, Plus, Search, X } from "lucide-react";
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
import { cn } from "@/lib/utils";
import {
  ORGANIZATIONS,
  ORGANIZATION_LABEL,
  isOrganizationSlug,
  type OrganizationSlug,
} from "@/lib/organizations";

type Crew = {
  legacy_user_id: string;
  display_name: string;
  team_name: string | null;
  part_name: string | null;
  cumulative_weeks: number | null;
  is_visible: boolean;
  admin_note: string | null;
  organization_slug: string | null;
  updated_at?: string;
};

const ALL = "__all__";
const VISIBILITY_OPTIONS = [
  { value: ALL, label: "전체" },
  { value: "visible", label: "표시" },
  { value: "hidden", label: "숨김" },
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
  const [data, setData] = useState<Crew[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState("");
  const [team, setTeam] = useState<string>(ALL);
  const [part, setPart] = useState<string>(ALL);
  const [visibility, setVisibility] = useState<string>(ALL);
  const [banner, setBanner] = useState<Banner>(null);
  const [modalOpen, setModalOpen] = useState(false);
  const [editing, setEditing] = useState<Crew | null>(null);
  const [form, setForm] = useState<FormState>(() => createEmptyForm(organization));
  const [submitting, setSubmitting] = useState(false);

  const refresh = useCallback(async (org: OrganizationSlug) => {
    setLoading(true);
    try {
      const res = await fetch(
        `/api/admin/crews?organization=${encodeURIComponent(org)}`,
        { cache: "no-store" },
      );
      const json = await res.json();
      if (!res.ok || !json.success) {
        throw new Error(json?.error ?? "목록을 불러오지 못했습니다.");
      }
      setData((json.data ?? []) as Crew[]);
    } catch (err) {
      setBanner({
        kind: "error",
        message:
          err instanceof Error ? err.message : "목록을 불러오지 못했습니다.",
      });
    } finally {
      setLoading(false);
    }
  }, []);

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
      Array.from(new Set(data.map((crew) => crew.team_name).filter(Boolean))) as string[],
    [data],
  );
  const parts = useMemo(
    () =>
      Array.from(new Set(data.map((crew) => crew.part_name).filter(Boolean))) as string[],
    [data],
  );

  const filtered = useMemo(() => {
    const query = search.trim().toLowerCase();
    return data.filter((crew) => {
      if (team !== ALL && crew.team_name !== team) return false;
      if (part !== ALL && crew.part_name !== part) return false;
      if (visibility === "visible" && !crew.is_visible) return false;
      if (visibility === "hidden" && crew.is_visible) return false;
      if (query && !crew.display_name?.toLowerCase().includes(query)) return false;
      return true;
    });
  }, [data, part, search, team, visibility]);

  const visibleCount = useMemo(
    () => data.filter((crew) => crew.is_visible).length,
    [data],
  );

  const openCreate = () => {
    setEditing(null);
    setForm(createEmptyForm(organization));
    setModalOpen(true);
  };

  const openEdit = (crew: Crew) => {
    setEditing(crew);
    setForm({
      legacy_user_id: String(crew.legacy_user_id),
      display_name: crew.display_name ?? "",
      team_name: crew.team_name ?? "",
      part_name: crew.part_name ?? "",
      cumulative_weeks:
        crew.cumulative_weeks == null ? "0" : String(crew.cumulative_weeks),
      is_visible: crew.is_visible,
      admin_note: crew.admin_note ?? "",
      organization_slug: isOrganizationSlug(crew.organization_slug)
        ? crew.organization_slug
        : organization,
    });
    setModalOpen(true);
  };

  const closeModal = () => {
    if (submitting) return;
    setModalOpen(false);
  };

  const handleSubmit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (submitting) return;

    if (!form.legacy_user_id.trim()) {
      setBanner({ kind: "error", message: "legacy_user_id는 필수입니다." });
      return;
    }
    if (!form.display_name.trim()) {
      setBanner({ kind: "error", message: "이름은 필수입니다." });
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

    if (editing) {
      console.log("[CrewManager] PATCH payload", payload);
    } else {
      console.log("[CrewManager] POST payload", payload);
    }

    setSubmitting(true);
    try {
      const url = editing
        ? `/api/admin/crews/${encodeURIComponent(String(editing.legacy_user_id))}`
        : "/api/admin/crews";
      const method = editing ? "PATCH" : "POST";

      const res = await fetch(url, {
        method,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const json = await res.json();
      if (!res.ok || !json.success) {
        throw new Error(json?.error ?? "저장에 실패했습니다.");
      }

      setBanner({
        kind: "success",
        message: json.warning
          ? `${editing ? "수정" : "추가"} 완료. ${json.warning}`
          : editing
            ? "수정 완료"
            : "추가 완료",
      });
      setModalOpen(false);
      await refresh(organization);
    } catch (err) {
      setBanner({
        kind: "error",
        message: err instanceof Error ? err.message : "저장에 실패했습니다.",
      });
    } finally {
      setSubmitting(false);
    }
  };

  const toggleVisibility = async (crew: Crew) => {
    const next = !crew.is_visible;
    try {
      const res = await fetch(
        `/api/admin/crews/${encodeURIComponent(String(crew.legacy_user_id))}`,
        {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ is_visible: next }),
        },
      );
      const json = await res.json();
      if (!res.ok || !json.success) {
        throw new Error(json?.error ?? "변경에 실패했습니다.");
      }
      setBanner({
        kind: "success",
        message: next ? "표시 처리했습니다." : "숨김 처리했습니다.",
      });
      await refresh(organization);
    } catch (err) {
      setBanner({
        kind: "error",
        message: err instanceof Error ? err.message : "변경에 실패했습니다.",
      });
    }
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
        <StatCard label="조직" value={ORGANIZATION_LABEL[organization]} isText />
        <StatCard label="총 인원" value={data.length} />
        <StatCard label="표시 중" value={visibleCount} />
        <StatCard label="필터 결과" value={filtered.length} />
      </div>

      <Card>
        <CardHeader className="flex flex-row items-center justify-between">
          <CardTitle>{ORGANIZATION_LABEL[organization]} 크루 목록</CardTitle>
          <Button onClick={openCreate} size="sm">
            <Plus className="h-4 w-4" />
            신규 추가
          </Button>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          <div className="flex flex-wrap items-center gap-2">
            <div className="relative w-full sm:w-64">
              <Search className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
              <Input
                value={search}
                onChange={(event) => setSearch(event.target.value)}
                placeholder="이름 검색"
                className="pl-8"
              />
            </div>
            <Select value={team} onValueChange={(value) => setTeam(value ?? ALL)}>
              <SelectTrigger className="w-40">
                <SelectValue placeholder="전체 팀" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={ALL}>전체 팀</SelectItem>
                {teams.map((value) => (
                  <SelectItem key={value} value={value}>
                    {value}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Select value={part} onValueChange={(value) => setPart(value ?? ALL)}>
              <SelectTrigger className="w-40">
                <SelectValue placeholder="전체 파트" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={ALL}>전체 파트</SelectItem>
                {parts.map((value) => (
                  <SelectItem key={value} value={value}>
                    {value}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Select
              value={visibility}
              onValueChange={(value) => setVisibility(value ?? ALL)}
            >
              <SelectTrigger className="w-32">
                <SelectValue placeholder="표시 상태" />
              </SelectTrigger>
              <SelectContent>
                {VISIBILITY_OPTIONS.map((option) => (
                  <SelectItem key={option.value} value={option.value}>
                    {option.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="rounded-md border">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="w-16">상태</TableHead>
                  <TableHead>이름</TableHead>
                  <TableHead>팀</TableHead>
                  <TableHead>파트</TableHead>
                  <TableHead className="text-right">주차</TableHead>
                  <TableHead>관리자 메모</TableHead>
                  <TableHead className="w-32 text-right">작업</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {filtered.map((crew) => (
                  <TableRow
                    key={String(crew.legacy_user_id)}
                    className={cn(!crew.is_visible && "opacity-60")}
                  >
                    <TableCell>
                      <span
                        className={cn(
                          "inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium",
                          crew.is_visible
                            ? "bg-emerald-100 text-emerald-900"
                            : "bg-muted text-muted-foreground",
                        )}
                      >
                        {crew.is_visible ? "표시" : "숨김"}
                      </span>
                    </TableCell>
                    <TableCell className="font-medium">
                      {crew.display_name}
                    </TableCell>
                    <TableCell>{crew.team_name ?? "-"}</TableCell>
                    <TableCell>{crew.part_name ?? "-"}</TableCell>
                    <TableCell className="text-right">
                      {crew.cumulative_weeks ?? 0}
                    </TableCell>
                    <TableCell
                      className="max-w-[240px] truncate text-muted-foreground"
                      title={crew.admin_note ?? ""}
                    >
                      {crew.admin_note ?? ""}
                    </TableCell>
                    <TableCell className="text-right">
                      <div className="flex justify-end gap-1">
                        <Button
                          variant="ghost"
                          size="icon-sm"
                          onClick={() => openEdit(crew)}
                          aria-label="수정"
                        >
                          <Pencil className="h-3.5 w-3.5" />
                        </Button>
                        <Button
                          variant="ghost"
                          size="icon-sm"
                          onClick={() => toggleVisibility(crew)}
                          aria-label={crew.is_visible ? "숨김" : "표시"}
                        >
                          {crew.is_visible ? (
                            <EyeOff className="h-3.5 w-3.5" />
                          ) : (
                            <Eye className="h-3.5 w-3.5" />
                          )}
                        </Button>
                      </div>
                    </TableCell>
                  </TableRow>
                ))}
                {!loading && filtered.length === 0 && (
                  <TableRow>
                    <TableCell
                      colSpan={7}
                      className="h-24 text-center text-muted-foreground"
                    >
                      결과 없음
                    </TableCell>
                  </TableRow>
                )}
                {loading && (
                  <TableRow>
                    <TableCell
                      colSpan={7}
                      className="h-24 text-center text-muted-foreground"
                    >
                      불러오는 중...
                    </TableCell>
                  </TableRow>
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
          onClose={closeModal}
          onSubmit={handleSubmit}
        />
      )}
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
  onClose: () => void;
  onSubmit: (event: React.FormEvent) => void;
};

function CrewFormModal({
  editing,
  form,
  setForm,
  submitting,
  organization,
  onClose,
  onSubmit,
}: ModalProps) {
  const isEdit = Boolean(editing);

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
      onClick={onClose}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label={isEdit ? "크루 수정" : "크루 추가"}
        className="w-full max-w-lg rounded-xl bg-background p-5 shadow-lg ring-1 ring-foreground/10"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="mb-4 flex items-center justify-between">
          <h2 className="text-base font-semibold">
            {isEdit ? "크루 수정" : "크루 추가"}{" "}
            <span className="text-sm font-normal text-muted-foreground">
              · {ORGANIZATION_LABEL[organization]}
            </span>
          </h2>
          <Button
            variant="ghost"
            size="icon-sm"
            onClick={onClose}
            aria-label="닫기"
            disabled={submitting}
          >
            <X className="h-4 w-4" />
          </Button>
        </div>

        <form onSubmit={onSubmit} className="flex flex-col gap-3">
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <Field label="legacy_user_id" required>
              <Input
                value={form.legacy_user_id}
                onChange={(event) =>
                  setForm((current) => ({
                    ...current,
                    legacy_user_id: event.target.value,
                  }))
                }
                disabled={isEdit}
                placeholder="user_profiles와 매칭되는 계정 id"
                required
              />
            </Field>
            <Field label="이름" required>
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
            <Field label="팀">
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
            <Field label="파트">
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
            <Field label="조직" required>
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
                  <SelectValue placeholder="조직 선택" />
                </SelectTrigger>
                <SelectContent>
                  {ORGANIZATIONS.map((slug) => (
                    <SelectItem key={slug} value={slug}>
                      {ORGANIZATION_LABEL[slug]}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </Field>
            <Field label="누적 주차">
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
            <Field label="표시 여부">
              <label className="mt-1 inline-flex items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  checked={form.is_visible}
                  onChange={(event) =>
                    setForm((current) => ({
                      ...current,
                      is_visible: event.target.checked,
                    }))
                  }
                />
                User App `/crews`에 노출
              </label>
            </Field>
          </div>

          <Field label="관리자 메모">
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
              placeholder="사용자에게 노출되지 않는 내부 메모"
            />
          </Field>

          <div className="mt-2 flex justify-end gap-2">
            <Button
              type="button"
              variant="ghost"
              onClick={onClose}
              disabled={submitting}
            >
              취소
            </Button>
            <Button type="submit" disabled={submitting}>
              {submitting ? "저장 중..." : "저장"}
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
