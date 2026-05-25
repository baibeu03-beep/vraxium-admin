-- 2026-05-25_cluster3_growth_seed_diversify.sql
-- Cluster3 성장 지표 검증용 더미 데이터 다양화.
-- 기존 30명을 6개 그룹(A~F)으로 재배분하고,
-- user_week_statuses / user_growth_stats / user_cumulative_points 를 교체한다.
--
-- 의존성: 2026-05-25_cluster3_growth_indicators.sql 적용 후 실행.
-- Idempotent — 재실행해도 안전하다 (DELETE + INSERT 패턴).
--
-- ⚠ 본 SQL 은 시드 데이터 전용. 운영 환경에서는 실행하지 않는다.
--
-- 그룹 배정:
--   A (온보딩)        : 1~5     growth_status = active
--   B (우수 활동)     : 6~10    growth_status = active
--   C (평균 활동)     : 11~15   growth_status = active
--   D (개인 휴식 경험) : 16~20   #18 weekly_rest, #19 seasonal_rest, #20 paused
--   E (실패 누적)     : 21~25   #25 suspended
--   F (졸업 직전)     : 26~30   #26 oranke approved=24, #27 oranke approved=25,
--                               #28 oranke approved=26 graduated,
--                               #29 graduated, #30 graduated


DO $$
DECLARE
  rec RECORD;
  v_growth_status text;
  v_activity_started_at timestamptz;
  v_activity_ended_at timestamptz;
  v_success int;
  v_fail int;
  v_personal_rest int;
  v_official_rest int;
  v_total_weeks int;
  v_total_stars int;
  v_total_raw_advantages int;
  v_total_lightnings int;
  v_total_shields int;
  v_week_cursor date;
  v_week_count int;
  v_status text;
  v_iso_year int;
  v_iso_week int;
  v_s_placed int;
  v_f_placed int;
  v_p_placed int;
  v_d_placed int;
  v_org text;
  v_force_org text;
BEGIN

  FOR rec IN
    SELECT
      user_id,
      organization_slug,
      ROW_NUMBER() OVER (ORDER BY created_at, user_id) AS rn
    FROM public.user_profiles
    WHERE organization_slug IS NOT NULL
    ORDER BY created_at, user_id
    LIMIT 30
  LOOP
    v_org := rec.organization_slug;
    v_force_org := NULL;
    v_activity_ended_at := NULL;

    -- ═══════════════════════════════════════════════════════════════
    -- 그룹 배정 + 파라미터 결정
    -- ═══════════════════════════════════════════════════════════════

    IF rec.rn BETWEEN 1 AND 5 THEN
      -- ─── Group A: 온보딩 (1주차) ───
      v_growth_status := 'active';
      v_activity_started_at := '2026-05-19 00:00:00+09'::timestamptz;
      v_success := 1;  v_fail := 0;  v_personal_rest := 0;  v_official_rest := 0;
      v_total_stars := 1 + (rec.rn % 3);
      v_total_raw_advantages := 1;
      v_total_lightnings := 0;

    ELSIF rec.rn BETWEEN 6 AND 10 THEN
      -- ─── Group B: 우수 활동 (8~12주, 100% success) ───
      v_growth_status := 'active';
      v_total_weeks := 8 + (rec.rn - 6);  -- 8,9,10,11,12
      v_activity_started_at := (CURRENT_DATE - (v_total_weeks * 7))::date;
      v_activity_started_at := v_activity_started_at
        - ((EXTRACT(ISODOW FROM v_activity_started_at)::int - 1) || ' days')::interval;
      v_official_rest := CASE
        WHEN v_total_weeks >= 10 THEN 2
        WHEN v_total_weeks >= 8  THEN 1
        ELSE 0
      END;
      v_success := v_total_weeks - v_official_rest;
      v_fail := 0;  v_personal_rest := 0;
      v_total_stars := v_success * 3 + (rec.rn % 5);
      v_total_raw_advantages := v_success * 2;
      v_total_lightnings := 0;

    ELSIF rec.rn BETWEEN 11 AND 15 THEN
      -- ─── Group C: 평균 활동 (success + fail + personal_rest 혼합) ───
      v_growth_status := 'active';
      v_total_weeks := 10 + (rec.rn - 11);  -- 10,11,12,13,14
      v_activity_started_at := (CURRENT_DATE - (v_total_weeks * 7))::date;
      v_activity_started_at := v_activity_started_at
        - ((EXTRACT(ISODOW FROM v_activity_started_at)::int - 1) || ' days')::interval;
      v_official_rest := CASE WHEN v_total_weeks >= 12 THEN 2 ELSE 1 END;
      v_personal_rest := 1 + (rec.rn - 11) % 2;  -- 1,2,1,2,1
      v_fail := 2 + (rec.rn - 11) % 3;            -- 2,3,4,2,3
      v_success := v_total_weeks - v_official_rest - v_personal_rest - v_fail;
      IF v_success < 1 THEN
        v_success := 1;
        v_fail := v_total_weeks - v_official_rest - v_personal_rest - v_success;
      END IF;
      v_total_stars := v_success * 2 + (rec.rn % 3);
      v_total_raw_advantages := v_success + (rec.rn % 4);
      v_total_lightnings := v_fail;

    ELSIF rec.rn BETWEEN 16 AND 20 THEN
      -- ─── Group D: 개인 휴식 경험 ───
      v_total_weeks := 12 + (rec.rn - 16);  -- 12,13,14,15,16
      v_activity_started_at := (CURRENT_DATE - (v_total_weeks * 7))::date;
      v_activity_started_at := v_activity_started_at
        - ((EXTRACT(ISODOW FROM v_activity_started_at)::int - 1) || ' days')::interval;
      v_official_rest := 2;
      v_personal_rest := 2 + (rec.rn - 16) % 3;  -- 2,3,4,2,3
      v_fail := 1 + (rec.rn - 16) % 2;            -- 1,2,1,2,1
      v_success := v_total_weeks - v_official_rest - v_personal_rest - v_fail;
      IF v_success < 2 THEN
        v_success := 2;
        v_fail := v_total_weeks - v_official_rest - v_personal_rest - v_success;
      END IF;

      CASE rec.rn
        WHEN 18 THEN v_growth_status := 'weekly_rest';
        WHEN 19 THEN v_growth_status := 'seasonal_rest';
        WHEN 20 THEN v_growth_status := 'paused';
        ELSE          v_growth_status := 'active';
      END CASE;

      v_total_stars := v_success * 2;
      v_total_raw_advantages := v_success + 1;
      v_total_lightnings := v_fail + v_personal_rest;

    ELSIF rec.rn BETWEEN 21 AND 25 THEN
      -- ─── Group E: 실패 누적 ───
      v_total_weeks := 8 + (rec.rn - 21);  -- 8,9,10,11,12
      v_activity_started_at := (CURRENT_DATE - (v_total_weeks * 7))::date;
      v_activity_started_at := v_activity_started_at
        - ((EXTRACT(ISODOW FROM v_activity_started_at)::int - 1) || ' days')::interval;
      v_official_rest := CASE WHEN v_total_weeks >= 10 THEN 2 ELSE 1 END;
      v_personal_rest := 0;
      v_success := 2;
      v_fail := v_total_weeks - v_official_rest - v_personal_rest - v_success;

      IF rec.rn = 25 THEN
        v_growth_status := 'suspended';
      ELSE
        v_growth_status := 'active';
      END IF;

      v_total_stars := v_success;
      v_total_raw_advantages := 1;
      v_total_lightnings := v_fail * 2;

    ELSE
      -- ─── Group F: 졸업 직전/졸업 완료 (26~30) ───
      --   #26: oranke, approved=24 (NOT_YET)
      --   #27: oranke, approved=25 (ELIGIBLE, 정확히 졸업 기준)
      --   #28: oranke, approved=26, graduated
      --   #29: encre,  approved=29, graduated
      --   #30: phalanx, approved=28, graduated

      CASE rec.rn
        WHEN 26 THEN
          v_force_org := 'oranke';
          v_growth_status := 'active';
          v_success := 24; v_fail := 2; v_personal_rest := 1; v_official_rest := 3;
        WHEN 27 THEN
          v_force_org := 'oranke';
          v_growth_status := 'active';
          v_success := 25; v_fail := 1; v_personal_rest := 1; v_official_rest := 3;
        WHEN 28 THEN
          v_force_org := 'oranke';
          v_growth_status := 'graduated';
          v_activity_ended_at := (CURRENT_DATE - 7)::date;
          v_success := 26; v_fail := 1; v_personal_rest := 0; v_official_rest := 3;
        WHEN 29 THEN
          v_force_org := 'encre';
          v_growth_status := 'graduated';
          v_activity_ended_at := (CURRENT_DATE - 14)::date;
          v_success := 29; v_fail := 1; v_personal_rest := 1; v_official_rest := 4;
        WHEN 30 THEN
          v_force_org := 'phalanx';
          v_growth_status := 'graduated';
          v_activity_ended_at := (CURRENT_DATE - 21)::date;
          v_success := 28; v_fail := 2; v_personal_rest := 1; v_official_rest := 4;
      END CASE;

      v_total_weeks := v_success + v_fail + v_personal_rest + v_official_rest;
      v_activity_started_at := (CURRENT_DATE - (v_total_weeks * 7))::date;
      v_activity_started_at := v_activity_started_at
        - ((EXTRACT(ISODOW FROM v_activity_started_at)::int - 1) || ' days')::interval;

      v_total_stars := v_success * 3;
      v_total_raw_advantages := v_success * 2 + 3;
      v_total_lightnings := v_fail;
    END IF;

    -- ═══════════════════════════════════════════════════════════════
    -- net_advantages 정합성 보장
    -- ═══════════════════════════════════════════════════════════════
    v_total_shields := v_total_raw_advantages - ABS(v_total_lightnings);
    IF v_total_shields < 0 THEN
      v_total_shields := 0;
      v_total_raw_advantages := ABS(v_total_lightnings);
    END IF;

    -- ═══════════════════════════════════════════════════════════════
    -- 1. user_profiles 업데이트
    -- ═══════════════════════════════════════════════════════════════
    IF v_force_org IS NOT NULL THEN
      UPDATE public.user_profiles
      SET growth_status = v_growth_status,
          activity_started_at = v_activity_started_at,
          activity_ended_at = v_activity_ended_at,
          organization_slug = v_force_org
      WHERE user_id = rec.user_id;
      v_org := v_force_org;
    ELSE
      UPDATE public.user_profiles
      SET growth_status = v_growth_status,
          activity_started_at = v_activity_started_at,
          activity_ended_at = v_activity_ended_at
      WHERE user_id = rec.user_id;
    END IF;

    -- ═══════════════════════════════════════════════════════════════
    -- 2. user_week_statuses 교체
    -- ═══════════════════════════════════════════════════════════════
    DELETE FROM public.user_week_statuses WHERE user_id = rec.user_id;

    v_total_weeks := v_success + v_fail + v_personal_rest + v_official_rest;
    v_week_cursor := v_activity_started_at::date;
    v_s_placed := 0; v_f_placed := 0; v_p_placed := 0; v_d_placed := 0;
    v_week_count := 0;

    WHILE v_week_count < v_total_weeks LOOP
      v_iso_year := EXTRACT(ISOYEAR FROM v_week_cursor)::int;
      v_iso_week := EXTRACT(WEEK FROM v_week_cursor)::int;

      IF (v_iso_year = 2025 AND v_iso_week IN (1,5,31,32,40,41,52))
         OR (v_iso_year = 2026 AND v_iso_week IN (1,5,22)) THEN
        -- 공식 휴식 주차 slot
        IF v_d_placed < v_official_rest THEN
          v_status := 'official_rest';
          v_d_placed := v_d_placed + 1;
        ELSIF v_s_placed < v_success THEN
          v_status := 'success'; v_s_placed := v_s_placed + 1;
        ELSE
          v_status := 'fail'; v_f_placed := v_f_placed + 1;
        END IF;
      ELSE
        -- 비공식 주차: success → personal_rest → fail → official_rest
        IF v_s_placed < v_success THEN
          v_status := 'success'; v_s_placed := v_s_placed + 1;
        ELSIF v_p_placed < v_personal_rest THEN
          v_status := 'personal_rest'; v_p_placed := v_p_placed + 1;
        ELSIF v_f_placed < v_fail THEN
          v_status := 'fail'; v_f_placed := v_f_placed + 1;
        ELSIF v_d_placed < v_official_rest THEN
          v_status := 'official_rest'; v_d_placed := v_d_placed + 1;
        ELSE
          v_status := 'success'; v_s_placed := v_s_placed + 1;
        END IF;
      END IF;

      INSERT INTO public.user_week_statuses
        (user_id, year, week_number, week_start_date, status)
      VALUES
        (rec.user_id, v_iso_year::smallint, v_iso_week::smallint, v_week_cursor, v_status)
      ON CONFLICT (user_id, year, week_number) DO UPDATE
        SET status = EXCLUDED.status,
            week_start_date = EXCLUDED.week_start_date,
            updated_at = now();

      v_week_cursor := v_week_cursor + 7;
      v_week_count := v_week_count + 1;
    END LOOP;

    -- ═══════════════════════════════════════════════════════════════
    -- 3. user_growth_stats
    -- ═══════════════════════════════════════════════════════════════
    INSERT INTO public.user_growth_stats (user_id, approved_weeks, cumulative_weeks)
    VALUES (rec.user_id, v_success, v_total_weeks)
    ON CONFLICT (user_id) DO UPDATE
      SET approved_weeks = EXCLUDED.approved_weeks,
          cumulative_weeks = EXCLUDED.cumulative_weeks;

    -- ═══════════════════════════════════════════════════════════════
    -- 4. user_cumulative_points
    -- ═══════════════════════════════════════════════════════════════
    INSERT INTO public.user_cumulative_points
      (user_id, total_stars, total_shields, total_lightnings, total_raw_advantages)
    VALUES
      (rec.user_id, v_total_stars, v_total_shields, v_total_lightnings, v_total_raw_advantages)
    ON CONFLICT (user_id) DO UPDATE
      SET total_stars = EXCLUDED.total_stars,
          total_shields = EXCLUDED.total_shields,
          total_lightnings = EXCLUDED.total_lightnings,
          total_raw_advantages = EXCLUDED.total_raw_advantages;

  END LOOP;
END $$;
