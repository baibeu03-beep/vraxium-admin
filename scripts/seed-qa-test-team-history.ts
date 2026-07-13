/**
 * QA 데이터 보정: 합성 테스트 유저(test_user_markers)의 과거 팀·파트 소속 이력을 시드한다.
 * 목적: 테스트 유저의 user_week_statuses(활동) 시간축과 팀·파트 소속(user_position_histories)
 *       시간축을 맞춘다. 현재 (T)팀은 2026-H2에만 있어 과거 반기 팀·파트 표가 비어 있음.
 *
 * 범위(과거 반기만 · 운영 데이터 무접촉):
 *   · 대상 유저   : test_user_markers 전수(실유저·운영팀 절대 무접촉)
 *   · 대상 반기   : 2025-H2, 2026-H1 (각 유저의 실제 uws 가장 오래된 주차 ~ 2026-H1 종료)
 *   · 팀          : 조직별 표준 (T)팀 3개(TEST_TEAM_SCOPE)만 — 과거 반기에 신규 생성
 *   · 파트        : 각 (T)팀의 2026-H2 카탈로그(cluster4_team_parts)를 그대로 복제
 *   · 배정        : 결정론적 라운드로빈(유저 안정 해시 정렬) — 팀·파트 균등, 조직 간 이동 없음
 *   · 이력(UPH)   : 각 유저의 실제 uws 주차마다 1행(raw_team=(T)팀, raw_part=배정 파트)
 *
 * 안전장치:
 *   · UPH 마커      source='qa_seed_test_history' (롤백/멱등 키)
 *   · team_halves   description='[QA-SEED] 과거 테스트 이력 시드' (롤백 키), 표준 (T)명만
 *   · 멱등          이미 존재하는 (org,half,team) / (team_half,part) / (user,week_id) 는 건너뜀
 *   · uws·growth_stats·2026-H2·운영 데이터 절대 미변경
 *
 *   미리보기(기본):  npx tsx --env-file=.env.local scripts/seed-qa-test-team-history.ts
 *   적용:            ... --apply
 *   롤백:            ... --rollback
 */
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { fetchTestUserMarkerIds } from "@/lib/testUsers";
import { seasonKeyToHalfKey } from "@/lib/teamHalf";
import { TEST_TEAM_SCOPE } from "@/lib/cluster4ExperienceTestScope";

const TARGET_SEASONS = ["2025-summer", "2025-autumn", "2026-winter", "2026-spring"];
const TARGET_HALVES = ["2025-H2", "2026-H1"];
const UPH_SOURCE = "qa_seed_test_history";
const TH_DESC = "[QA-SEED] 과거 테스트 이력 시드";
const H2 = "2026-H2";

const TEAMS: Record<string, string[]> = Object.fromEntries(
  Object.entries(TEST_TEAM_SCOPE).map(([org, set]) => [org, [...set]]),
);

function hashInt(s: string, salt: number): number {
  const hex = s.replace(/[^0-9a-f]/gi, "");
  let h = salt >>> 0;
  for (let i = 0; i < hex.length; i++) h = (h * 31 + parseInt(hex[i], 16)) >>> 0;
  return h >>> 0;
}
const sortByHash = (a: string, b: string) => (hashInt(a, 1) - hashInt(b, 1)) || a.localeCompare(b);

type Assign = { team: string; part: string };

async function buildContext() {
  const testIds = [...(await fetchTestUserMarkerIds())].sort();
  const testSet = new Set(testIds);

  const { data: profs } = await supabaseAdmin
    .from("user_profiles").select("user_id,organization_slug").in("user_id", testIds);
  const orgByUser = new Map<string, string>();
  for (const p of (profs ?? []) as any[]) orgByUser.set(p.user_id, p.organization_slug);

  // 2026-H2 (T) 팀 카탈로그(파트) 로드 — 과거 반기에 그대로 복제.
  const { data: h2th } = await supabaseAdmin
    .from("cluster4_team_halves").select("id,organization_slug,team_name").eq("half_key", H2);
  const h2Id = new Map<string, string>();
  for (const r of (h2th ?? []) as any[]) if (/\(T\)/.test(r.team_name)) h2Id.set(`${r.organization_slug}/${r.team_name}`, r.id);
  const { data: h2parts } = await supabaseAdmin
    .from("cluster4_team_parts").select("team_half_id,part_name,is_default,display_order").in("team_half_id", [...h2Id.values()]);
  const catalog = new Map<string, Array<{ part_name: string; is_default: boolean; display_order: number }>>();
  const nonGeneral = new Map<string, string[]>();
  for (const [key, id] of h2Id) {
    const rows = ((h2parts ?? []) as any[]).filter((p) => p.team_half_id === id)
      .sort((a, b) => (a.display_order ?? 0) - (b.display_order ?? 0));
    catalog.set(key, rows.map((r) => ({ part_name: r.part_name, is_default: !!r.is_default, display_order: r.display_order ?? 0 })));
    nonGeneral.set(key, rows.filter((r) => !r.is_default && r.part_name !== "일반").map((r) => r.part_name));
  }

  // 결정론적 라운드로빈 배정.
  const assign = new Map<string, Assign>();
  const byOrg = new Map<string, string[]>();
  for (const uid of testIds) {
    const org = orgByUser.get(uid);
    if (org && TEAMS[org]) (byOrg.get(org) ?? byOrg.set(org, []).get(org)!).push(uid);
  }
  for (const [org, users] of byOrg) {
    const teams = TEAMS[org];
    const sorted = [...users].sort(sortByHash);
    const teamUsers = new Map<string, string[]>(teams.map((t) => [t, []]));
    sorted.forEach((uid, i) => teamUsers.get(teams[i % teams.length])!.push(uid));
    for (const [team, tus] of teamUsers) {
      const pool = nonGeneral.get(`${org}/${team}`);
      const parts = pool && pool.length ? pool : ["일반"];
      [...tus].sort(sortByHash).forEach((uid, j) => assign.set(uid, { team, part: parts[j % parts.length] }));
    }
  }

  return { testIds, testSet, orgByUser, catalog, assign };
}

async function loadWeeks() {
  const { data } = await supabaseAdmin
    .from("weeks").select("id,season_key,week_number,start_date").in("season_key", TARGET_SEASONS);
  const byKey = new Map<string, { id: string; week_number: number | null; start_date: string }>();
  for (const w of (data ?? []) as any[]) byKey.set(`${w.season_key}|${String(w.start_date).slice(0,10)}`, { id: w.id, week_number: w.week_number, start_date: String(w.start_date).slice(0,10) });
  return byKey;
}

async function pagedUws(testIds: string[]) {
  const all: Array<{ user_id: string; week_start_date: string; season_key: string }> = [];
  const CHUNK = 40;
  for (let i = 0; i < testIds.length; i += CHUNK) {
    const ids = testIds.slice(i, i + CHUNK);
    for (let from = 0; ; from += 1000) {
      const { data } = await supabaseAdmin.from("user_week_statuses")
        .select("user_id,week_start_date,season_key").in("user_id", ids).in("season_key", TARGET_SEASONS).range(from, from + 999);
      const batch = (data ?? []) as any[];
      all.push(...batch);
      if (batch.length < 1000) break;
    }
  }
  return all;
}

async function rollback() {
  console.log("=== ROLLBACK ===");
  const { data: th } = await supabaseAdmin
    .from("cluster4_team_halves").select("id").in("half_key", TARGET_HALVES).eq("description", TH_DESC);
  const ids = ((th ?? []) as any[]).map((r) => r.id);
  const { data: delUph } = await supabaseAdmin.from("user_position_histories").delete().eq("source", UPH_SOURCE).select("id");
  let delParts = 0;
  if (ids.length) {
    const { data: dp } = await supabaseAdmin.from("cluster4_team_parts").delete().in("team_half_id", ids).select("id");
    delParts = (dp ?? []).length;
  }
  const { data: delTh } = await supabaseAdmin.from("cluster4_team_halves").delete().in("half_key", TARGET_HALVES).eq("description", TH_DESC).select("id");
  console.log(`삭제: UPH ${(delUph ?? []).length} · team_parts ${delParts} · team_halves ${(delTh ?? []).length}`);
}

async function main() {
  const apply = process.argv.includes("--apply");
  if (process.argv.includes("--rollback")) { await rollback(); process.exit(0); }

  const { testIds, testSet, orgByUser, catalog, assign } = await buildContext();
  const weeks = await loadWeeks();
  const uws = await pagedUws(testIds);

  // 안전 가드: 대상 전원 test marker.
  const leak = [...assign.keys()].filter((id) => !testSet.has(id));
  if (leak.length) { console.log("❌ 비-테스트 유저 혼입 — 중단."); process.exit(1); }

  // ── 1) team_halves 계획 (9팀 × 2반기) ──
  const thPlan: Array<{ organization_slug: string; half_key: string; team_name: string; display_order: number }> = [];
  for (const org of Object.keys(TEAMS)) TEAMS[org].forEach((team, i) => {
    for (const half of TARGET_HALVES) thPlan.push({ organization_slug: org, half_key: half, team_name: team, display_order: i + 1 });
  });
  // 기존 존재분 제외(멱등).
  const { data: existTh } = await supabaseAdmin
    .from("cluster4_team_halves").select("id,organization_slug,half_key,team_name").in("half_key", TARGET_HALVES);
  const existThKey = new Set(((existTh ?? []) as any[]).map((r) => `${r.organization_slug}|${r.half_key}|${r.team_name}`));
  const thToInsert = thPlan.filter((r) => !existThKey.has(`${r.organization_slug}|${r.half_key}|${r.team_name}`));

  // ── 2) UPH 계획 (uws 주차마다 1행) ──
  const uphPlan: any[] = [];
  const seenUserWeek = new Set<string>();
  for (const r of uws) {
    const a = assign.get(r.user_id); if (!a) continue;
    const wk = weeks.get(`${r.season_key}|${String(r.week_start_date).slice(0,10)}`); if (!wk) continue;
    const uwk = `${r.user_id}|${wk.id}`;
    if (seenUserWeek.has(uwk)) continue; // 유저×주차 1행
    seenUserWeek.add(uwk);
    uphPlan.push({
      user_id: r.user_id, organization: orgByUser.get(r.user_id), season_key: r.season_key,
      week_id: wk.id, week_number: wk.week_number, week_start_date: wk.start_date,
      position_code: "regular", source: UPH_SOURCE, source_system: "qa_seed",
      raw_level: "일반", raw_team: a.team, raw_part: a.part,
    });
  }

  // 기존 시드 UPH(user,week_id) — 멱등 net 계산에 사용(미리보기·적용 공통).
  //   ⚠ PostgREST 1000행 cap 회피 위해 반드시 페이지네이션(시드 1634>1000).
  const existUphKey = new Set<string>();
  for (let from = 0; ; from += 1000) {
    const { data, error } = await supabaseAdmin
      .from("user_position_histories").select("user_id,week_id").eq("source", UPH_SOURCE).range(from, from + 999);
    if (error) { console.log(`❌ 기존 UPH 조회 실패: ${error.message}`); process.exit(1); }
    const batch = (data ?? []) as any[];
    for (const r of batch) existUphKey.add(`${r.user_id}|${r.week_id}`);
    if (batch.length < 1000) break;
  }
  const uphInsert = uphPlan.filter((r) => !existUphKey.has(`${r.user_id}|${r.week_id}`));

  // ── 리포트 ──
  const thByHalfOrg: Record<string, number> = {};
  for (const r of thToInsert) thByHalfOrg[`${r.half_key}|${r.organization_slug}`] = (thByHalfOrg[`${r.half_key}|${r.organization_slug}`] || 0) + 1;
  const uphByHalfOrg: Record<string, number> = {};
  for (const r of uphInsert) { const half = seasonKeyToHalfKey(r.season_key); uphByHalfOrg[`${half}|${r.organization}`] = (uphByHalfOrg[`${half}|${r.organization}`] || 0) + 1; }
  console.log(`test users=${testIds.length} | uws(target)=${uws.length}`);
  console.log(`team_halves 삽입 예정=${thToInsert.length}/${thPlan.length} (기존 ${thPlan.length - thToInsert.length})`, thByHalfOrg);
  console.log(`UPH 삽입 예정=${uphInsert.length}/${uphPlan.length} (기존 시드 ${uphPlan.length - uphInsert.length})`, uphByHalfOrg);

  if (!apply) { console.log("\n(미리보기 — 적용하려면 --apply)"); process.exit(0); }

  // ── APPLY ──
  // 1) team_halves insert
  if (thToInsert.length) {
    const { error } = await supabaseAdmin.from("cluster4_team_halves").insert(
      thToInsert.map((r) => ({ ...r, is_active: true, team_id: null, description: TH_DESC, leader_user_id: null, leader_crew_code: null, leader_name: null })),
    );
    if (error) { console.log(`❌ team_halves insert 실패: ${error.message}`); process.exit(1); }
  }
  // 2) team_parts (카탈로그 복제, onConflict ignore)
  const { data: seededTh } = await supabaseAdmin
    .from("cluster4_team_halves").select("id,organization_slug,half_key,team_name").in("half_key", TARGET_HALVES).eq("description", TH_DESC);
  const tpRows: any[] = [];
  for (const th of (seededTh ?? []) as any[]) {
    const cat = catalog.get(`${th.organization_slug}/${th.team_name}`) ?? [{ part_name: "일반", is_default: true, display_order: 0 }];
    for (const p of cat) tpRows.push({ team_half_id: th.id, part_name: p.part_name, is_default: p.is_default, display_order: p.display_order, leader_user_id: null });
  }
  if (tpRows.length) {
    const { error } = await supabaseAdmin.from("cluster4_team_parts").upsert(tpRows, { onConflict: "team_half_id,part_name", ignoreDuplicates: true });
    if (error) { console.log(`❌ team_parts upsert 실패: ${error.message}`); process.exit(1); }
  }
  // 3) UPH — (user,week_id) 기존 시드분 제외(위에서 계산한 uphInsert) 후 chunk insert.
  let inserted = 0;
  for (let i = 0; i < uphInsert.length; i += 500) {
    const chunk = uphInsert.slice(i, i + 500);
    const { error } = await supabaseAdmin.from("user_position_histories").insert(chunk);
    if (error) { console.log(`❌ UPH insert 실패(@${i}): ${error.message}`); process.exit(1); }
    inserted += chunk.length;
  }
  console.log(`✅ 적용 완료: team_halves +${thToInsert.length} · team_parts(upsert) ${tpRows.length} · UPH +${inserted} (기존 시드 ${uphPlan.length - uphInsert.length} 건너뜀)`);
  process.exit(0);
}
main().catch((e) => { console.error(e); process.exit(1); });
