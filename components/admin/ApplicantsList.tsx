"use client";

import { useEffect, useMemo, useState } from "react";
import { CheckCircle2, RefreshCw, Search, UserPlus, UserX, X } from "lucide-react";
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
import { cn } from "@/lib/utils";
import { APPLICANT_STATUSES } from "@/lib/adminApplicantTypes";
import { useAdminDevMode } from "@/components/admin/useAdminDevMode";

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
  user_id: string;
  name: string | null;
  contact_email: string | null;
  auth_email: string | null;
  organization: string | null;
};

type Banner = { kind: "success" | "error"; message: string } | null;

const STATUS_ALL = "__all__";
const STATUS_DEFAULT = "pending";

function fmt(value: string | null | undefined) {
  return value?.trim() ? value : "-";
}

function fmtDate(value: string | null | undefined) {
  if (!value) return "-";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat("ko-KR", {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(date);
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

export default function ApplicantsList() {
  const devMode = useAdminDevMode();
  const [applicants, setApplicants] = useState<Applicant[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [status, setStatus] = useState<string>(STATUS_DEFAULT);
  const [refreshTick, setRefreshTick] = useState(0);
  const [banner, setBanner] = useState<Banner>(null);
  const [approveTarget, setApproveTarget] = useState<Applicant | null>(null);
  const [rejectingId, setRejectingId] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      setLoading(true);
      setError(null);
      const params = new URLSearchParams();
      if (status !== STATUS_ALL) params.set("status", status);
      const url = `/api/admin/applicants${params.size ? `?${params}` : ""}`;
      try {
        const res = await fetch(url, { cache: "no-store" });
        const json = await res.json();
        if (!res.ok || !json.success) {
          throw new Error(json?.error ?? "Failed to load applicants.");
        }
        if (!cancelled) setApplicants((json.data ?? []) as Applicant[]);
      } catch (err) {
        if (!cancelled) {
          setError(
            err instanceof Error ? err.message : "Failed to load applicants.",
          );
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    };
    void load();
    return () => {
      cancelled = true;
    };
  }, [status, refreshTick]);

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
    const confirmed = window.confirm(
      `${applicant.name ?? applicant.email ?? "이 신청자"}의 가입을 거절하시겠습니까?`,
    );
    if (!confirmed) return;

    setRejectingId(applicant.id);
    try {
      const res = await fetch(
        `/api/admin/applicants/${encodeURIComponent(applicant.id)}/reject`,
        { method: "POST" },
      );
      const json = await res.json();
      if (!res.ok || !json.success) {
        throw new Error(json?.error ?? "Failed to reject applicant.");
      }
      setBanner({
        kind: "success",
        message: `${applicant.name ?? applicant.email ?? "신청자"} 가입을 거절했습니다.`,
      });
      setRefreshTick((n) => n + 1);
    } catch (err) {
      setBanner({
        kind: "error",
        message:
          err instanceof Error ? err.message : "Failed to reject applicant.",
      });
    } finally {
      setRejectingId(null);
    }
  };

  const handleApproveSuccess = (linkedDisplayName: string | null) => {
    setBanner({
      kind: "success",
      message: linkedDisplayName
        ? `${linkedDisplayName} 계정과 연결하여 승인했습니다.`
        : "가입 요청을 승인했습니다.",
    });
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
              ? "카카오 로그인으로 가입을 시도한 요청 목록입니다."
              : "카카오 로그인으로 가입을 신청한 사람들의 목록입니다. 승인 또는 거절을 결정해 주세요."}
            {devMode && (
              <code className="mx-1 font-mono">public.applicants</code>
            )}
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
                  <TableHead className="w-[180px] text-right">액션</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {filtered.map((applicant) => {
                  const isPending = applicant.status === "pending";
                  const isRejecting = rejectingId === applicant.id;
                  return (
                    <TableRow key={applicant.id}>
                      <TableCell className="sticky left-0 z-10 bg-card border-r max-w-[160px] truncate font-medium">
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
                      <TableCell className="text-right">
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
                              disabled={Boolean(rejectingId) || Boolean(approveTarget)}
                            >
                              <UserX className="h-3.5 w-3.5" />
                              {isRejecting ? "처리 중..." : "거절"}
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
                  <TableRow>
                    <TableCell
                      colSpan={8}
                      className="py-10 text-center text-muted-foreground"
                    >
                      불러오는 중...
                    </TableCell>
                  </TableRow>
                )}
              </TableBody>
            </Table>
          </div>

          <p className="text-xs text-muted-foreground">
            {devMode
              ? "승인 시 선택한 user_profile의 auth_email에 카카오 이메일을 연결하고, applicant 상태를 approved로 변경합니다."
              : "승인하면 선택한 회원의 로그인 이메일에 카카오 이메일을 연결하고, 신청 상태를 '승인'으로 바꿉니다."}
          </p>
        </CardContent>
      </Card>

      {approveTarget && (
        <ApproveDialog
          applicant={approveTarget}
          devMode={devMode}
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
  onClose: () => void;
  onApproved: (linkedDisplayName: string | null) => void;
  onError: (message: string) => void;
};

function ApproveDialog({
  applicant,
  devMode,
  onClose,
  onApproved,
  onError,
}: ApproveDialogProps) {
  const [searchQuery, setSearchQuery] = useState("");
  const [userResults, setUserResults] = useState<UserProfileCandidate[]>([]);
  const [selectedUser, setSelectedUser] = useState<UserProfileCandidate | null>(
    null,
  );
  const [searching, setSearching] = useState(false);
  const [approving, setApproving] = useState(false);
  const [hasSearched, setHasSearched] = useState(false);
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
        `/api/admin/user-profiles/search?q=${encodeURIComponent(trimmedQuery)}`,
        { cache: "no-store" },
      );
      const json = await res.json();
      if (!res.ok) {
        throw new Error(json?.error ?? "Failed to search user profiles.");
      }
      setUserResults((json.users ?? []) as UserProfileCandidate[]);
      setHasSearched(true);
    } catch (err) {
      onError(
        err instanceof Error ? err.message : "Failed to search user profiles.",
      );
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
        `/api/admin/applicants/${encodeURIComponent(applicant.id)}/approve-existing`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ user_id: selectedUser.user_id }),
        },
      );
      const json = await res.json();
      if (!res.ok) {
        throw new Error(json?.error ?? "Failed to approve applicant.");
      }
      onApproved(
        selectedUser.name ??
          selectedUser.contact_email ??
          selectedUser.user_id,
      );
    } catch (err) {
      onError(
        err instanceof Error ? err.message : "Failed to approve applicant.",
      );
    } finally {
      setApproving(false);
    }
  };

  const handleApproveNew = async () => {
    if (approving) return;

    setApproving(true);
    try {
      const res = await fetch(
        `/api/admin/applicants/${encodeURIComponent(applicant.id)}/approve-new`,
        { method: "POST" },
      );
      const json = await res.json();
      if (!res.ok) {
        throw new Error(json?.error ?? "Failed to create user and approve.");
      }
      onApproved(null);
    } catch (err) {
      onError(
        err instanceof Error
          ? err.message
          : "Failed to create user and approve.",
      );
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
        className="flex max-h-[90vh] w-full max-w-3xl flex-col rounded-xl bg-background p-5 shadow-lg ring-1 ring-foreground/10"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="mb-4 flex items-start justify-between gap-4">
          <div>
            <h3 className="text-base font-semibold">가입 신청 승인</h3>
            <p className="mt-1 text-xs text-muted-foreground">
              카카오 계정 정보만으로는 기존 사용자를 자동 식별할 수 없습니다.
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
          <Detail label={devMode ? "Kakao Email" : "카카오 이메일"} value={applicant.email} />
          <Detail label={devMode ? "Provider" : "로그인 수단"} value={applicant.provider} />
          <Detail label={devMode ? "Applied At" : "신청 일시"} value={fmtDate(applicant.createdAt)} />
        </div>

        <div className="mt-4 rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-900">
          {devMode
            ? "이름만으로 자동 연결하지 않습니다. applicant.email과 contact_email이 다르더라도 관리자가 명시적으로 선택하면 연결할 수 있습니다."
            : "이름만으로 자동 연결하지 않습니다. 신청한 카카오 이메일과 기존 연락 이메일이 달라도, 운영자가 직접 선택하면 연결할 수 있습니다."}
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
            disabled={searching || approving}
          >
            <Search className="h-4 w-4" />
            {searching ? "검색 중..." : "검색"}
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
                <TableHead className="w-[120px] text-right">선택</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {userResults.map((profile) => {
                const isSelected = selectedUser?.user_id === profile.user_id;
                return (
                  <TableRow
                    key={profile.user_id}
                    className={cn("cursor-pointer", isSelected && "bg-muted/60")}
                    onClick={() => {
                      if (!approving) {
                        setSelectedUser(profile);
                      }
                    }}
                  >
                    <TableCell className="max-w-[200px]">
                      <div className="truncate font-medium">
                        {fmt(profile.name)}
                        {isSelected && (
                          <span className="ml-2 text-xs text-primary">선택됨</span>
                        )}
                      </div>
                      {devMode && (
                        <div className="truncate font-mono text-[11px] text-muted-foreground">
                          {profile.user_id}
                        </div>
                      )}
                    </TableCell>
                    <TableCell className="max-w-[200px] truncate">
                      {fmt(profile.contact_email)}
                    </TableCell>
                    <TableCell className="max-w-[200px] truncate">
                      {fmt(profile.auth_email)}
                    </TableCell>
                    <TableCell>{fmt(profile.organization)}</TableCell>
                    <TableCell className="text-right">
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
              {searching && (
                <TableRow>
                  <TableCell
                    colSpan={5}
                    className="py-8 text-center text-muted-foreground"
                  >
                    검색 중...
                  </TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
        </div>

        {selectedUser && (
          <div className="mt-4 rounded-lg border bg-muted/20 px-4 py-3 text-sm">
            <div className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
              선택된 사용자
            </div>
            <div className="mt-1 font-medium">
              {fmt(selectedUser.name)} / {fmt(selectedUser.contact_email)}
            </div>
            {devMode && (
              <div className="mt-1 font-mono text-xs text-muted-foreground">
                {selectedUser.user_id}
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
            disabled={approving}
          >
            <UserPlus className="h-3.5 w-3.5" />
            {approving ? "처리 중..." : "신규 사용자로 생성 후 승인"}
          </Button>
          <Button
            type="button"
            onClick={() => void handleApproveExisting()}
            disabled={!selectedUser || approving}
          >
            <CheckCircle2 className="h-3.5 w-3.5" />
            {approving ? "처리 중..." : "이 사용자와 연결 승인"}
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
      <div className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
        {label}
      </div>
      <div className="mt-1 text-sm font-medium">{fmt(value)}</div>
    </div>
  );
}
