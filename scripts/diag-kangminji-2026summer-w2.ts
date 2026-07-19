// Diagnostic — T강민지 / 2026-summer / week 2 act-check anomalies.
//   현상1: [브리핑] 가이드 적용 누락   현상2: [파트] 조직 관리 동일 액트 2회.
// read-only. run: npx tsx --env-file=.env.local scripts/diag-kangminji-2026summer-w2.ts
import { supabaseAdmin } from "@/lib/supabaseAdmin";

function j(v: unknown) { return JSON.stringify(v, null, 2); }

async function main() {
  // ── 1. 사용자 찾기 (T강민지) ──
  const { data: profs, error: profErr } = await supabaseAdmin
    .from("user_profiles")
    .select("user_id,display_name,role,organization_slug,current_team_name,current_part_name,growth_status")
    .ilike("display_name", "%강민지%");
  console.log("=== user_profiles matching 강민지 ===", profErr?.message ?? "");
  console.log(j(profs));

  const candidates = (profs ?? []) as Array<{
    user_id: string; display_name: string | null;
    role: string | null; organization_slug: string | null;
  }>;
  // T강민지 우선 (display_name 정확히 T강민지 또는 T 접두)
  const target = candidates.find((p) => p.display_name === "T강민지")
    ?? candidates.find((p) => (p.display_name ?? "").startsWith("T") && (p.display_name ?? "").includes("강민지"))
    ?? candidates[0];
  if (!target) { console.log("NO TARGET FOUND"); return; }
  console.log("\n=== TARGET ===\n", j(target));
  const userId = target.user_id;
  const org = target.organization_slug;

  // ── 2. 멤버십 (전체 이력) ──
  const { data: mems } = await supabaseAdmin
    .from("user_memberships")
    .select("*")
    .eq("user_id", userId);
  console.log("\n=== user_memberships (all) ===\n", j(mems));

  // ── 3. 주차 찾기 2026-summer W2 ──
  const { data: weeks } = await supabaseAdmin
    .from("weeks")
    .select("id,start_date,end_date,season_key,week_number,iso_year,iso_week")
    .eq("season_key", "2026-summer")
    .order("week_number", { ascending: true });
  console.log("\n=== weeks 2026-summer ===\n", j(weeks));
  const w2 = ((weeks ?? []) as Array<{ id: string; week_number: number | null; iso_year: number | null; iso_week: number | null; start_date: string }>)
    .find((w) => w.week_number === 2);
  if (!w2) { console.log("NO W2"); return; }
  console.log("\n=== W2 ===\n", j(w2));

  // ── 4. 이 사용자의 원장 전체(이 주차) ──
  const { data: awards } = await supabaseAdmin
    .from("process_point_awards")
    .select("*")
    .eq("user_id", userId)
    .eq("year", w2.iso_year!)
    .eq("week_number", w2.iso_week!);
  console.log("\n=== process_point_awards (user, W2 iso) — ALL ROWS ===\n", j(awards));

  const awardRows = (awards ?? []) as Array<{
    id: string; source: string; ref_id: string; point_check: number; point_advantage: number;
    point_penalty: number; created_at: string; updated_at: string; cancelled_at?: string | null;
    organization_slug: string | null; scope_mode: string;
  }>;

  // ── 5. 각 regular ref_id → process_check_statuses + act + line_group ──
  const regularRefs = [...new Set(awardRows.filter((a) => a.source === "regular").map((a) => a.ref_id))];
  const irregularRefs = [...new Set(awardRows.filter((a) => a.source === "irregular").map((a) => a.ref_id))];

  if (regularRefs.length) {
    const { data: statuses } = await supabaseAdmin
      .from("process_check_statuses")
      .select("*")
      .in("id", regularRefs);
    console.log("\n=== process_check_statuses for user's regular awards (W2) ===\n", j(statuses));
    const stRows = (statuses ?? []) as Array<{ id: string; act_id: string; line_group_id: string }>;
    const actIds = [...new Set(stRows.map((s) => s.act_id))];
    if (actIds.length) {
      const { data: acts } = await supabaseAdmin
        .from("process_acts")
        .select("id,act_name,hub,line_group_id,act_type,point_check,point_advantage,point_penalty,duration_minutes")
        .in("id", actIds);
      console.log("\n=== process_acts (for those statuses) ===\n", j(acts));
    }
    const lgIds = [...new Set(stRows.map((s) => s.line_group_id))];
    if (lgIds.length) {
      const { data: lgs } = await supabaseAdmin.from("process_line_groups").select("id,name,hub").in("id", lgIds);
      console.log("\n=== process_line_groups ===\n", j(lgs));
    }
  }
  if (irregularRefs.length) {
    const { data: irr } = await supabaseAdmin
      .from("process_irregular_acts")
      .select("id,act_name,kind,point_a,point_b,point_c,scope_mode,organization_slug,created_at,scheduled_check_at")
      .in("id", irregularRefs);
    console.log("\n=== process_irregular_acts (for user's irregular awards) ===\n", j(irr));
  }

  // ── 6. [브리핑] 가이드 적용 액트 존재 여부 (전체 마스터) ──
  const { data: briefingActs } = await supabaseAdmin
    .from("process_acts")
    .select("id,act_name,hub,line_group_id,act_type,point_check,point_advantage,point_penalty")
    .ilike("act_name", "%가이드 적용%");
  console.log("\n=== process_acts LIKE '가이드 적용' ===\n", j(briefingActs));

  // 그 액트들의 W2 status 행 (org 무관 전체)
  const briefIds = ((briefingActs ?? []) as Array<{ id: string }>).map((a) => a.id);
  if (briefIds.length) {
    const { data: briefStatuses } = await supabaseAdmin
      .from("process_check_statuses")
      .select("*")
      .in("act_id", briefIds)
      .eq("week_id", w2.id);
    console.log("\n=== process_check_statuses for '가이드 적용' acts @ W2 ===\n", j(briefStatuses));
    // 각 status 의 recipients + ledger
    for (const s of (briefStatuses ?? []) as Array<{ id: string }>) {
      const { data: recips } = await supabaseAdmin
        .from("process_check_review_recipients")
        .select("user_id,match_type,source,ref_id")
        .eq("source", "regular").eq("ref_id", s.id);
      const { data: led } = await supabaseAdmin
        .from("process_point_awards")
        .select("user_id,point_check,point_advantage,point_penalty,cancelled_at")
        .eq("source", "regular").eq("ref_id", s.id);
      console.log(`\n--- status ${s.id} recipients(matched) ---\n`, j(recips));
      console.log(`--- status ${s.id} ledger rows (who got it) ---\n`, j(led));
      // 우리 target 이 recipients/ledger 에 포함되는지
      const inRecip = ((recips ?? []) as Array<{ user_id: string }>).some((r) => r.user_id === userId);
      const inLed = ((led ?? []) as Array<{ user_id: string }>).some((r) => r.user_id === userId);
      console.log(`   target in recipients=${inRecip}  in ledger=${inLed}`);
    }
  }

  // ── 7. [파트] 조직 관리 line group + acts + W2 statuses (중복 조사) ──
  const { data: orgMgmtLg } = await supabaseAdmin
    .from("process_line_groups")
    .select("id,name,hub")
    .ilike("name", "%조직 관리%");
  console.log("\n=== process_line_groups LIKE '조직 관리' ===\n", j(orgMgmtLg));
  const orgMgmtLgIds = ((orgMgmtLg ?? []) as Array<{ id: string }>).map((l) => l.id);
  if (orgMgmtLgIds.length) {
    const { data: orgActs } = await supabaseAdmin
      .from("process_acts")
      .select("id,act_name,hub,line_group_id,act_type")
      .in("line_group_id", orgMgmtLgIds);
    console.log("\n=== acts under '조직 관리' line group ===\n", j(orgActs));
    const { data: orgStatuses } = await supabaseAdmin
      .from("process_check_statuses")
      .select("*")
      .in("line_group_id", orgMgmtLgIds)
      .eq("week_id", w2.id);
    console.log("\n=== process_check_statuses under '조직 관리' @ W2 (ALL scopes) ===\n", j(orgStatuses));
  }

  // ── 8. target 의 W2 원장 요약 diff (현상2 두 행 비교용) ──
  console.log("\n=== SUMMARY: target ledger rows W2 (id, source, ref_id, A/B/C, occurred hints) ===");
  for (const a of awardRows) {
    console.log(`  award=${a.id} src=${a.source} ref=${a.ref_id} A=${a.point_check} B=${a.point_advantage} C=${a.point_penalty} created=${a.created_at} updated=${a.updated_at} cancelled=${a.cancelled_at ?? "-"} mode=${a.scope_mode} org=${a.organization_slug}`);
  }
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
