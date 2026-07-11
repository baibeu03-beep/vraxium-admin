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
import { TableSkeletonRows } from "@/components/ui/table-skeleton";
import { useReportLoading } from "@/components/admin/loadingBannerContext";
import AdminHelpIconButton from "@/components/admin/AdminHelpIconButton";
import { buildCustomerClusterUrl } from "@/lib/customerAppUrl";

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
  useReportLoading(loading);
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
    // base URL 해석/쿼리 구성은 lib/customerAppUrl 의 단일 헬퍼로 통일(어드민 진입 SoT).
    //   /admin/test-users 목록은 전원 test_user_markers → test=true(demoUserId+mode=test).
    //   여름 시뮬레이션 뷰와 미리보기를 일치시킨다(snapshot 로직 불변 — mode=test 면 live summer-sim).
    const url = buildCustomerClusterUrl(user.organizationSlug, user.userId, {
      test: true,
      name: user.name,
    });
    if (!url) {
      // 운영에서 env 미설정: localhost 로 가지 않고 명시적으로 차단/안내.
      setError(
        "크루 페이지 URL이 설정되지 않았습니다. Vercel 환경변수 NEXT_PUBLIC_CUSTOMER_APP_URL " +
          "(예: https://<크루앱>.vercel.app)을 설정해 주세요.",
      );
      return;
    }
    // 어드민 탭(/admin/test-users)은 그대로 두고 크루 페이지는 새 탭에서 연다.
    //   window.open(_blank, noopener,noreferrer) → opener 노출 차단 + 새 브라우징 컨텍스트.
    window.open(url, "_blank", "noopener,noreferrer");
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
        <CardTitle className="inline-flex items-center gap-1.5">
          테스트 유저 (데모 미리보기)
          <AdminHelpIconButton
            helpKey="admin.testUsers.section.list"
            title="테스트 유저 (데모 미리보기)"
            size="sm"
          />
        </CardTitle>
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
                <TableHead>
                  <span className="inline-flex items-center gap-1">
                    <span>이름</span>
                    <AdminHelpIconButton
                      helpKey="admin.testUsers.column.name"
                      title="이름"
                      size="xs"
                    />
                  </span>
                </TableHead>
                <TableHead>
                  <span className="inline-flex items-center gap-1">
                    <span>이메일</span>
                    <AdminHelpIconButton
                      helpKey="admin.testUsers.column.email"
                      title="이메일"
                      size="xs"
                    />
                  </span>
                </TableHead>
                <TableHead>
                  <span className="inline-flex items-center gap-1">
                    <span>조직</span>
                    <AdminHelpIconButton
                      helpKey="admin.testUsers.column.organization"
                      title="조직"
                      size="xs"
                    />
                  </span>
                </TableHead>
                <TableHead>
                  <span className="inline-flex items-center gap-1">
                    <span>시즌</span>
                    <AdminHelpIconButton
                      helpKey="admin.testUsers.column.season"
                      title="시즌"
                      size="xs"
                    />
                  </span>
                </TableHead>
                <TableHead>
                  <span className="inline-flex items-center gap-1">
                    <span>팀</span>
                    <AdminHelpIconButton
                      helpKey="admin.testUsers.column.team"
                      title="팀"
                      size="xs"
                    />
                  </span>
                </TableHead>
                <TableHead>
                  <span className="inline-flex items-center gap-1">
                    <span>파트</span>
                    <AdminHelpIconButton
                      helpKey="admin.testUsers.column.part"
                      title="파트"
                      size="xs"
                    />
                  </span>
                </TableHead>
                <TableHead>
                  <span className="inline-flex items-center gap-1">
                    <span>역할</span>
                    <AdminHelpIconButton
                      helpKey="admin.testUsers.column.role"
                      title="역할"
                      size="xs"
                    />
                  </span>
                </TableHead>
                <TableHead>
                  <span className="inline-flex items-center gap-1">
                    <span>등급</span>
                    <AdminHelpIconButton
                      helpKey="admin.testUsers.column.grade"
                      title="등급"
                      size="xs"
                    />
                  </span>
                </TableHead>
                <TableHead>
                  <span className="inline-flex items-center gap-1">
                    <span>성장 상태</span>
                    <AdminHelpIconButton
                      helpKey="admin.testUsers.column.growthStatus"
                      title="성장 상태"
                      size="xs"
                    />
                  </span>
                </TableHead>
                <TableHead>
                  <span className="inline-flex items-center gap-1">
                    <span>동작</span>
                    <AdminHelpIconButton
                      helpKey="admin.testUsers.column.action"
                      title="동작"
                      size="xs"
                    />
                  </span>
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {loading ? (
                <TableSkeletonRows columns={10} rows={6} />
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
                    <TableCell>
                      {/* 1행 2열 가로 배치 — 왼쪽: 어드민 페이지로 보기 / 오른쪽: 크루 페이지로 보기.
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
                          크루 페이지로 보기
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
