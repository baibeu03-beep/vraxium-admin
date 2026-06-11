// ===================================================================
// PMS 역할 백필 Phase 2 — 테스트 team_leader 슬롯 회수 + 운영진 팀장 배정.
//   기본 = DRY-RUN. 실제 반영은 `--apply`.
//
// 승인 범위(사용자 확정):
//   회수(테스트 role 'team_leader' → NULL, 테스트 계정만):
//     · oranke 커머스 : T윤민지
//     · oranke 콘텐츠 : T신현준
//     · encre  A&R    : T홍채원
//   배정(운영진 role NULL → 'team_leader'):
//     · oranke 커머스 : 김채은
//     · oranke 콘텐츠 : 전성은
//     · encre  A&R    : 이유진(encre, PMS#1490)
//   제외(건드리지 않음): 박윤슬·서유솔(A&R 미선정), 노서정·김세현(범위 외),
//                        이창훈(이미 team_leader=패션), T강서현(oranke 스타일 — 배정 후보 없음·보류).
//
// 안전장치: 회수=테스트마커 보유 + role='team_leader' 가드 / 배정=role IS NULL 가드.
//   회수 먼저 → 배정(uniq_team_leader_per_team 충돌 회피). 반영 후 6명 snapshot stale만(lazy).
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

const RECOVER = [
  { uid: "ea286f9d-fb5b-492e-a081-cd5c200a4455", name: "T윤민지", org: "oranke", team: "커머스" },
  { uid: "58a4c844-6fd2-4108-8d2d-51c701018a7b", name: "T신현준", org: "oranke", team: "콘텐츠" },
  { uid: "9e2f8097-b1ce-4920-9c67-af9989074cfd", name: "T홍채원", org: "encre", team: "A&R" },
];
const ASSIGN = [
  { uid: "ecaa1a4c-c72a-4ef5-9657-faa7414a241d", name: "김채은", org: "oranke", team: "커머스" },
  { uid: "e318c666-b5f4-4508-916b-a228995baf15", name: "전성은", org: "oranke", team: "콘텐츠" },
  { uid: "a7fa21b0-a44e-4569-acf1-0a630cc37450", name: "이유진", org: "encre", team: "A&R" },
];

async function main() {
  console.log(`\n*** PMS 역할 백필 Phase2 — 모드: ${APPLY ? "APPLY(실제 반영)" : "DRY-RUN(읽기 전용)"} ***\n`);

  const ids = [...RECOVER, ...ASSIGN].map((x) => x.uid);
  const profs = await sbAll(`user_profiles?select=user_id,display_name,role,organization_slug,current_team_name&user_id=in.(${ids.join(",")})`);
  const profByUid = new Map(profs.map((p) => [p.user_id, p]));
  const testSet = new Set((await sbAll("test_user_markers?select=user_id")).map((t) => t.user_id));

  // ── 사전 점검(가드) ──
  console.log("=================== [사전 점검] ===================");
  let abort = false;
  for (const r of RECOVER) {
    const p = profByUid.get(r.uid);
    const okTest = testSet.has(r.uid); const okRole = p?.role === "team_leader";
    console.log(`  회수 ${r.name} [${r.org}/${r.team}] test=${okTest} role=${p?.role ?? "?"} ${okTest && okRole ? "OK" : "✗ 가드불일치"}`);
    if (!okTest || !okRole) abort = true;
  }
  for (const a of ASSIGN) {
    const p = profByUid.get(a.uid);
    const notTest = !testSet.has(a.uid); const isNull = (p?.role ?? null) === null;
    console.log(`  배정 ${a.name} [${a.org}/${a.team}] test=${!notTest} role=${p?.role ?? "null"} ${notTest && isNull ? "OK" : "✗ 가드불일치"}`);
    if (!notTest || !isNull) abort = true;
  }
  if (abort) { console.log("\n  ✗ 가드 불일치 — 중단(데이터가 예상과 다름)."); return; }

  console.log("\n=================== [반영 계획] ===================");
  console.log("  회수(테스트→null):");
  for (const r of RECOVER) console.log(`    - [${r.org}/${r.team}] ${r.name} team_leader → null`);
  console.log("  배정(운영진 null→team_leader):");
  for (const a of ASSIGN) console.log(`    - [${a.org}/${a.team}] ${a.name} null → team_leader`);

  if (!APPLY) {
    console.log("\n*** DRY-RUN 종료 — write 없음. 실제 반영하려면 `--apply`. ***");
    return;
  }

  // ── APPLY: 회수 먼저(슬롯 비움) → 배정 ──
  console.log("\n=================== [APPLY] ===================");
  const changed: string[] = [];
  let recovered = 0, assigned = 0;
  for (const r of RECOVER) {
    const { data, error } = await supabaseAdmin.from("user_profiles").update({ role: null }).eq("user_id", r.uid).eq("role", "team_leader").select("user_id");
    if (error) { console.log(`  ✗ 회수 ${r.name}: ${error.message}`); continue; }
    if ((data ?? []).length === 1) { recovered++; changed.push(r.uid); console.log(`  ✓ 회수 ${r.name} (${r.team})`); }
    else console.log(`  - 회수 ${r.name} skip(이미 null)`);
  }
  for (const a of ASSIGN) {
    const { data, error } = await supabaseAdmin.from("user_profiles").update({ role: "team_leader" }).eq("user_id", a.uid).is("role", null).select("user_id");
    if (error) { console.log(`  ✗ 배정 ${a.name}: ${error.message}`); continue; }
    if ((data ?? []).length === 1) { assigned++; changed.push(a.uid); console.log(`  ✓ 배정 ${a.name} (${a.team}) → team_leader`); }
    else console.log(`  ✗ 배정 ${a.name} skip(role 비-null)`);
  }
  console.log(`\n  회수 ${recovered}건 · 배정 ${assigned}건 · 변경 총 ${changed.length}명`);

  // org별 검증.
  const after = await sbAll(`user_profiles?select=user_id,display_name,role,organization_slug&user_id=in.(${ids.join(",")})`);
  console.log("  변경 후 상태:");
  for (const p of after) console.log(`    [${p.organization_slug}] ${p.display_name} role=${p.role ?? "null"}`);

  // snapshot stale(강제 재계산 없음).
  const { count: snapRows } = await supabaseAdmin.from("cluster4_weekly_card_snapshots").select("*", { count: "exact", head: true }).in("user_id", changed.length ? changed : ["00000000-0000-0000-0000-000000000000"]);
  console.log(`\n  snapshot 보유 변경자 행=${snapRows ?? 0} → stale 표시(lazy 위임)`);
  await markWeeklyCardsSnapshotStaleMany(changed);
  console.log("  ✓ markWeeklyCardsSnapshotStaleMany 완료 (강제 재계산 없음)");
  console.log(`\n*** Phase2 APPLY 완료 — 회수 ${recovered} / 배정 ${assigned} ***`);
}
main().catch((e) => { console.error(e); process.exit(1); });
