"use client";

import { useCallback, useEffect, useState } from "react";
import { ExternalLink, RefreshCw } from "lucide-react";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { organizationRouteSuffix } from "@/lib/organizations";

// GET /api/admin/test-users 응답 row (lib/testUsers.ts TestUserDto 와 동일 shape).
type TestUser = {
  userId: string;
  name: string;
  email: string | null;
  seasonName: string | null;
  teamName: string | null;
  partName: string | null;
  roleLabel: string | null;
  status: string | null;
  growthStatus: string | null;
  organizationSlug: string | null;
  organizationName: string | null;
  userType: string | null;
  legacyUserId: string | null;
};

// 고객 페이지(front) 앱 origin. admin(3000)과 포트가 달라 sessionStorage 가 공유되지
// 않으므로, 이동은 절대 URL + 쿼리(demoUserId/demoUserName)로만 상태를 전달한다.
// 미설정 시 로컬 기본값(3001)로 폴백 — 운영에서는 NEXT_PUBLIC_CUSTOMER_APP_URL 필수.
const CUSTOMER_APP_URL = (
  process.env.NEXT_PUBLIC_CUSTOMER_APP_URL ?? "http://localhost:3001"
).replace(/\/+$/, "");

// 조직(organization_slug) → 고객 페이지 라우트 분기.
// API 경로(/api/cluster4/...)는 그대로, 페이지 라우트만 조직별로 나눈다.
// cluster number(4)는 내부 식별자라 그대로 두고, URL suffix(marketing/
// entertainment/planning)는 lib/organizations 의 단일 출처 매핑을 사용한다.
//   → 프론트 organization config 와 동일 규칙을 한 곳에서만 관리한다.
const CLUSTER_ROUTE_BASE = "/cluster-4";

function customerRouteForOrg(slug: string | null): string {
  return `${CLUSTER_ROUTE_BASE}-${organizationRouteSuffix(slug)}`;
}

function dash(value: string | null | undefined) {
  return value && value.trim() !== "" ? value : "-";
}

function growthSummary(user: TestUser) {
  const parts = [user.growthStatus, user.status].filter(
    (v): v is string => Boolean(v && v.trim()),
  );
  return parts.length > 0 ? parts.join(" · ") : "-";
}

export default function TestUsersManager() {
  const [users, setUsers] = useState<TestUser[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/admin/test-users", { cache: "no-store" });
      const json = await res.json();
      if (!res.ok || !json.success) {
        throw new Error(json?.error ?? "Failed to load test users.");
      }
      setUsers((json.data ?? []) as TestUser[]);
    } catch (err) {
      setError(
        err instanceof Error ? err.message : "Failed to load test users.",
      );
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const openCustomerPage = useCallback((user: TestUser) => {
    // 고객 앱은 다른 origin(포트 3001)이라 sessionStorage 가 공유되지 않는다.
    // → 상태(테스트 유저 id/이름)는 쿼리스트링으로만 전달하고, 절대 URL 로 이동한다.
    //   router.push(상대경로) 는 admin(3000) 기준이라 404 → 절대 URL 로 처리.
    // 어드민 탭(/admin/test-users)은 그대로 두고 고객 페이지는 새 탭에서 연다.
    //   window.open(_blank, noopener,noreferrer) → opener 노출 차단 + 새 브라우징 컨텍스트.
    // 조직(organization_slug)에 따라 페이지 라우트만 분기한다.
    const path = customerRouteForOrg(user.organizationSlug);
    const url = new URL(`${CUSTOMER_APP_URL}${path}`);
    url.searchParams.set("admin", "true");
    url.searchParams.set("demoUserId", user.userId);
    // 배너 이름 표시용 — sessionStorage 대체 (cross-origin 미공유).
    if (user.name && user.name.trim()) {
      url.searchParams.set("demoUserName", user.name.trim());
    }
    window.open(url.toString(), "_blank", "noopener,noreferrer");
  }, []);

  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between gap-2">
        <CardTitle>테스트 유저 (데모 미리보기)</CardTitle>
        <Button
          variant="outline"
          size="sm"
          onClick={() => void refresh()}
          disabled={loading}
        >
          <RefreshCw className={loading ? "animate-spin" : undefined} />
          새로고침
        </Button>
      </CardHeader>
      <CardContent>
        {error ? (
          <div className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">
            {error}
          </div>
        ) : null}

        <div className="overflow-x-auto">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>이름</TableHead>
                <TableHead>이메일</TableHead>
                <TableHead>조직</TableHead>
                <TableHead>시즌</TableHead>
                <TableHead>팀</TableHead>
                <TableHead>파트</TableHead>
                <TableHead>역할</TableHead>
                <TableHead>성장 상태</TableHead>
                <TableHead className="text-right">동작</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {loading ? (
                <TableRow>
                  <TableCell
                    colSpan={9}
                    className="py-8 text-center text-sm text-muted-foreground"
                  >
                    불러오는 중…
                  </TableCell>
                </TableRow>
              ) : users.length === 0 ? (
                <TableRow>
                  <TableCell
                    colSpan={9}
                    className="py-8 text-center text-sm text-muted-foreground"
                  >
                    {error ? "목록을 불러오지 못했습니다." : "테스트 유저가 없습니다."}
                  </TableCell>
                </TableRow>
              ) : (
                users.map((user) => (
                  <TableRow key={user.userId}>
                    <TableCell className="font-medium">{dash(user.name)}</TableCell>
                    <TableCell className="text-muted-foreground">
                      {dash(user.email)}
                    </TableCell>
                    <TableCell>{dash(user.organizationName)}</TableCell>
                    <TableCell>{dash(user.seasonName)}</TableCell>
                    <TableCell>{dash(user.teamName)}</TableCell>
                    <TableCell>{dash(user.partName)}</TableCell>
                    <TableCell>{dash(user.roleLabel)}</TableCell>
                    <TableCell>{growthSummary(user)}</TableCell>
                    <TableCell className="text-right">
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => openCustomerPage(user)}
                      >
                        <ExternalLink />
                        고객 페이지로 보기
                      </Button>
                    </TableCell>
                  </TableRow>
                ))
              )}
            </TableBody>
          </Table>
        </div>
      </CardContent>
    </Card>
  );
}
