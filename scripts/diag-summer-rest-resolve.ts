/**
 * 진단 전용(read-only): 2026-summer 휴식 확정 50명 → user_id 해석 + 현재 상태 분석.
 *   npx tsx --env-file=.env.local scripts/diag-summer-rest-resolve.ts
 *
 * 각 이름에 대해(org 내 display_name 매칭):
 *   - 매칭된 user_id 수 (0=누락, 1=단일, >1=동명이인 모호)
 *   - 현재 growth_status / status
 *   - 보유 user_season_statuses (season_key:status) — 봄 활동/휴식 여부
 *   - test_user_markers 여부
 */
import { supabaseAdmin } from "@/lib/supabaseAdmin";

const EXPECTED: Record<string, string[]> = {
  encre: [
    "현유빈","추가현","최인영","제서영","이혜인","이재은","송은서","손지희","손정민","류신형",
    "김혜령","강지원","김가희","김나연","김다연","김다정","김도연","김민아","황수민","박가은",
    "오재우","김성현","이예령","박기연","임지윤","윤정환","김수민","김유나","우태경","황예원",
    "김준우","김지민","김지우","김채연",
  ],
  oranke: ["이수현","박소윤","공지민","김동욱","김민결","전현성","정은지","이윤재"],
  phalanx: ["성채윤","정혜빈","김다빈","강은비","최종원","공준혁","양설아","신유이"],
};

const line = (s = "") => console.log(s);
const hr = () => line("─".repeat(78));

async function main() {
  const markers = new Set<string>();
  {
    const { data } = await supabaseAdmin.from("test_user_markers").select("user_id");
    for (const r of (data ?? []) as any[]) markers.add(r.user_id);
  }

  const summary = { resolved: 0, missing: 0, ambiguous: 0, springRest: 0, springActive: 0, alreadySummerRest: 0, isTest: 0 };

  for (const org of ["encre", "oranke", "phalanx"]) {
    hr();
    line(`[${org}] 기대 ${EXPECTED[org].length}명`);
    hr();
    for (const name of EXPECTED[org]) {
      const { data: profs } = await supabaseAdmin.from("user_profiles")
        .select("user_id,display_name,organization_slug,growth_status,status,activity_started_at")
        .eq("organization_slug", org).eq("display_name", name);
      const rows = (profs ?? []) as any[];
      if (rows.length === 0) {
        summary.missing++;
        line(`  ✖ ${name.padEnd(6)} — user_profiles 매칭 0 (org=${org})`);
        continue;
      }
      if (rows.length > 1) summary.ambiguous++;
      for (const p of rows) {
        const tag = markers.has(p.user_id) ? " [TEST]" : "";
        if (markers.has(p.user_id)) summary.isTest++;
        // season statuses
        const { data: ss } = await supabaseAdmin.from("user_season_statuses")
          .select("season_key,status").eq("user_id", p.user_id).order("season_key");
        const ssArr = (ss ?? []) as any[];
        const ssStr = ssArr.map((r) => `${r.season_key}:${r.status}`).join(", ") || "(없음)";
        const hasSpringRest = ssArr.some((r) => r.season_key === "2026-spring" && r.status === "rest");
        const hasSpringSuccess = ssArr.some((r) => r.season_key === "2026-spring" && r.status === "success");
        const hasSummerRest = ssArr.some((r) => r.season_key === "2026-summer" && r.status === "rest");
        if (hasSpringRest) summary.springRest++;
        if (hasSpringSuccess) summary.springActive++;
        if (hasSummerRest) summary.alreadySummerRest++;
        // 봄 활동주차 보유(uws success)
        const { count: springWeeks } = await supabaseAdmin.from("user_week_statuses")
          .select("user_id", { count: "exact", head: true })
          .eq("user_id", p.user_id).eq("season_key", "2026-spring").eq("status", "success");
        if (rows.length === 1) summary.resolved++;
        const flag = rows.length > 1 ? " ⚠동명이인" : "";
        line(`  ${rows.length > 1 ? "?" : "✔"} ${name.padEnd(6)}${tag}${flag} ${p.user_id.slice(0, 8)} growth=${p.growth_status ?? "-"} status=${p.status ?? "-"} 봄success주차=${springWeeks ?? 0}`);
        line(`       season_statuses: ${ssStr}`);
      }
    }
  }

  hr();
  line("요약");
  hr();
  line(JSON.stringify(summary, null, 2));
  line("");
  line("해석 가이드:");
  line("  - missing>0 : 이름이 해당 org user_profiles 에 없음(매칭 실패) → 수동 확인 필요");
  line("  - ambiguous>0 : 동명이인 → user_id 직접 지정 필요");
  line("  - springRest : 이미 봄 휴식자(365 코호트와 겹침) — '봄까지 활동자' 전제와 불일치 가능");
  line("  - springActive/봄success주차>0 : 봄 활동자 → 여름 휴식 시 봄 기록 보존 필수");
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
