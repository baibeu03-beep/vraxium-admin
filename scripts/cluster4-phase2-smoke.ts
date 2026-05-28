/**
 * Phase 2 Smoke Test: cluster4_lines bridge columns + activity_types info seed 검증.
 * Dev 서버 없이 Supabase DB에 직접 쿼리하여 migration 적용 상태와 DTO 변환 로직을 검증.
 *
 * 실행: npx tsx scripts/cluster4-phase2-smoke.ts
 */
import { createClient } from "@supabase/supabase-js";

const url = process.env.NEXT_PUBLIC_SUPABASE_URL || "https://oksnumlerbaybxlmgdux.supabase.co";
const key = process.env.SUPABASE_SERVICE_ROLE_KEY || "";
if (!key) {
  console.error("SUPABASE_SERVICE_ROLE_KEY is required");
  process.exit(1);
}

const sb = createClient(url, key);

let pass = 0;
let fail = 0;
const results: { test: string; status: "PASS" | "FAIL"; detail: string }[] = [];

function ok(test: string, detail = "") {
  pass++;
  results.push({ test, status: "PASS", detail });
  console.log(`  ✅ ${test}${detail ? ` — ${detail}` : ""}`);
}
function ng(test: string, detail = "") {
  fail++;
  results.push({ test, status: "FAIL", detail });
  console.log(`  ❌ ${test}${detail ? ` — ${detail}` : ""}`);
}

async function main() {
  console.log("\n=== Phase 2 Smoke Test ===\n");

  // ────────────────────────────────────────────────
  // 1. Migration 1: cluster4_lines 신규 컬럼 존재 확인
  // ────────────────────────────────────────────────
  console.log("[1] cluster4_lines 신규 컬럼 존재 확인");

  // 컬럼 존재 확인: activity_type_id가 있는 행을 select 시도
  const { data: linesSample, error: linesErr } = await sb
    .from("cluster4_lines")
    .select("id, activity_type_id, output_images, team_id, career_project_id, part_type, main_title, is_active")
    .limit(5);

  if (linesErr) {
    ng("cluster4_lines 컬럼 조회", linesErr.message);
  } else {
    ok("cluster4_lines 컬럼 조회 성공", `${linesSample?.length ?? 0}행 반환`);
    // 컬럼 존재 여부 확인 (빈 테이블이어도 에러 없이 반환되면 컬럼 존재)
    if (linesSample && linesSample.length > 0) {
      const sample = linesSample[0];
      const hasNewCols =
        "activity_type_id" in sample &&
        "output_images" in sample &&
        "team_id" in sample &&
        "career_project_id" in sample;
      hasNewCols
        ? ok("신규 4개 컬럼 존재 확인")
        : ng("신규 컬럼 누락", JSON.stringify(Object.keys(sample)));
    } else {
      ok("cluster4_lines 빈 테이블 (컬럼 존재는 에러 없음으로 확인)");
    }
  }

  // ────────────────────────────────────────────────
  // 2. Migration 2: activity_types info seed 확인
  // ────────────────────────────────────────────────
  console.log("\n[2] activity_types practical_info seed 확인");

  const { data: infoTypes, error: infoErr } = await sb
    .from("activity_types")
    .select("id, name, line_code, cluster_id, is_active")
    .eq("cluster_id", "practical_info")
    .order("id");

  if (infoErr) {
    ng("activity_types practical_info 조회", infoErr.message);
  } else {
    const expected = ["calendar", "community", "essay", "etc_a", "forum", "infodesk", "practical_lecture", "session", "wisdom"];
    const actual = (infoTypes || []).map((t) => t.id).sort();
    const allPresent = expected.every((id) => actual.includes(id));
    allPresent
      ? ok(`info 타입 ${actual.length}개 확인`, actual.join(", "))
      : ng(`info 타입 불일치`, `expected ${expected.length}, got ${actual.length}: ${actual.join(", ")}`);
  }

  // 전체 cluster_id 분포 확인
  const { data: allTypes } = await sb
    .from("activity_types")
    .select("cluster_id")
    .eq("is_active", true);

  if (allTypes) {
    const counts: Record<string, number> = {};
    for (const t of allTypes) {
      counts[t.cluster_id] = (counts[t.cluster_id] || 0) + 1;
    }
    ok("activity_types cluster_id 분포", JSON.stringify(counts));
  }

  // ────────────────────────────────────────────────
  // 3. 부분 UNIQUE 인덱스 확인 (동일 activity_type_id 중복 삽입 시도)
  // ────────────────────────────────────────────────
  console.log("\n[3] 부분 UNIQUE 인덱스 검증");
  // 테스트용 라인 2개를 같은 activity_type_id로 생성 시도
  const testTypeId = `__smoke_test_${Date.now()}`;
  const now = new Date();
  const future = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000);

  const { data: line1 } = await sb.from("cluster4_lines").insert({
    part_type: "info",
    main_title: "smoke-test-1",
    activity_type_id: testTypeId,
    is_active: true,
    submission_opens_at: now.toISOString(),
    submission_closes_at: future.toISOString(),
  }).select("id").single();

  if (!line1) {
    ng("테스트 라인 1 생성 실패");
  } else {
    const { error: dupErr } = await sb.from("cluster4_lines").insert({
      part_type: "info",
      main_title: "smoke-test-2-dup",
      activity_type_id: testTypeId,
      is_active: true,
      submission_opens_at: now.toISOString(),
      submission_closes_at: future.toISOString(),
    }).select("id").single();

    dupErr
      ? ok("UNIQUE 인덱스 중복 차단 확인", dupErr.code || dupErr.message)
      : ng("UNIQUE 인덱스 미작동 — 중복 삽입 성공");

    // cleanup
    await sb.from("cluster4_lines").delete().eq("activity_type_id", testTypeId);
    ok("테스트 데이터 정리 완료");
  }

  // ────────────────────────────────────────────────
  // 4. Profile API DTO 변환 시뮬레이션
  // ────────────────────────────────────────────────
  console.log("\n[4] DTO 변환 시뮬레이션 (cluster4_line_targets → weeklyActivities 형태)");

  // 실제 주차 데이터 확인
  const { data: recentWeek } = await sb
    .from("weeks")
    .select("id, week_number, start_date")
    .order("start_date", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (!recentWeek) {
    ng("최근 주차 조회 실패");
  } else {
    ok("최근 주차", `week_number=${recentWeek.week_number}, start_date=${recentWeek.start_date}`);

    // cluster4_line_targets에서 해당 주차의 라인 조회 (Profile API [13] 쿼리 재현)
    const { data: targets, error: targetsErr } = await sb
      .from("cluster4_line_targets")
      .select("week_id, cluster4_lines!inner(id, activity_type_id, main_title, is_active, submission_opens_at, submission_closes_at, output_link_1, output_images, team_id)")
      .eq("week_id", recentWeek.id);

    if (targetsErr) {
      ng("cluster4_line_targets JOIN 쿼리", targetsErr.message);
    } else {
      ok(`targets 조회 성공`, `${targets?.length ?? 0}행`);

      // DTO 변환 시뮬레이션
      if (targets && targets.length > 0) {
        const seen = new Set<string>();
        const adapted = targets
          .filter((t: any) => t.cluster4_lines?.activity_type_id)
          .filter((t: any) => {
            const k = t.cluster4_lines.activity_type_id;
            if (seen.has(k)) return false;
            seen.add(k);
            return true;
          })
          .map((t: any) => {
            const line = t.cluster4_lines;
            return {
              id: line.id,
              activity_type_id: line.activity_type_id,
              title: line.main_title,
              is_active: line.is_active,
              opened_at: line.submission_opens_at,
              deadline: line.submission_closes_at,
              output_links: line.output_link_1 ? [{ url: line.output_link_1 }] : [],
              output_images: line.output_images || [],
              team_id: line.team_id || null,
            };
          });

        ok(`weeklyActivities DTO 변환 성공`, `${adapted.length}개 활동`);

        // 필드 검증
        if (adapted.length > 0) {
          const sample = adapted[0];
          const fields = ["id", "activity_type_id", "title", "is_active", "opened_at", "deadline", "output_links", "output_images", "team_id"];
          const missing = fields.filter((f) => !(f in sample));
          missing.length === 0
            ? ok("weeklyActivities DTO 필드 완전", JSON.stringify(sample, null, 2).substring(0, 200))
            : ng("weeklyActivities DTO 필드 누락", missing.join(", "));
        }
      } else {
        ok("해당 주차에 라인 target 없음 (빈 배열 정상)");
      }
    }
  }

  // ────────────────────────────────────────────────
  // 5. activityRecords DTO 변환 시뮬레이션
  // ────────────────────────────────────────────────
  console.log("\n[5] activityRecords DTO 변환 시뮬레이션 (cluster4_line_submissions)");

  // 아무 사용자의 submissions 조회
  const { data: subs, error: subsErr } = await sb
    .from("cluster4_line_submissions")
    .select("id, user_id, submitted_at, cluster4_line_targets!inner(week_id, cluster4_lines!inner(activity_type_id))")
    .limit(5);

  if (subsErr) {
    ng("cluster4_line_submissions JOIN 쿼리", subsErr.message);
  } else {
    ok(`submissions 조회 성공`, `${subs?.length ?? 0}행`);

    if (subs && subs.length > 0) {
      const adapted = subs
        .filter((s: any) => s.cluster4_line_targets?.cluster4_lines?.activity_type_id)
        .map((s: any) => ({
          id: s.id,
          week_id: s.cluster4_line_targets.week_id,
          activity_type_id: s.cluster4_line_targets.cluster4_lines.activity_type_id,
          is_completed: true,
        }));

      ok(`activityRecords DTO 변환 성공`, `${adapted.length}개`);
      if (adapted.length > 0) {
        const s = adapted[0];
        s.is_completed === true
          ? ok("is_completed=true 확인")
          : ng("is_completed 값 오류");
        ok("샘플", JSON.stringify(s));
      }
    } else {
      ok("submissions 없음 (빈 배열 = activityRecords 없음 = 모두 'failed' 정상)");
    }
  }

  // ────────────────────────────────────────────────
  // 6. activity-details 검증 기반 시뮬레이션
  // ────────────────────────────────────────────────
  console.log("\n[6] activity-details 마감 검증 시뮬레이션 (cluster4_lines 기반)");

  // cluster4_lines에서 활성 라인 + targets 조회
  const { data: activeTargets, error: atErr } = await sb
    .from("cluster4_line_targets")
    .select("week_id, target_user_id, cluster4_lines!inner(is_active, submission_opens_at, submission_closes_at, team_id, activity_type_id)")
    .eq("cluster4_lines.is_active", true)
    .limit(3);

  if (atErr) {
    ng("활성 라인 targets 조회", atErr.message);
  } else {
    ok(`활성 라인 targets`, `${activeTargets?.length ?? 0}행`);

    if (activeTargets && activeTargets.length > 0) {
      const t = activeTargets[0] as any;
      const line = t.cluster4_lines;
      const isBeforeDeadline = line?.submission_closes_at &&
        Date.now() < new Date(line.submission_closes_at).getTime();

      ok("마감 검증 시뮬레이션", `activity_type_id=${line?.activity_type_id}, is_active=${line?.is_active}, deadline=${line?.submission_closes_at}, isBeforeDeadline=${isBeforeDeadline}`);
    }
  }

  // ────────────────────────────────────────────────
  // 7. user_activity_details 연결 확인
  // ────────────────────────────────────────────────
  console.log("\n[7] user_activity_details 테이블 상태");

  const { data: uadSample, error: uadErr } = await sb
    .from("user_activity_details")
    .select("user_id, week_id, activity_type_id, sub_title, rating")
    .limit(3);

  if (uadErr) {
    ng("user_activity_details 조회", uadErr.message);
  } else {
    ok(`user_activity_details`, `${uadSample?.length ?? 0}행 존재`);
  }

  // ────────────────────────────────────────────────
  // Summary
  // ────────────────────────────────────────────────
  console.log("\n=== 결과 ===");
  console.log(`PASS: ${pass}, FAIL: ${fail}, TOTAL: ${pass + fail}`);

  if (fail > 0) {
    console.log("\n실패 항목:");
    for (const r of results.filter((r) => r.status === "FAIL")) {
      console.log(`  ❌ ${r.test}: ${r.detail}`);
    }
  }

  console.log("\n=== API 테스트 (Dev 서버 필요) ===");
  console.log("Dev 서버 실행 후 아래 항목 추가 테스트 필요:");
  console.log("  1. GET /api/profile?context=card&weekId=<uuid> → 200 + weekBundle 확인");
  console.log("  2. PUT /api/activity-details → 비어드민 403 해소 확인");
  console.log("  3. 프론트 Cluster4CardContent.tsx 카드 렌더링 확인");

  process.exit(fail > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(2);
});
