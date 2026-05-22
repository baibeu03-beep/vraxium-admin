-- Seed v4.2: profile + cluster2 enrichment
-- batch_id = '2026-05-22_seed_30users_v1'
-- UI limits: vision<=10, slogan<=86, essays<=1000

BEGIN;

DO $$
DECLARE target_count int; phalanx_in_targets int; pre_test_format_count int;
BEGIN
  SELECT COUNT(*) INTO target_count
  FROM public.test_user_markers tm
  JOIN public.user_profiles up ON up.user_id = tm.user_id
  WHERE tm.seed_batch_id = '2026-05-22_seed_30users_v1';

  SELECT COUNT(*) INTO phalanx_in_targets
  FROM public.test_user_markers tm
  JOIN public.user_profiles up ON up.user_id = tm.user_id
  WHERE tm.seed_batch_id = '2026-05-22_seed_30users_v1' AND up.organization_slug = 'phalanx';

  SELECT COUNT(*) INTO pre_test_format_count
  FROM public.test_user_markers tm
  JOIN public.user_profiles up ON up.user_id = tm.user_id
  WHERE tm.seed_batch_id = '2026-05-22_seed_30users_v1' AND up.display_name LIKE '[TEST] 더미크루%';

  IF target_count <> 30 THEN RAISE EXCEPTION 'target_count=% (30)', target_count; END IF;
  IF phalanx_in_targets > 0 THEN RAISE EXCEPTION 'phalanx_in_targets=% (0)', phalanx_in_targets; END IF;
  IF pre_test_format_count <> 30 THEN
    RAISE WARNING 'v4.1 display_name 매칭 % (30 기대)', pre_test_format_count;
  END IF;
END $$;

WITH base_map AS (
  SELECT
    tm.user_id,
    tm.user_type,
    (tm.legacy_user_id - 900000)::int AS idx,
    CASE
      WHEN (tm.legacy_user_id - 900000)::int IN (1,10,16,22,29) THEN 'minimal'
      WHEN (tm.legacy_user_id - 900000)::int IN (2,7,13,21,30) THEN 'newbie'
      WHEN (tm.legacy_user_id - 900000)::int IN (3,8,14,20,26) THEN 'normal'
      WHEN (tm.legacy_user_id - 900000)::int IN (4,9,15,19,25) THEN 'high_activity'
      WHEN (tm.legacy_user_id - 900000)::int IN (5,11,17,23,27) THEN 'operator'
      ELSE 'overflow_guard'
    END AS persona,
    (ARRAY['김민준','이서연','이도윤','박지우','박서준','최하윤','최주원','정채원','정시우','강유나','강하준','조서아','조지호','윤지아','윤예준','장은서','장은우','임소율','임지후','한채은','한로운','송예나','송태민','권아인','권시환','황지유','황건우','안다현','안준서','신서윤'])[(tm.legacy_user_id - 900000)::int] AS new_name,
    (ARRAY['서울대학교','연세대학교','고려대학교','성균관대학교','한양대학교','서강대학교','중앙대학교','경희대학교','한국외국어대학교','홍익대학교'])[(((tm.legacy_user_id - 900000)::int - 1) % 10) + 1] AS new_school,
    (ARRAY['경영학과','컴퓨터공학과','디자인학과','미디어커뮤니케이션학과','심리학과','경제학과','산업공학과','전자공학과','국어국문학과','데이터사이언스학과'])[(((tm.legacy_user_id - 900000)::int - 1) % 10) + 1] AS new_dept,
    (ARRAY['서울시 성북구','서울시 마포구','서울시 강남구','서울시 서대문구','서울시 동대문구','경기도 성남시','경기도 수원시','경기도 고양시','인천시 연수구'])[(((tm.legacy_user_id - 900000)::int - 1) % 9) + 1] AS new_address,
    (ARRAY['평일 오후 2시 이후','평일 저녁 7시 이후','주말 오후 가능','화/목 오후 가능','평일 오전 10시~12시 가능'])[(((tm.legacy_user_id - 900000)::int - 1) % 5) + 1] AS new_available,
    (ARRAY['구글','토스','네이버','카카오','삼성전자','현대자동차','쿠팡','배달의민족','라인','당근'])[(((tm.legacy_user_id - 900000)::int - 1) % 10) + 1] AS new_vision
  FROM public.test_user_markers tm
  WHERE tm.seed_batch_id = '2026-05-22_seed_30users_v1'
), enriched_map AS (
  SELECT bm.*,
    CASE bm.persona
      WHEN 'minimal' THEN '구글 같은 팀에서 기본을 빠르게 흡수하고 끝까지 완성합니다.'
      WHEN 'newbie' THEN '토스를 목표로 작은 실행을 꾸준히 쌓는 신입 기획자입니다.'
      WHEN 'normal' THEN '네이버가 푸는 문제를 관찰하며 사용자 흐름을 정리하는 실무형 인재입니다.'
      WHEN 'high_activity' THEN '카카오 수준의 속도와 밀도로 실험하고 기록하는 고활동 메이커입니다.'
      WHEN 'operator' THEN '삼성전자처럼 팀 운영과 실행 품질을 함께 책임지는 조율형 운영자입니다.'
      ELSE '현대자동차 같은 큰 환경에서도 문제 정의와 실행, 회고를 끝까지 연결하는 사람입니다.' END AS s1,
    CASE bm.persona
      WHEN 'minimal' THEN '입력이 많지 않아도 불필요한 수식 없이 핵심 판단 근거를 남겨 협업 비용을 줄이는 편입니다.'
      WHEN 'newbie' THEN '첫 화면의 맥락을 빠르게 읽고 필요한 정보를 차분하게 정리해 신뢰를 만드는 편입니다.'
      WHEN 'normal' THEN '사용자 반응과 운영 데이터를 함께 보며 우선순위를 조정하고, 팀이 납득할 근거를 남깁니다.'
      WHEN 'high_activity' THEN '여러 과제를 병렬로 다루더라도 실험 기록과 후속 액션을 남겨 재사용 가능한 흐름을 만듭니다.'
      WHEN 'operator' THEN '일정, 품질, 커뮤니케이션을 함께 관리하며 팀원마다 필요한 지원 방식이 다르다는 점을 세심하게 챙깁니다.'
      ELSE '길이 제한에 맞춰 핵심만 남기되, 읽는 사람이 다음 행동을 바로 정할 수 있게 구조화해서 전달합니다.' END AS s2,
    CASE bm.persona
      WHEN 'minimal' THEN '한 번의 좋은 산출물보다 반복 가능한 작업 방식을 더 중요하게 여기며, 작은 개선을 꾸준히 쌓습니다.'
      WHEN 'newbie' THEN '배운 내용을 바로 실행으로 옮기고, 작게라도 결과를 남겨 다음 주의 기준점으로 삼습니다.'
      WHEN 'normal' THEN '낯선 업무도 질문을 정리해 먼저 부딪히고, 이해한 내용을 팀 문맥에 맞게 다시 설명할 수 있습니다.'
      WHEN 'high_activity' THEN '문제 정의와 실행 계획, 결과 공유를 한 흐름으로 묶어 팀이 같은 방향을 바라보게 만드는 데 강점이 있습니다.'
      WHEN 'operator' THEN '빠른 실행이 필요한 상황에서도 기준 문서와 체크포인트를 남겨 팀 전체의 안정성을 지키려 합니다.'
      ELSE '경계값에 가까운 조건에서도 표현이 무너지지 않도록 문장 길이와 정보 밀도를 함께 조정합니다.' END AS s3,
    CASE bm.persona
      WHEN 'minimal' THEN '저는 처음부터 말이 많거나 눈에 띄는 편은 아니었습니다. 대신 맡은 일을 조용히 끝내고, 꼭 필요한 말만 정리해서 전달하는 방식이 더 편했습니다. 그래서 성장도 느려 보일 때가 있었지만, 작은 일이라도 누락 없이 마무리하는 경험이 쌓이면서 신뢰를 얻기 시작했습니다. 지금도 화려한 표현보다 정확한 정리와 실행을 더 중요하게 생각합니다. 많은 내용을 넣기보다 핵심을 남기는 태도가 오히려 오래 가는 힘이라는 점을 계속 확인하고 있습니다.'
      WHEN 'newbie' THEN '대학교에 들어와 처음 맡았던 팀 과제는 역할이 자주 바뀌고 일정도 불안정했습니다. 그때 저는 잘하는 사람보다 끝까지 정리하는 사람이 필요하다는 걸 배웠습니다. 회의 내용을 먼저 기록하고, 빠진 결정사항을 다시 확인하며 작은 혼선을 줄였습니다. 큰 성과를 냈다고 말하기는 어렵지만, 그 경험 이후로 낯선 일 앞에서도 기본 구조를 세우는 습관이 생겼고 지금도 새로운 일을 시작할 때 가장 먼저 흐름과 기준을 정리합니다.'
      WHEN 'normal' THEN '처음에는 아이디어를 내는 일만 좋아했고, 실행 단계에서 생기는 세부 조율은 다른 사람의 몫이라고 생각했습니다. 하지만 학회와 팀 프로젝트를 거치며 실제 결과를 만드는 힘은 마감 직전의 정리와 반복 확인에서 나온다는 걸 배웠습니다. 이후에는 발표 자료, 일정표, 피드백 메모처럼 눈에 잘 띄지 않는 정리 작업을 자주 맡았고, 그 과정에서 제 강점이 사람들의 생각을 하나의 흐름으로 묶는 데 있다는 사실을 알게 됐습니다.'
      WHEN 'high_activity' THEN '여러 프로젝트를 동시에 진행하던 시기에 가장 크게 배운 점은 많이 하는 것보다 꾸준히 남기는 것이 중요하다는 사실이었습니다. 아이디어 회의, 사용자 인터뷰, 운영 실험을 반복하면서도 기록이 없으면 같은 논의를 다시 하게 됐습니다. 그래서 매 작업마다 가설과 결과를 짧게라도 남기는 방식을 만들었고, 팀원들이 그 기록을 다시 참고하는 경험을 하며 제 일의 기준도 더 선명해졌습니다. 이후로 저는 성과뿐 아니라 재사용 가능한 과정까지 함께 만드는 사람으로 성장하고 싶어졌습니다.'
      WHEN 'operator' THEN '운영 역할을 맡기 전에는 결과물의 완성도만 보며 일했습니다. 하지만 사람과 일정이 엮인 환경에서는 좋은 결과도 안정적으로 굴러가야 의미가 있다는 걸 팀 운영을 통해 배웠습니다. 새로 합류한 사람의 질문을 정리하고, 일정이 흔들릴 때 우선순위를 다시 세우고, 갈등이 생기면 중간 언어를 찾는 과정이 반복됐습니다. 그 경험은 저를 더 넓게 보게 했고, 지금은 한 사람의 산출물보다 팀 전체의 흐름을 건강하게 만드는 데 더 큰 책임감을 느끼고 있습니다.'
      ELSE '여러 활동을 하며 제 방식이 가장 잘 드러난 순간은 제한이 많은 조건에서도 표현의 밀도를 유지해야 할 때였습니다. 분량이 짧아도 핵심은 빠지지 않아야 했고, 긴 글을 쓸 수 있어도 늘 읽는 사람의 집중 시간을 고려해야 했습니다. 그래서 저는 문장을 쓰기 전에 먼저 우선순위를 나누고, 어떤 정보가 반드시 남아야 하는지부터 정리합니다. 이런 습관은 단순한 글쓰기 기술을 넘어, 문제를 구조화하고 전달 가능한 단위로 바꾸는 저만의 성장 방식이 되었습니다.' END AS g,
    CASE bm.persona
      WHEN 'minimal' THEN '저는 많은 사람과 빠르게 친해지는 편은 아니지만, 협업 상황에서는 필요한 정보를 정리해 주는 역할로 자연스럽게 관계를 만들어 왔습니다. 질문이 많지 않은 대신 상대가 헷갈릴 지점을 먼저 정리해 전달하려고 했고, 그 방식이 오히려 팀에서 안정감을 준다는 피드백을 받았습니다. 덕분에 사회 경험은 저에게 네트워킹의 폭보다 신뢰의 밀도를 배우는 과정이었습니다. 지금도 새로운 사람을 만날 때는 화려한 인상보다 함께 일했을 때 편안한 사람으로 기억되고 싶습니다.'
      WHEN 'newbie' THEN '학내 프로젝트와 외부 활동을 함께 하면서 가장 많이 배운 것은 사람마다 이해 속도와 표현 방식이 다르다는 점이었습니다. 같은 목표를 두고도 어떤 사람은 빠르게 결정을 원했고, 어떤 사람은 충분한 설명이 있어야 움직였습니다. 저는 그 차이를 갈등으로 보기보다 조율해야 하는 정보라고 생각했고, 회의 전에 안건을 정리하거나 끝난 뒤 합의 내용을 다시 문서화하는 역할을 자주 맡았습니다. 덕분에 협업은 친화력만이 아니라 구조를 만드는 능력이라는 점을 몸으로 익혔습니다.'
      WHEN 'normal' THEN '처음 참여한 대외활동에서는 의견 충돌이 생기면 빨리 결론을 내는 것이 좋은 협업이라고 생각했습니다. 하지만 실제로는 속도보다 서로의 맥락을 이해하는 시간이 더 중요했습니다. 이후에는 반대 의견이 나왔을 때 바로 설득하기보다 왜 그렇게 생각하는지 먼저 질문하는 방식을 택했습니다. 그러자 논의가 더 오래가더라도 결과는 훨씬 안정적이었습니다. 지금은 협업에서 가장 중요한 능력이 말을 잘하는 것보다, 다른 사람의 기준을 파악하고 번역하는 일이라고 생각합니다.'
      WHEN 'high_activity' THEN '고활동 시기에는 짧은 주기로 여러 사람과 협업할 일이 많았습니다. 새로운 팀원이 들어오고 빠지는 흐름 속에서 공통 기준이 없으면 금세 품질 차이가 커졌습니다. 그래서 저는 회의록, 체크리스트, 실행 로그를 가볍게라도 남겨 누구나 현재 상태를 알 수 있도록 했습니다. 이 방식은 단순한 문서 정리를 넘어 팀의 불안을 낮추는 장치가 됐고, 동시에 협업에서 신뢰가 어떻게 쌓이는지도 배우게 해주었습니다. 결국 좋은 협업은 감정과 정보가 함께 관리될 때 오래 지속된다고 느꼈습니다.'
      WHEN 'operator' THEN '운영진 역할을 맡으며 가장 크게 달라진 점은 개인의 입장보다 팀 전체의 맥락을 먼저 생각하게 됐다는 점입니다. 누군가는 일정이 벅차고, 누군가는 역할이 모호해서 힘들어했습니다. 저는 각자의 말을 듣는 데서 끝내지 않고, 그 이유가 구조 문제인지 커뮤니케이션 문제인지 구분하려고 노력했습니다. 그리고 필요한 경우에는 기준을 다시 문서로 만들고, 역할을 재조정하는 방식으로 대응했습니다. 이 경험 덕분에 사람을 이해하는 일과 시스템을 정비하는 일이 결국 같은 선상에 있다는 것을 배웠습니다.'
      ELSE '길이 제한이나 시간 제약이 있는 협업 환경에서는 전달 방식 하나가 팀의 효율을 크게 좌우했습니다. 저는 회의나 피드백에서 내용을 무작정 길게 말하기보다, 지금 당장 결정해야 할 것과 나중에 논의할 것을 나눠 전달하는 연습을 많이 했습니다. 덕분에 상대가 부담 없이 핵심을 파악할 수 있었고, 후속 작업 속도도 빨라졌습니다. 이런 경험을 통해 사회 경험은 단순한 참여 이력이 아니라, 함께 일하는 사람이 이해하기 쉬운 언어를 만드는 훈련이라는 생각을 갖게 됐습니다.' END AS se,
    CASE bm.persona
      WHEN 'minimal' THEN '제 목표는 많은 기능을 만들기보다 필요한 문제를 정확하게 고르는 실무자가 되는 것입니다. 입력이 적은 상황에서도 핵심을 정리하고, 불필요한 일을 줄이는 방향으로 판단할 수 있는 사람으로 성장하고 싶습니다. 결국 더 적은 자원으로도 더 명확한 결정을 만드는 사람이 되고 싶습니다.'
      WHEN 'newbie' THEN '지금은 다양한 실무를 넓게 경험하되, 결국에는 사용자 문제를 구조화하고 실행 우선순위로 바꾸는 역할을 잘하는 사람이 되고 싶습니다. 화려한 아이디어보다 실제로 움직일 수 있는 문장과 흐름을 만드는 데 강점이 있다고 느끼기 때문에, 기획과 운영의 접점을 오래 파고들 계획입니다.'
      WHEN 'normal' THEN '저는 하나의 직무 이름보다 어떤 문제를 반복해서 잘 풀 수 있는지가 더 중요하다고 생각합니다. 앞으로는 서비스 기획과 운영, 리서치 사이를 오가며 사용자 반응을 실제 개선안으로 연결하는 역량을 키우고 싶습니다. 그 과정에서 기록과 정리 능력을 제 핵심 경쟁력으로 만들고자 합니다.'
      WHEN 'high_activity' THEN '앞으로의 방향은 빠르게 결과를 내는 사람에 머무르지 않고, 다음 실험을 설계할 수 있는 사람으로 성장하는 것입니다. 데이터와 사용자 반응, 팀의 운영 맥락을 함께 읽어 우선순위를 세우고, 작은 실행을 반복 가능한 시스템으로 전환하는 역할을 맡고 싶습니다. 그래서 판단의 근거를 설명할 수 있는 실무자가 되는 것이 제 목표입니다.'
      WHEN 'operator' THEN '장기적으로는 팀이 안정적으로 성과를 낼 수 있도록 운영 구조와 실행 구조를 함께 설계하는 역할을 하고 싶습니다. 개인의 산출물뿐 아니라 팀이 흔들리지 않도록 기준을 세우고, 필요한 정보를 제때 연결하는 사람이 되는 것이 제 커리어 방향입니다. 특히 새로 합류한 사람도 빠르게 적응할 수 있는 환경을 만드는 데 관심이 많습니다.'
      ELSE '경계값에 가까운 조건에서도 품질을 지키는 방식에 관심이 많습니다. 앞으로는 제한된 시간과 분량, 인력 안에서 어떤 정보를 남겨야 결과가 무너지지 않는지 판단하는 역량을 키우고, 이를 서비스 운영과 기획 실행 전반에 적용하고 싶습니다. 제약을 기획의 출발점으로 삼는 사람이 되는 것이 목표입니다.' END AS cd,
    CASE bm.persona
      WHEN 'minimal' THEN '저는 필요한 말만 남기고 과한 표현은 줄이는 편입니다. 작업에서도 같은 성향이 드러나서, 문서나 메시지를 길게 쓰기보다 상대가 바로 이해할 수 있는 단위로 정리합니다. 그래서 제 스타일은 눈에 띄기보다 실수를 줄이고 협업 비용을 낮추는 쪽에 가깝습니다. 담백하지만 재사용 가능한 결과를 만드는 것이 제 기준입니다.'
      WHEN 'newbie' THEN '저는 일을 시작하면 먼저 기준과 순서를 정리하는 편입니다. 급하게 움직여야 할 때도 지금 결정된 것, 아직 비어 있는 것, 다시 확인해야 할 것을 구분해 두면 전체 흐름이 훨씬 안정적이었습니다. 그래서 협업할 때는 속도와 함께 재확인 가능한 기록을 남기는 방식을 중요하게 생각합니다.'
      WHEN 'normal' THEN '제 작업 방식은 일단 작게 만들고 바로 반응을 확인하는 쪽에 가깝습니다. 완벽한 초안을 오래 붙잡기보다 빠르게 공유하고, 받은 피드백을 기준으로 다음 단계를 조정합니다. 대신 수정 이력과 결정 이유를 남겨서 같은 논의를 반복하지 않도록 관리하려고 합니다. 이렇게 해야 팀도 더 빠르게 배울 수 있다고 생각합니다.'
      WHEN 'high_activity' THEN '실행량이 많아질수록 저는 우선순위와 회고를 더 자주 확인합니다. 해야 할 일을 늘리는 것보다 지금 진행 중인 작업이 왜 중요한지 팀과 다시 맞추는 편이 결과적으로 더 빠르다고 느꼈기 때문입니다. 그래서 기록, 공유, 다음 액션 정리를 한 세트로 가져가려 합니다. 이 방식이 반복될수록 팀의 기준도 더 선명해집니다.'
      WHEN 'operator' THEN '운영 역할을 맡을 때는 결과물의 품질만큼 사람의 상태와 일정의 안정성을 함께 봅니다. 누군가 막히는 지점이 보이면 혼자 버티게 두기보다 기준 문서나 체크포인트를 추가해 흐름을 보완합니다. 저는 이런 방식이 팀 전체의 속도를 지키는 데 더 효과적이라고 믿습니다. 결국 운영은 배려와 구조를 함께 다루는 일이라고 생각합니다.'
      ELSE '제 작업 방식은 제한 조건을 먼저 확인한 뒤 그 안에서 가장 밀도 높은 결과를 만드는 쪽입니다. 글자 수, 시간, 리소스처럼 경계가 분명할수록 오히려 우선순위를 더 선명하게 세울 수 있다고 생각합니다. 그래서 항상 핵심 정보와 보조 정보를 구분해 전달하려고 합니다. 제약이 많을수록 구조를 먼저 세우는 이유도 여기에 있습니다.' END AS ws,
    CASE bm.persona
      WHEN 'minimal' THEN '저는 많은 것을 한꺼번에 보여주기보다 꼭 필요한 것만 남기는 방식에 더 끌립니다. 글을 쓸 때도, 사람을 만날 때도, 일을 설명할 때도 비슷합니다. 그래서 처음에는 담백하다는 말을 많이 들었지만, 시간이 지나면 오히려 편안하다는 피드백을 자주 받았습니다. 제 이야기 역시 거창한 전환점보다 조용히 쌓인 선택들의 합에 가깝습니다. 오래 봤을 때 신뢰할 수 있는 사람이 되고 싶다는 기준이 늘 제 판단의 중심에 있습니다.'
      WHEN 'newbie' THEN '저는 낯선 환경에 들어가면 먼저 분위기와 흐름을 파악한 뒤 천천히 제 역할을 넓혀 가는 편입니다. 처음부터 앞에 나서기보다, 지금 필요한 일이 무엇인지 본 뒤 그 자리를 메우는 방식이 더 자연스럽습니다. 그래서 주변에서는 조용하지만 꾸준한 사람이라는 말을 자주 해줍니다. 저도 그런 평가가 좋습니다. 눈에 띄는 한 번보다 오래 믿을 수 있는 태도가 결국 더 큰 힘이 된다고 믿기 때문입니다.'
      WHEN 'normal' THEN '개인적으로는 결과를 빨리 보여주고 싶다는 마음과 충분히 준비하고 싶다는 마음이 늘 함께 있습니다. 예전에는 그 사이에서 자주 망설였지만, 지금은 완벽함보다 반복 가능한 실행이 더 중요하다고 생각합니다. 그래서 작은 단위라도 먼저 움직이고, 그다음에 고치는 방식을 의식적으로 연습하고 있습니다. 이 태도는 일뿐 아니라 일상에서도 영향을 줘서, 요즘은 새로운 시도를 할 때 실패 가능성보다 다음에 남길 배움을 먼저 생각하게 됐습니다.'
      WHEN 'high_activity' THEN '활동이 많아질수록 제 안에서 더 분명해진 것은 기록에 대한 애정입니다. 메모를 남기고, 지나간 대화를 다시 읽고, 왜 이런 판단을 했는지 적어 두는 일이 저를 안정시키기 때문입니다. 누군가는 느리다고 볼 수 있지만, 저는 그 과정이 있어야 같은 실수를 줄이고 더 나은 선택을 할 수 있다고 믿습니다. 그래서 제 퍼스널 스토리는 거창한 성취보다, 꾸준히 남겨 온 작은 기록들이 지금의 저를 만들었다는 이야기와 더 가깝습니다.'
      WHEN 'operator' THEN '사람을 챙기는 일과 일을 굴러가게 만드는 일이 서로 다르지 않다는 점이 저에게는 중요합니다. 일정이 밀렸을 때 단순히 독촉하는 대신 왜 막혔는지 듣고, 새로 온 사람이 헤매면 규칙을 다시 설명할 수 있는 사람이 되고 싶었습니다. 그런 태도는 때로 시간이 더 들지만, 결국 팀이 오래 가게 만드는 힘이라고 믿습니다. 저는 누군가의 성과를 돕는 역할에서도 충분히 의미를 느끼고, 그 과정에서 오히려 제 책임감과 시야가 더 많이 자랐다고 생각합니다.'
      ELSE '저는 경계가 분명한 상황에서 오히려 더 차분해지는 편입니다. 제한된 분량 안에서 핵심을 남겨야 하거나, 시간이 부족한데도 품질을 유지해야 하는 순간에 집중력이 높아집니다. 아마 무엇을 포기하고 무엇을 남길지 정하는 과정이 저에게는 사고를 선명하게 만들어 주기 때문인 것 같습니다. 그래서 개인적으로도 선택지가 많을 때보다 조건이 분명한 문제를 좋아합니다. 복잡한 상황에서도 구조를 만들 수 있다는 감각이 저를 가장 저답게 만들어 줍니다.' END AS ps
  FROM base_map bm
), pu AS (
  UPDATE public.user_profiles up
  SET display_name = em.new_name || ' [TEST]', school_name = em.new_school, department_name = em.new_dept,
      address = em.new_address, contact_available = em.new_available, vision = em.new_vision, updated_at = now()
  FROM enriched_map em WHERE up.user_id = em.user_id RETURNING up.user_id
), iu AS (
  INSERT INTO public.user_introductions (user_id, slogan_1, slogan_2, slogan_3, updated_at)
  SELECT user_id, s1, s2, s3, now() FROM enriched_map
  ON CONFLICT (user_id) DO UPDATE SET slogan_1 = EXCLUDED.slogan_1, slogan_2 = EXCLUDED.slogan_2, slogan_3 = EXCLUDED.slogan_3, updated_at = EXCLUDED.updated_at
  RETURNING user_id
)
INSERT INTO public.user_cluster2 (user_id, growth_story, social_experience, career_direction, work_style, personal_story, updated_at)
SELECT user_id, g, se, cd, ws, ps, now() FROM enriched_map
ON CONFLICT (user_id) DO UPDATE SET growth_story = EXCLUDED.growth_story, social_experience = EXCLUDED.social_experience, career_direction = EXCLUDED.career_direction, work_style = EXCLUDED.work_style, personal_story = EXCLUDED.personal_story, updated_at = EXCLUDED.updated_at;

DO $$
DECLARE
  updated_count int; new_format_count int; vision_filled_count int; contact_filled_count int; distinct_name_count int;
  slogan_rows_count int; intro_rows_count int; vision_limit_count int;
  slogan_1_range_count int; slogan_2_range_count int; slogan_3_range_count int;
  growth_story_range_count int; social_experience_range_count int; career_direction_range_count int; work_style_range_count int; personal_story_range_count int;
  phalanx_affected int; realuser_affected int;
BEGIN
  SELECT COUNT(*) INTO updated_count FROM public.user_profiles up JOIN public.test_user_markers tm ON tm.user_id = up.user_id WHERE tm.seed_batch_id = '2026-05-22_seed_30users_v1';
  SELECT COUNT(*) INTO new_format_count FROM public.user_profiles up JOIN public.test_user_markers tm ON tm.user_id = up.user_id WHERE tm.seed_batch_id = '2026-05-22_seed_30users_v1' AND up.display_name LIKE '% [TEST]' AND up.display_name NOT LIKE '[TEST] %';
  SELECT COUNT(*) INTO vision_filled_count FROM public.user_profiles up JOIN public.test_user_markers tm ON tm.user_id = up.user_id WHERE tm.seed_batch_id = '2026-05-22_seed_30users_v1' AND up.vision IS NOT NULL;
  SELECT COUNT(*) INTO contact_filled_count FROM public.user_profiles up JOIN public.test_user_markers tm ON tm.user_id = up.user_id WHERE tm.seed_batch_id = '2026-05-22_seed_30users_v1' AND up.contact_available IS NOT NULL;
  SELECT COUNT(DISTINCT up.display_name) INTO distinct_name_count FROM public.user_profiles up JOIN public.test_user_markers tm ON tm.user_id = up.user_id WHERE tm.seed_batch_id = '2026-05-22_seed_30users_v1';
  SELECT COUNT(*) INTO slogan_rows_count FROM public.user_introductions ui JOIN public.test_user_markers tm ON tm.user_id = ui.user_id WHERE tm.seed_batch_id = '2026-05-22_seed_30users_v1' AND ui.slogan_1 IS NOT NULL AND ui.slogan_2 IS NOT NULL AND ui.slogan_3 IS NOT NULL;
  SELECT COUNT(*) INTO intro_rows_count FROM public.user_cluster2 uc JOIN public.test_user_markers tm ON tm.user_id = uc.user_id WHERE tm.seed_batch_id = '2026-05-22_seed_30users_v1' AND uc.growth_story IS NOT NULL AND uc.social_experience IS NOT NULL AND uc.career_direction IS NOT NULL AND uc.work_style IS NOT NULL AND uc.personal_story IS NOT NULL;
  SELECT COUNT(*) INTO vision_limit_count FROM public.user_profiles up JOIN public.test_user_markers tm ON tm.user_id = up.user_id WHERE tm.seed_batch_id = '2026-05-22_seed_30users_v1' AND char_length(up.vision) <= 10;
  SELECT COUNT(*) INTO slogan_1_range_count FROM public.user_introductions ui JOIN public.test_user_markers tm ON tm.user_id = ui.user_id WHERE tm.seed_batch_id = '2026-05-22_seed_30users_v1' AND char_length(ui.slogan_1) BETWEEN 30 AND 50 AND char_length(ui.slogan_1) <= 86;
  SELECT COUNT(*) INTO slogan_2_range_count FROM public.user_introductions ui JOIN public.test_user_markers tm ON tm.user_id = ui.user_id WHERE tm.seed_batch_id = '2026-05-22_seed_30users_v1' AND char_length(ui.slogan_2) BETWEEN 40 AND 70 AND char_length(ui.slogan_2) <= 86;
  SELECT COUNT(*) INTO slogan_3_range_count FROM public.user_introductions ui JOIN public.test_user_markers tm ON tm.user_id = ui.user_id WHERE tm.seed_batch_id = '2026-05-22_seed_30users_v1' AND char_length(ui.slogan_3) BETWEEN 40 AND 70 AND char_length(ui.slogan_3) <= 86;
  SELECT COUNT(*) INTO growth_story_range_count FROM public.user_cluster2 uc JOIN public.test_user_markers tm ON tm.user_id = uc.user_id WHERE tm.seed_batch_id = '2026-05-22_seed_30users_v1' AND char_length(uc.growth_story) BETWEEN 200 AND 400 AND char_length(uc.growth_story) <= 1000;
  SELECT COUNT(*) INTO social_experience_range_count FROM public.user_cluster2 uc JOIN public.test_user_markers tm ON tm.user_id = uc.user_id WHERE tm.seed_batch_id = '2026-05-22_seed_30users_v1' AND char_length(uc.social_experience) BETWEEN 200 AND 400 AND char_length(uc.social_experience) <= 1000;
  SELECT COUNT(*) INTO career_direction_range_count FROM public.user_cluster2 uc JOIN public.test_user_markers tm ON tm.user_id = uc.user_id WHERE tm.seed_batch_id = '2026-05-22_seed_30users_v1' AND char_length(uc.career_direction) BETWEEN 150 AND 300 AND char_length(uc.career_direction) <= 1000;
  SELECT COUNT(*) INTO work_style_range_count FROM public.user_cluster2 uc JOIN public.test_user_markers tm ON tm.user_id = uc.user_id WHERE tm.seed_batch_id = '2026-05-22_seed_30users_v1' AND char_length(uc.work_style) BETWEEN 150 AND 300 AND char_length(uc.work_style) <= 1000;
  SELECT COUNT(*) INTO personal_story_range_count FROM public.user_cluster2 uc JOIN public.test_user_markers tm ON tm.user_id = uc.user_id WHERE tm.seed_batch_id = '2026-05-22_seed_30users_v1' AND char_length(uc.personal_story) BETWEEN 200 AND 400 AND char_length(uc.personal_story) <= 1000;
  SELECT COUNT(*) INTO phalanx_affected FROM public.user_profiles up LEFT JOIN public.test_user_markers tm ON tm.user_id = up.user_id WHERE up.organization_slug = 'phalanx' AND tm.user_id IS NULL AND up.updated_at >= now() - INTERVAL '1 minute';
  SELECT COUNT(*) INTO realuser_affected FROM public.user_profiles up LEFT JOIN public.test_user_markers tm ON tm.user_id = up.user_id WHERE tm.user_id IS NULL AND up.updated_at >= now() - INTERVAL '1 minute';
  IF updated_count <> 30 THEN RAISE EXCEPTION 'updated_count=%', updated_count; END IF;
  IF new_format_count <> 30 THEN RAISE EXCEPTION 'new_format_count=%', new_format_count; END IF;
  IF vision_filled_count <> 30 THEN RAISE EXCEPTION 'vision_filled_count=%', vision_filled_count; END IF;
  IF contact_filled_count <> 30 THEN RAISE EXCEPTION 'contact_filled_count=%', contact_filled_count; END IF;
  IF distinct_name_count <> 30 THEN RAISE EXCEPTION 'distinct_name_count=%', distinct_name_count; END IF;
  IF slogan_rows_count <> 30 THEN RAISE EXCEPTION 'slogan_rows_count=%', slogan_rows_count; END IF;
  IF intro_rows_count <> 30 THEN RAISE EXCEPTION 'intro_rows_count=%', intro_rows_count; END IF;
  IF vision_limit_count <> 30 THEN RAISE EXCEPTION 'vision_limit_count=%', vision_limit_count; END IF;
  IF slogan_1_range_count <> 30 THEN RAISE EXCEPTION 'slogan_1_range_count=%', slogan_1_range_count; END IF;
  IF slogan_2_range_count <> 30 THEN RAISE EXCEPTION 'slogan_2_range_count=%', slogan_2_range_count; END IF;
  IF slogan_3_range_count <> 30 THEN RAISE EXCEPTION 'slogan_3_range_count=%', slogan_3_range_count; END IF;
  IF growth_story_range_count <> 30 THEN RAISE EXCEPTION 'growth_story_range_count=%', growth_story_range_count; END IF;
  IF social_experience_range_count <> 30 THEN RAISE EXCEPTION 'social_experience_range_count=%', social_experience_range_count; END IF;
  IF career_direction_range_count <> 30 THEN RAISE EXCEPTION 'career_direction_range_count=%', career_direction_range_count; END IF;
  IF work_style_range_count <> 30 THEN RAISE EXCEPTION 'work_style_range_count=%', work_style_range_count; END IF;
  IF personal_story_range_count <> 30 THEN RAISE EXCEPTION 'personal_story_range_count=%', personal_story_range_count; END IF;
  IF phalanx_affected > 0 THEN RAISE EXCEPTION 'phalanx_affected=%', phalanx_affected; END IF;
  IF realuser_affected > 0 THEN RAISE EXCEPTION 'realuser_affected=%', realuser_affected; END IF;
END $$;

COMMIT;

/* rollback to v4.1 baseline */
/*
BEGIN;
WITH profile_rollback AS (
  SELECT tm.user_id, (tm.legacy_user_id - 900000)::int AS idx
  FROM public.test_user_markers tm
  WHERE tm.seed_batch_id = '2026-05-22_seed_30users_v1'
)
UPDATE public.user_profiles up
SET display_name='[TEST] 더미크루' || lpad(pr.idx::text, 2, '0'),
    school_name=(ARRAY['서울대','연세대','고려대','카이스트','포스텍','한양대','서강대','성균관대'])[((pr.idx - 1) % 8) + 1],
    department_name=(ARRAY['경영학과','컴퓨터공학과','디자인학과','미디어학과','전자공학과','심리학과'])[((pr.idx - 1) % 6) + 1],
    address='서울시 성북구 (TEST)', contact_available=NULL, vision=NULL, updated_at=now()
FROM profile_rollback pr WHERE up.user_id = pr.user_id;
UPDATE public.user_introductions ui SET slogan_1=NULL, slogan_2=NULL, slogan_3=NULL, updated_at=now() FROM public.test_user_markers tm WHERE tm.seed_batch_id='2026-05-22_seed_30users_v1' AND ui.user_id = tm.user_id;
UPDATE public.user_cluster2 uc SET growth_story=NULL, social_experience=NULL, career_direction=NULL, work_style=NULL, personal_story=NULL, updated_at=now() FROM public.test_user_markers tm WHERE tm.seed_batch_id='2026-05-22_seed_30users_v1' AND uc.user_id = tm.user_id;
COMMIT;
*/

-- verification helpers
SELECT tm.legacy_user_id, tm.user_type, up.vision, char_length(up.vision) AS vision_len,
  char_length(ui.slogan_1) AS slogan_1_len, char_length(ui.slogan_2) AS slogan_2_len,
  char_length(ui.slogan_3) AS slogan_3_len, char_length(uc.growth_story) AS growth_story_len,
  char_length(uc.social_experience) AS social_experience_len, char_length(uc.career_direction) AS career_direction_len,
  char_length(uc.work_style) AS work_style_len, char_length(uc.personal_story) AS personal_story_len
FROM public.test_user_markers tm
JOIN public.user_profiles up ON up.user_id = tm.user_id
LEFT JOIN public.user_introductions ui ON ui.user_id = tm.user_id
LEFT JOIN public.user_cluster2 uc ON uc.user_id = tm.user_id
WHERE tm.seed_batch_id = '2026-05-22_seed_30users_v1'
ORDER BY tm.legacy_user_id;
