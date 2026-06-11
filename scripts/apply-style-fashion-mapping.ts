// ===================================================================
// 팀 매핑 정정 — 이창훈 패션 → 스타일 (운영 정책: 패션팀 = 스타일팀).
//   기본 = DRY-RUN. 실제 반영은 `--apply`.
//
// 단순 role 백필이 아니라 멤버십 팀 매핑 정정. 처리:
//   1) T강서현(TEST) role='team_leader' → NULL  (제약 슬롯 회수 — 운영 판단에선 무시되는 테스트 계정)
//   2) 이창훈 user_memberships(현재행) team_name '패션' → '스타일'
//      → 트리거 user_memberships_sync_current 가 user_profiles.current_team_name 을 자동 '스타일' 동기화
//   3) 이창훈 role='team_leader' 유지 (변경 안 함)
//   ※ 순서 필수: T강서현 회수 먼저(스타일 슬롯 비움) → 이창훈 이동(uniq_team_leader_per_team 충돌 회피).
//
// 안전: 가드(이창훈=운영·role=team_leader·패션 / T강서현=테스트·role=team_leader). 반영 후 2명 snapshot stale(lazy).
//   강제 재계산 없음. snapshot 생성/조회 로직 무변경.
// ===================================================================
import { readFileSync } from "node:fs";
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { markWeeklyCardsSnapshotStaleMany } from "@/lib/cluster4WeeklyCardsSnapshot";

const APPLY = process.argv.includes("--apply");
const env = readFileSync(".env.local", "utf8");
const G = (k: string) => env.match(new RegExp(`^${k}=(.+)$`, "m"))?.[1]?.trim();
const sbUrl = G("NEXT_PUBLIC_SUPABASE_URL")!; const sbKey = G("SUPABASE_SERVICE_ROLE_KEY")!;
const SH = { apikey: sbKey, Authorization: `Bearer ${sbKey}` };
async function sbAll(p: string){const A:any[]=[];for(let f=0;;f+=1000){const s=p.includes("?")?"&":"?";const r=await fetch(`${sbUrl}/rest/v1/${p}${s}limit=1000&offset=${f}`,{headers:SH});const j=await r.json();A.push(...j);if(j.length<1000)break;}return A;}

const LEE = "3db9012c-b339-4550-900c-873df9463514";   // 이창훈(운영)
const TKANG = "3330f4c3-5331-4632-bbe6-01a19017a089"; // T강서현(TEST)
const ORG = "oranke", FROM_TEAM = "패션", TO_TEAM = "스타일";

async function main() {
  console.log(`\n*** 팀 매핑 정정(이창훈 패션→스타일) — 모드: ${APPLY ? "APPLY" : "DRY-RUN"} ***\n`);

  const testSet = new Set((await sbAll("test_user_markers?select=user_id")).map((t) => t.user_id));
  const lee = (await sbAll(`user_profiles?select=user_id,display_name,role,organization_slug,current_team_name&user_id=eq.${LEE}`))[0];
  const tkang = (await sbAll(`user_profiles?select=user_id,display_name,role,organization_slug,current_team_name&user_id=eq.${TKANG}`))[0];
  const leeMems = await sbAll(`user_memberships?select=id,team_name,is_current,updated_at&user_id=eq.${LEE}&order=updated_at.desc`);
  const curRow = leeMems.find((m) => m.is_current) ?? leeMems[0];

  console.log("=================== [사전 점검 — 가드] ===================");
  const g1 = !testSet.has(LEE) && lee?.role === "team_leader" && lee?.organization_slug === ORG && curRow?.team_name === FROM_TEAM;
  const g2 = testSet.has(TKANG) && tkang?.role === "team_leader" && tkang?.current_team_name === TO_TEAM;
  console.log(`  이창훈: 운영=${!testSet.has(LEE)} role=${lee?.role} 멤버십team='${curRow?.team_name}' ${g1 ? "OK" : "✗"}`);
  console.log(`  T강서현: 테스트=${testSet.has(TKANG)} role=${tkang?.role} current_team_name='${tkang?.current_team_name}' ${g2 ? "OK" : "✗"}`);
  if (!g1 || !g2) { console.log("\n  ✗ 가드 불일치 — 중단."); return; }

  console.log("\n=================== [반영 계획] ===================");
  console.log(`  1) T강서현(TEST) role=team_leader → NULL  (스타일 제약 슬롯 회수)`);
  console.log(`  2) 이창훈 user_memberships(id=${curRow.id}) team_name '${FROM_TEAM}' → '${TO_TEAM}'`);
  console.log(`     → 트리거가 user_profiles.current_team_name '${FROM_TEAM}' → '${TO_TEAM}' 자동 동기화`);
  console.log(`  3) 이창훈 role=team_leader 유지`);
  console.log(`  snapshot stale 대상: 이창훈 + T강서현 = 2명 (강제 재계산 없음)`);

  if (!APPLY) {
    console.log("\n*** DRY-RUN 종료 — write 없음. 승인 후 `--apply`. ***");
    return;
  }

  console.log("\n=================== [APPLY — 순서: 회수 → 이동] ===================");
  // 1) T강서현 회수(슬롯 비움).
  const r1 = await supabaseAdmin.from("user_profiles").update({ role: null }).eq("user_id", TKANG).eq("role", "team_leader").select("user_id");
  if (r1.error) { console.log(`  ✗ T강서현 회수 실패: ${r1.error.message}`); return; }
  console.log(`  ✓ T강서현 role → null (${(r1.data ?? []).length}건)`);

  // 2) 이창훈 멤버십 team_name 변경 → 트리거가 profile.current_team_name 동기화.
  const r2 = await supabaseAdmin.from("user_memberships").update({ team_name: TO_TEAM }).eq("id", curRow.id).eq("team_name", FROM_TEAM).select("id");
  if (r2.error) { console.log(`  ✗ 이창훈 멤버십 이동 실패: ${r2.error.message}`); return; }
  console.log(`  ✓ 이창훈 멤버십 team_name '${FROM_TEAM}' → '${TO_TEAM}' (${(r2.data ?? []).length}건)`);

  // 검증.
  const leeAfter = (await sbAll(`user_profiles?select=display_name,role,current_team_name&user_id=eq.${LEE}`))[0];
  const tkangAfter = (await sbAll(`user_profiles?select=display_name,role,current_team_name&user_id=eq.${TKANG}`))[0];
  console.log("\n  변경 후:");
  console.log(`    이창훈: role=${leeAfter?.role} current_team_name='${leeAfter?.current_team_name}' (트리거 동기화 확인)`);
  console.log(`    T강서현: role=${tkangAfter?.role ?? "null"}`);

  // snapshot stale(강제 재계산 없음).
  const changed = [LEE, TKANG];
  const { count } = await supabaseAdmin.from("cluster4_weekly_card_snapshots").select("*", { count: "exact", head: true }).in("user_id", changed);
  console.log(`\n  snapshot 보유 변경자 행=${count ?? 0} → stale 표시(lazy 위임)`);
  await markWeeklyCardsSnapshotStaleMany(changed);
  console.log("  ✓ markWeeklyCardsSnapshotStaleMany 완료 (강제 재계산 없음)");
  console.log("\n*** APPLY 완료 ***");
}
main().catch((e) => { console.error(e); process.exit(1); });
