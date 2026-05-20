import Link from "next/link";
import {
  AlertTriangle,
  ArrowRight,
  CalendarClock,
  ClipboardList,
  Database,
  Inbox,
  UserCheck,
  UserPlus,
  Users,
} from "lucide-react";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { cn } from "@/lib/utils";
import {
  loadDashboardSnapshot,
  type DashboardApplicant,
  type DashboardEditWindow,
  type DashboardMember,
} from "@/lib/adminDashboardData";
import {
  ORGANIZATION_LABEL,
  isOrganizationSlug,
} from "@/lib/organizations";
import { getResourceLabel } from "@/lib/adminEditWindowsTypes";

export const dynamic = "force-dynamic";

// 모든 시각 라벨은 서버에서 ko-KR 로 직접 포맷한다 (hydration 차이 회피).
const dateFormatter = new Intl.DateTimeFormat("ko-KR", {
  year: "2-digit",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  hour12: false,
});

function formatDateTime(iso: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return dateFormatter.format(d);
}

function formatRelativeFromNow(iso: string, now: Date): string {
  const target = new Date(iso);
  if (Number.isNaN(target.getTime())) return "—";
  const diffMs = target.getTime() - now.getTime();
  const absMin = Math.abs(Math.round(diffMs / 60000));
  if (absMin < 60) return diffMs >= 0 ? `${absMin}분 후` : `${absMin}분 전`;
  const absHour = Math.round(absMin / 60);
  if (absHour < 24) return diffMs >= 0 ? `${absHour}시간 후` : `${absHour}시간 전`;
  const absDay = Math.round(absHour / 24);
  return diffMs >= 0 ? `${absDay}일 후` : `${absDay}일 전`;
}

function membersHref(member: DashboardMember): string {
  if (member.organizationSlug && isOrganizationSlug(member.organizationSlug)) {
    return `/admin/crews/${member.organizationSlug}`;
  }
  return "/admin/members";
}

function editWindowHref(window: DashboardEditWindow): string {
  const params = new URLSearchParams({
    resource_key: window.resourceKey,
    q: window.userId,
  });
  return `/admin/settings/edit-windows?${params.toString()}`;
}

function memberDisplay(member: DashboardMember): string {
  return member.displayName?.trim() || member.authEmail || member.userId;
}

function applicantDisplay(applicant: DashboardApplicant): string {
  return applicant.name?.trim() || applicant.email || applicant.id;
}

function orgLabel(slug: string | null): string {
  if (slug && isOrganizationSlug(slug)) return ORGANIZATION_LABEL[slug];
  return slug ?? "미지정";
}

// ─────────────────────────────────────────────────────────────────────
// Primitives
// ─────────────────────────────────────────────────────────────────────

type Tone = "default" | "warn" | "ok";

type SummaryCardProps = {
  label: string;
  value: number;
  icon: typeof Users;
  tone?: Tone;
  hint?: string;
};

function SummaryCard({ label, value, icon: Icon, tone = "default", hint }: SummaryCardProps) {
  const isAlert = tone === "warn" && value > 0;
  return (
    <Card
      size="sm"
      className={cn(
        "transition-colors",
        isAlert && "ring-tone-warn/40 bg-tone-warn-bg/40",
      )}
    >
      <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-0">
        <CardTitle className="text-[11px] font-medium tracking-wide text-muted-foreground uppercase">
          {label}
        </CardTitle>
        <Icon
          className={cn(
            "h-3.5 w-3.5",
            isAlert ? "text-tone-warn" : "text-muted-foreground/70",
          )}
        />
      </CardHeader>
      <CardContent className="pt-0">
        <div
          className={cn(
            "text-3xl font-semibold tracking-tight tabular-nums leading-none",
            isAlert && "text-tone-warn",
          )}
        >
          {value.toLocaleString("ko-KR")}
        </div>
        {hint && (
          <div className="mt-1.5 text-[11px] text-muted-foreground">{hint}</div>
        )}
      </CardContent>
    </Card>
  );
}

function EmptyRow({ text }: { text: string }) {
  return (
    <li className="rounded-md border border-dashed border-border/70 bg-surface-subtle px-3 py-2 text-xs text-muted-foreground">
      {text}
    </li>
  );
}

function GroupHeading({
  label,
  hint,
  href,
}: {
  label: string;
  hint?: string;
  href?: { label: string; to: string };
}) {
  return (
    <div className="mb-2 flex items-end justify-between gap-3 px-0.5">
      <div className="flex items-baseline gap-2">
        <h3 className="text-[11px] font-semibold tracking-[0.12em] text-muted-foreground uppercase">
          {label}
        </h3>
        {hint && (
          <span className="text-[11px] text-muted-foreground/70">{hint}</span>
        )}
      </div>
      {href && (
        <Link
          href={href.to}
          className="inline-flex items-center gap-1 text-[11px] text-muted-foreground hover:text-foreground"
        >
          {href.label}
          <ArrowRight className="h-3 w-3" />
        </Link>
      )}
    </div>
  );
}

function SectionCard({
  title,
  href,
  hrefLabel,
  count,
  icon: Icon,
  tone = "default",
  attentionCount = 0,
  children,
}: {
  title: string;
  href: string;
  hrefLabel: string;
  count?: number;
  icon: typeof Users;
  tone?: Tone;
  attentionCount?: number;
  children: React.ReactNode;
}) {
  const showWarn = tone === "warn" && attentionCount > 0;
  return (
    <Card
      size="sm"
      className={cn(
        "transition-colors",
        showWarn && "ring-tone-warn/30",
      )}
    >
      <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
        <div className="flex items-center gap-2">
          <Icon
            className={cn(
              "h-3.5 w-3.5",
              showWarn ? "text-tone-warn" : "text-muted-foreground/70",
            )}
          />
          <CardTitle className="text-[13px] font-medium">
            {title}
            {typeof count === "number" && (
              <span className="ml-1.5 text-muted-foreground tabular-nums">
                {count.toLocaleString("ko-KR")}
              </span>
            )}
          </CardTitle>
        </div>
        <Link
          href={href}
          className="inline-flex items-center gap-1 text-[11px] text-muted-foreground hover:text-foreground"
        >
          {hrefLabel}
          <ArrowRight className="h-3 w-3" />
        </Link>
      </CardHeader>
      <CardContent className="pt-0">
        <ul className="flex flex-col gap-px">{children}</ul>
      </CardContent>
    </Card>
  );
}

const rowBase =
  "group/row flex items-center justify-between gap-3 rounded-md px-2.5 py-1.5 text-[13px] transition-colors hover:bg-muted/60";

const metaBase = "shrink-0 text-[11px] text-muted-foreground tabular-nums";

// ─────────────────────────────────────────────────────────────────────
// Page
// ─────────────────────────────────────────────────────────────────────

export default async function DashboardPage() {
  const now = new Date();
  const snapshot = await loadDashboardSnapshot(now);

  const { summary, actionNeeded, openEditWindows, recent } = snapshot;

  const actionTotal =
    actionNeeded.pendingApplicants.length +
    actionNeeded.membersWithoutOrganization.length +
    actionNeeded.membersWithoutAuthEmail.length +
    actionNeeded.expiringEditWindows.length;

  return (
    <div className="mx-auto flex w-full max-w-[1200px] flex-col gap-8">
      {/* Page header */}
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div className="space-y-1">
          <h2 className="text-xl font-semibold tracking-tight">대시보드</h2>
          <p className="text-[12px] text-muted-foreground tabular-nums">
            {formatDateTime(snapshot.generatedAt)} 기준 · 운영 상황판
          </p>
        </div>
        <nav className="flex flex-wrap gap-1.5" aria-label="빠른 이동">
          <Link
            href="/admin/members"
            className="inline-flex items-center gap-1.5 rounded-md border border-border bg-background px-2.5 py-1 text-[12px] font-medium text-foreground/80 hover:bg-muted hover:text-foreground"
          >
            <Users className="h-3.5 w-3.5" /> 전체 멤버
          </Link>
          <Link
            href="/admin/users/applicants"
            className="inline-flex items-center gap-1.5 rounded-md border border-border bg-background px-2.5 py-1 text-[12px] font-medium text-foreground/80 hover:bg-muted hover:text-foreground"
          >
            <UserCheck className="h-3.5 w-3.5" /> 승인 대기
          </Link>
          <Link
            href="/admin/settings/edit-windows"
            className="inline-flex items-center gap-1.5 rounded-md border border-border bg-background px-2.5 py-1 text-[12px] font-medium text-foreground/80 hover:bg-muted hover:text-foreground"
          >
            <CalendarClock className="h-3.5 w-3.5" /> 작성 기간 관리
          </Link>
          <Link
            href="/admin/import"
            className="inline-flex items-center gap-1.5 rounded-md border border-border bg-background px-2.5 py-1 text-[12px] font-medium text-foreground/80 hover:bg-muted hover:text-foreground"
          >
            <Database className="h-3.5 w-3.5" /> 데이터 가져오기
          </Link>
        </nav>
      </div>

      {/* KPIs */}
      <section>
        <GroupHeading label="KPI" hint="현재 운영 지표" />
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          <SummaryCard
            label="전체 멤버"
            value={summary.totalMembers}
            icon={Users}
            hint="전체 회원 수"
          />
          <SummaryCard
            label="승인 대기"
            value={summary.pendingApplicants}
            icon={UserCheck}
            tone="warn"
            hint="결정이 필요한 신청자"
          />
          <SummaryCard
            label="작성 기간 열림"
            value={summary.openEditWindows}
            icon={CalendarClock}
            hint="현재 작성 가능한 권한"
          />
          <SummaryCard
            label="최근 7일 수정"
            value={summary.recentlyUpdatedMembers}
            icon={ClipboardList}
            hint="최근 일주일 내 정보 수정"
          />
        </div>
      </section>

      {/* Action needed */}
      <section>
        <GroupHeading
          label="조치 필요"
          hint={actionTotal > 0 ? `현재 노출 ${actionTotal}건` : "처리할 항목 없음"}
        />
        <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
          <SectionCard
            title="승인 대기"
            icon={UserCheck}
            tone="warn"
            attentionCount={actionNeeded.pendingApplicants.length}
            href="/admin/users/applicants"
            hrefLabel="전체"
            count={summary.pendingApplicants}
          >
            {actionNeeded.pendingApplicants.length === 0 ? (
              <EmptyRow text="대기 중인 신청자가 없습니다." />
            ) : (
              actionNeeded.pendingApplicants.map((applicant) => (
                <li key={applicant.id}>
                  <Link href="/admin/users/applicants" className={rowBase}>
                    <div className="flex min-w-0 flex-col">
                      <span className="truncate font-medium">
                        {applicantDisplay(applicant)}
                      </span>
                      <span className="truncate text-[11px] text-muted-foreground">
                        {applicant.email ?? "이메일 없음"}
                        {applicant.provider ? ` · ${applicant.provider}` : ""}
                      </span>
                    </div>
                    <span className={metaBase}>
                      {formatDateTime(applicant.createdAt)}
                    </span>
                  </Link>
                </li>
              ))
            )}
          </SectionCard>

          <SectionCard
            title="7일 내 만료되는 작성 기간"
            icon={CalendarClock}
            tone="warn"
            attentionCount={actionNeeded.expiringEditWindows.length}
            href="/admin/settings/edit-windows"
            hrefLabel="작성 기간 관리"
            count={actionNeeded.expiringEditWindows.length}
          >
            {actionNeeded.expiringEditWindows.length === 0 ? (
              <EmptyRow text="만료가 임박한 작성 기간이 없습니다." />
            ) : (
              actionNeeded.expiringEditWindows.map((w) => (
                <li key={w.id}>
                  <Link href={editWindowHref(w)} className={rowBase}>
                    <div className="flex min-w-0 flex-col">
                      <span className="truncate font-medium">
                        {w.displayName ?? w.userId}
                      </span>
                      <span className="truncate text-[11px] text-muted-foreground">
                        {getResourceLabel(w.resourceKey)}
                      </span>
                    </div>
                    <span className="shrink-0 text-[11px] font-medium tabular-nums text-tone-warn">
                      {formatRelativeFromNow(w.expiresAt, now)} 만료
                    </span>
                  </Link>
                </li>
              ))
            )}
          </SectionCard>

          <SectionCard
            title="소속 없는 멤버"
            icon={AlertTriangle}
            tone="warn"
            attentionCount={actionNeeded.membersWithoutOrganization.length}
            href="/admin/members"
            hrefLabel="멤버 목록"
            count={actionNeeded.membersWithoutOrganization.length}
          >
            {actionNeeded.membersWithoutOrganization.length === 0 ? (
              <EmptyRow text="조치 필요한 멤버가 없습니다." />
            ) : (
              actionNeeded.membersWithoutOrganization.map((member) => (
                <li key={member.userId}>
                  <Link href={membersHref(member)} className={rowBase}>
                    <div className="flex min-w-0 flex-col">
                      <span className="truncate font-medium">
                        {memberDisplay(member)}
                      </span>
                      <span className="truncate text-[11px] text-muted-foreground">
                        {member.authEmail ?? "로그인 이메일 없음"}
                      </span>
                    </div>
                    <span className={metaBase}>
                      {formatDateTime(member.createdAt)}
                    </span>
                  </Link>
                </li>
              ))
            )}
          </SectionCard>

          <SectionCard
            title="로그인 이메일 없는 멤버"
            icon={AlertTriangle}
            tone="warn"
            attentionCount={actionNeeded.membersWithoutAuthEmail.length}
            href="/admin/members"
            hrefLabel="멤버 목록"
            count={actionNeeded.membersWithoutAuthEmail.length}
          >
            {actionNeeded.membersWithoutAuthEmail.length === 0 ? (
              <EmptyRow text="조치 필요한 멤버가 없습니다." />
            ) : (
              actionNeeded.membersWithoutAuthEmail.map((member) => (
                <li key={member.userId}>
                  <Link href={membersHref(member)} className={rowBase}>
                    <div className="flex min-w-0 flex-col">
                      <span className="truncate font-medium">
                        {memberDisplay(member)}
                      </span>
                      <span className="truncate text-[11px] text-muted-foreground">
                        {orgLabel(member.organizationSlug)}
                      </span>
                    </div>
                    <span className={metaBase}>
                      {formatDateTime(member.createdAt)}
                    </span>
                  </Link>
                </li>
              ))
            )}
          </SectionCard>
        </div>
      </section>

      {/* Open edit windows */}
      <section>
        <GroupHeading
          label="운영 상태"
          hint="현재 열려 있는 작성 기간"
          href={{ label: "작성 기간 관리", to: "/admin/settings/edit-windows" }}
        />
        <Card size="sm">
          <CardContent className="px-2 py-2">
            {openEditWindows.length === 0 ? (
              <EmptyRow text="열려 있는 작성 기간이 없습니다." />
            ) : (
              <ul className="flex flex-col gap-px">
                {openEditWindows.map((w) => (
                  <li key={w.id}>
                    <Link
                      href={editWindowHref(w)}
                      className="grid grid-cols-[1fr,1.4fr,auto] items-center gap-3 rounded-md px-2.5 py-1.5 text-[13px] transition-colors hover:bg-muted/60"
                    >
                      <span className="flex items-center gap-2 truncate font-medium">
                        <span className="inline-block h-1.5 w-1.5 shrink-0 rounded-full bg-tone-ok" aria-hidden />
                        {w.displayName ?? w.userId}
                      </span>
                      <span className="truncate text-[12px] text-muted-foreground">
                        {getResourceLabel(w.resourceKey)}
                      </span>
                      <span className="shrink-0 text-[11px] tabular-nums text-muted-foreground">
                        만료 {formatDateTime(w.expiresAt)}{" "}
                        <span className="text-foreground/70">
                          · {formatRelativeFromNow(w.expiresAt, now)}
                        </span>
                      </span>
                    </Link>
                  </li>
                ))}
              </ul>
            )}
          </CardContent>
        </Card>
      </section>

      {/* Recent activity (보조 정보 — 시각 위계 한 단계 낮춤) */}
      <section className="pb-4">
        <GroupHeading label="최근 활동" hint="참고용" />
        <div className="grid grid-cols-1 gap-3 lg:grid-cols-3">
          <SectionCard
            title="최근 가입된 멤버"
            icon={UserPlus}
            href="/admin/members"
            hrefLabel="멤버 목록"
          >
            {recent.newMembers.length === 0 ? (
              <EmptyRow text="최근 가입한 멤버가 없습니다." />
            ) : (
              recent.newMembers.map((m) => (
                <li key={m.userId}>
                  <Link href={membersHref(m)} className={rowBase}>
                    <span className="truncate font-medium">{memberDisplay(m)}</span>
                    <span className={metaBase}>{formatDateTime(m.createdAt)}</span>
                  </Link>
                </li>
              ))
            )}
          </SectionCard>

          <SectionCard
            title="최근 수정된 멤버"
            icon={ClipboardList}
            href="/admin/members"
            hrefLabel="멤버 목록"
          >
            {recent.recentlyUpdatedMembers.length === 0 ? (
              <EmptyRow text="최근 수정된 멤버가 없습니다." />
            ) : (
              recent.recentlyUpdatedMembers.map((m) => (
                <li key={m.userId}>
                  <Link href={membersHref(m)} className={rowBase}>
                    <span className="truncate font-medium">{memberDisplay(m)}</span>
                    <span className={metaBase}>{formatDateTime(m.updatedAt)}</span>
                  </Link>
                </li>
              ))
            )}
          </SectionCard>

          <SectionCard
            title="최근 신청자"
            icon={Inbox}
            href="/admin/users/applicants"
            hrefLabel="승인 대기"
          >
            {recent.newApplicants.length === 0 ? (
              <EmptyRow text="최근 신청자가 없습니다." />
            ) : (
              recent.newApplicants.map((a) => (
                <li key={a.id}>
                  <Link href="/admin/users/applicants" className={rowBase}>
                    <span className="truncate font-medium">
                      {applicantDisplay(a)}
                    </span>
                    <span className={metaBase}>{formatDateTime(a.createdAt)}</span>
                  </Link>
                </li>
              ))
            )}
          </SectionCard>
        </div>
      </section>
    </div>
  );
}
