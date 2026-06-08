# 3조직 활동자 전체 dry-run (2026-06-07 · B안 composite key · read-only)

정책: PMS 인정 우선 (FLIP=checks_migrated:false) · (source_system,legacy_user_id) 복합키 · 3중 키 매칭 · org_week_thresholds 해석 · ORANKE 916 이유나/873 선우은교 제외(HRDB/OLYMPUS 단일 기준)

| source | org | 대상 | 신규 | 매칭 | 모호 | 테스터차단 | 페어충돌 | uws계획 | PMS인정 | v18성공 | FLIP | 미귀속(log/act) | subtitle | rating |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| oranke | oranke | 93 | 92 | 0 | 0 | 0 | 0 | 1108 | 1011 | 983 | 28 | 76/6 | 100.0% | 100.0% |
| hrdb | encre | 145 | 144 | 0 | 0 | 0 | 0 | 2194 | 1826 | 1813 | 13 | 193/10 | 100.0% | 100.0% |
| olympus | phalanx | 38 | 9 | 26 | 0 | 0 | 0 | 518 | 450 | 446 | 4 | 47/0 | 100.0% | 100.0% |

합계: 대상 276 · 신규 245 · 매칭 26 · 모호 0 · FLIP 45 · hold queue 0

## hold queue
- 없음
