// ===================================================================
// PMS usersinfo.TeamRole(파트장/에이전트) → Vraxium user_memberships.membership_level 보정.
//   기본 = DRY-RUN(읽기 전용). 실제 반영은 `--apply`.
//
// 매핑(심화 크루 내부 역할 구분):
//   TeamRole='파트장'   → membership_level='심화(파트장)'
//   TeamRole='에이전트' → membership_level='심화(에이전트)'
//
// 대상(승인 범위, 총 29명):
//   · PMS 최신 usersinfo TeamRole=파트장/에이전트 + (source_system, legacy_user_id) Vraxium 매칭
//   · 비테스트 · 졸업/활동정지 미이관 제외(=매칭된 현행 계정만) · is_current 멤버십 보유
//   · 현재 membership_level(trim)이 '심화*'(생 '심화' 등) → 하위유형 보정(refine, 27명)
//     또는 '일반' → PMS 기준 복구(tier-change, 박유진·최인영 2명, 운영 승인 완료)
//   · role=team_leader/ambassador/admin 등 운영진 role 보유자는 제외(conflict 방지)
//
// 안전장치:
//   · UPDATE 는 is_current=true 행 + 현재값(from) 정확 일치 가드 → 멱등·경합 방지.
//   · user_profiles.role 은 건드리지 않음. team_leader/ambassador 백필과 독립.
//   · 반영 후 대상자 weekly-card snapshot 을 stale 표시만(강제 재계산 없음 — lazy recompute 위임).
//   · 롤백 로그(before/after) 를 claudedocs JSON 으로 저장.
//
// 실행:
//   DRY-RUN : npx tsx --env-file=.env.local scripts/apply-pms-grade-membership-backfill.ts
//   APPLY   : npx tsx --env-file=.env.local scripts/apply-pms-grade-membership-backfill.ts --apply
// ===================================================================
import { readFileSync, writeFileSync } from "node:fs";
import mysql from "mysql2/promise";
import { type PmsSourceSystem } from "@/lib/pmsMigration";
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { markWeeklyCardsSnapshotStaleMany } from "@/lib/cluster4WeeklyCardsSnapshot";

const APPLY = process.argv.includes("--apply");

const env = readFileSync(".env.local", "utf8");
const G = (k: string) => env.match(new RegExp(`^${k}=(.+)$`, "m"))?.[1]?.trim();
const sbUrl = G("NEXT_PUBLIC_SUPABASE_URL")!;
const sbKey = G("SUPABASE_SERVICE_ROLE_KEY")!;
const SH = { apikey: sbKey, Authorization: `Bearer ${sbKey}` };
async function sbAll(p: string): Promise<any[]> {
  const A: any[] = [];
  for (let f = 0; ; f += 1000) {
    const s = p.includes("?") ? "&" : "?";
    const r = await fetch(`${sbUrl}/rest/v1/${p}${s}limit=1000&offset=${f}`, { headers: SH });
    if (!r.ok) throw new Error(`${p} ${r.status} ${await r.text()}`);
    const j = await r.json();
    A.push(...j);
    if (j.length < 1000) break;
  }
  return A;
}

const SOURCE_DB: Record<PmsSourceSystem, string> = { oranke: "oranke", hrdb: "hrdb", olympus: "olympus" };
const ORG_ORDER: Array<{ source: PmsSourceSystem; org: string }> = [
  { source: "oranke", org: "oranke" },
  { source: "hrdb", org: "encre" },
  { source: "olympus", org: "phalanx" },
];
const OPERATOR_ROLES = new Set(["team_leader", "ambassador", "admin", "super_admin"]);

type TargetLevel = "심화(파트장)" | "심화(에이전트)";
function targetLevel(teamRole: string | null): TargetLevel | null {
  const tr = (teamRole ?? "").trim();
  if (tr === "파트장") return "심화(파트장)";
  if (tr === "에이전트") return "심화(에이전트)";
  return null;
}

type Cand = {
  org: string; source: PmsSourceSystem; pmsUserId: number; name: string;
  team: string; part: string; pmsState: string; teamRole: string | null;
  target: TargetLevel; vid: string; vName: string | null;
  curRole: string | null; fromLevel: string; kind: "refine" | "tier-change";
};

async function main() {
  console.log(`\n*** PMS 등급(파트장/에이전트) → membership_level 보정 — 모드: ${APPLY ? "APPLY(실제 반영)" : "DRY-RUN(읽기 전용)"} ***\n`);

  const conn = await mysql.createConnection({
    host: G("MYSQL_HOST"), port: Number(G("MYSQL_PORT") ?? 3306),
    user: G("MYSQL_USER"), password: G("MYSQL_PASSWORD"), dateStrings: true,
    ssl: { rejectUnauthorized: false },
  });
  const q = async (s: string) => (await conn.query(s))[0] as any[];

  const vUsers = await sbAll("users?select=id,legacy_user_id,source_system");
  const vProfiles = await sbAll("user_profiles?select=user_id,display_name,role,organization_slug,growth_status");
  const testSet = new Set((await sbAll("test_user_markers?select=user_id")).map((t) => t.user_id));
  const profByUid = new Map(vProfiles.map((p) => [p.user_id, p]));
  const vidByKey = new Map<string, string>();
  for (const u of vUsers) {
    if (u.source_system == null || u.legacy_user_id == null) continue;
    vidByKey.set(`${u.source_system}::${Number(u.legacy_user_id)}`, u.id);
  }
  const allMems = await sbAll("user_memberships?select=user_id,membership_level,is_current");
  const memByUid = new Map<string, any>();
  for (const m of allMems) { const ex = memByUid.get(m.user_id); if (!ex || (m.is_current && !ex.is_current)) memByUid.set(m.user_id, m); }

  const cands: Cand[] = [];
  const skipped: Array<{ reason: string; org: string; pmsUserId: number; name: string; detail: string }> = [];

  for (const { source, org } of ORG_ORDER) {
    const db = SOURCE_DB[source];
    const ui = await q(`SELECT InfoID,UserID,Team,Part,State,UserRole,TeamRole FROM \`${db}\`.usersinfo`);
    const names = new Map<number, string>(
      (await q(`SELECT UserId,Name FROM \`${db}\`.users`)).map((r: any) => [r.UserId, (r.Name || "").trim()]),
    );
    const latest = new Map<number, any>();
    for (const r of ui) { const c = latest.get(r.UserID); if (!c || Number(r.InfoID) > Number(c.InfoID)) latest.set(r.UserID, r); }

    for (const [uid, r] of latest) {
      const target = targetLevel(r.TeamRole);
      if (!target) continue;
      const vid = vidByKey.get(`${source}::${uid}`);
      const name = names.get(uid) ?? "(?)";
      const pmsState = String(r.State ?? "").trim();
      if (!vid) { skipped.push({ reason: "unmatched(미이관)", org, pmsUserId: uid, name, detail: `State=${pmsState}` }); continue; }
      if (testSet.has(vid)) { skipped.push({ reason: "test", org, pmsUserId: uid, name, detail: "" }); continue; }
      const prof = profByUid.get(vid);
      const vGrowth = prof?.growth_status ?? null;
      if (pmsState === "졸업" || String(vGrowth) === "graduated") { skipped.push({ reason: "graduated", org, pmsUserId: uid, name, detail: `State=${pmsState} growth=${vGrowth}` }); continue; }
      const curRole = prof?.role ?? null;
      if (curRole && OPERATOR_ROLES.has(curRole)) { skipped.push({ reason: "conflict(운영진 role)", org, pmsUserId: uid, name, detail: `role=${curRole}` }); continue; }
      const mem = memByUid.get(vid);
      if (!mem) { skipped.push({ reason: "no-membership", org, pmsUserId: uid, name, detail: "" }); continue; }
      const fromLevel = String(mem.membership_level ?? "");
      const fromTrim = fromLevel.trim();
      if (fromTrim === target) { skipped.push({ reason: "already(동일)", org, pmsUserId: uid, name, detail: `level=${fromLevel}` }); continue; }

      let kind: "refine" | "tier-change";
      if (fromTrim.startsWith("심화")) kind = "refine";
      else if (fromTrim === "일반") kind = "tier-change"; // 박유진·최인영 — PMS 기준 복구(승인됨)
      else { skipped.push({ reason: "기타 level(비대상)", org, pmsUserId: uid, name, detail: `level=${fromLevel}` }); continue; }

      cands.push({
        org, source, pmsUserId: uid, name, team: r.Team, part: r.Part, pmsState, teamRole: r.TeamRole,
        target, vid, vName: prof?.display_name ?? null, curRole, fromLevel, kind,
      });
    }
  }
  await conn.end();

  // ── 계획 보고 ──
  const refine = cands.filter((c) => c.kind === "refine");
  const tier = cands.filter((c) => c.kind === "tier-change");
  console.log("=================== [반영 계획] ===================");
  for (const { org } of ORG_ORDER) {
    const o = cands.filter((c) => c.org === org);
    if (o.length === 0) continue;
    console.log(`  [${org}] 총 ${o.length}명 — 심화(파트장) ${o.filter((c) => c.target === "심화(파트장)").length} / 심화(에이전트) ${o.filter((c) => c.target === "심화(에이전트)").length} (refine ${o.filter((c) => c.kind === "refine").length} / tier-change ${o.filter((c) => c.kind === "tier-change").length})`);
  }
  console.log(`  ──────────────`);
  console.log(`  합계 = ${cands.length}명 (refine ${refine.length} / tier-change ${tier.length})`);
  console.log(`  심화(파트장) ${cands.filter((c) => c.target === "심화(파트장)").length} · 심화(에이전트) ${cands.filter((c) => c.target === "심화(에이전트)").length}`);

  console.log("\n  [tier-change(일반→심화) — PMS 기준 복구 승인 건]");
  for (const c of tier) console.log(`    [${c.org}] PMS#${c.pmsUserId} ${c.name} (${c.team}/${c.part}) TeamRole=${c.teamRole} | '${c.fromLevel}' → '${c.target}'`);

  console.log("\n  [전체 대상 명단]");
  for (const c of cands)
    console.log(`    [${c.org}] PMS#${c.pmsUserId} ${c.name} (${c.team}/${c.part}, State=${c.pmsState}) ${c.kind} | '${c.fromLevel}' → '${c.target}' uid=${c.vid}`);

  // 스킵 요약(카운트만).
  const skipByReason = new Map<string, number>();
  for (const s of skipped) skipByReason.set(s.reason, (skipByReason.get(s.reason) ?? 0) + 1);
  console.log("\n  [스킵 요약]");
  for (const [k, v] of [...skipByReason.entries()].sort((a, b) => b[1] - a[1])) console.log(`    ${k.padEnd(20)} : ${v}`);

  // 안전성 점검: tier-change 가 승인된 2명(박유진·최인영)인지 확인.
  const tierNames = tier.map((c) => c.name).sort().join(",");
  const EXPECTED_TIER = ["박유진", "최인영"].sort().join(",");
  if (tierNames !== EXPECTED_TIER)
    console.log(`\n  ⚠ 경고: tier-change 대상이 승인 명단(박유진·최인영)과 다릅니다 → 실제='${tierNames}'. 검토 필요!`);

  if (!APPLY) {
    console.log("\n*** DRY-RUN 종료 — write 없음. 실제 반영하려면 `--apply` 로 재실행하세요. ***");
    return;
  }

  // ── APPLY ──
  console.log("\n=================== [APPLY 실행] ===================");
  const ts = new Date().toISOString().replace(/[:.]/g, "-");
  const rollback: any[] = [];
  const appliedIds: string[] = [];
  let affected = 0;
  for (const c of cands) {
    const { data, error } = await supabaseAdmin
      .from("user_memberships")
      .update({ membership_level: c.target })
      .eq("user_id", c.vid)
      .eq("is_current", true)
      .eq("membership_level", c.fromLevel) // 현재값 정확 일치 가드(멱등·경합 방지)
      .select("user_id,membership_level");
    if (error) { console.log(`  ✗ ${c.name} UPDATE 실패: ${error.message}`); continue; }
    if ((data ?? []).length >= 1) {
      affected += data!.length;
      appliedIds.push(c.vid);
      rollback.push({ user_id: c.vid, name: c.name, org: c.org, pmsUserId: c.pmsUserId, from: c.fromLevel, to: c.target, kind: c.kind });
    } else {
      console.log(`  - ${c.name} 영향 0행(현재값 불일치 — 이미 변경됨?) skip`);
    }
  }
  console.log(`  UPDATE affected = ${affected}행 / 대상 ${cands.length}명`);

  // 롤백 로그 저장.
  const rbPath = `claudedocs/grade-membership-backfill-rollback-${ts}.json`;
  writeFileSync(rbPath, JSON.stringify({ ts, affected, rows: rollback }, null, 2), "utf8");
  console.log(`  롤백 로그 = ${rbPath}`);

  // snapshot stale 표시(강제 재계산 없음).
  const { count: snapRows } = await supabaseAdmin
    .from("cluster4_weekly_card_snapshots")
    .select("*", { count: "exact", head: true })
    .in("user_id", appliedIds.length ? appliedIds : ["00000000-0000-0000-0000-000000000000"]);
  console.log(`\n  snapshot 보유 대상자 행 = ${snapRows ?? 0}건 → stale 표시(lazy recompute 위임)`);
  await markWeeklyCardsSnapshotStaleMany(appliedIds);
  console.log("  ✓ markWeeklyCardsSnapshotStaleMany 완료 (강제 재계산 없음)");

  // 반영 후 분포(검증).
  console.log("\n  [반영 후 org별 심화(파트장/에이전트) 카운트]");
  for (const { org } of ORG_ORDER) {
    const orgProfs = vProfiles.filter((p) => p.organization_slug === org && !testSet.has(p.user_id));
    const ids = orgProfs.map((p) => p.user_id);
    const after = await sbAll(`user_memberships?select=user_id,membership_level,is_current&user_id=in.(${ids.map((x) => `"${x}"`).join(",") || '"x"'})`);
    const byUid = new Map<string, any>();
    for (const m of after) { const ex = byUid.get(m.user_id); if (!ex || (m.is_current && !ex.is_current)) byUid.set(m.user_id, m); }
    let pl = 0, ag = 0;
    for (const p of orgProfs) { const lv = String(byUid.get(p.user_id)?.membership_level ?? "").trim(); if (lv === "심화(파트장)") pl++; else if (lv === "심화(에이전트)") ag++; }
    console.log(`    ${org}: 심화(파트장) ${pl} / 심화(에이전트) ${ag}`);
  }

  console.log(`\n*** APPLY 완료 — ${affected}행 반영. 롤백: ${rbPath} ***`);
}

main().catch((e) => { console.error(e); process.exit(1); });
