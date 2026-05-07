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
  updatedAt?: string;
};

const ALL = "__all__";
const VISIBILITY_OPTIONS = [
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
        throw new Error(json?.error ?? "Failed to load crews.");
      }
      setData((json.data ?? []) as Crew[]);
    } catch (err) {
      setBanner({
        kind: "error",
        message: err instanceof Error ? err.message : "Failed to load crews.",
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

  const openEdit = (crew: Crew) => {
    setEditing(crew);
    setForm({
      legacy_user_id: String(crew.legacyUserId),
      display_name: crew.displayName ?? "",
      team_name: crew.teamName ?? "",
      part_name: crew.partName ?? "",
      cumulative_weeks:
        crew.cumulativeWeeks == null ? "0" : String(crew.cumulativeWeeks),
      is_visible: crew.isVisible,
      admin_note: crew.adminNote ?? "",
      organization_slug: isOrganizationSlug(crew.organizationSlug)
        ? crew.organizationSlug
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
      setBanner({ kind: "error", message: "legacy_user_id is required." });
      return;
    }

    if (!form.display_name.trim()) {
      setBanner({ kind: "error", message: "display_name is required." });
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
        throw new Error(json?.error ?? "Failed to save crew.");
      }

      setBanner({
        kind: "success",
        message: json.warning
          ? `${editing ? "Updated" : "Created"}. ${json.warning}`
          : editing
            ? "Updated."
            : "Created.",
      });
      setModalOpen(false);
      await refresh(organization);
    } catch (err) {
      setBanner({
        kind: "error",
        message: err instanceof Error ? err.message : "Failed to save crew.",
      });
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
        throw new Error(json?.error ?? "Failed to change visibility.");
      }
      setBanner({
        kind: "success",
        message: next ? "Marked visible." : "Marked hidden.",
      });
      await refresh(organization);
    } catch (err) {
      setBanner({
        kind: "error",
        message:
          err instanceof Error ? err.message : "Failed to change visibility.",
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
        <StatCard label="Organization" value={ORGANIZATION_LABEL[organization]} isText />
        <StatCard label="Total Crews" value={data.length} />
        <StatCard label="Visible" value={visibleCount} />
        <StatCard label="Filtered" value={filtered.length} />
      </div>

      <Card>
        <CardHeader className="flex flex-row items-center justify-between">
          <CardTitle>{ORGANIZATION_LABEL[organization]} Crews</CardTitle>
          <Button onClick={openCreate} size="sm">
            <Plus className="h-4 w-4" />
            Add Crew
          </Button>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          <div className="flex flex-wrap items-center gap-2">
            <div className="relative w-full sm:w-64">
              <Search className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
              <Input
                value={search}
                onChange={(event) => setSearch(event.target.value)}
                placeholder="Search name"
                className="pl-8"
              />
            </div>

            <Select value={team} onValueChange={(value) => setTeam(value ?? ALL)}>
              <SelectTrigger className="w-40">
                <SelectValue placeholder="All teams" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={ALL}>All teams</SelectItem>
                {teams.map((value) => (
                  <SelectItem key={value} value={value}>
                    {value}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>

            <Select value={part} onValueChange={(value) => setPart(value ?? ALL)}>
              <SelectTrigger className="w-40">
                <SelectValue placeholder="All parts" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={ALL}>All parts</SelectItem>
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
                <SelectValue placeholder="Visibility" />
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

          <div className="overflow-x-auto rounded-md border">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="w-16">Status</TableHead>
                  <TableHead>Name</TableHead>
                  <TableHead>Gender</TableHead>
                  <TableHead>Birth Date</TableHead>
                  <TableHead>Contact</TableHead>
                  <TableHead>Email</TableHead>
                  <TableHead>School</TableHead>
                  <TableHead>Department</TableHead>
                  <TableHead>Team</TableHead>
                  <TableHead>Part</TableHead>
                  <TableHead>Level</TableHead>
                  <TableHead>State</TableHead>
                  <TableHead className="text-right">Cumulative</TableHead>
                  <TableHead className="text-right">Approved</TableHead>
                  <TableHead>Organization</TableHead>
                  <TableHead>Admin Note</TableHead>
                  <TableHead className="w-32 text-right">Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {filtered.map((crew) => (
                  <TableRow
                    key={String(crew.legacyUserId)}
                    className={cn(!crew.isVisible && "opacity-60")}
                  >
                    <TableCell>
                      <span
                        className={cn(
                          "inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium",
                          crew.isVisible
                            ? "bg-emerald-100 text-emerald-900"
                            : "bg-muted text-muted-foreground",
                        )}
                      >
                        {crew.isVisible ? "Visible" : "Hidden"}
                      </span>
                    </TableCell>
                    <TableCell className="font-medium">{crew.displayName}</TableCell>
                    <TableCell>{formatValue(crew.gender)}</TableCell>
                    <TableCell>{formatBirthDate(crew)}</TableCell>
                    <TableCell>{formatValue(crew.contactPhone)}</TableCell>
                    <TableCell>{formatValue(crew.contactEmail)}</TableCell>
                    <TableCell>{formatValue(crew.schoolName)}</TableCell>
                    <TableCell>{formatValue(crew.departmentName ?? crew.majorName)}</TableCell>
                    <TableCell>{formatValue(crew.teamName)}</TableCell>
                    <TableCell>{formatValue(crew.partName)}</TableCell>
                    <TableCell>{formatValue(crew.membershipLevel)}</TableCell>
                    <TableCell>{formatValue(crew.membershipState)}</TableCell>
                    <TableCell className="text-right">
                      {formatValue(crew.cumulativeWeeks)}
                    </TableCell>
                    <TableCell className="text-right">
                      {formatValue(crew.approvedWeeks)}
                    </TableCell>
                    <TableCell>{formatValue(crew.organizationSlug)}</TableCell>
                    <TableCell
                      className="max-w-[240px] truncate text-muted-foreground"
                      title={crew.adminNote ?? ""}
                    >
                      {crew.adminNote ?? ""}
                    </TableCell>
                    <TableCell className="text-right">
                      <div className="flex justify-end gap-1">
                        <Button
                          variant="ghost"
                          size="icon-sm"
                          onClick={() => openEdit(crew)}
                          aria-label="Edit"
                        >
                          <Pencil className="h-3.5 w-3.5" />
                        </Button>
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
                      No crews found.
                    </TableCell>
                  </TableRow>
                )}

                {loading && (
                  <TableRow>
                    <TableCell
                      colSpan={17}
                      className="h-24 text-center text-muted-foreground"
                    >
                      Loading crews...
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
        aria-label={isEdit ? "Edit crew" : "Add crew"}
        className="w-full max-w-4xl rounded-xl bg-background p-5 shadow-lg ring-1 ring-foreground/10"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="mb-4 flex items-center justify-between">
          <h2 className="text-base font-semibold">
            {isEdit ? "Edit Crew" : "Add Crew"}{" "}
            <span className="text-sm font-normal text-muted-foreground">
              @ {ORGANIZATION_LABEL[organization]}
            </span>
          </h2>
          <Button
            variant="ghost"
            size="icon-sm"
            onClick={onClose}
            aria-label="Close"
            disabled={submitting}
          >
            <X className="h-4 w-4" />
          </Button>
        </div>

        <form onSubmit={onSubmit} className="flex flex-col gap-4">
          {editing && (
            <div className="grid grid-cols-1 gap-3 rounded-lg border bg-muted/20 p-3 text-sm sm:grid-cols-2 lg:grid-cols-3">
              <ReadonlyField label="Name" value={editing.displayName} />
              <ReadonlyField label="Gender" value={editing.gender} />
              <ReadonlyField label="Birth Date" value={formatBirthDate(editing)} />
              <ReadonlyField label="Contact" value={editing.contactPhone} />
              <ReadonlyField label="Email" value={editing.contactEmail} />
              <ReadonlyField
                label="School / Department"
                value={editing.universityMajor ?? editing.schoolName ?? editing.departmentName}
              />
              <ReadonlyField label="Team" value={editing.teamName} />
              <ReadonlyField label="Part" value={editing.partName} />
              <ReadonlyField label="Level" value={editing.membershipLevel} />
              <ReadonlyField label="State" value={editing.membershipState} />
              <ReadonlyField label="Cumulative Weeks" value={editing.cumulativeWeeks} />
              <ReadonlyField label="Approved Weeks" value={editing.approvedWeeks} />
              <ReadonlyField label="Organization" value={editing.organizationSlug} />
            </div>
          )}

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
                placeholder="Mapped user_profiles account id"
                required
              />
            </Field>

            <Field label="Display Name" required>
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

            <Field label="Team">
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

            <Field label="Part">
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

            <Field label="Organization" required>
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
                  <SelectValue placeholder="Select organization" />
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

            <Field label="Cumulative Weeks">
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

            <Field label="Visibility">
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
                Expose on user app `/crews`
              </label>
            </Field>
          </div>

          <Field label="Admin Note">
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
              placeholder="Internal note not shown to end users"
            />
          </Field>

          <div className="mt-2 flex justify-end gap-2">
            <Button
              type="button"
              variant="ghost"
              onClick={onClose}
              disabled={submitting}
            >
              Cancel
            </Button>
            <Button type="submit" disabled={submitting}>
              {submitting ? "Saving..." : "Save"}
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
