"use client";

import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { ExternalLink, RefreshCw, ShieldCheck } from "lucide-react";
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
import { resolveCustomerAppUrl } from "@/lib/customerAppUrl";

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
  memberRole: "team_leader" | "part_leader" | "agent" | "member";
};

// 어드민 임퍼소네이션 버튼 노출 대상 역할(team_leader/part_leader/agent). crew/member 제외.
const IMPERSONATABLE_ROLES = new Set(["team_leader", "part_leader", "agent"]);

// memberRole(normalizeMemberRole 출력) → 한글 역할 라벨.
const MEMBER_ROLE_LABEL: Record<TestUser["memberRole"], string> = {
  team_leader: "팀장",
  part_leader: "파트장",
  agent: "에이전트",
  member: "일반",
};

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
  const router = useRouter();
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
    // 고객 앱은 다른 origin(별도 Vercel 배포/도메인)이라 sessionStorage 가 공유되지
    // 않는다. → 상태(테스트 유저 id/이름)는 쿼리스트링으로만 전달하고, 절대 URL 로 이동.
    //   router.push(상대경로) 는 admin 기준이라 404 → 절대 URL 로 처리.
    // 고객 도메인은 admin 도메인과 다르므로 window.location.origin 으로 유추 불가 →
    //   lib/customerAppUrl 의 단일 resolver(env 우선, 운영 localhost 금지)를 사용한다.
    const customerAppUrl = resolveCustomerAppUrl();
    if (!customerAppUrl) {
      // 운영에서 env 미설정: localhost 로 가지 않고 명시적으로 차단/안내.
      setError(
        "고객 앱 URL이 설정되지 않았습니다. Vercel 환경변수 NEXT_PUBLIC_CUSTOMER_APP_URL " +
          "(예: https://<고객앱>.vercel.app)을 설정해 주세요.",
      );
      return;
    }

    // 어드민 탭(/admin/test-users)은 그대로 두고 고객 페이지는 새 탭에서 연다.
    //   window.open(_blank, noopener,noreferrer) → opener 노출 차단 + 새 브라우징 컨텍스트.
    // 조직(organization_slug)에 따라 페이지 라우트만 분기한다.
    const path = customerRouteForOrg(user.organizationSlug);
    const url = new URL(`${customerAppUrl}${path}`);
    url.searchParams.set("admin", "true");
    url.searchParams.set("demoUserId", user.userId);
    // 배너 이름 표시용 — sessionStorage 대체 (cross-origin 미공유).
    if (user.name && user.name.trim()) {
      url.searchParams.set("demoUserName", user.name.trim());
    }
    window.open(url.toString(), "_blank", "noopener,noreferrer");
  }, []);

  // 어드민 페이지로 보기 — 해당 테스트 유저의 역할로 임퍼소네이션(mode=test + actAsTestUserId).
  //   같은 origin(admin) 이므로 새 탭으로 이동(test-users 목록 유지). org/mode/tab/actAs query 부착.
  const openAdminPage = useCallback((user: TestUser) => {
    const org = user.organizationSlug ?? "";
    const params = new URLSearchParams();
    if (org) params.set("org", org);
    params.set("mode", "test");
    params.set("tab", "open");
    params.set("actAsTestUserId", user.userId);
    const url = `/admin/line-opening/practical-experience?${params.toString()}`;
    window.open(url, "_blank", "noopener,noreferrer");
    void router; // 동일 origin — 새 탭 유지(라우터 미사용, 목록 보존)
  }, [router]);

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
                <TableHead>등급</TableHead>
                <TableHead>성장 상태</TableHead>
                <TableHead className="text-right">동작</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {loading ? (
                <TableRow>
                  <TableCell
                    colSpan={10}
                    className="py-8 text-center text-sm text-muted-foreground"
                  >
                    불러오는 중…
                  </TableCell>
                </TableRow>
              ) : users.length === 0 ? (
                <TableRow>
                  <TableCell
                    colSpan={10}
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
                    {/* 역할 — memberRole(팀장/파트장/에이전트/일반). 등급(아래)=membership_level raw. */}
                    <TableCell>{MEMBER_ROLE_LABEL[user.memberRole] ?? "일반"}</TableCell>
                    <TableCell>{dash(user.roleLabel)}</TableCell>
                    <TableCell>{growthSummary(user)}</TableCell>
                    <TableCell className="text-right">
                      {/* 1행 2열 가로 배치 — 왼쪽: 어드민 페이지로 보기 / 오른쪽: 고객 페이지로 보기.
                          어드민 버튼은 team_leader/part_leader/agent 만 노출(crew/member 미노출 — 동작/조건 불변). */}
                      <div className="flex items-center justify-end gap-2">
                        {IMPERSONATABLE_ROLES.has(user.memberRole) && (
                          <Button
                            variant="outline"
                            size="sm"
                            onClick={() => openAdminPage(user)}
                            title={`${user.memberRole} 역할로 어드민 페이지 임퍼소네이션(mode=test)`}
                          >
                            <ShieldCheck />
                            어드민 페이지로 보기
                          </Button>
                        )}
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={() => openCustomerPage(user)}
                        >
                          <ExternalLink />
                          고객 페이지로 보기
                        </Button>
                      </div>
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
