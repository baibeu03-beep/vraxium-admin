-- 2026-07-16_cluster4_line_second_entry_overrides.sql
-- 크루별·주차별·라인별 "2차 기입(라인 칸 제출) 편집권" 관리자 수동 override — SoT.
--
-- 배경: 2차 기입 편집 가능 여부(canEdit)의 정상 경로는 자동 기간(N+1주 월 00:00~수 22:00 KST,
--   cluster4_lines.submission_opens_at/closes_at) + 허브 단위 user_edit_windows(cluster4.work_*).
--   그러나 운영진이 "특정 회원·특정 주차·특정 라인 하나"의 2차 기입을 자동 기간 종료 후에도
--   수동으로 다시 열어줘야 하는 예외가 있다. 기존 user_edit_windows 는 (user, resource_key=허브, week)
--   단위라 라인 하나만 여는 것이 물리적으로 불가능(라인 식별 컬럼 없음)하므로, per-line override 를 신설한다.
--
-- 정책(사용자 확정, 2026-07-16):
--   - "허용"(allowed=true) = 클럽 오픈 + 강화 성공 라인에 한해 자동 기간이 끝나도 force-open.
--       자격(클럽오픈 && 강화성공)은 지급/조회 계층에서 검증 — 미오픈/실패 라인은 허용 저장 자체를 거부.
--   - "불가"(allowed=false) = override 회수. 라인은 자동 기간 로직으로 복귀(자동 기간이 아직 열려 있으면
--       그 동안은 편집 가능 — force-close 는 도입하지 않음. 정상 크루 편집 동작 불변).
--   - 자동 기간 로직 재실행으로 수동 허용이 저절로 닫히지 않는다(행이 SoT). 관리자가 직접 불가로만 닫음.
--   - 해제는 allowed=false 로 tombstone 유지(누가/언제 닫았는지 감사 보존). 행 부재 = override 없음(자동).
--
-- 적용(읽기): lib/cluster4SecondEntryOverride.ts 가 loadWeeklyCards 반환 직전 read-time overlay 로만
--   canEdit 을 보정한다(snapshot 미굽기 — 선례: cluster4_line_enhancement_overrides). 저장(크루 2차 기입
--   저장 API)은 소유권 + is_active + override(allowed) 를 서버에서 재검증한다(양쪽 repo).
--
-- ⚠ 수동 마이그레이션: 이 SQL 을 운영 DB 에 직접 실행해야 기능이 동작한다("column/table does not exist" = 미적용).

CREATE TABLE IF NOT EXISTS public.cluster4_line_second_entry_overrides (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id      uuid NOT NULL,                 -- 카드 주인 = user_profiles.user_id
  week_id      uuid NOT NULL,                 -- 카드 주차 = weeks.id (= card.weekId)
  line_id      uuid NOT NULL,                 -- 대상 라인 = cluster4_lines.id (실제 개설 라인만 대상)
  allowed      boolean NOT NULL DEFAULT true, -- true=수동 force-open, false=회수(tombstone)
  source       text NOT NULL DEFAULT 'admin_manual'
               CHECK (source IN ('admin_manual', 'admin_bulk')), -- 개별/일괄 provenance
  note         text,                          -- 변경 사유 메모(감사용)
  created_by   uuid,                          -- 최초 지정 관리자 user_id
  updated_by   uuid,                          -- 최종 변경 관리자 user_id
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now()
);

-- (사용자, 주차, 라인) 1행 — 멱등 토글/일괄 재실행 시 중복 행 방지(find-then-write).
CREATE UNIQUE INDEX IF NOT EXISTS cluster4_line_second_entry_override_uq
  ON public.cluster4_line_second_entry_overrides (user_id, week_id, line_id);

-- 읽기 경로(사용자 카드 조회)는 user_id 로 전체 override 를 한 번에 로드한다.
CREATE INDEX IF NOT EXISTS cluster4_line_second_entry_override_user_idx
  ON public.cluster4_line_second_entry_overrides (user_id);

-- 저장 가드(크루 2차 기입 저장)는 (user_id, week_id, line_id) 단건 조회.
CREATE INDEX IF NOT EXISTS cluster4_line_second_entry_override_lookup_idx
  ON public.cluster4_line_second_entry_overrides (user_id, week_id, line_id, allowed);
