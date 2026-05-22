-- 2026-05-22_permissions_matrix_step2_seed.sql
-- 권한 매트릭스 카탈로그(public.permissions) seed ─ Cluster1~3 v1 확정분.
--
-- 의존성: 2026-05-22_permissions_matrix_step1_tables.sql 이 먼저 적용되어야 한다.
-- 멱등성: INSERT ... ON CONFLICT (key) DO UPDATE — 재실행 시 label/description/
--          requires_edit_window/sort_order 가 본 파일 기준으로 갱신된다.
--          (cluster/resource/action 은 key 의 의미와 직접 묶여 있어 의도된 동기화.)
-- 범위:
--   - 본 seed 는 public.permissions 만 채운다.
--   - public.role_permissions 는 seed 하지 않으며, "행 없음 = OFF" 규칙대로
--     super_admin 이 관리 페이지에서 직접 ON 한다.
--   - Cluster4 / future cluster 는 별도 후속 마이그레이션에서 추가한다.

INSERT INTO public.permissions (
  key, cluster, resource, action,
  label, description, requires_edit_window, sort_order
) VALUES
  -- ───── Cluster 1 ─────
  ('cluster1.resume_card.view',
   'cluster1', 'resume_card', 'view',
   '이력서 카드 조회',
   'Cluster1 이력서 카드 전체 조회 권한.',
   false, 110),

  ('cluster1.contact_available.edit',
   'cluster1', 'contact_available', 'edit',
   '연락 가능 시간 편집',
   '이력서 카드의 contact_available 필드 본인 편집 권한.',
   false, 111),

  -- ───── Cluster 2 ─────
  ('cluster2.profile.view',
   'cluster2', 'profile', 'view',
   '프로필 조회',
   'Cluster2 프로필 전체 조회 권한.',
   false, 210),

  ('cluster2.profile_photo.edit',
   'cluster2', 'profile_photo', 'edit',
   '프로필 사진 편집',
   'Cluster2 프로필 사진 본인 편집 권한.',
   false, 211),

  ('cluster2.profile_video.edit',
   'cluster2', 'profile_video', 'edit',
   '프로필 영상 편집',
   'Cluster2 프로필 영상 본인 편집 권한.',
   false, 212),

  ('cluster2.slogan.edit',
   'cluster2', 'slogan', 'edit',
   '슬로건 편집',
   'Cluster2 슬로건 본인 편집 권한.',
   false, 213),

  ('cluster2.education.edit',
   'cluster2', 'education', 'edit',
   '학력 편집',
   'Cluster2 학력 본인 편집 권한. user_edit_windows 작성 기간 필요.',
   true, 214),

  ('cluster2.club_review.edit',
   'cluster2', 'club_review', 'edit',
   '클럽 리뷰 편집',
   'Cluster2 클럽 리뷰 본인 편집 권한. user_edit_windows 작성 기간 필요. '
   '기존 cluster2.review_links 와의 의미 동치 여부는 별도 확정 필요.',
   true, 215),

  ('cluster2.introduction.edit',
   'cluster2', 'introduction', 'edit',
   '자기소개 편집',
   'Cluster2 자기소개 본인 편집 권한.',
   false, 216),

  -- ───── Cluster 3 ─────
  ('cluster3.portfolio.view',
   'cluster3', 'portfolio', 'view',
   '포트폴리오 조회',
   'Cluster3 포트폴리오 전체 조회 권한.',
   false, 310),

  ('cluster3.channel_cards.edit',
   'cluster3', 'channel_cards', 'edit',
   '채널 카드 편집',
   'Cluster3 채널 카드 본인 편집 권한.',
   false, 311),

  ('cluster3.output_cards.edit',
   'cluster3', 'output_cards', 'edit',
   '대표 작업물 카드 편집',
   'Cluster3 대표 작업물 카드 본인 편집 권한. user_edit_windows 작성 기간 필요.',
   true, 312),

  ('cluster3.detail_cards.edit',
   'cluster3', 'detail_cards', 'edit',
   '상세 카드 편집',
   'Cluster3 상세 카드 본인 편집 권한. user_edit_windows 작성 기간 필요.',
   true, 313)
ON CONFLICT (key) DO UPDATE
SET cluster              = EXCLUDED.cluster,
    resource             = EXCLUDED.resource,
    action               = EXCLUDED.action,
    label                = EXCLUDED.label,
    description          = EXCLUDED.description,
    requires_edit_window = EXCLUDED.requires_edit_window,
    sort_order           = EXCLUDED.sort_order;
