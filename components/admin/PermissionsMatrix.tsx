"use client";

import { Fragment, useCallback, useEffect, useMemo, useState } from "react";
import { RefreshCw, Timer } from "lucide-react";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
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
import {
  USER_FACING_ROLES,
  type PermissionDto,
  type PermissionsMatrixDto,
  type RoleMatrix,
  type UserFacingRole,
} from "@/lib/adminPermissionsTypes";

// /admin/settings/permissions — 권한 설정 UI.
//   GET /api/admin/permissions     로 카탈로그 + 매트릭스 일괄 조회
//   PATCH /api/admin/permissions/[key]  로 단건 cell 토글 (super_admin 단독)
//
// 본 컴포넌트는 권한 정책의 "설정 UI" 만 담당한다. 실제 Cluster1~3 API gate /
// 프론트 분기 연결은 별도 단계에서 진행한다 (요구사항).

const ROLE_LABELS: Record<UserFacingRole, string> = {
  crew: "Crew",
  ambassador: "Ambassador",
  agent: "Agent",
  part_leader: "Part Leader",
  team_leader: "Team Leader",
  admin: "Admin",
  super_admin: "Super Admin",
};

const CLUSTER_LABELS: Record<string, string> = {
  cluster1: "Cluster 1",
  cluster2: "Cluster 2",
  cluster3: "Cluster 3",
};

type Banner = { kind: "success" | "error"; message: string } | null;

function cellKey(role: UserFacingRole, permissionKey: string) {
  return role + ":" + permissionKey;
}

function isAllowed(matrix: RoleMatrix, key: string, role: UserFacingRole) {
  return matrix[key]?.[role] === true;
}

export default function PermissionsMatrix() {
  const [permissions, setPermissions] = useState<PermissionDto[]>([]);
  const [matrix, setMatrix] = useState<RoleMatrix>({});
  const [isSuperAdmin, setIsSuperAdmin] = useState(false);
  const [loading, setLoading] = useState(true);
  useReportLoading(loading);
  const [error, setError] = useState<string | null>(null);
  const [banner, setBanner] = useState<Banner>(null);
  const [clusterFilter, setClusterFilter] = useState<string>("all");
  const [pending, setPending] = useState<Set<string>>(() => new Set());
  const [refreshTick, setRefreshTick] = useState(0);

  // ── load ─────────────────────────────────────────────────────────
  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      setLoading(true);
      setError(null);
      try {
        const res = await fetch("/api/admin/permissions", { cache: "no-store" });
        const json = await res.json();
        if (!res.ok || !json.success) {
          throw new Error(json?.error ?? "Failed to load permissions");
        }
        if (cancelled) return;
        const data = json.data as PermissionsMatrixDto;
        setPermissions(data.permissions);
        setMatrix(data.matrix);
        setIsSuperAdmin(data.isSuperAdmin);
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : "Failed to load");
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    };
    void load();
    return () => {
      cancelled = true;
    };
  }, [refreshTick]);

  // ── banner auto-dismiss ─────────────────────────────────────────
  useEffect(() => {
    if (!banner) return;
    const t = window.setTimeout(() => setBanner(null), 4500);
    return () => window.clearTimeout(t);
  }, [banner]);

  // ── derive ──────────────────────────────────────────────────────
  const clusterOptions = useMemo(() => {
    const seen = new Set<string>();
    for (const p of permissions) seen.add(p.cluster);
    return Array.from(seen).sort();
  }, [permissions]);

  const visiblePermissions = useMemo(() => {
    if (clusterFilter === "all") return permissions;
    return permissions.filter((p) => p.cluster === clusterFilter);
  }, [permissions, clusterFilter]);

  // permissions 는 GET 에서 sort_order 오름차순으로 정렬돼서 옴 →
  // 같은 cluster row 들은 자연스럽게 인접 → 그룹화는 단순 reduce.
  const groups = useMemo(() => {
    const map = new Map<string, PermissionDto[]>();
    for (const p of visiblePermissions) {
      const arr = map.get(p.cluster) ?? [];
      arr.push(p);
      map.set(p.cluster, arr);
    }
    return Array.from(map.entries());
  }, [visiblePermissions]);

  // ── toggle handler (optimistic + revert on failure) ─────────────
  const handleToggle = useCallback(
    async (permission: PermissionDto, role: UserFacingRole) => {
      if (!isSuperAdmin) return;
      const ck = cellKey(role, permission.key);
      if (pending.has(ck)) return;

      const prevValue = isAllowed(matrix, permission.key, role);
      const newValue = !prevValue;

      setMatrix((prev) => ({
        ...prev,
        [permission.key]: { ...(prev[permission.key] ?? {}), [role]: newValue },
      }));
      setPending((prev) => {
        const next = new Set(prev);
        next.add(ck);
        return next;
      });

      try {
        const res = await fetch(
          "/api/admin/permissions/" + encodeURIComponent(permission.key),
          {
            method: "PATCH",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ role, is_allowed: newValue }),
          },
        );
        const json = await res.json();
        if (!res.ok || !json.success) {
          throw new Error(json?.error ?? "Failed to save");
        }
        setBanner({
          kind: "success",
          message:
            permission.label +
            " · " +
            ROLE_LABELS[role] +
            ": " +
            (newValue ? "허용" : "차단"),
        });
      } catch (err) {
        // revert
        setMatrix((prev) => ({
          ...prev,
          [permission.key]: {
            ...(prev[permission.key] ?? {}),
            [role]: prevValue,
          },
        }));
        setBanner({
          kind: "error",
          message: err instanceof Error ? err.message : "Failed to save",
        });
      } finally {
        setPending((prev) => {
          const next = new Set(prev);
          next.delete(ck);
          return next;
        });
      }
    },
    [isSuperAdmin, matrix, pending],
  );

  // ── render ──────────────────────────────────────────────────────
  return (
    <div className="flex flex-col gap-6">
      <div className="flex items-end justify-between gap-3">
        <div>
          <h2 className="text-2xl font-semibold tracking-tight">권한 설정</h2>
          <p className="text-sm text-muted-foreground">
            회원 역할별로 어떤 작업을 허용할지 설정합니다. 변경은 최고 관리자만 가능합니다.
          </p>
        </div>
        <Button
          variant="outline"
          onClick={() => setRefreshTick((n) => n + 1)}
          disabled={loading}
        >
          <RefreshCw className={cn("h-4 w-4", loading && "animate-spin")} />
          새로고침
        </Button>
      </div>

      {!loading && !isSuperAdmin && (
        <div className="rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800">
          🔒 조회 전용 — 권한 설정 변경은 최고 관리자만 가능합니다.
        </div>
      )}

      {banner && (
        <div
          className={cn(
            "rounded-lg border px-4 py-3 text-sm",
            banner.kind === "success"
              ? "border-emerald-200 bg-emerald-50 text-emerald-700"
              : "border-red-200 bg-red-50 text-red-700",
          )}
        >
          {banner.message}
        </div>
      )}

      <Card>
        <CardHeader>
          <CardTitle className="text-base">역할별 권한</CardTitle>
          <CardDescription>
            오른쪽 스위치를 눌러 허용/차단을 바꿉니다. 시계 아이콘이 붙은 권한은 별도로 작성 기간을 열어줘야 실제로 동작합니다.
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          <div className="flex flex-wrap items-end gap-4">
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="cluster-filter">Cluster 필터</Label>
              <Select
                value={clusterFilter}
                onValueChange={(value: string | null) =>
                  setClusterFilter(value ?? "all")
                }
              >
                <SelectTrigger id="cluster-filter" className="w-48">
                  <SelectValue>
                    {clusterFilter === "all"
                      ? "전체"
                      : CLUSTER_LABELS[clusterFilter] ?? clusterFilter}
                  </SelectValue>
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">전체</SelectItem>
                  {clusterOptions.map((c) => (
                    <SelectItem key={c} value={c}>
                      {CLUSTER_LABELS[c] ?? c}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
              <Timer className="h-3.5 w-3.5 text-amber-600" />
              <span>= 작성 기간을 별도로 열어줘야 동작</span>
            </div>
          </div>

          {error && (
            <div className="rounded-md border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
              {error}
            </div>
          )}

          <div className="overflow-x-auto rounded-lg border">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="sticky left-0 z-20 bg-card min-w-[280px]">
                    권한
                  </TableHead>
                  {USER_FACING_ROLES.map((role) => (
                    <TableHead
                      key={role}
                      className="whitespace-nowrap text-center"
                    >
                      {ROLE_LABELS[role]}
                    </TableHead>
                  ))}
                </TableRow>
              </TableHeader>
              <TableBody>
                {groups.map(([cluster, perms]) => (
                  <Fragment key={cluster}>
                    <TableRow className="bg-muted/40 hover:bg-muted/40">
                      <TableCell
                        colSpan={USER_FACING_ROLES.length + 1}
                        className="py-2 text-xs font-semibold uppercase tracking-wider text-muted-foreground"
                      >
                        {CLUSTER_LABELS[cluster] ?? cluster}
                      </TableCell>
                    </TableRow>
                    {perms.map((perm) => (
                      <TableRow key={perm.key}>
                        <TableCell className="sticky left-0 z-10 bg-card">
                          <div className="flex items-center gap-1.5">
                            <span className="font-medium">{perm.label}</span>
                            {perm.requiresEditWindow && (
                              <Timer
                                className="h-3.5 w-3.5 text-amber-600"
                                aria-label="작성 기간 필요"
                              />
                            )}
                          </div>
                          <div className="font-mono text-[10px] text-muted-foreground">
                            {perm.key}
                          </div>
                        </TableCell>
                        {USER_FACING_ROLES.map((role) => {
                          const value = isAllowed(matrix, perm.key, role);
                          const ck = cellKey(role, perm.key);
                          const isPending = pending.has(ck);
                          return (
                            <TableCell key={role} className="text-center">
                              <ToggleSwitch
                                checked={value}
                                disabled={!isSuperAdmin}
                                pending={isPending}
                                onClick={() => void handleToggle(perm, role)}
                                ariaLabel={
                                  perm.label + " · " + ROLE_LABELS[role]
                                }
                              />
                            </TableCell>
                          );
                        })}
                      </TableRow>
                    ))}
                  </Fragment>
                ))}

                {!loading && permissions.length === 0 && !error && (
                  <TableRow>
                    <TableCell
                      colSpan={USER_FACING_ROLES.length + 1}
                      className="py-10 text-center text-muted-foreground"
                    >
                      등록된 권한이 없습니다.
                    </TableCell>
                  </TableRow>
                )}
                {loading && permissions.length === 0 && (
                  <TableSkeletonRows columns={USER_FACING_ROLES.length + 1} rows={6} />
                )}
              </TableBody>
            </Table>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}

function ToggleSwitch({
  checked,
  disabled,
  pending,
  onClick,
  ariaLabel,
}: {
  checked: boolean;
  disabled: boolean;
  pending: boolean;
  onClick: () => void;
  ariaLabel: string;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={ariaLabel}
      disabled={disabled || pending}
      onClick={onClick}
      className={cn(
        "relative inline-flex h-5 w-9 shrink-0 items-center rounded-full transition-colors",
        checked ? "bg-emerald-500" : "bg-muted",
        (disabled || pending) && "cursor-not-allowed opacity-50",
        !disabled && !pending && "hover:opacity-90",
        pending && "animate-pulse",
      )}
    >
      <span
        className={cn(
          "inline-block h-4 w-4 transform rounded-full bg-white shadow transition-transform",
          checked ? "translate-x-[1.125rem]" : "translate-x-0.5",
        )}
        aria-hidden
      />
    </button>
  );
}
