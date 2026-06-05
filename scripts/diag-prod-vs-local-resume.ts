// diag: 운영 Vercel vs 로컬 direct — cluster1 resume DTO 비교 (2026-06-05)
// 1) 누적 22주 사용자 탐색 → 2) 로컬 direct getCluster1Resume → 3) 운영 HTTP /api/cluster1/resume
// 실행: npx tsx scripts/diag-prod-vs-local-resume.ts [userId]
import { config } from "dotenv";
config({ path: ".env.local" });

const PROD_BASE = process.env.DIAG_ADMIN_BASE ?? "https://vraxium-admin.vercel.app";

async function main() {
  const { supabaseAdmin } = await import("../lib/supabaseAdmin");
  const { getCluster1Resume } = await import("../lib/cluster1ResumeData");

  let userId = process.argv[2];

  if (!userId) {
    // 누적 22주 사용자 후보 (테스터 제외)
    const { data: gs, error } = await supabaseAdmin
      .from("user_growth_stats")
      .select("user_id,cumulative_weeks,approved_weeks")
      .order("cumulative_weeks", { ascending: false })
      .limit(15);
    if (error) throw error;
    const ids = (gs ?? []).map((g: any) => g.user_id);
    const { data: markers } = await supabaseAdmin
      .from("test_user_markers")
      .select("user_id")
      .in("user_id", ids.length ? ids : ["00000000-0000-0000-0000-000000000000"]);
    const testerIds = new Set((markers ?? []).map((m: any) => m.user_id));
    console.log("[raw top-15 by cumulative_weeks]", JSON.stringify(gs));
    const real = (gs ?? []).filter((g: any) => !testerIds.has(g.user_id));
    console.log("[non-tester candidates]", JSON.stringify(real));
    if (!real.length) throw new Error("no candidate");
    userId = real[0].user_id;
  }

  const { data: prof } = await supabaseAdmin
    .from("user_profiles")
    .select("user_id,name")
    .eq("user_id", userId)
    .maybeSingle();
  console.log("[target user]", prof);

  // ── 로컬 direct ──
  const direct = await getCluster1Resume(userId!);
  console.log("\n=== LOCAL DIRECT getCluster1Resume ===");
  console.log(JSON.stringify({
    activityCompletion: direct?.activityCompletion,
    practicalStats: direct?.practicalStats,
    seasonRecords: direct?.seasonRecords?.map((r) => ({
      year: r.year, season: r.seasonName, approved: r.approvedWeeks, total: r.totalWeeks, status: r.progressStatus,
    })),
  }, null, 2));

  // ── 운영 HTTP ──
  const key = process.env.INTERNAL_API_KEY;
  if (!key) throw new Error("INTERNAL_API_KEY missing in .env.local");
  const url = `${PROD_BASE}/api/cluster1/resume?userId=${userId}`;
  const res = await fetch(url, { headers: { "x-internal-api-key": key } });
  console.log("\n=== PROD HTTP", url, "===");
  console.log("status:", res.status);
  console.log("headers:", {
    "x-vercel-id": res.headers.get("x-vercel-id"),
    "x-vercel-cache": res.headers.get("x-vercel-cache"),
    age: res.headers.get("age"),
    "cache-control": res.headers.get("cache-control"),
  });
  const body = await res.json().catch(() => null);
  if (!body?.success) {
    console.log("body:", JSON.stringify(body));
    return;
  }
  const d = body.data;
  console.log(JSON.stringify({
    activityCompletion: d.activityCompletion,
    practicalStats: d.practicalStats,
    seasonRecords: d.seasonRecords?.map((r: any) => ({
      year: r.year, season: r.seasonName, approved: r.approvedWeeks, total: r.totalWeeks, status: r.progressStatus,
    })),
  }, null, 2));
}

main().catch((e) => { console.error(e); process.exit(1); });
