"use client";

import { useState } from "react";
import { User } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import AdminHelpIconButton from "@/components/admin/AdminHelpIconButton";
import { ADMIN_SHARED_HELP_KEYS } from "@/lib/adminSharedHelpKeys";
import { organizationLabelKo } from "@/lib/organizations";
import { cn } from "@/lib/utils";

// ─────────────────────────────────────────────────────────────────────
// 회원 상단 공통 카드(인적사항 · 클럽 소속) — 회원 상세(/admin/members/[userId])와
//   주차 상세(/admin/members/[userId]/weeks/[weekId])가 "동일 컴포넌트"를 소비하도록 추출한다.
//   (페이지별 복제 금지. 도움말 키·프로필 사진 폴백·빈 값 처리까지 단일 구현.)
//
// 두 페이지 모두 GET /api/admin/members/[user_id] 의 같은 DTO 를 넘긴다 → 표시가 바이트 단위로 동일.
// ─────────────────────────────────────────────────────────────────────

// 회원 정체성 카드에 필요한 필드 집합(CrewDetailDto 의 부분집합 — 그대로 넘겨도 assignable).
export type CrewIdentity = {
  displayName: string | null;
  profilePhotoUrl: string | null;
  gender: string | null;
  birthDate: string | null;
  age: number | null;
  address: string | null;
  contactPhone: string | null;
  contactEmail: string | null;
  schoolName: string | null;
  departmentName: string | null;
  admissionPeriod: string | null;
  crewCode: string | null;
  organizationSlug: string | null;
  statusLabel: string;
  activityStartDate: string;
  activityStartWeek: string;
  activityEndDate: string;
  activityEndWeek: string;
  classLabel: string;
  teamName: string | null;
  partName: string | null;
};

// 클럽 표시명 = lib/organizations 단일 SoT(organizationLabelKo). 화면별 한글 매핑 재작성 금지.

// 문자열 값 — null/공백만 "-".
export function dash(value: string | null | undefined): string {
  return value && value.trim() ? value : "-";
}

// 요소 단위 도움말 키(인적사항/클럽 소속 섹션 + 메일 필드) — 회원 상세 페이지와 동일 레코드 공유.
//   (page_path=키 로 admin_page_help_contents 에 저장되므로 두 페이지가 같은 도움말을 본다.)
const IDENTITY_HELP = {
  personalInfo: "admin.members.detail.section.personalInfo",
  clubAffiliation: "admin.members.detail.section.clubAffiliation",
  contactEmail: "admin.members.detail.field.contactEmail",
} as const;

// 와이어프레임 필드 — 라벨 + bordered 값 박스(input 느낌). col-span 등은 className 으로.
//   회원 상세/주차 상세가 공유하는 공통 프리미티브(단일 구현).
export function Field({
  label,
  children,
  className,
  mono,
  helpKey,
}: {
  label: string;
  children: React.ReactNode;
  className?: string;
  mono?: boolean;
  helpKey?: string;
}) {
  return (
    <div className={cn("flex min-w-0 flex-col gap-1", className)}>
      <dt className="inline-flex items-center gap-1 text-xs font-medium text-muted-foreground">
        <span>{label}</span>
        {helpKey ? <AdminHelpIconButton helpKey={helpKey} title={label} /> : null}
      </dt>
      <dd
        className={cn(
          "flex min-h-[2.25rem] items-center break-words rounded-md border bg-muted/40 px-2.5 py-1.5 text-sm text-foreground",
          mono && "font-mono",
        )}
      >
        {children}
      </dd>
    </div>
  );
}

// 인적사항 + 클럽 소속 2카드(1행 2열 그리드, 좁은 화면 1열). 프로필 사진 로드 실패 폴백 내장.
export function CrewIdentityCards({ member }: { member: CrewIdentity }) {
  const [photoError, setPhotoError] = useState(false);
  return (
    <div className="grid grid-cols-1 gap-6 lg:grid-cols-[minmax(0,1.5fr)_minmax(360px,1fr)]">
      {/* 인적사항 */}
      <Card>
        <CardHeader>
          <CardTitle className="inline-flex items-center gap-1.5 text-base">
            인적사항
            <AdminHelpIconButton helpKey={IDENTITY_HELP.personalInfo} title="인적사항" size="sm" />
          </CardTitle>
        </CardHeader>
        <CardContent>
          <div className="flex gap-5">
            <div className="shrink-0">
              {member.profilePhotoUrl && !photoError ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img
                  src={member.profilePhotoUrl}
                  alt={`${dash(member.displayName)} 프로필 사진`}
                  className="h-36 w-28 rounded-lg object-cover ring-1 ring-foreground/10"
                  onError={() => setPhotoError(true)}
                />
              ) : (
                <div className="flex h-36 w-28 items-center justify-center rounded-lg bg-muted ring-1 ring-foreground/10">
                  <User className="h-10 w-10 text-muted-foreground" />
                </div>
              )}
            </div>
            <dl className="grid min-w-0 flex-1 grid-cols-1 gap-x-3 gap-y-3 sm:grid-cols-3">
              <Field label="이름" helpKey={ADMIN_SHARED_HELP_KEYS.crew.name}>
                {dash(member.displayName)}
              </Field>
              <Field label="성별">{dash(member.gender)}</Field>
              <Field label="생년월일">
                {member.birthDate
                  ? `${member.birthDate}${member.age != null ? ` (만 ${member.age})` : ""}`
                  : "-"}
              </Field>
              <Field label="거주지" className="sm:col-span-3">
                {dash(member.address)}
              </Field>
              <Field label="연락처">{dash(member.contactPhone)}</Field>
              <Field label="메일" className="sm:col-span-2" helpKey={IDENTITY_HELP.contactEmail}>
                {dash(member.contactEmail)}
              </Field>
              <Field label="학교">{dash(member.schoolName)}</Field>
              <Field label="전공">{dash(member.departmentName)}</Field>
              <Field label="입학 시기">{dash(member.admissionPeriod)}</Field>
            </dl>
          </div>
        </CardContent>
      </Card>

      {/* 클럽 소속 */}
      <Card>
        <CardHeader>
          <CardTitle className="inline-flex items-center gap-1.5 text-base">
            클럽 소속
            <AdminHelpIconButton helpKey={IDENTITY_HELP.clubAffiliation} title="클럽 소속" size="sm" />
          </CardTitle>
        </CardHeader>
        <CardContent>
          <dl className="grid grid-cols-1 gap-x-3 gap-y-3 sm:grid-cols-3">
            <Field label="크루 코드" mono helpKey={ADMIN_SHARED_HELP_KEYS.crew.code}>
              {member.crewCode ?? <span className="font-sans text-muted-foreground">미생성</span>}
            </Field>
            <Field label="클럽명" helpKey={ADMIN_SHARED_HELP_KEYS.crew.organization}>
              {organizationLabelKo(member.organizationSlug)}
            </Field>
            <Field label="상태">{dash(member.statusLabel)}</Field>
            <Field label="활동 시작일">{member.activityStartDate}</Field>
            <Field label="활동 시작 주차" className="sm:col-span-2">
              {member.activityStartWeek}
            </Field>
            <Field label="활동 종료일">{member.activityEndDate}</Field>
            <Field label="활동 종료 주차" className="sm:col-span-2">
              {member.activityEndWeek}
            </Field>
            <Field label="클래스">{dash(member.classLabel)}</Field>
            <Field label="소속 팀">{dash(member.teamName)}</Field>
            <Field label="파트">{dash(member.partName)}</Field>
          </dl>
        </CardContent>
      </Card>
    </div>
  );
}
