# HRDB/OLYMPUS threshold 백필 dry-run (2026-06-07)
> write 0 (--apply 미구현). org = source_system 매핑만 (hrdb→encre · olympus→phalanx).
## 소스별 집계
| source | org | 소스 주차 | insert 계획 | noop | conflict | thr NULL skip | weeks 부재 | oranke와 값 차이 |
|---|---|---|---|---|---|---|---|---|
| hrdb | encre | 94 | 93 | 0 | 0 | 0 | 1 | 80 |
| olympus | phalanx | 76 | 76 | 0 | 0 | 0 | 0 | 72 |
oranke 와 값이 다른 주차 합계: **152** — org 분리가 실제로 필요한 주차 수 (0 이면 분리 무의미).
## weeks 행 부재 (백필 불가 — 별도 판단)
- hrdb Id=3 2023-02-06 (겨울 6) thr=20
## oranke 와 값이 다른 주차 (상위 40)
| source | start_date | season_key | W | confirmStar | oranke(live) |
|---|---|---|---|---|---|
| hrdb | 2023-09-04 | 2023-autumn | 1 | 24 | 26 |
| hrdb | 2023-09-11 | 2023-autumn | 2 | 15 | 28 |
| hrdb | 2023-09-18 | 2023-autumn | 3 | 40 | 25 |
| hrdb | 2023-10-02 | 2023-autumn | 5 | 30 | 25 |
| hrdb | 2023-10-30 | 2023-autumn | 9 | 26 | 24 |
| hrdb | 2024-01-01 | 2024-winter | 1 | 25 | 22 |
| hrdb | 2024-01-15 | 2024-winter | 3 | 28 | 27 |
| hrdb | 2024-01-22 | 2024-winter | 4 | 29 | 30 |
| hrdb | 2024-01-29 | 2024-winter | 5 | 29 | 30 |
| hrdb | 2024-02-12 | 2024-winter | 7 | 28 | 26 |
| hrdb | 2024-02-19 | 2024-winter | 8 | 20 | 24 |
| hrdb | 2024-03-04 | 2024-spring | 1 | 25 | 27 |
| hrdb | 2024-03-11 | 2024-spring | 2 | 28 | 32 |
| hrdb | 2024-03-18 | 2024-spring | 3 | 29 | 32 |
| hrdb | 2024-03-25 | 2024-spring | 4 | 28 | 31 |
| hrdb | 2024-04-01 | 2024-spring | 5 | 27 | 30 |
| hrdb | 2024-04-29 | 2024-spring | 9 | 26 | 30 |
| hrdb | 2024-05-06 | 2024-spring | 9 | 27 | 34 |
| hrdb | 2024-05-13 | 2024-spring | 11 | 27 | 32 |
| hrdb | 2024-05-20 | 2024-spring | 12 | 25 | 40 |
| hrdb | 2024-05-27 | 2024-spring | 13 | 27 | 35 |
| hrdb | 2024-07-01 | 2024-summer | 1 | 25 | 31 |
| hrdb | 2024-07-08 | 2024-summer | 2 | 31 | 35 |
| hrdb | 2024-07-15 | 2024-summer | 3 | 35 | 36 |
| hrdb | 2024-07-22 | 2024-summer | 4 | 32 | 30 |
| hrdb | 2024-07-29 | 2024-summer | 5 | 33 | 30 |
| hrdb | 2024-08-05 | 2024-summer | 6 | 33 | 35 |
| hrdb | 2024-08-12 | 2024-summer | 7 | 17 | 25 |
| hrdb | 2024-08-19 | 2024-summer | 8 | 20 | 25 |
| hrdb | 2024-09-02 | 2024-autumn | 1 | 20 | 28 |
| hrdb | 2024-09-09 | 2024-autumn | 2 | 18 | 28 |
| hrdb | 2024-09-23 | 2024-autumn | 4 | 18 | 25 |
| hrdb | 2024-10-28 | 2024-autumn | 9 | 23 | 24 |
| hrdb | 2024-11-04 | 2024-autumn | 10 | 20 | 33 |
| hrdb | 2024-11-11 | 2024-autumn | 11 | 30 | 36 |
| hrdb | 2024-11-18 | 2024-autumn | 12 | 30 | 34 |
| hrdb | 2025-01-06 | 2025-winter | 2 | 25 | 30 |
| hrdb | 2025-01-20 | 2025-winter | 4 | 30 | 23 |
| hrdb | 2025-02-03 | 2025-winter | 6 | 32 | 21 |
| hrdb | 2025-02-10 | 2025-winter | 7 | 31 | 25 |
## apply 계약 (승인 후 별도 스크립트)
- upsert `onConflict: week_id,organization_slug`, provenance: `source_system`·`source_table`(소스 프리픽스)·`source_pk=weekssettings.Id`·`inferred=false`·`payload`=원본 행.
- conflict 행은 자동 덮어쓰기 금지 — 본 리포트에서 건별 결정.
- weeks/uws/user_weekly_points/snapshot write 0 유지.
