// T조예린 단일 사용자 6단계 추적 — raw / direct / admin HTTP / 고객 HTTP(일반·demoUserId 양 경로).
import { config } from "dotenv";
config({ path: ".env.local" });

const ADMIN = "http://localhost:3000";
const CUSTOMER = "http://localhost:3001";

async function main() {
  const { createClient } = await import("@supabase/supabase-js");
  const sb = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
  );
  const { isTransitionWeekStart } = await import("../lib/seasonCalendar");
  const { getCluster1Resume } = await import("../lib/cluster1ResumeData");

  const { data: profMatches } = await sb
    .from("user_profiles")
    .select("user_id, display_name")
    .ilike("display_name", "%조예린%");
  console.log("display_name 매칭:", JSON.stringify(profMatches));
  const prof = ((profMatches ?? []) as any[]).find((p) => p.display_name === "T조예린") ?? (profMatches ?? [])[0];
  if (!prof) throw new Error("T조예린 미발견");
  const uid = prof.user_id;
  console.log(`\n■ ${prof.display_name} user_id=${uid}`);

  // [0] raw user_week_statuses 전체
  const { data: uws } = await sb
    .from("user_week_statuses")
    .select("season_key,week_start_date,week_number,status,updated_at")
    .eq("user_id", uid)
    .order("week_start_date", { ascending: true });
  console.log(`\n[0. raw user_week_statuses 전체 ${(uws ?? []).length}행]`);
  for (const r of (uws ?? []) as any[]) {
    console.log(
      `  ${r.week_start_date} wk${String(r.week_number).padStart(2)} ${r.season_key} ${String(r.status).padEnd(13)} trans=${r.week_start_date ? isTransitionWeekStart(r.week_start_date) : "?"} updated=${String(r.updated_at).slice(0, 16)}`,
    );
  }
  // raw 시즌 요약
  const bySeason = new Map<string, { reg: number; regS: number; trans: number; transS: number }>();
  for (const r of (uws ?? []) as any[]) {
    const e = bySeason.get(r.season_key) ?? { reg: 0, regS: 0, trans: 0, transS: 0 };
    const t = r.week_start_date && isTransitionWeekStart(r.week_start_date);
    if (t) { e.trans++; if (r.status === "success") e.transS++; }
    else { e.reg++; if (r.status === "success") e.regS++; }
    bySeason.set(r.season_key, e);
  }
  console.log("  [raw 시즌 요약]");
  for (const [k, e] of bySeason) console.log(`    ${k}: 비전환 ${e.reg}행(success ${e.regS}) / 전환 ${e.trans}행(success ${e.transS})`);

  // [1] direct
  const dto = await getCluster1Resume(uid);
  console.log(`\n[1. direct getCluster1Resume → seasonRecords 전체]`);
  console.log(JSON.stringify(dto?.seasonRecords ?? null, null, 2));

  // [2] admin HTTP 원문
  const adminRes = await fetch(`${ADMIN}/api/cluster1/resume?userId=${uid}`, {
    headers: { "x-internal-api-key": process.env.INTERNAL_API_KEY! },
  });
  const adminJson: any = await adminRes.json().catch(() => null);
  console.log(`\n[2. admin HTTP /api/cluster1/resume status=${adminRes.status} → seasonRecords 전체]`);
  console.log(JSON.stringify(adminJson?.data?.seasonRecords ?? adminJson, null, 2));

  // [3] direct == HTTP
  const same = JSON.stringify(dto?.seasonRecords) === JSON.stringify(adminJson?.data?.seasonRecords);
  console.log(`\n[3. direct == admin HTTP] ${same ? "동일" : "불일치"}`);

  // [4] 고객 HTTP — 일반 경로(userId)와 demoUserId 경로 양쪽
  for (const param of ["userId", "demoUserId"]) {
    const res = await fetch(`${CUSTOMER}/api/profile/?${param}=${uid}`);
    const json: any = await res.json().catch(() => null);
    const sh = json?.seasonHistories ?? [];
    console.log(`\n[4. 고객 HTTP /api/profile/?${param}= status=${res.status} → seasonHistories ${Array.isArray(sh) ? sh.length : "?"}건]`);
    for (const h of Array.isArray(sh) ? sh : []) {
      console.log(
        `  ${h.seasons?.year ?? "?"} ${h.seasons?.name ?? h.seasonName ?? "?"} | approved=${h.approved_weeks} total=${h.total_weeks} | ${h.progress_status} | ${h.review_status} | id=${h.id}`,
      );
    }
    console.log(`  (admin seasonRecords 패스스루 필드) seasonRecords=${JSON.stringify(json?.seasonRecords ?? null)}`);
  }
}
main().catch((e) => {
  console.error(e);
  process.exit(1);
});
