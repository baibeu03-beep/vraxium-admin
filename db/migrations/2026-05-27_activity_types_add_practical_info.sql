-- 2026-05-27_activity_types_add_practical_info.sql
-- activity_types CHECK 제약조건에 'practical_info' 추가 + info 타입 9개 seed.
--
-- 배경:
--   activity_types.cluster_id CHECK 이 practical_competency/experience/career 3종만 허용.
--   info 타입(wisdom, essay 등)은 프론트에서 하드코딩으로 관리되어 왔으나,
--   어드민 드롭다운 지원 및 하드코딩 불일치(9개 vs 7개) 해소를 위해
--   DB 기반 통합 관리로 전환한다.
--
-- 변경:
--   1) CHECK 제약조건 교체: 3종 → 4종 (practical_info 추가)
--   2) info 타입 9개 INSERT (ON CONFLICT DO NOTHING)
--
-- 재실행 안전:
--   DROP + ADD CONSTRAINT (idempotent pattern)
--   INSERT ON CONFLICT DO NOTHING

BEGIN;

-- ============================================================
-- PART 1: CHECK 제약조건 교체
-- ============================================================
ALTER TABLE public.activity_types
  DROP CONSTRAINT IF EXISTS activity_types_cluster_id_valid;

ALTER TABLE public.activity_types
  ADD CONSTRAINT activity_types_cluster_id_valid CHECK (
    cluster_id IN (
      'practical_info',
      'practical_competency',
      'practical_experience',
      'practical_career'
    )
  );

-- ============================================================
-- PART 2: info 타입 9개 seed
-- ============================================================
INSERT INTO public.activity_types (id, name, line_code, cluster_id, is_active)
VALUES
  ('wisdom',            '위즈덤',           'wisdom',            'practical_info', true),
  ('essay',             '에세이',           'essay',             'practical_info', true),
  ('infodesk',          '인포데스크',       'infodesk',          'practical_info', true),
  ('calendar',          '캘린더',           'calendar',          'practical_info', true),
  ('forum',             '포럼',             'forum',             'practical_info', true),
  ('session',           '세션',             'session',           'practical_info', true),
  ('practical_lecture',  '실무특강',        'practical_lecture',  'practical_info', true),
  ('community',         '커뮤니티',         'community',         'practical_info', true),
  ('etc_a',             '기타A',            'etc_a',             'practical_info', true)
ON CONFLICT (id) DO NOTHING;

COMMIT;

-- ============================================================
-- ROLLBACK (필요 시)
-- ============================================================
/*
BEGIN;
DELETE FROM public.activity_types
WHERE id IN ('wisdom','essay','infodesk','calendar','forum','session','practical_lecture','community','etc_a')
  AND cluster_id = 'practical_info';

ALTER TABLE public.activity_types
  DROP CONSTRAINT IF EXISTS activity_types_cluster_id_valid;

ALTER TABLE public.activity_types
  ADD CONSTRAINT activity_types_cluster_id_valid CHECK (
    cluster_id IN (
      'practical_competency',
      'practical_experience',
      'practical_career'
    )
  );
COMMIT;
*/
