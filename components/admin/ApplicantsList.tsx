"use client";

import { useEffect, useMemo, useState } from "react";
import {
  CheckCheck,
  CheckCircle2,
  RefreshCw,
  Search,
  UserPlus,
  UserX,
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
import { cn } from "@/lib/utils";
import { formatAdminDateTime } from "@/lib/adminDateTime";
import { APPLICANT_STATUSES } from "@/lib/adminApplicantTypes";
import { useAdminDevMode } from "@/components/admin/useAdminDevMode";
import { useConfirm } from "@/components/ui/confirm-dialog";
import { useReportLoading } from "@/components/admin/loadingBannerContext";
import { useActionToast } from "@/lib/actionToast";
import type { ScopeMode } from "@/lib/userScopeShared";
import { apiErrorFrom, getApiErrorMessage } from "@/lib/apiError";

type Applicant = {
  id: string;
  email: string | null;
  name: string | null;
  provider: string | null;
  status: "pending" | "approved" | "rejected";
  linkedUserId: string | null;
  linkedDisplayName: string | null;
  createdAt: string | null;
  updatedAt: string | null;
};

type UserProfileCandidate = {
  userId: string;
  displayName: string | null;
  contactEmail: string | null;
  authEmail: string | null;
  organizationSlug: string | null;
};

type Banner = { kind: "success" | "error"; message: string } | null;

const STATUS_ALL = "__all__";
const STATUS_DEFAULT = "pending";

function fmt(value: string | null | undefined) {
  return value?.trim() ? value : "-";
}

// createdAt·updatedAt 등 메타 시각 — 항상 서울 표준시(KST) "YYYY-MM-DD HH:mm:ss".
function fmtDate(value: string | null | undefined) {
  return formatAdminDateTime(value, { fallback: "-" });
}

function statusLabel(status: Applicant["status"]) {
  switch (status) {
    case "pending":
      return "대기";
    case "approved":
      return "승인";
    case "rejected":
      return "거절";
    default:
      return status;
  }
}

function statusBadgeClass(status: Applicant["status"]) {
  switch (status) {
    case "pending":
      return "bg-amber-100 text-amber-800 ring-amber-200";
    case "approved":
      return "bg-emerald-100 text-emerald-800 ring-emerald-200";
    case "rejected":
      return "bg-red-100 text-red-800 ring-red-200";
    default:
      return "bg-muted text-muted-foreground ring-border";
  }
}

export default function ApplicantsList({ mode }: { mode: ScopeMode }) {
  const confirm = useConfirm();
  const t = useActionToast();
  const devMode = useAdminDevMode();
  const [applicants, setApplicants] = useState<Applicant[]>([]);
  const [loading, setLoading] = useState(true);
  useReportLoading(loading);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [status, setStatus] = useState<string>(STATUS_DEFAULT);
  const [refreshTick, setRefreshTick] = useState(0);
  const [banner, setBanner] = useState<Banner>(null);
  const [approveTarget, setApproveTarget] = useState<Applicant | null>(null);
  const [rejectingId, setRejectingId] = useState<string | null>(null);
  const [approvingAll, setApprovingAll] = useState(false);

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      setLoading(true);
      setError(null);
      const params = new URLSearchParams();
      if (status !== STATUS_ALL) params.set("status", status);
      if (mode === "test") params.set("mode", mode);
      const url = `/api/admin/applicants${params.size ? `?${params}` : ""}`;
      try {
        const res = await fetch(url, { cache: "no-store" });
        const json = await res.json();
        if (!res.ok || !json.success) {
          throw apiErrorFrom(res, json, "가입 요청 목록을 불러오지 못했습니다.");
        }
        if (!cancelled) setApplicants((json.data ?? []) as Applicant[]);
      } catch (err) {
        if (!cancelled) {
          console.error("[applicants] load failed", err);
          setError(getApiErrorMessage(err, "가입 요청 목록을 불러오지 못했습니다."));
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    };
    void load();
    return () => {
      cancelled = true;
    };
  }, [mode, status, refreshTick]);

  useEffect(() => {
    if (!banner) return;
    const timer = window.setTimeout(() => setBanner(null), 4500);
    return () => window.clearTimeout(timer);
  }, [banner]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return applicants;
    return applicants.filter((applicant) => {
      const haystack = [
        applicant.email,
        applicant.name,
        applicant.provider,
        applicant.linkedUserId,
      ]
        .filter((value): value is string => Boolean(value))
        .map((value) => value.toLowerCase());
      return haystack.some((value) => value.includes(q));
    });
  }, [applicants, query]);

  const summary = loading
    ? "불러오는 중..."
    : `총 ${filtered.length}명${
        query.trim() && applicants.length !== filtered.length
          ? ` (전체 ${applicants.length}명 중 검색 결과)`
          : ""
      }`;

  const handleReject = async (applicant: Applicant) => {
    if (rejectingId || approveTarget) return;
    const confirmed = await confirm({
      title: "가입 거절",
      description: `${applicant.name ?? applicant.email ?? "이 신청자"}의 가입을 거절하시겠습니까?`,
      confirmLabel: "거절",
      tone: "destructive",
    });
    if (!confirmed) return;

    setRejectingId(applicant.id);
    try {
      const res = await fetch(
        `/api/admin/applicants/${encodeURIComponent(applicant.id)}/reject${mode === "test" ? "?mode=test" : ""}`,
        { method: "POST" },
      );
      const json = await res.json();
      if (!res.ok || !json.success) {
        throw apiErrorFrom(res, json, "가입 요청을 거절하지 못했습니다.");
      }
      t.success("reject", "가입을 거절했습니다.");
      setRefreshTick((n) => n + 1);
    } catch (err) {
      console.error("[applicants] reject failed", err);
      t.apiError("reject", err, "가입 요청을 거절하지 못했습니다.");
    } finally {
      setRejectingId(null);
    }
  };

  // 전체 승인 대상 = 현재 mode 스코프로 로드된 pending 지원자(서버 처리 모집단과 일치).
  // 클라이언트 검색어(query)는 표시 narrowing 일 뿐이므로 카운트/대상에 반영하지 않는다.
  const pendingCount = useMemo(
    () => applicants.filter((a) => a.status === "pending").length,
    [applicants],
  );

  const handleApproveAll = async () => {
    if (approvingAll || rejectingId || approveTarget) return;
    if (pendingCount === 0) {
      setBanner({ kind: "error", message: "승인 대기 중인 지원자가 없습니다." });
      return;
    }
    const confirmed = await confirm({
      title: "전체 승인",
      description: `현재 필터 조건의 승인 대기 지원자 ${pendingCount}명을 전체 승인하시겠습니까?`,
      confirmLabel: "전체 승인",
    });
    if (!confirmed) return;

    setApprovingAll(true);
    try {
      const res = await fetch(
        `/api/admin/applicants/approve-all${mode === "test" ? "?mode=test" : ""}`,
        { method: "POST" },
      );
      const json = await res.json();
      if (!res.ok || !json.ok) {
        throw new Error(json?.error ?? "전체 승인에 실패했습니다.");
      }
      const { succeeded = 0, failed = 0 } = json as {
        succeeded?: number;
        failed?: number;
      };
      if (failed > 0) {
        console.warn(`approve-all: succeeded ${succeeded}, failed ${failed}`);
        t.raw("warning", "일부 지원자를 승인하지 못했습니다. 목록을 확인해주세요.");
      } else {
        t.success("approve");
      }
      setRefreshTick((n) => n + 1);
    } catch (err) {
      console.error("[applicants] approve-all failed", err);
      t.apiError("approve", err, "일괄 승인을 처리하지 못했습니다.");
    } finally {
      setApprovingAll(false);
    }
  };

  const handleApproveSuccess = (_linkedDisplayName: string | null) => {
    t.success("approve", "가입 요청을 승인했습니다.");
    setApproveTarget(null);
    setRefreshTick((n) => n + 1);
  };

  return (
    <div className="flex flex-col gap-6">
      <div className="flex items-end justify-between gap-3">
        <div>
          <h2 className="text-2xl font-semibold tracking-tight">가입 대기자</h2>
          <p className="text-sm text-muted-foreground">
            {devMode
              ? "소셜 로그인으로 가입을 시도한 요청 목록입니다."
              : "소셜 로그인으로 가입을 신청한 사람들의 목록입니다. 승인 또는 거절을 결정해 주세요."}
            {devMode && (
              <code className="mx-1 font-mono">public.applicants</code>
            )}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Button
            onClick={() => void handleApproveAll()}
            loading={approvingAll}
            disabled={
              loading ||
              pendingCount === 0 ||
              Boolean(rejectingId) ||
              Boolean(approveTarget)
            }
          >
            <CheckCheck className="h-4 w-4" />
            {`전체 승인${pendingCount > 0 ? ` (${pendingCount})` : ""}`}
          </Button>
          <Button
            variant="outline"
            onClick={() => setRefreshTick((n) => n + 1)}
            disabled={loading || approvingAll}
          >
            <RefreshCw className={cn("h-4 w-4", loading && "animate-spin")} />
            새로고침
          </Button>
        </div>
      </div>

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
          <CardTitle className="text-base">신청 목록</CardTitle>
          <CardDescription>{summary}</CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
            <div className="relative flex-1">
              <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
              <Input
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder={
                  devMode
                    ? "이름, email, provider, linked_user_id 검색"
                    : "이름, 이메일, 로그인 수단으로 검색"
                }
                className="pl-9"
              />
            </div>
            <div className="w-full sm:w-56">
              <Select
                value={status}
                onValueChange={(v) => setStatus(v ?? STATUS_ALL)}
              >
                <SelectTrigger>
                  <SelectValue placeholder="상태 필터" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={STATUS_ALL}>전체 상태</SelectItem>
                  {APPLICANT_STATUSES.map((s) => (
                    <SelectItem key={s} value={s}>
                      {devMode ? `${statusLabel(s)} (${s})` : statusLabel(s)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>

          {error && (
            <div className="rounded-md border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
              {error}
            </div>
          )}

          <div className="overflow-hidden rounded-lg border">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="sticky left-0 z-20 bg-card border-r">이름</TableHead>
                  <TableHead>{devMode ? "Email" : "이메일"}</TableHead>
                  <TableHead>{devMode ? "Provider" : "로그인 수단"}</TableHead>
                  <TableHead>상태</TableHead>
                  <TableHead>{devMode ? "연결된 user_id" : "연결된 회원"}</TableHead>
                  <TableHead>신청일</TableHead>
                  <TableHead>최근 수정</TableHead>
                  <TableHead className="w-[180px]">액션</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {filtered.map((applicant) => {
                  const isPending = applicant.status === "pending";
                  const isRejecting = rejectingId === applicant.id;
                  return (
                    <TableRow key={applicant.id}>
                      <TableCell className="sticky left-0 z-10 bg-card border-r max-w-[224px] truncate font-medium">
                        {fmt(applicant.name)}
                      </TableCell>
                      <TableCell className="max-w-[220px] truncate">
                        {fmt(applicant.email)}
                      </TableCell>
                      <TableCell>{fmt(applicant.provider)}</TableCell>
                      <TableCell>
                        <span
                          className={cn(
                            "inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ring-1 ring-inset",
                            statusBadgeClass(applicant.status),
                          )}
                        >
                          {statusLabel(applicant.status)}
                        </span>
                      </TableCell>
                      <TableCell className="max-w-[200px]">
                        {applicant.linkedUserId ? (
                          <>
                            <div className="truncate font-medium">
                              {applicant.linkedDisplayName ?? "이름 미등록"}
                            </div>
                            {devMode && (
                              <div
                                className="truncate font-mono text-[10px] text-muted-foreground"
                                title={applicant.linkedUserId}
                              >
                                {applicant.linkedUserId}
                              </div>
                            )}
                          </>
                        ) : (
                          <span className="text-muted-foreground">-</span>
                        )}
                      </TableCell>
                      <TableCell className="whitespace-nowrap text-xs">
                        {fmtDate(applicant.createdAt)}
                      </TableCell>
                      <TableCell className="whitespace-nowrap text-xs">
                        {fmtDate(applicant.updatedAt)}
                      </TableCell>
                      <TableCell>
                        {isPending ? (
                          <div className="flex justify-end gap-2">
                            <Button
                              size="sm"
                              onClick={() => setApproveTarget(applicant)}
                              disabled={Boolean(rejectingId) || Boolean(approveTarget)}
                            >
                              <CheckCircle2 className="h-3.5 w-3.5" />
                              승인
                            </Button>
                            <Button
                              size="sm"
                              variant="destructive"
                              onClick={() => void handleReject(applicant)}
                              loading={isRejecting}
                              disabled={Boolean(rejectingId) || Boolean(approveTarget)}
                            >
                              <UserX className="h-3.5 w-3.5" />
                              거절
                            </Button>
                          </div>
                        ) : (
                          <span className="text-xs text-muted-foreground">-</span>
                        )}
                      </TableCell>
                    </TableRow>
                  );
                })}
                {!loading && filtered.length === 0 && !error && (
                  <TableRow>
                    <TableCell
                      colSpan={8}
                      className="py-10 text-center text-muted-foreground"
                    >
                      조회된 신청자가 없습니다.
                    </TableCell>
                  </TableRow>
                )}
                {loading && filtered.length === 0 && (
                  <TableSkeletonRows columns={8} rows={6} />
                )}
              </TableBody>
            </Table>
          </div>

          <p className="text-xs text-muted-foreground">
            {devMode
              ? "승인 시 선택한 user_profile의 auth_email에 applicant.email을 연결하고, applicant 상태를 approved로 변경합니다."
              : "승인하면 선택한 회원의 로그인 이메일에 신청한 계정 이메일을 연결하고, 신청 상태를 '승인'으로 바꿉니다."}
          </p>
        </CardContent>
      </Card>

      {approveTarget && (
        <ApproveDialog
          applicant={approveTarget}
          devMode={devMode}
          mode={mode}
          onClose={() => setApproveTarget(null)}
          onApproved={handleApproveSuccess}
          onError={(message) => setBanner({ kind: "error", message })}
        />
      )}
    </div>
  );
}

type ApproveDialogProps = {
  applicant: Applicant;
  devMode: boolean;
  mode: ScopeMode;
  onClose: () => void;
  onApproved: (linkedDisplayName: string | null) => void;
  onError: (message: string) => void;
};

function ApproveDialog({
  applicant,
  devMode,
  mode,
  onClose,
  onApproved,
  onError,
}: ApproveDialogProps) {
  const [searchQuery, setSearchQuery] = useState(applicant.email ?? "");
  const [userResults, setUserResults] = useState<UserProfileCandidate[]>([]);
  const [selectedUser, setSelectedUser] = useState<UserProfileCandidate | null>(
    null,
  );
  const [searching, setSearching] = useState(false);
  const [approving, setApproving] = useState(false);
  const [hasSearched, setHasSearched] = useState(false);
  const t = useActionToast();
  const trimmedQuery = searchQuery.trim();

  const handleSearch = async () => {
    if (searching || approving) return;
    if (trimmedQuery.length < 2) {
      setUserResults([]);
      setSelectedUser(null);
      onError("이름 또는 이메일로 2자 이상 검색해주세요.");
      return;
    }

    setSearching(true);
    setSelectedUser(null);
    try {
      const res = await fetch(
        `/api/admin/user-profiles/search?q=${encodeURIComponent(trimmedQuery)}${mode === "test" ? "&mode=test" : ""}`,
        { cache: "no-store" },
      );
      const json = await res.json();
      if (!res.ok) {
        throw apiErrorFrom(res, json, "사용자를 검색하지 못했습니다.");
      }
      setUserResults((json.users ?? []) as UserProfileCandidate[]);
      setHasSearched(true);
    } catch (err) {
      console.error("[applicants] user search failed", err);
      t.apiError("submit", err, "검색하지 못했습니다. 잠시 후 다시 시도해주세요.");
    } finally {
      setSearching(false);
    }
  };

  const handleApproveExisting = async () => {
    if (!selectedUser) {
      onError("연결할 사용자를 선택해야 승인할 수 있습니다.");
      return;
    }
    if (approving) return;

    setApproving(true);
    try {
      const res = await fetch(
        `/api/admin/applicants/${encodeURIComponent(applicant.id)}/approve-existing${mode === "test" ? "?mode=test" : ""}`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ user_id: selectedUser.userId }),
        },
      );
      const json = await res.json();
      if (!res.ok) {
        throw apiErrorFrom(res, json, "가입 요청을 승인하지 못했습니다.");
      }
      onApproved(
        selectedUser.displayName ??
          selectedUser.contactEmail ??
          selectedUser.userId,
      );
    } catch (err) {
      console.error("[applicants] approve-existing failed", err);
      t.apiError("approve", err, "가입 요청을 승인하지 못했습니다.");
    } finally {
      setApproving(false);
    }
  };

  const handleApproveNew = async () => {
    if (approving) return;

    setApproving(true);
    try {
      const res = await fetch(
        `/api/admin/applicants/${encodeURIComponent(applicant.id)}/approve-new${mode === "test" ? "?mode=test" : ""}`,
        { method: "POST" },
      );
      const json = await res.json();
      if (!res.ok) {
        throw apiErrorFrom(res, json, "사용자를 생성하고 승인하지 못했습니다.");
      }
      onApproved(null);
    } catch (err) {
      console.error("[applicants] approve-new failed", err);
      t.apiError("approve", err, "사용자를 생성하고 승인하지 못했습니다.");
    } finally {
      setApproving(false);
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label="가입 신청 승인"
        className="flex max-h-[90vh] modal-w-xl flex-col rounded-xl bg-background p-5 shadow-lg ring-1 ring-foreground/10"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="mb-4 flex items-start justify-between gap-4">
          <div>
            <h3 className="text-base font-semibold">가입 신청 승인</h3>
            <p className="mt-1 text-xs text-muted-foreground">
              외부 계정 정보만으로는 기존 사용자를 자동 식별할 수 없습니다.
            </p>
            <p className="mt-1 text-xs text-muted-foreground">
              기존 사용자와 연결하거나, 신규 사용자로 생성 후 승인할 수 있습니다.
            </p>
          </div>
          <Button
            variant="ghost"
            size="icon-sm"
            onClick={onClose}
            aria-label="닫기"
            disabled={approving}
          >
            <X className="h-4 w-4" />
          </Button>
        </div>

        <div className="grid gap-3 rounded-lg border bg-muted/20 p-3 text-sm sm:grid-cols-2">
          <Detail label="신청자 이름" value={applicant.name} />
          <Detail label={devMode ? "Email" : "계정 이메일"} value={applicant.email} />
          <Detail label={devMode ? "Provider" : "로그인 수단"} value={applicant.provider} />
          <Detail label={devMode ? "Applied At" : "신청 일시"} value={fmtDate(applicant.createdAt)} />
        </div>

        <div className="mt-4 rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-900">
          {devMode
            ? "이름만으로 자동 연결하지 않습니다. applicant.email과 contact_email이 다르더라도 관리자가 명시적으로 선택하면 연결할 수 있습니다."
            : "이름만으로 자동 연결하지 않습니다. 신청한 계정 이메일과 기존 연락 이메일이 달라도, 운영자가 직접 선택하면 연결할 수 있습니다."}
        </div>

        <div className="mt-4 flex flex-col gap-3 sm:flex-row">
          <div className="relative flex-1">
            <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              autoFocus
              value={searchQuery}
              onChange={(event) => setSearchQuery(event.target.value)}
              placeholder={
                devMode
                  ? "이름, 연락 이메일, auth_email 또는 user_id(UUID) 검색"
                  : "이름, 연락 이메일, 로그인 이메일 또는 회원 ID로 검색"
              }
              className="pl-9"
              disabled={approving}
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  event.preventDefault();
                  void handleSearch();
                }
              }}
            />
          </div>
          <Button
            type="button"
            variant="outline"
            onClick={() => void handleSearch()}
            loading={searching}
            disabled={approving}
          >
            <Search className="h-4 w-4" />
            검색
          </Button>
        </div>

        <p className="mt-2 text-xs text-muted-foreground">
          기존 사용자와 연결하려면 검색 후 선택하세요. 신규 사용자는 검색 없이
          바로 생성할 수 있습니다.
        </p>

        <div className="mt-4 flex-1 overflow-y-auto overflow-x-hidden rounded-lg border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>{devMode ? "User" : "회원"}</TableHead>
                <TableHead>{devMode ? "Contact" : "연락 이메일"}</TableHead>
                <TableHead>{devMode ? "Auth Email" : "로그인 이메일"}</TableHead>
                <TableHead>{devMode ? "Org" : "소속"}</TableHead>
                <TableHead className="w-[120px]">선택</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {userResults.map((profile) => {
                const isSelected = selectedUser?.userId === profile.userId;
                return (
                  <TableRow
                    key={profile.userId}
                    className={cn("cursor-pointer", isSelected && "bg-muted/60")}
                    onClick={() => {
                      if (!approving) {
                        setSelectedUser(profile);
                      }
                    }}
                  >
                    <TableCell className="max-w-[200px]">
                      <div className="truncate font-medium">
                        {fmt(profile.displayName)}
                        {isSelected && (
                          <span className="ml-2 text-xs text-primary">선택됨</span>
                        )}
                      </div>
                      {devMode && (
                        <div className="truncate font-mono text-[11px] text-muted-foreground">
                          {profile.userId}
                        </div>
                      )}
                    </TableCell>
                    <TableCell className="max-w-[200px] truncate">
                      {fmt(profile.contactEmail)}
                    </TableCell>
                    <TableCell className="max-w-[200px] truncate">
                      {fmt(profile.authEmail)}
                    </TableCell>
                    <TableCell>{fmt(profile.organizationSlug)}</TableCell>
                    <TableCell>
                      <Button
                        size="sm"
                        type="button"
                        variant={isSelected ? "default" : "outline"}
                        onClick={(event) => {
                          event.stopPropagation();
                          setSelectedUser(profile);
                        }}
                        disabled={approving}
                      >
                        {isSelected ? "선택 완료" : "선택"}
                      </Button>
                    </TableCell>
                  </TableRow>
                );
              })}
              {!searching && userResults.length === 0 && !hasSearched && (
                <TableRow>
                  <TableCell
                    colSpan={5}
                    className="py-8 text-center text-muted-foreground"
                  >
                    기존 사용자와 연결하려면 검색 후 선택하세요.
                  </TableCell>
                </TableRow>
              )}
              {!searching && userResults.length === 0 && hasSearched && (
                <TableRow>
                  <TableCell
                    colSpan={5}
                    className="py-8 text-center text-muted-foreground"
                  >
                    검색 결과가 없습니다. 검색어를 바꾸거나 신규 사용자로
                    생성해주세요.
                  </TableCell>
                </TableRow>
              )}
              {searching && <TableSkeletonRows columns={5} rows={6} />}
            </TableBody>
          </Table>
        </div>

        {selectedUser && (
          <div className="mt-4 rounded-lg border bg-muted/20 px-4 py-3 text-sm">
            <div className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
              선택된 사용자
            </div>
            <div className="mt-1 font-medium">
              {fmt(selectedUser.displayName)} / {fmt(selectedUser.contactEmail)}
            </div>
            {devMode && (
              <div className="mt-1 font-mono text-xs text-muted-foreground">
                {selectedUser.userId}
              </div>
            )}
            <div className="mt-1 text-xs text-muted-foreground">
              {devMode
                ? `승인 시 auth_email은 ${fmt(applicant.email)} 로 연결됩니다.`
                : `승인하면 로그인 이메일이 ${fmt(applicant.email)} 로 연결됩니다.`}
            </div>
          </div>
        )}

        <div className="mt-4 flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
          <Button variant="outline" onClick={onClose} disabled={approving}>
            취소
          </Button>
          <Button
            type="button"
            variant="secondary"
            onClick={() => void handleApproveNew()}
            loading={approving}
          >
            <UserPlus className="h-3.5 w-3.5" />
            신규 사용자로 생성 후 승인
          </Button>
          <Button
            type="button"
            onClick={() => void handleApproveExisting()}
            loading={approving}
            disabled={!selectedUser}
          >
            <CheckCircle2 className="h-3.5 w-3.5" />
            이 사용자와 연결 승인
          </Button>
        </div>
      </div>
    </div>
  );
}

function Detail({
  label,
  value,
}: {
  label: string;
  value: string | null | undefined;
}) {
  return (
    <div>
      <div className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
        {label}
      </div>
      <div className="mt-1 text-sm font-medium">{fmt(value)}</div>
    </div>
  );
}
