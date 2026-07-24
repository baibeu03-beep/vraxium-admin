# 전역 테이블 페이지네이션 전수조사

기준: 필터·검색·정렬 완료 행이 20개 이하이면 숨김, 21개 이상이면 20개씩 표시.
공통 SoT는 `lib/tablePagination.ts`의 `DEFAULT_TABLE_PAGE_SIZE`다.

## 집계

| 분류 | 수 |
|---|---:|
| 공통 자동 페이지네이션 적용 | 47 |
| 기존 서버 페이지네이션 유지(20행 통일) | 7 |
| 기존 클라이언트 페이지네이션 유지(20행 통일) | 6 |
| 의도적인 예외 | 12 |
| 합계 | 72 |

`<Table>` 49곳, native `<table>` 22곳, div/card 기반 행 목록 1곳을 조사했다.
`role="table"`, `role="grid"`, `role="row"` 기반의 추가 독립 테이블 구현은 없었다.

## 1. 공통 자동 페이지네이션 적용 (47)

공통 `Table`이 필터·정렬 완료 후 전달된 `TableBody` 행을 페이지 단위로 자른다.
native 표는 같은 알고리즘을 쓰는 `PaginatedNativeTable`로 감쌌다.

### 공통 `Table` 경유 (37)

- `components/ui/app-table.tsx` (향후 선언형 표 포함)
- `components/admin/AdminUsersList.tsx`
- `components/admin/ApplicantManager.tsx` 2곳
- `components/admin/ApplicantsList.tsx` 2곳
- `components/admin/AppUsersList.tsx`
- `components/admin/CompetencyApplicantSection.tsx`
- `components/admin/CrewManager.tsx`
- `components/admin/cluster4/CareerEvaluationTab.tsx`
- `components/admin/cluster4/Cluster4LineTable.tsx` 2곳
- `components/admin/LineRegistrationInfoManager.tsx`
- `components/admin/OfficialRestPeriodsManager.tsx`
- `components/admin/OperationHealthCheckView.tsx`
- `components/admin/PracticalCareerManager.tsx`
- `components/admin/PracticalCompetencyManager.tsx` 2곳
- `components/admin/PracticalExperienceManager.tsx` 5곳
- `components/admin/PracticalInfoManager.tsx` 2곳
- `components/admin/ProcessCheckActTable.tsx`
- `components/admin/ProcessCheckCompletedCrewList.tsx`
- `components/admin/ProcessCheckManualGrantDialog.tsx`
- `components/admin/ProcessIrregularManager.tsx`
- `components/admin/ProcessIrregularManualGrantDialog.tsx`
- `components/admin/SeasonParticipationsView.tsx`
- `components/admin/TestUsersManager.tsx`
- `components/admin/UserWeeklyStatusView.tsx`
- `components/admin/WeekRecognitionsView.tsx` 3곳

### native 표 경유 (10)

- `components/admin/CafeCrewPicker.tsx`
- `components/admin/CompetencyLineManageBoard.tsx`
- `components/admin/CrewDetail.tsx` 시즌 이력
- `components/admin/CrewWeekActHistory.tsx`
- `components/admin/CrewWeekLineHistory.tsx`
- `components/admin/CrewWeekPublishPanel.tsx` 팀 결과
- `components/admin/CrewWeekPublishPanel.tsx` 크루 결과
- `components/admin/CrewWeekResultsDetailTable.tsx`
- `components/admin/PracticalInfoCrewEditModal.tsx`
- `components/admin/TeamDetail.tsx` 크루 편집 목록

## 2. 기존 서버 페이지네이션 유지, 20행 통일 (7)

응답 배열 길이가 아니라 서버의 실제 `total`/`filteredTotal`/`pagination.totalCount`를 사용한다.

- `components/admin/AccountsManager.tsx` ↔ `app/api/admin/accounts/route.ts`
- `components/admin/CareerProjectsManager.tsx` ↔ `app/api/admin/career-projects/route.ts`
- `components/admin/EditWindowsManager.tsx` ↔ `app/api/admin/edit-windows/route.ts`
- `components/admin/LineHistoryManager.tsx` ↔ `app/api/admin/cluster4/lines/history/route.ts`
- `components/admin/MembersList.tsx` 크루 목록 ↔ `app/api/admin/members/roster/route.ts`
- `components/admin/CrewWeekResultsBoard.tsx` ↔ `app/api/admin/team-parts/info/crew-week-results/route.ts`
- `components/admin/TeamPartsInfoWeeksManager.tsx` ↔ `app/api/admin/team-parts/info/weeks/route.ts`

## 3. 기존 클라이언트 페이지네이션 유지, 20행 통일 (6)

- `components/admin/CrewDetail.tsx` 주차 결과
- `components/admin/MembersList.tsx` 크루 주차 정보
- `components/admin/ProcessUnifiedManager.tsx` 프로세스 액트 목록
- `components/admin/RestManagementManager.tsx` 휴식 신청 목록
- `components/admin/SeasonWeeksList.tsx` 기간 정보
- `components/admin/Cluster4Editor.tsx` 주차 카드 목록(div/card 기반, 종전 4개)

## 4. 의도적인 예외 (12)

| 파일/표 | 제외 사유 |
|---|---|
| `PermissionsMatrix.tsx` | 권한 행×역할 열 전체를 동시에 비교·편집하는 매트릭스 |
| `ExperiencePartLeadInput.tsx` | 팀·파트 입력 매트릭스, 전체 비교와 일괄 입력이 목적 |
| `ExperienceTeamOverallBoard.tsx` | 팀 종합 결과 매트릭스 |
| `ClubSummaryList.tsx` | 고정 3개 조직 비교 및 합계 행을 함께 보는 통계표 |
| `Cluster3Editor.tsx` | 성장 단계 분포를 한 번에 비교하는 소형 통계표 |
| `ResumeCardEditor.tsx` | 이력서 카드 편집/미리보기용 표 |
| `teamCardShared.tsx` | 주차×팀 상태 매트릭스 |
| `TeamPartsInfoWeekDetailManager.tsx` 액트 요일표 | 행·요일 열 자체가 의미인 일정 매트릭스 |
| `TeamPartsInfoWeekDetailManager.tsx` 라인 오픈표 | 라인×요일 비교 매트릭스 |
| `TeamPartsInfoWeekDetailManager.tsx` 팀 요약표 | 상세 화면 내 전체 비교 통계표 |
| `TeamPartsInfoWeekDetailManager.tsx` 파트 요약표 | 상세 화면 내 전체 비교 통계표 |
| `WeeklyCardFinalizationView.tsx` | 7개 고정 집계 지표 요약표 |

예외인 공통 `Table` 3곳은 `pagination="off"`로 명시했다. 나머지는 native 표이며
고정 통계/매트릭스라는 구조적 이유로 `PaginatedNativeTable`을 적용하지 않았다.

## 선택·내보내기

페이지 절단은 필터·정렬된 React 행의 표시 단계에만 적용한다. 원본/필터 결과 배열은 바꾸지 않으므로
기존 전체 선택 handler와 CSV·엑셀 내보내기 입력은 유지된다. `CrewWeekActHistory`의 전체 선택도
기존 `cancellableIds` 전체를 계속 대상으로 하며 현재 페이지로 의미가 바뀌지 않는다.
