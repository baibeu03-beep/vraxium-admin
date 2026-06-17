"use client";

import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { ArrowLeft, ExternalLink, Loader2, NotebookPen, User, X } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { appendModeQuery, type ScopeMode } from "@/lib/userScopeShared";
import { buildCustomerClusterUrl } from "@/lib/customerAppUrl";

type CrewNote = {
  note: string;
  updatedAt: string | null;
  updatedBy: string | null;
};

type CrewDetailDto = {
  userId: string;
  displayName: string | null;
  organizationSlug: string | null;
  isTestUser: boolean;
  // 인적사항
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
  // 클럽 소속
  crewCode: string | null;
  statusLabel: string;
  activityStartDate: string;
  activityStartWeek: string;
  activityEndDate: string;
  activityEndWeek: string;
  classLabel: string;
  teamName: string | null;
  partName: string | null;
  note: CrewNote;
};

const CLUB_LABEL_KO: Record<string, string> = {
  encre: "엥크레",
  oranke: "오랑캐",
  phalanx: "팔랑크스",
};

function dash(value: string | null | undefined): string {
  return value && value.trim() ? value : "-";
}

export default function CrewDetail({
  userId,
  mode,
}: {
  userId: string;
  mode: ScopeMode;
}) {
  const router = useRouter();
  const [detail, setDetail] = useState<CrewDetailDto | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // 클럽 관리 기록 모달.
  const [noteOpen, setNoteOpen] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`/api/admin/members/${userId}`, { cache: "no-store" });
      const json = await res.json();
      if (!res.ok || !json.success) {
        throw new Error(json?.error ?? "크루 상세를 불러오지 못했습니다.");
      }
      setDetail(json.data as CrewDetailDto);
    } catch (err) {
      setError(err instanceof Error ? err.message : "크루 상세를 불러오지 못했습니다.");
    } finally {
      setLoading(false);
    }
  }, [userId]);

  useEffect(() => {
    // 마운트 시 상세 1회 fetch(표준 데이터 로딩 effect). load 내부 setState 는 의도된 동작.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void load();
  }, [load]);

  const goBack = useCallback(() => {
    // 목록 조건(클럽/필터/검색/정렬)은 MembersList 가 sessionStorage 로 복원한다.
    // 모집단 모드만 URL 로 유지(operating 은 쿼리 생략).
    router.push(appendModeQuery("/admin/members", mode));
  }, [router, mode]);

  const openCareerResume = useCallback(() => {
    if (!detail) return;
    // 고객 페이지 SoT 경로(/cluster-4-<suffix>) 재사용. 새 탭.
    //   테스트 유저(test_user_markers) → demoUserId+mode=test(테스트 유저 모드 배너·여름 시뮬).
    //   일반(운영) 크루 → userId 만(배너 없음·실제 사용자 cluster-4 카드). 모집단 모드(list)와
    //   무관하게 "그 크루가 테스트 유저인가"로만 결정한다(operating 탭의 일반 크루에 배너 금지).
    const url = buildCustomerClusterUrl(detail.organizationSlug, detail.userId, {
      test: detail.isTestUser,
      name: detail.displayName,
    });
    if (!url) {
      setError(
        "고객 앱 URL이 설정되지 않았습니다. 환경변수 NEXT_PUBLIC_CUSTOMER_APP_URL 을 확인해 주세요.",
      );
      return;
    }
    window.open(url, "_blank", "noopener,noreferrer");
  }, [detail]);

  return (
    <div className="mx-auto flex w-full max-w-5xl flex-col gap-6 px-4 py-6">
      {/* 상단 3버튼 헤더 — 1행 3열 그리드 */}
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
        <Button variant="outline" onClick={goBack} className="justify-center">
          <ArrowLeft className="h-4 w-4" />
          목록으로 돌아가기
        </Button>
        <Button
          variant="outline"
          onClick={openCareerResume}
          disabled={loading || !detail}
          className="justify-center"
        >
          <ExternalLink className="h-4 w-4" />
          크루 : 커리어레쥬메
        </Button>
        <Button
          variant="outline"
          onClick={() => setNoteOpen(true)}
          disabled={loading || !detail}
          className="justify-center"
        >
          <NotebookPen className="h-4 w-4" />
          클럽 관리 기록
        </Button>
      </div>

      {error && (
        <div className="rounded-md border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
          {error}
        </div>
      )}

      {loading ? (
        <Card>
          <CardContent>
            <div className="flex items-center gap-2 py-8 text-sm text-muted-foreground">
              <Loader2 className="h-4 w-4 animate-spin" />
              불러오는 중...
            </div>
          </CardContent>
        </Card>
      ) : detail ? (
        // 1행 2열 그리드 — 왼쪽: 인적사항 / 오른쪽: 클럽 소속.
        <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
          {/* 인적사항 */}
          <Card>
            <CardHeader>
              <CardTitle className="text-base">인적사항</CardTitle>
            </CardHeader>
            <CardContent>
              <div className="flex gap-5">
                {/* 프로필 사진 — Cluster2 첫 번째 슬롯(없으면 placeholder) */}
                <div className="shrink-0">
                  {detail.profilePhotoUrl ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img
                      src={detail.profilePhotoUrl}
                      alt={`${dash(detail.displayName)} 프로필 사진`}
                      className="h-28 w-28 rounded-lg object-cover ring-1 ring-foreground/10"
                    />
                  ) : (
                    <div className="flex h-28 w-28 items-center justify-center rounded-lg bg-muted ring-1 ring-foreground/10">
                      <User className="h-10 w-10 text-muted-foreground" />
                    </div>
                  )}
                </div>
                {/* 인적 정보 */}
                <dl className="grid flex-1 grid-cols-1 gap-x-6 gap-y-2.5 sm:grid-cols-2">
                  <Field label="이름">{dash(detail.displayName)}</Field>
                  <Field label="성별">{dash(detail.gender)}</Field>
                  <Field label="생년월일">
                    {dash(detail.birthDate)}
                    {detail.age != null ? ` (만 ${detail.age})` : ""}
                  </Field>
                  <Field label="거주지">{dash(detail.address)}</Field>
                  <Field label="연락처">{dash(detail.contactPhone)}</Field>
                  <Field label="메일">{dash(detail.contactEmail)}</Field>
                  <Field label="학교">{dash(detail.schoolName)}</Field>
                  <Field label="전공">{dash(detail.departmentName)}</Field>
                  <Field label="입학 시기">{dash(detail.admissionPeriod)}</Field>
                </dl>
              </div>
            </CardContent>
          </Card>

          {/* 클럽 소속 */}
          <Card>
            <CardHeader>
              <CardTitle className="text-base">클럽 소속</CardTitle>
            </CardHeader>
            <CardContent>
              <dl className="grid grid-cols-1 gap-x-6 gap-y-2.5 sm:grid-cols-2">
                <Field label="크루 코드">
                  <span className="font-mono">
                    {detail.crewCode ?? <span className="text-muted-foreground">미생성</span>}
                  </span>
                </Field>
                <Field label="클럽명">
                  {detail.organizationSlug
                    ? CLUB_LABEL_KO[detail.organizationSlug] ?? detail.organizationSlug
                    : "공통"}
                </Field>
                <Field label="상태">{dash(detail.statusLabel)}</Field>
                <Field label="클래스">{dash(detail.classLabel)}</Field>
                <Field label="활동 시작일">{dash(detail.activityStartDate)}</Field>
                <Field label="활동 시작 주차">{dash(detail.activityStartWeek)}</Field>
                <Field label="활동 종료일">{dash(detail.activityEndDate)}</Field>
                <Field label="활동 종료 주차">{dash(detail.activityEndWeek)}</Field>
                <Field label="소속 팀">{dash(detail.teamName)}</Field>
                <Field label="파트">{dash(detail.partName)}</Field>
              </dl>
            </CardContent>
          </Card>
        </div>
      ) : (
        <Card>
          <CardContent>
            <p className="py-8 text-sm text-muted-foreground">크루를 찾을 수 없습니다.</p>
          </CardContent>
        </Card>
      )}

      {noteOpen && detail && (
        <CrewNoteDialog
          userId={detail.userId}
          displayName={detail.displayName}
          crewCode={detail.crewCode}
          initialNote={detail.note}
          onClose={() => setNoteOpen(false)}
          onSaved={(saved) =>
            setDetail((prev) => (prev ? { ...prev, note: saved } : prev))
          }
        />
      )}
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-0.5">
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className="text-sm text-foreground">{children}</dd>
    </div>
  );
}

// 클럽 관리 기록 모달 — 이름·크루 코드 표시 + 관리자 메모(취소/저장). autosave 없음.
function CrewNoteDialog({
  userId,
  displayName,
  crewCode,
  initialNote,
  onClose,
  onSaved,
}: {
  userId: string;
  displayName: string | null;
  crewCode: string | null;
  initialNote: CrewNote;
  onClose: () => void;
  onSaved: (saved: CrewNote) => void;
}) {
  const [note, setNote] = useState(initialNote.note);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const save = useCallback(async () => {
    setSaving(true);
    setError(null);
    try {
      const res = await fetch(`/api/admin/members/${userId}/note`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ note }),
      });
      const json = await res.json();
      if (!res.ok || !json.success) {
        throw new Error(json?.error ?? "메모를 저장하지 못했습니다.");
      }
      onSaved(json.data as CrewNote);
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : "메모를 저장하지 못했습니다.");
    } finally {
      setSaving(false);
    }
  }, [userId, note, onSaved, onClose]);

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget && !saving) onClose();
      }}
    >
      <div className="w-full max-w-md rounded-xl bg-card p-5 shadow-xl ring-1 ring-foreground/10">
        <div className="mb-3 flex items-center justify-between">
          <h2 className="text-base font-semibold">클럽 관리 기록</h2>
          <button type="button" onClick={onClose} disabled={saving} className="hover:opacity-70">
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="space-y-1.5 rounded-md border bg-muted/30 px-3 py-2 text-sm">
          <div className="flex justify-between gap-2">
            <span className="text-muted-foreground">이름</span>
            <span className="font-medium">{dash(displayName)}</span>
          </div>
          <div className="flex justify-between gap-2">
            <span className="text-muted-foreground">크루 코드</span>
            <span className="font-mono">{crewCode ?? "미생성"}</span>
          </div>
        </div>

        <label className="mt-3 flex flex-col gap-1 text-xs text-muted-foreground">
          관리자 메모
          <textarea
            value={note}
            onChange={(e) => setNote(e.target.value)}
            rows={6}
            placeholder="관리 메모를 입력하세요."
            className="w-full resize-y rounded-md border border-input bg-background px-3 py-2 text-sm text-foreground"
          />
        </label>

        {error && (
          <div className="mt-2 rounded-md border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700">
            {error}
          </div>
        )}

        <div className="mt-4 flex justify-end gap-2">
          <Button type="button" variant="ghost" size="sm" disabled={saving} onClick={onClose}>
            취소
          </Button>
          <Button type="button" size="sm" disabled={saving} onClick={save}>
            {saving && <Loader2 className={cn("h-4 w-4 animate-spin")} />}
            저장
          </Button>
        </div>
      </div>
    </div>
  );
}
