-- 2026-05-28_cluster4_line_masters_xlsx_seed.sql
-- 실무 경험 / 실무 역량 라인 마스터 — Excel(4허브 라인.xlsx) 데이터 반영 seed.
--
-- 정책:
--   1) cluster4_experience_line_masters (실무 경험)
--      - 시트 1 ('실무경험') 25개 행을 organization_slug + line_code 키로 upsert.
--      - 진행 클럽 EC / OK / PX → organization_slug = encre / oranke / phalanx.
--      - 동일 line_code 가 EC / OK / PX 에 별도로 존재 (EXBS-EL* 4종 × 3조직).
--   2) cluster4_competency_line_masters (실무 역량)
--      - 시트 2 ('실무역량') 30개 행 모두 '공통' → organization_slug = 'common'.
--      - 'common' 은 어느 조직에서도 함께 노출되는 공용 라인 식별값.
--
-- 중복 / 충돌 처리:
--   - UNIQUE 키 (organization_slug, line_code) 기준 upsert.
--   - 동일 키 존재 시 line_name / main_title 만 갱신 (다른 테이블 FK 참조 보존을 위해
--     id 는 절대 재생성하지 않음).
--
-- 의존:
--   - 2026-05-28_experience_line_masters_org_slug.sql (organization_slug 컬럼 + unique)
--   - 2026-05-28_cluster4_competency_line_masters.sql (역량 마스터 테이블)
--
-- 재실행 안전: ON CONFLICT DO UPDATE 이므로 반복 실행 시 idempotent.
--
-- 산출 카운트 검증 (DRY-RUN):
--   SELECT organization_slug, COUNT(*)
--     FROM public.cluster4_experience_line_masters
--    WHERE line_code LIKE 'EX%'
--    GROUP BY organization_slug;
--   SELECT organization_slug, COUNT(*)
--     FROM public.cluster4_competency_line_masters
--    WHERE line_code LIKE 'CPBS-NN%';

BEGIN;


-- ═══════════════════════════════════════════════════════════════════════
-- PART 1: 실무 경험 라인 마스터 (sheet '실무경험') — 25 rows
-- ═══════════════════════════════════════════════════════════════════════

INSERT INTO public.cluster4_experience_line_masters
  (organization_slug, line_code, line_name, default_main_title, source_file_name, is_active)
VALUES
  -- Encre (EC) — 기획/분석/피드백 + BS 공통 매니징/PT
  ('encre', 'EXEC-EN0001', '[기획] 엔터테인먼트/미디어 콘텐츠 제작',
   '[엔터테인먼트 실무] 미디어 업계의 모든 업무는 결국 ‘대중’ 을 향한 것! 나는 대중의 기호를 타겟으로, 콘텐츠를 구상하고 던질 수 있을까?',
   '4허브 라인.xlsx', true),
  ('encre', 'EXEC-EN0002', '[분석] 엔터테인먼트/미디어 퍼포먼스 결과',
   '[엔터테인먼트 실무] 표현되고 업로드된 모든 기획의 결과는 대중의 반응! 기획자로서, 제작자로서 대중이 평가하는 나의 결과는 어떨까?',
   '4허브 라인.xlsx', true),
  ('encre', 'EXEC-EN0003', '[다면 피드백] 실무 생산성 강화',
   '[엔터테인먼트 실무] 엔터테인먼트 분야도 취미가 아닌 전문 커리어로 간다면, 결국 생산성의 문제! 내 기획과 분석에서, 취향과 아집을 삭제한다면?',
   '4허브 라인.xlsx', true),

  -- Oranke (OK) — 커리어/콘텐츠/퍼포먼스/생산성
  ('oranke', 'EXOK-EN0001', '[커리어] 마케터 Launch',
   '[역량 파악 & 성장점 분석] “백날 말로만 떠드는 마케팅 커리어가 아니라, 지금 당장 어느 정도로 준비되었는지 그 현실을 뼈저리게 느껴보자구!”',
   '4허브 라인.xlsx', true),
  ('oranke', 'EXOK-EN0002', '[콘텐츠] 마케팅 실무_기획/제작',
   '[콘텐츠 마케팅] “어떤 제품/서비스더라도, 마케터가 제대로 ‘표현’ 하지 못한다면, 그저 ‘낙서’ 에 불과해. 어떻게 내 제품/서비스를 표현할 수 있을까?',
   '4허브 라인.xlsx', true),
  ('oranke', 'EXOK-EN0003', '[퍼포먼스] 마케팅 실무_확산/분석',
   '[퍼포먼스 마케팅] “마케팅 효과가 좋더라도, 결과를 제대로 ‘인지’ 하지 못한다면, 운 좋은 ‘우연’ 에 지나지 않아. 이 마케팅.. 계속 나아갈 수 있어?',
   '4허브 라인.xlsx', true),
  ('oranke', 'EXOK-EN0004', '[생산성] 상호 피드백',
   '[상호 피드백] “100명의 사람이 있으면, 100개의 시각과 관점이 있다고 하지. 과연 내 마케팅은, 내가 의도한대로 전달되고 있는 것이 맞을까?”',
   '4허브 라인.xlsx', true),

  -- Phalanx (PX) — 실무 기획 1~4단계 + 레퍼런스/사례 강화
  ('phalanx', 'EXPX-EN0001', '[실무 기획] 니즈의 파악 (1/4)',
   '[실무 기획] 니즈의 파악 : ‘누구’ 에게, ‘언제’, ‘어떤’ 기획이 ‘왜’ 필요한가?',
   '4허브 라인.xlsx', true),
  ('phalanx', 'EXPX-EN0002', '[실무 기획] 내용의 구조화 (2/4)',
   '[실무 기획] 내용의 구조화 : 이 기획의 내용은 어떻게 분할 구성되며, 상위 / 하위 개념은 어떻게 나누어지는가? (위계 및 토워딩)',
   '4허브 라인.xlsx', true),
  ('phalanx', 'EXPX-EN0003', '[실무 기획] 디테일의 확충 (3/4)',
   '[실무 기획] 디테일의 확충 : 기획의 구조 뼈대 위에, 어떻게 살을 붙여 풍성하고 안정적인 볼륨을 달성하는가?',
   '4허브 라인.xlsx', true),
  ('phalanx', 'EXPX-EN0004', '[실무 기획] 제안의 타진 (4/4)',
   '[실무 기획] 제안의 타진 : 이 기획은 고객에게 어떻게 설득 / 표현되고, 어떤 방식으로 전달되는가?',
   '4허브 라인.xlsx', true),
  ('phalanx', 'EXPX-EN0005', '[실무 기획] 레퍼런스 분석',
   '[실무 기획] 레퍼런스 분석 : 우리 눈에 보이는 이 세상 모든 것은 결국 ‘기획’ 이다. 이 세상에는 어떤 기획들이 있는가?',
   '4허브 라인.xlsx', true),
  ('phalanx', 'EXPX-EN0006', '[실무 기획] 사례 강화',
   '[실무 기획] 사례 강화 : 내 기획은 타인에게 어떻게 보일까? 내가 의도한 바는 나만의 막연한 상상이 아닐까?',
   '4허브 라인.xlsx', true),

  -- EXBS-EL series — 모든 3 조직 공통 매니징/PT (EC/OK/PX 각각)
  ('encre', 'EXBS-EL0001', '[매니징] 세부 팀/조직 관리_파트장',
   '[관리/매니징 실무] 다수의 팀원을 리딩하는 ‘파트’ 의 장(將)은 무엇을 고려하며, 정기적인 일정과 개별적인 적용은 어떻게 조화시키는가?',
   '4허브 라인.xlsx', true),
  ('encre', 'EXBS-EL0002', '[매니징] 세부 팀/조직 관리_에이전트',
   '[관리/매니징 실무] 다수의 팀원들이 따라올 수 있는 가이드라인과 자료 체계는 어떻게 구성하며, 이는 팀 전체의 퍼포먼스에 어떤 영향을 미치는가?',
   '4허브 라인.xlsx', true),
  ('encre', 'EXBS-EL0003', '[실무 PT] 온라인 : 현황 취합과 제안 발표',
   '[보고/제안] 실무에서의 기획과 제안은 당연히 뚜렷한 증거가 필요해. 우리는 얼마나 뛰어난 경쟁력을 가졌으며, 그것을 어떤 제안으로 풀어나갈까?',
   '4허브 라인.xlsx', true),
  ('encre', 'EXBS-EL0004', '[실무 PT] 오프라인 : 경쟁력 어필과 계약 입찰',
   '[보고/제안] 실무에서의 채용과 계약은 그동안 쌓아온 경쟁력, 그리고 그것의 순간적인 폭발에서 시작될거야. 사회가 보는 나의 업무력 평가는 과연 어떨까?',
   '4허브 라인.xlsx', true),

  ('oranke', 'EXBS-EL0001', '[매니징] 세부 팀/조직 관리_파트장',
   '[관리/매니징 실무] 다수의 팀원을 리딩하는 ‘파트’ 의 장(將)은 무엇을 고려하며, 정기적인 일정과 개별적인 적용은 어떻게 조화시키는가?',
   '4허브 라인.xlsx', true),
  ('oranke', 'EXBS-EL0002', '[매니징] 세부 팀/조직 관리_에이전트',
   '[관리/매니징 실무] 다수의 팀원들이 따라올 수 있는 가이드라인과 자료 체계는 어떻게 구성하며, 이는 팀 전체의 퍼포먼스에 어떤 영향을 미치는가?',
   '4허브 라인.xlsx', true),
  ('oranke', 'EXBS-EL0003', '[실무 PT] 온라인 : 현황 취합과 제안 발표',
   '[보고/제안] 실무에서의 기획과 제안은 당연히 뚜렷한 증거가 필요해. 우리는 얼마나 뛰어난 경쟁력을 가졌으며, 그것을 어떤 제안으로 풀어나갈까?',
   '4허브 라인.xlsx', true),
  ('oranke', 'EXBS-EL0004', '[실무 PT] 오프라인 : 경쟁력 어필과 계약 입찰',
   '[보고/제안] 실무에서의 채용과 계약은 그동안 쌓아온 경쟁력, 그리고 그것의 순간적인 폭발에서 시작될거야. 사회가 보는 나의 업무력 평가는 과연 어떨까?',
   '4허브 라인.xlsx', true),

  ('phalanx', 'EXBS-EL0001', '[매니징] 세부 팀/조직 관리_파트장',
   '[관리/매니징 실무] 다수의 팀원을 리딩하는 ‘파트’ 의 장(將)은 무엇을 고려하며, 정기적인 일정과 개별적인 적용은 어떻게 조화시키는가?',
   '4허브 라인.xlsx', true),
  ('phalanx', 'EXBS-EL0002', '[매니징] 세부 팀/조직 관리_에이전트',
   '[관리/매니징 실무] 다수의 팀원들이 따라올 수 있는 가이드라인과 자료 체계는 어떻게 구성하며, 이는 팀 전체의 퍼포먼스에 어떤 영향을 미치는가?',
   '4허브 라인.xlsx', true),
  ('phalanx', 'EXBS-EL0003', '[실무 PT] 온라인 : 현황 취합과 제안 발표',
   '[보고/제안] 실무에서의 기획과 제안은 당연히 뚜렷한 증거가 필요해. 우리는 얼마나 뛰어난 경쟁력을 가졌으며, 그것을 어떤 제안으로 풀어나갈까?',
   '4허브 라인.xlsx', true),
  ('phalanx', 'EXBS-EL0004', '[실무 PT] 오프라인 : 경쟁력 어필과 계약 입찰',
   '[보고/제안] 실무에서의 채용과 계약은 그동안 쌓아온 경쟁력, 그리고 그것의 순간적인 폭발에서 시작될거야. 사회가 보는 나의 업무력 평가는 과연 어떨까?',
   '4허브 라인.xlsx', true)
ON CONFLICT (organization_slug, line_code) DO UPDATE
  SET line_name          = EXCLUDED.line_name,
      default_main_title = EXCLUDED.default_main_title,
      source_file_name   = EXCLUDED.source_file_name,
      is_active          = EXCLUDED.is_active,
      updated_at         = now();


-- ═══════════════════════════════════════════════════════════════════════
-- PART 2: 실무 역량 라인 마스터 (sheet '실무역량') — 30 rows, 공통
-- ═══════════════════════════════════════════════════════════════════════
--   - organization_slug = 'common' : 모든 조직에서 함께 노출되는 공용 라인.
--   - 향후 조직별 조회는: WHERE organization_slug IN (current_org, 'common').

INSERT INTO public.cluster4_competency_line_masters
  (organization_slug, line_code, line_name, main_title, source_file_name, is_active)
VALUES
  ('common', 'CPBS-NN0001', '[실무 Principle. 1] 정량화',
   '업무는 감각과 형용사가 아닌, 숫자와 지표로 표현된다. (KPI)', '4허브 라인.xlsx', true),
  ('common', 'CPBS-NN0002', '[실무 Principle. 2] 현실화',
   '업무는 실제로 실행될 수 있는 범위 안에서 논의되어야 한다. (Plausible)', '4허브 라인.xlsx', true),
  ('common', 'CPBS-NN0003', '[실무 Principle. 3] 가시화',
   '업무의 과정과 결과가 ‘잘 보이지 않는’ 순간, 그 업무는 멈추게 된다. (Good Looking)', '4허브 라인.xlsx', true),
  ('common', 'CPBS-NN0004', '[실무 Principle. 4] 이미지화',
   '업무의 과정과 결과에서, 이미지와 동영상은 말과 글을 압도한다. (Visualize)', '4허브 라인.xlsx', true),
  ('common', 'CPBS-NN0005', '[실무 Principle. 5] 항목화',
   '업무는 항목으로 분류되는 순간부터, 비로소 시작될 수 있다. (List)', '4허브 라인.xlsx', true),
  ('common', 'CPBS-NN0006', '[실무 Principle. 6] 구조화',
   '업무 내용은, ‘범위’ 와 ‘계층’ 을 통해, 구조화되어야 한다. (Structure)', '4허브 라인.xlsx', true),
  ('common', 'CPBS-NN0007', '[실무 Principle. 7] 자료화',
   '업무는 과정과 결과가 ‘자료화’ 되어 기록과 증거가 남아야 한다. (document)', '4허브 라인.xlsx', true),
  ('common', 'CPBS-NN0008', '[실무 Principle. 8] 취향 경계',
   '나만 좋아하는 ‘기호’ 와 고객이 원하는 ‘비즈니스’ 의 차이 (No Taste)', '4허브 라인.xlsx', true),
  ('common', 'CPBS-NN0009', '[실무 Principle. 9] 상상 통제',
   '꿈꾸는 자는 예술가(Artist) 이지, 실무자(Career)가 아니다. (No Imagination)', '4허브 라인.xlsx', true),
  ('common', 'CPBS-NN0010', '[실무 Principle. 10] 맥락 고려',
   '모든 업무는 ‘출발점’ 과 ‘목표점’, 그리고 상황 조건들을 가진다. (No OverSink)', '4허브 라인.xlsx', true),

  ('common', 'CPBS-NN0011', '[실무 Tool. 1] Notion',
   '뭐에 특출난 도구인지는 모르겠지만, 모든 업무는 일단 노션으로 시작할거야. (단호)', '4허브 라인.xlsx', true),
  ('common', 'CPBS-NN0012', '[실무 Tool. 2] Claude Code',
   '초등학생도 프로그램을 만드는 세상인데, 실무자가 안한다고 버티면 어떻게 되겠니..?', '4허브 라인.xlsx', true),
  ('common', 'CPBS-NN0013', '[실무 Tool. 3] Napkin AI',
   '단 한 장의 인포그래픽(도식화)이 백 마디 생각을, 가볍게 압도한다구!', '4허브 라인.xlsx', true),
  ('common', 'CPBS-NN0014', '[실무 Tool. 4] Obsidian',
   '업무에 대한 추상적 생각, 막연한 구조가 실제 모습으로 나타난다면 어떻게 될까?', '4허브 라인.xlsx', true),
  ('common', 'CPBS-NN0015', '[실무 Tool. 5] Chrome Extensions',
   '똑같은 도구도, ‘확장 프로그램’ 의 존재를 어떻게 사용하느냐에 따라 다른 도구가 된다는 것!', '4허브 라인.xlsx', true),
  ('common', 'CPBS-NN0016', '[실무 Tool. 6] MS designer',
   '슬프지만, 그림과 이미지, 일러스트는 이제 인간의 영역에서 벗어나 버린 것이 아닐까?', '4허브 라인.xlsx', true),
  ('common', 'CPBS-NN0017', '[실무 Tool. 7] Speechma',
   '우리의 업무와 실무 결과물에 목소리가 입혀진다면, 어떤 부분에, 어떤 목소리가 적합할까?', '4허브 라인.xlsx', true),
  ('common', 'CPBS-NN0018', '[실무 Tool. 8] PixVerse',
   '상상이 현실로, 그리고 그 현실이 움직임으로! 내가 하는 업무 내용을 실제 장면으로 볼 수 있다면?', '4허브 라인.xlsx', true),
  ('common', 'CPBS-NN0019', '[실무 Tool. 9] Listly',
   '데이터는 원래 ‘한 번’ 에 뽑는거야. 어부들이 그물을 던지는 것 처럼!', '4허브 라인.xlsx', true),
  ('common', 'CPBS-NN0020', '[실무 Tool. 10] Pigma',
   'IT 프로그램을 만드려면, ‘모습’ 이 있어야 하고, ‘설계’ 가 있어야 해. 손으로 그릴거야?', '4허브 라인.xlsx', true),

  ('common', 'CPBS-NN0021', '[실무 Mindset. 1] 누가 나의 고객인가?',
   '결국 커리어와 직업적 성공이란, 고객이 누구인지에 대해 얼마나 제대로 아는 지에 달려있다.', '4허브 라인.xlsx', true),
  ('common', 'CPBS-NN0022', '[실무 Mindset. 2] 업무 지시란 무엇인가?',
   '업무를 지시하는 사람은 왜 그렇게 업무 지시를 할 수 밖에 없었는가?', '4허브 라인.xlsx', true),
  ('common', 'CPBS-NN0023', '[실무 Mindset. 3] 업무 보고란 무엇인가?',
   '업무를 보고하는 사람은 왜 그렇게 업무 보고를 할 수 밖에 없었는가?', '4허브 라인.xlsx', true),
  ('common', 'CPBS-NN0024', '[실무 Mindset. 4] 커뮤니케이션',
   '커뮤니케이션? 그거 애인 사이에도, 친구 사이에도, 가족 사이에도 안되는 거 알잖아.', '4허브 라인.xlsx', true),
  ('common', 'CPBS-NN0025', '[실무 Mindset. 5] 조직/사회 예절',
   '예절만 지킨다고 모두 성공하지는 않아. 그런데 성공한 사람들은 모두 예절에 민감하다는 것이 핵심!', '4허브 라인.xlsx', true),

  ('common', 'CPBS-NN0026', '[실무 Resource. 1] 티타임즈',
   '내 주변에서 돌아가는 친구들의 세상이 아닌, 실제 기업들이 돌아가는 시장과 세상은 어떻게 바뀌고 있니?', '4허브 라인.xlsx', true),
  ('common', 'CPBS-NN0027', '[실무 Resource. 2] 퇴사한 이형',
   '이성의 마음을 이해하고 노력하는 것 만큼, 나를 뽑는 면접관의 마음을 이해해보자구!', '4허브 라인.xlsx', true),
  ('common', 'CPBS-NN0028', '[실무 Resource. 3] 공여사들',
   '정리를 못하면, 관리가 안되고, 관리를 못하면, 나아갈 수가 없어. 꼼꼼함은 선택의 영역이 아니야! 필수지!', '4허브 라인.xlsx', true),
  ('common', 'CPBS-NN0029', '[실무 Resource. 4] 앤드스튜디오',
   '일잘러의 관점과 시각이 나에게 너무 당연한 것이 되면, 그냥 나도 그 순간부터 일잘러인거잖아..?', '4허브 라인.xlsx', true),
  ('common', 'CPBS-NN0030', '[실무 Resource. 5] 오빠두엑셀',
   '업무 실력은 결국 도구라니까? 아니, 망치를 못 다루는데 어떻게 집을 짓겠냐구!', '4허브 라인.xlsx', true)
ON CONFLICT (organization_slug, line_code) DO UPDATE
  SET line_name        = EXCLUDED.line_name,
      main_title       = EXCLUDED.main_title,
      source_file_name = EXCLUDED.source_file_name,
      is_active        = EXCLUDED.is_active,
      updated_at       = now();


COMMIT;


-- ═══════════════════════════════════════════════════════════════════════
-- VERIFICATION QUERIES — 적용 후 직접 실행
-- ═══════════════════════════════════════════════════════════════════════
/*
-- 1) 실무 경험 라인 카운트 (조직별)
SELECT organization_slug, COUNT(*) AS rows
  FROM public.cluster4_experience_line_masters
 WHERE source_file_name = '4허브 라인.xlsx'
 GROUP BY organization_slug
 ORDER BY organization_slug;
-- 기대: encre=7, oranke=8, phalanx=10 (총 25)

-- 2) 실무 역량 라인 카운트 ('common')
SELECT organization_slug, COUNT(*) AS rows
  FROM public.cluster4_competency_line_masters
 WHERE source_file_name = '4허브 라인.xlsx'
 GROUP BY organization_slug;
-- 기대: common=30

-- 3) EXBS-EL series 3 조직 공통 확인
SELECT line_code, COUNT(*) AS org_count
  FROM public.cluster4_experience_line_masters
 WHERE line_code LIKE 'EXBS-EL%'
 GROUP BY line_code
 ORDER BY line_code;
-- 기대: EXBS-EL0001~EL0004 each → org_count = 3

-- 4) 기존 경험 라인 (org_slug seed) 보존 확인
SELECT line_code FROM public.cluster4_experience_line_masters
 WHERE organization_slug = 'oranke'
   AND line_code IN (
     'EX02A - ES0001','EX99A - ER0003','EX99A - ER0004',
     'EX99A - ER0002','EX99L - ER0005','EX99L - ER0006'
   );
-- 기대: 6 rows — 새 seed 가 기존 row 를 삭제하지 않음

-- 5) 기존 역량 라인 (oranke CP00A) 보존 확인
SELECT COUNT(*) FROM public.cluster4_competency_line_masters
 WHERE organization_slug = 'oranke'
   AND line_code LIKE 'CP00A - NS%';
-- 기대: 21 (기존 oranke seed 유지)
*/


-- ═══════════════════════════════════════════════════════════════════════
-- ROLLBACK — 새 seed 만 제거 (기존 데이터 보존)
-- ═══════════════════════════════════════════════════════════════════════
/*
BEGIN;

DELETE FROM public.cluster4_experience_line_masters
 WHERE source_file_name = '4허브 라인.xlsx'
   AND line_code IN (
     'EXEC-EN0001','EXEC-EN0002','EXEC-EN0003',
     'EXOK-EN0001','EXOK-EN0002','EXOK-EN0003','EXOK-EN0004',
     'EXPX-EN0001','EXPX-EN0002','EXPX-EN0003','EXPX-EN0004','EXPX-EN0005','EXPX-EN0006',
     'EXBS-EL0001','EXBS-EL0002','EXBS-EL0003','EXBS-EL0004'
   );

DELETE FROM public.cluster4_competency_line_masters
 WHERE source_file_name = '4허브 라인.xlsx'
   AND organization_slug = 'common'
   AND line_code LIKE 'CPBS-NN%';

COMMIT;
*/
