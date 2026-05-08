"use client";

import { useEffect, useMemo, useState } from "react";
import { CheckCircle2, RefreshCw, Search, UserX, X } from "lucide-react";
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

type Applicant = {
  id: string;
  email: string | null;
  name: string | null;
  provider: string | null;
  status: "pending" | "approved" | "rejected";
  linkedUserId: string | null;
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
  return value?.trim() ? value : "—";
}

function fmtDate(value: string | null | undefined) {
  if (!value) return "—";
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
      return "승인됨";
    case "rejected":
      return "거절됨";
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
      `${applicant.name ?? applicant.email ?? "이 신청자"}의 가입을 거절하시겠어요?`,
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
        message: `${applicant.name ?? applicant.email ?? "신청자"}의 가입을 거절했습니다.`,
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
        ? `${linkedDisplayName} 계정에 연결하여 승인했습니다.`
        : "신청자를 승인했습니다.",
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
            카카오 등 외부 인증으로 가입을 시도한 신청자 목록입니다. 기준 테이블:
            <code className="mx-1 font-mono">public.applicants</code>
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
          <CardTitle className="text-base">신청자 목록</CardTitle>
          <CardDescription>{summary}</CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
            <div className="relative flex-1">
              <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
              <Input
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder="이름, email, provider, linked_user_id 검색"
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
                      {statusLabel(s)} ({s})
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
                  <TableHead>이름</TableHead>
                  <TableHead>Email</TableHead>
                  <TableHead>Provider</TableHead>
                  <TableHead>상태</TableHead>
                  <TableHead>연결된 user_id</TableHead>
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
                      <TableCell className="max-w-[160px] truncate font-medium">
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
                      <TableCell className="font-mono text-[11px]">
                        {fmt(applicant.linkedUserId)}
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
                              {isRejecting ? "처리 중" : "거절"}
                            </Button>
                          </div>
                        ) : (
                          <span className="text-xs text-muted-foreground">—</span>
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
            승인 시 선택한 user_profiles에 카카오 이메일이 auth_email로
            연결되며, 다음 로그인부터 자동으로 승인됩니다.
          </p>
        </CardContent>
      </Card>

      {approveTarget && (
        <ApproveDialog
          applicant={approveTarget}
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
  onClose: () => void;
  onApproved: (linkedDisplayName: string | null) => void;
  onError: (message: string) => void;
};

function ApproveDialog({
  applicant,
  onClose,
  onApproved,
  onError,
}: ApproveDialogProps) {
  const initialQuery = applicant.name?.trim() || applicant.email?.trim() || "";
  const [query, setQuery] = useState(initialQuery);
  const [results, setResults] = useState<UserProfileCandidate[]>([]);
  const [searching, setSearching] = useState(false);
  const [submittingUserId, setSubmittingUserId] = useState<string | null>(null);

  useEffect(() => {
    const trimmed = query.trim();
    if (trimmed.length < 2) {
      setResults([]);
      return;
    }

    let cancelled = false;
    const timer = window.setTimeout(async () => {
      setSearching(true);
      try {
        const res = await fetch(
          `/api/admin/user-profiles?query=${encodeURIComponent(trimmed)}`,
          { cache: "no-store" },
        );
        const json = await res.json();
        if (!res.ok || !json.success) {
          throw new Error(json?.error ?? "Failed to search user_profiles.");
        }
        if (!cancelled) {
          setResults((json.data ?? []) as UserProfileCandidate[]);
        }
      } catch (err) {
        if (!cancelled) {
          onError(
            err instanceof Error ? err.message : "Failed to search user_profiles.",
          );
        }
      } finally {
        if (!cancelled) setSearching(false);
      }
    }, 250);

    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [query, onError]);

  const handleApprove = async (profile: UserProfileCandidate) => {
    if (submittingUserId) return;
    setSubmittingUserId(profile.userId);
    try {
      const res = await fetch(
        `/api/admin/applicants/${encodeURIComponent(applicant.id)}/approve`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ userId: profile.userId }),
        },
      );
      const json = await res.json();
      if (!res.ok || !json.success) {
        throw new Error(json?.error ?? "Failed to approve applicant.");
      }
      onApproved(profile.displayName ?? profile.userId);
    } catch (err) {
      onError(
        err instanceof Error ? err.message : "Failed to approve applicant.",
      );
    } finally {
      setSubmittingUserId(null);
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
      onClick={onClose}
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
              연결할 기존 user_profiles를 직접 검색하여 선택하세요. 자동
              매칭은 수행하지 않습니다.
            </p>
          </div>
          <Button
            variant="ghost"
            size="icon-sm"
            onClick={onClose}
            aria-label="닫기"
            disabled={Boolean(submittingUserId)}
          >
            <X className="h-4 w-4" />
          </Button>
        </div>

        <div className="grid gap-3 rounded-lg border bg-muted/20 p-3 text-sm sm:grid-cols-2">
          <Detail label="신청자 이름" value={applicant.name} />
          <Detail label="Kakao Email" value={applicant.email} />
          <Detail label="Provider" value={applicant.provider} />
          <Detail label="Applied At" value={fmtDate(applicant.createdAt)} />
        </div>

        <div className="relative mt-4">
          <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            autoFocus
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="display_name, contact_email, auth_email, organization으로 검색"
            className="pl-9"
            disabled={Boolean(submittingUserId)}
          />
        </div>

        <div className="mt-4 flex-1 overflow-auto rounded-lg border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>User</TableHead>
                <TableHead>Contact</TableHead>
                <TableHead>Auth Email</TableHead>
                <TableHead>Org</TableHead>
                <TableHead className="w-[120px] text-right">액션</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {results.map((profile) => {
                const isSubmitting = submittingUserId === profile.userId;
                return (
                  <TableRow key={profile.userId}>
                    <TableCell className="max-w-[200px] truncate">
                      <div className="font-medium">{fmt(profile.displayName)}</div>
                      <div className="font-mono text-[11px] text-muted-foreground">
                        {profile.userId}
                      </div>
                    </TableCell>
                    <TableCell className="max-w-[200px] truncate">
                      {fmt(profile.contactEmail)}
                    </TableCell>
                    <TableCell className="max-w-[200px] truncate">
                      {fmt(profile.authEmail)}
                    </TableCell>
                    <TableCell>{fmt(profile.organizationSlug)}</TableCell>
                    <TableCell className="text-right">
                      <Button
                        size="sm"
                        onClick={() => void handleApprove(profile)}
                        disabled={Boolean(submittingUserId)}
                      >
                        <CheckCircle2 className="h-3.5 w-3.5" />
                        {isSubmitting ? "처리 중" : "이 계정으로 승인"}
                      </Button>
                    </TableCell>
                  </TableRow>
                );
              })}
              {!searching && results.length === 0 && query.trim().length < 2 && (
                <TableRow>
                  <TableCell
                    colSpan={5}
                    className="py-8 text-center text-muted-foreground"
                  >
                    2자 이상 입력하여 검색하세요.
                  </TableCell>
                </TableRow>
              )}
              {!searching && results.length === 0 && query.trim().length >= 2 && (
                <TableRow>
                  <TableCell
                    colSpan={5}
                    className="py-8 text-center text-muted-foreground"
                  >
                    일치하는 user_profiles가 없습니다.
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

        <div className="mt-4 flex justify-end">
          <Button
            variant="outline"
            onClick={onClose}
            disabled={Boolean(submittingUserId)}
          >
            취소
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
