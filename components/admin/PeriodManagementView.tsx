"use client";

import AdminPageHeader from "@/components/admin/AdminPageHeader";
import PageSection from "@/components/admin/PageSection";
import PeriodRegisterForm from "@/components/admin/PeriodRegisterForm";
import SeasonWeeksList from "@/components/admin/SeasonWeeksList";
import { useReportLoading } from "@/components/admin/loadingBannerContext";
import { useSeasonWeeksData } from "@/components/admin/seasonWeeksData";

// ── 기간 관리(통합) 페이지 ────────────────────────────────────────────────────
//   /admin/periods/register 의 최상위 뷰. 기존 두 페이지(기간 등록 / 기간 정보)를 한 화면으로
//   합치되, 목록 기능은 재사용 컴포넌트(SeasonWeeksList)로 분리하고 데이터는 단일 조회를 공유한다.
//
//   레이아웃(위 → 아래):
//     1) 최상위 제목(h1) "기간 관리" + 페이지 전역 도움말 버튼(한 번만)
//     2) 기간 등록 폼(PeriodRegisterForm, 섹션 제목 h2 "기간 등록")
//     3) 가로 구분선(Separator) — 위아래 넉넉한 세로 여백은 admin-section-stack gap 이 담당
//     4) 기간 정보 목록(SeasonWeeksList, 섹션 제목 h2 "기간 정보")
//
//   · 등록 폼과 목록이 같은 /api/admin/season-weeks GET 을 각자 호출하지 않도록 useSeasonWeeksData
//     로 한 번만 조회해 공유(중복 호출 제거). 등록 성공 시 refetch 한 번으로 목록이 즉시 갱신된다.
//   · 등록 폼의 "취소"는 폼 입력만, 목록의 "초기화"는 필터/정렬만 리셋 — 상태가 서로 간섭하지 않는다.
//   · 데이터 조회에는 org/mode/test 분기가 없다(로더가 단일 SoT) — 일반/테스트/데모 DTO 동일.
export default function PeriodManagementView() {
  const { rows, generatedAt, loading, error, refetch } = useSeasonWeeksData();
  // 전역 로딩 배너 보고는 이 통합 뷰에서 한 번만(중복 보고 방지).
  useReportLoading(loading);

  return (
    <div className="admin-section-stack">
      {/* 최상위 제목 + 페이지 전역 도움말 — 공통 AdminPageHeader(도움말 내장·PageTitle 규격 통일) */}
      <AdminPageHeader title="기간 관리" />

      {/* [시범 적용] 주요 섹션을 PageSection 으로 감싼다 — 제목(h2 "기간 등록"·"기간 정보")은
          자식 컴포넌트(PeriodRegisterForm·SeasonWeeksList)가 이미 렌더하므로 PageSection 에는
          title 을 주지 않는다(제목 중복 렌더 금지 — 제목 개수 변경 없음).
          PageSection 은 ①섹션 사이 큰 간격(총 48/64px) ②두 번째 섹션 위 강화 fade 구분선만 담당한다.
          기존의 단독 <Separator/>는 이 divider 로 대체(위치 의미 동일). */}
      <PageSection>
        <PeriodRegisterForm rows={rows} onRegistered={refetch} />
      </PageSection>

      <PageSection divider="wave-dot">
        <SeasonWeeksList
          rows={rows}
          generatedAt={generatedAt}
          loading={loading}
          error={error}
          onRefresh={refetch}
        />
      </PageSection>
    </div>
  );
}
