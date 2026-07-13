"use client";

import { useEffect, useMemo, useState } from "react";
import { Link2, Search, UserX } from "lucide-react";
import { appendModeQuery, readScopeMode } from "@/lib/userScopeShared";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
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
import { formatAdminDateTime } from "@/lib/adminDateTime";

type Applicant = {
  id: string;
  email: string | null;
  name: string | null;
  provider: string | null;
  status: "pending" | "approved" | "rejected";
  createdAt: string | null;
};

type UserProfileCandidate = {
  userId: string;
  displayName: string | null;
  contactEmail: string | null;
  authEmail: string | null;
  organizationSlug: string | null;
};

type Banner = { kind: "success" | "error"; message: string } | null;

function fmt(value: string | null | undefined) {
  return value?.trim() ? value : "-";
}

// createdAt 등 메타 시각 — 항상 서울 표준시(KST) "YYYY-MM-DD HH:mm:ss".
function fmtDate(value: string | null | undefined) {
  return formatAdminDateTime(value, { fallback: "-" });
}

export default function ApplicantManager() {
  const [applicants, setApplicants] = useState<Applicant[]>([]);
  const [loading, setLoading] = useState(true);
  useReportLoading(loading);
  const [banner, setBanner] = useState<Banner>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [searchLoading, setSearchLoading] = useState(false);
  const [results, setResults] = useState<UserProfileCandidate[]>([]);
  const [acting, setActing] = useState(false);
  const [linkingUserId, setLinkingUserId] = useState<string | null>(null);

  const selected = useMemo(
    () => applicants.find((applicant) => applicant.id === selectedId) ?? null,
    [applicants, selectedId],
  );

  const refreshApplicants = async (preserveId?: string | null) => {
    setLoading(true);
    try {
      const res = await fetch(
        appendModeQuery(
          "/api/admin/applicants?status=pending",
          readScopeMode(new URLSearchParams(window.location.search)),
        ),
        { cache: "no-store" },
      );
      const json = await res.json();
      if (!res.ok || !json.success) {
        throw new Error(json?.error ?? "Failed to load applicants.");
      }

      const next = (json.data ?? []) as Applicant[];
      const preferredApplicant =
        next.find((item) => item.id === preserveId) ?? next[0] ?? null;
      setApplicants(next);
      setSelectedId(preferredApplicant?.id ?? null);
      setQuery(preferredApplicant?.name?.trim() || preferredApplicant?.email?.trim() || "");
    } catch (error) {
      setBanner({
        kind: "error",
        message:
          error instanceof Error ? error.message : "Failed to load applicants.",
      });
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    const timeoutId = window.setTimeout(() => {
      void refreshApplicants();
    }, 0);
    return () => window.clearTimeout(timeoutId);
  }, []);

  useEffect(() => {
    if (!banner) return;
    const timer = window.setTimeout(() => setBanner(null), 4500);
    return () => window.clearTimeout(timer);
  }, [banner]);

  useEffect(() => {
    if (!selected) return;

    const trimmed = query.trim();
    if (trimmed.length < 2) return;

    const timer = window.setTimeout(async () => {
      setSearchLoading(true);
      try {
        const res = await fetch(
          appendModeQuery(
            `/api/admin/user-profiles?query=${encodeURIComponent(trimmed)}`,
            readScopeMode(new URLSearchParams(window.location.search)),
          ),
          { cache: "no-store" },
        );
        const json = await res.json();
        if (!res.ok || !json.success) {
          throw new Error(json?.error ?? "Failed to search user_profiles.");
        }
        setResults((json.data ?? []) as UserProfileCandidate[]);
      } catch (error) {
        setBanner({
          kind: "error",
          message:
            error instanceof Error
              ? error.message
              : "Failed to search user_profiles.",
        });
      } finally {
        setSearchLoading(false);
      }
    }, 250);

    return () => window.clearTimeout(timer);
  }, [query, selected]);

  const handleLink = async (userId: string) => {
    if (!selected || acting) return;

    setActing(true);
    setLinkingUserId(userId);
    try {
      const res = await fetch(
        `/api/admin/applicants/${encodeURIComponent(selected.id)}/link`,
        {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ userId }),
        },
      );
      const json = await res.json();
      if (!res.ok || !json.success) {
        throw new Error(json?.error ?? "Failed to link applicant.");
      }

      const profile = json.data?.profile as UserProfileCandidate | undefined;
      setBanner({
        kind: "success",
        message: `Linked to ${profile?.displayName ?? profile?.userId ?? userId}.`,
      });
      setResults([]);
      await refreshApplicants(selected.id);
    } catch (error) {
      setBanner({
        kind: "error",
        message:
          error instanceof Error ? error.message : "Failed to link applicant.",
      });
    } finally {
      setActing(false);
      setLinkingUserId(null);
    }
  };

  const handleReject = async () => {
    if (!selected || acting) return;

    setActing(true);
    try {
      const res = await fetch(
        `/api/admin/applicants/${encodeURIComponent(selected.id)}/reject`,
        { method: "PATCH" },
      );
      const json = await res.json();
      if (!res.ok || !json.success) {
        throw new Error(json?.error ?? "Failed to reject applicant.");
      }

      setBanner({
        kind: "success",
        message: `${selected.name ?? selected.email ?? "Applicant"} was rejected.`,
      });
      setResults([]);
      await refreshApplicants(selected.id);
    } catch (error) {
      setBanner({
        kind: "error",
        message:
          error instanceof Error ? error.message : "Failed to reject applicant.",
      });
    } finally {
      setActing(false);
    }
  };

  return (
    <div className="flex flex-col gap-6">
      <div className="flex items-end justify-between gap-3">
        <div>
          <h2 className="text-2xl font-semibold tracking-tight">Applicants</h2>
          <p className="text-sm text-muted-foreground">
            Pending applicant를 기존 user_profiles에 수동 연결합니다.
          </p>
        </div>
        <Button
          variant="outline"
          onClick={() => void refreshApplicants(selectedId)}
          loading={loading}
          disabled={loading || acting}
        >
          Refresh
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

      <div className="grid gap-6 xl:grid-cols-[minmax(0,1.1fr)_minmax(0,1.4fr)]">
        <Card>
          <CardHeader>
            <CardTitle>Pending Queue</CardTitle>
            <CardDescription>
              {loading ? "Loading..." : `${applicants.length} pending applicants`}
            </CardDescription>
          </CardHeader>
          <CardContent>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Name</TableHead>
                  <TableHead>Email</TableHead>
                  <TableHead>Provider</TableHead>
                  <TableHead>Applied</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {loading && applicants.length === 0 && (
                  <TableSkeletonRows columns={4} rows={6} />
                )}
                {applicants.map((applicant) => {
                  const active = applicant.id === selectedId;
                  return (
                    <TableRow
                      key={applicant.id}
                      data-state={active ? "selected" : undefined}
                      className="cursor-pointer"
                      onClick={() => {
                        setSelectedId(applicant.id);
                        setQuery(applicant.name?.trim() || applicant.email?.trim() || "");
                      }}
                    >
                      <TableCell className="max-w-[224px] truncate font-medium">
                        {fmt(applicant.name)}
                      </TableCell>
                      <TableCell className="max-w-[220px] truncate">
                        {fmt(applicant.email)}
                      </TableCell>
                      <TableCell>{fmt(applicant.provider)}</TableCell>
                      <TableCell>{fmtDate(applicant.createdAt)}</TableCell>
                    </TableRow>
                  );
                })}
                {!loading && applicants.length === 0 && (
                  <TableRow>
                    <TableCell
                      colSpan={4}
                      className="py-8 text-center text-muted-foreground"
                    >
                      No pending applicants.
                    </TableCell>
                  </TableRow>
                )}
              </TableBody>
            </Table>
          </CardContent>
        </Card>

        <div className="flex flex-col gap-6">
          <Card>
            <CardHeader>
              <CardTitle>Applicant Detail</CardTitle>
              <CardDescription>
                연결 대상이 맞는지 확인한 뒤 link 하세요.
              </CardDescription>
            </CardHeader>
            <CardContent className="grid gap-3 sm:grid-cols-2">
              <Detail label="Kakao Email" value={selected?.email} />
              <Detail label="Name" value={selected?.name} />
              <Detail label="Provider" value={selected?.provider} />
              <Detail label="Applied At" value={fmtDate(selected?.createdAt)} />
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>Find Existing User</CardTitle>
              <CardDescription>
                이름, contact_email, auth_email, organization으로 검색합니다.
              </CardDescription>
            </CardHeader>
            <CardContent className="flex flex-col gap-4">
              <div className="relative">
                <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
                <Input
                  value={query}
                  onChange={(event) => setQuery(event.target.value)}
                  placeholder="Search existing user_profiles"
                  className="pl-9"
                  disabled={!selected || acting}
                />
              </div>

              {!selected && (
                <div className="rounded-lg border border-dashed px-4 py-8 text-center text-sm text-muted-foreground">
                  Select a pending applicant first.
                </div>
              )}

              {selected && (
                <div className="overflow-hidden rounded-lg border">
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>User</TableHead>
                        <TableHead>Contact</TableHead>
                        <TableHead>Auth Email</TableHead>
                        <TableHead>Org</TableHead>
                        <TableHead className="w-[110px]">Action</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {results.map((profile) => (
                        <TableRow key={profile.userId}>
                          <TableCell className="max-w-[180px] truncate">
                            <div className="font-medium">
                              {fmt(profile.displayName)}
                            </div>
                            <div className="text-xs text-muted-foreground">
                              {profile.userId}
                            </div>
                          </TableCell>
                          <TableCell className="max-w-[220px] truncate">
                            {fmt(profile.contactEmail)}
                          </TableCell>
                          <TableCell className="max-w-[220px] truncate">
                            {fmt(profile.authEmail)}
                          </TableCell>
                          <TableCell>{fmt(profile.organizationSlug)}</TableCell>
                          <TableCell>
                            <Button
                              size="sm"
                              onClick={() => void handleLink(profile.userId)}
                              loading={linkingUserId === profile.userId}
                              disabled={acting}
                            >
                              <Link2 className="h-3.5 w-3.5" />
                              Link
                            </Button>
                          </TableCell>
                        </TableRow>
                      ))}
                      {!searchLoading && results.length === 0 && query.trim().length < 2 && (
                        <TableRow>
                          <TableCell
                            colSpan={5}
                            className="py-8 text-center text-muted-foreground"
                          >
                            Enter at least 2 characters to search.
                          </TableCell>
                        </TableRow>
                      )}
                      {!searchLoading && results.length === 0 && query.trim().length >= 2 && (
                        <TableRow>
                          <TableCell
                            colSpan={5}
                            className="py-8 text-center text-muted-foreground"
                          >
                            No matching user_profiles found.
                          </TableCell>
                        </TableRow>
                      )}
                      {searchLoading && <TableSkeletonRows columns={5} rows={6} />}
                    </TableBody>
                  </Table>
                </div>
              )}

              <div className="flex justify-end">
                <Button
                  variant="destructive"
                  onClick={() => void handleReject()}
                  disabled={!selected || acting}
                >
                  <UserX className="h-3.5 w-3.5" />
                  Reject Applicant
                </Button>
              </div>
            </CardContent>
          </Card>
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
    <div className="rounded-lg border bg-muted/20 px-4 py-3">
      <div className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
        {label}
      </div>
      <div className="mt-1 text-sm font-medium">{fmt(value)}</div>
    </div>
  );
}
