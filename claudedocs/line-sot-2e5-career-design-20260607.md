# Phase 2E-5 설계 — career 등가성 확보 (2026-06-07, 설계 전용)

> read-only 조사 + 설계만. 구현/DB 변경 없음. 조사 스크립트: `scripts/diag-career-2e5.ts`

## 1. 현재 career 구조 (실측)

```
[입력]  PracticalCareerManager 등록 탭 · CareerProjectsManager  ──┐
[신규]  통합 라인 등록 → 2C 브리지 find-or-create  ───────────────┼──▶ career_projects (1건)
                                                                  │        │ FK career_project_id
[개설]  career-line-options → POST career-lines (+sponsor-meta) ──┘        ▼
                                                              cluster4_lines (career 1건)
[고객]  career-records · cluster-4-ranking · weekly-cards sponsor 메타 — career_projects/주차/기록 직조
```

## 2. 기존 1건 판단 — **테스트 데이터, 참조 0 (정리 가능)**

| 항목 | 실측 |
|---|---|
| 내용 | "테스트 라인명 프로젝트" / 스파르타코딩클럽 / 김테스트 / default_main_title "라인 등록 테스트 테스트…" — 명백한 테스트 입력 |
| cluster4_lines 연결 | 1건 (career, **targets 0 · submissions 0 · opened_at null** — 개설 워크플로 미완) |
| career_project_weeks | **0** → cluster-4-ranking 분모에 미산입 |
| career_records | **0** → 고객 career-records 미노출 |
| career_line_evaluations | 0 |
| 고객 노출 | **없음** — 모든 고객 경로(targets inner-join·records·weeks)에서 도달 불가 |

## 3. 고객앱 career 참조 경로 (대체 금지 영역)

| 경로 | 참조 |
|---|---|
| `../vraxium /api/career-records` | career_projects 직조 + `career_records_project_id_fkey` join (supervisor 메타) |
| `../vraxium /api/cluster-4-ranking` | career_projects select + career_project_weeks 기반 분모(주차당 개설 슬롯) |
| admin repo `fetchCareerProjectMetaByIds` (weekly-cards sponsor) · `cluster4LinesData`·`adminCluster4LinesData` career 메타 | career_project_id FK 경유 |
| `career-line-options` → `POST career-lines` | 개설 플로우 |

→ **career_projects 는 고객앱이 직접 읽는 유일한 정의 테이블** — 제거/대체 불가(제약과도 일치).

## 4. manager_profile 이미지

- **자산 현황 변화**: admin `public/` 에 6종 PNG 실존 (Joan of Arc/Tomb Raider/Ms Marvel/Thor/Iron Man/Captain America) + `LINE_REGISTRATION_PROFILE_IMAGE_MAP` 매핑 코드 존재 — 등록 화면 미리보기용으로 추가됨.
- **단기(NULL 유지) 가능**: career_projects.supervisor_profile_img 는 nullable, 고객 카드 supervisorPhotoUrl null = 미표시/placeholder — 운영 무리 없음.
- **추후 매핑 방식 (구현 시 결정 1건)**:
  - (a) admin 도메인 절대 URL(`https://vraxium-admin.vercel.app/Thor.png` 등) 저장 — 즉시 가능하나 admin 도메인 결합
  - (b) **Supabase storage 공용 버킷(cluster4-line-images)에 6종 1회 업로드 후 그 URL 매핑 — 권장** (기존 로고/사진과 동일 저장 체계, 도메인 결합 없음)
  - 어느 쪽이든 브리지의 `supervisor_profile_img: null` 한 줄을 매핑 호출로 바꾸는 작은 변경.

## 5. 선택지 평가 → 추천 설계

| 안 | 평가 |
|---|---|
| A. 기존 1건 제외 유지 | 가능하나 diff 1 영구 잔존 + 라인 정보/개설 드롭다운에 테스트 행 계속 노출 |
| B. 기존 1건 이관 | 테스트 데이터를 통합 레지스트리에 들임 — 오염, 비권장 |
| **C. 테스트 1건 정리** | **권장(전제 충족 실측)** — 참조 0이라 안전: ① 연결 라인 1건을 기존 DELETE 라인 플로우로 삭제(targets 0 → 무효화 대상 0명 → snapshot 무영향) ② career_projects 1건 백업 후 삭제. ※ 삭제는 본 설계 제약상 **별도 승인 후 구현 단계에서** |
| **D. career 기존 SoT 유지 + 신규는 브리지** | **권장(구조 확정)** — career_projects 를 "고객앱 호환 mirror" 로 존치, 입력 SoT 는 registrations |

### 추천: **D(구조) + C(데이터 정리) 조합**

```
입력 SoT: line_registrations (통합 등록)
   │  2C 브리지 (find-or-create — 이미 가동)
   ▼
career_projects = 고객앱 호환 mirror (존치, 고객앱 무수정)
   │  기존 개설 플로우 그대로 (career-line-options → career-lines, FK 유지)
   ▼
cluster4_lines / 고객 경로 — 무변
```

- **정방향**: 신규 career = 통합 등록 → 브리지가 career_projects 생성 (2C 에서 이미 동작 검증).
- **역방향 정합(2E-5 신규 구현)**: career 화면의 career_projects PATCH·sponsor-meta PATCH 성공 시, **bridged registration 이 있는 행만** 2E-2 패턴으로 registration 동기화(company→partner 등 역매핑). 미연결 행(레거시)은 동작 불변.
- **기존 화면**: PracticalCareerManager 등록 탭은 당분간 병행 유지(soft 안내 유지). 직접 등록분은 registration 사본이 없으므로 sync 대상 아님 — 시간이 지나며 통합 등록 경로로 수렴.

## 6. snapshot / 고객앱 영향

- **snapshot**: 없음 — sponsor 메타는 계속 career_projects(mirror) FK 경유, 코드 무변. C 정리도 targets 0 라인이라 무효화 대상 0명·재계산 불필요.
- **고객앱**: 없음 — career_projects 가 그대로 SoT-호환 mirror 로 남고, 직조 쿼리 결과는 데이터 정리(참조 0행 삭제) 외 변화 없음.

## 7. rollback 계획

- 역방향 sync: 코드 revert 만 (DB 무변).
- C 정리: 삭제 전 full-row 백업 JSON → 복원 insert 로 원복 가능. 라인 삭제도 동일 백업.
- 프로필 매핑: 브리지 1줄 revert (기존 저장분은 supervisor_profile_img 단건 update 로 정정).

## 8. 2E-5 구현 가능 범위 (승인 시)

1. **역방향 sync** — career-projects PATCH·sponsor-meta PATCH → bridged registration 동기화 (2E-2 패턴 확장)
2. **테스트 1건 정리** — dry-run(백업)→apply 스크립트: 연결 라인 DELETE(기존 플로우) → career_projects 삭제 ← **삭제 승인 필요**
3. **프로필 토큰→이미지 매핑** — 위 (a)/(b) 중 결정 후 브리지 1줄 + 6자산 업로드(b안)
4. **diff 스크립트 career 축 확장** — 정리/이관 완료 후 career 알려진 diff 해소 → **2E-6(마스터 deprecated) 진입 조건 완성**

구현 전 결정 필요: ① C 정리(삭제) 승인 여부 ② 프로필 매핑 (a) admin URL / (b) storage 업로드(권장) / 보류(NULL 유지)
