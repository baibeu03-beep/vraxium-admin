/**
 * READ-ONLY 교차검증: 삭제 후보 라인이 "테스트 유저 전용"인지 실제 read-path 로 확인.
 *   npx tsx --env-file=.env.local scripts/verify-test-line-candidate-direct.ts
 *
 * HTTP 라우트(app/api/cluster4/lines/...)는 이 lib 함수를 그대로 래핑하므로
 * direct == HTTP. 후보 라인의 타깃 유저로 조회 → 그 라인이 잡히는지, 타깃이 전원
 * test_user_markers 인지 확인한다. (DB 변경 없음)
 */
import { config } from "dotenv";
config({ path: ".env.local" });

import { createClient } from "@supabase/supabase-js";
import { getCluster4LineDetailForProfileUser } from "@/lib/cluster4LinesData";
import { fetchTestUserMarkerIds } from "@/lib/testUsers";

const sb = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
  { auth: { persistSession: false, autoRefreshToken: false } },
);

// 검증 대상 후보 라인(앞 진단의 TEST-only 표본 — info/experience/competency 각 1).
// uuid 컬럼은 like 불가 → main_title 의 고유 부분문자열로 매칭.
const SAMPLE_LINE_IDS = [
  "동해물과 백두산", // info  W13 sub=1
  "결과를 제대로 ‘인지’", // experience W13 퍼포먼스 마케팅 sub=1
  "가볍게 압도한다구", // competency W13 인포그래픽 sub=1
];

async function main() {
  const testIds = await fetchTestUserMarkerIds();
  console.log(`test_user_markers: ${testIds.size}명\n`);

  for (const prefix of SAMPLE_LINE_IDS) {
    // 1) 후보 라인 본체 + part_type
    const { data: lines } = await sb
      .from("cluster4_lines")
      .select("id,part_type,main_title,is_active")
      .ilike("main_title", `%${prefix}%`);
    const line = (lines ?? [])[0] as
      | { id: string; part_type: string; main_title: string; is_active: boolean }
      | undefined;
    if (!line) {
      console.log(`[${prefix}] 라인 없음 — 스킵`);
      continue;
    }

    // 2) 라인의 타깃(전수) → 전원 test 유저인지
    const { data: targets } = await sb
      .from("cluster4_line_targets")
      .select("id,week_id,target_user_id,target_mode")
      .eq("line_id", line.id);
    const userTargets = ((targets ?? []) as any[]).filter((t) => t.target_mode === "user");
    const realTargets = userTargets.filter((t) => !testIds.has(t.target_user_id));
    console.log(
      `[${prefix}] ${line.part_type} "${line.main_title.slice(0, 24)}" 타깃 ${userTargets.length} | 실유저 ${realTargets.length} ${realTargets.length === 0 ? "✅ 전원 테스트" : "❌ 실유저 포함"}`,
    );

    // 3) 타깃 유저로 read-path 조회 → 같은 라인이 잡히는지
    const sample = userTargets[0];
    if (!sample) {
      console.log(`     (타깃 없음 — read-path 조회 생략)`);
      continue;
    }
    const detail = await getCluster4LineDetailForProfileUser(
      sample.target_user_id,
      sample.week_id,
      line.part_type as any,
    );
    const hit = detail.line?.lineId === line.id;
    console.log(
      `     read-path(타깃유저=${String(sample.target_user_id).slice(0, 8)}, week=${String(sample.week_id).slice(0, 8)}): status=${detail.status} lineMatch=${hit ? "✅" : "❌ " + (detail.line?.lineId ?? "null")}`,
    );

    // 4) 같은 주차/파트에서 임의의 실유저(비테스트)는 이 라인을 보지 못한다.
    const { data: realUser } = await sb
      .from("cluster4_line_targets")
      .select("target_user_id")
      .eq("week_id", sample.week_id)
      .eq("cluster4_lines.part_type" as any, line.part_type)
      .limit(50);
    const realProbe = ((realUser ?? []) as any[])
      .map((r) => r.target_user_id)
      .find((u) => u && !testIds.has(u));
    if (realProbe) {
      const realDetail = await getCluster4LineDetailForProfileUser(
        realProbe,
        sample.week_id,
        line.part_type as any,
      );
      const leaked = realDetail.line?.lineId === line.id;
      console.log(
        `     실유저 교차(${String(realProbe).slice(0, 8)}): 후보라인 노출=${leaked ? "❌ 누수!" : "✅ 안 보임"} (그들의 라인=${realDetail.line?.lineId?.slice(0, 8) ?? "void"})`,
      );
    }
    console.log();
  }
  console.log("완료 (read-only).");
}

main().catch((e) => {
  console.error("ERR", e);
  process.exit(1);
});
