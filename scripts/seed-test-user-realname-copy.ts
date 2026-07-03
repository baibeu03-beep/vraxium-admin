/**
 * 테스트 유저 이름을 "같은 조직 실사용자 이름 + 단일 T 접두"로 교체하는 seed/script.
 * ─────────────────────────────────────────────────────────────────────
 * 목적: 카페 댓글은 실사용자 실명이 들어온다. QA 모집단(test 유저)에서도 실제 댓글 데이터를
 *       매칭 테스트할 수 있도록, 조직별 테스트 유저의 display_name 을 같은 조직 실사용자
 *       이름으로 복사한 뒤 맨 앞에 T 를 붙인다(예: 실사용자 "김민지" → 테스트유저 "T김민지").
 *       매칭 라우트는 test 모집단에서 크루 이름의 단일 선두 T 를 벗겨 실명 댓글과 대조한다.
 *
 * 안전 규약(엄수):
 *   · 수정 대상 = public.test_user_markers 등재 유저만. 실사용자 row 는 절대 무접촉(읽기만).
 *     (다중 가드: 수정 후보를 marker 집합에서만 뽑고, 소스 실사용자 id 는 non-marker 강제,
 *      write 직전 전원 marker 재검증.)
 *   · 변경 컬럼 = user_profiles.display_name 하나뿐. row 복사/생성/삭제 없음.
 *   · 결과 이름은 항상 "T"+실명 → 실사용자(실명)와 절대 같은 이름이 되지 않는다(T prefix 유지).
 *   · 이미 T가 붙어 있어도 skip 하지 않고, 실사용자 이름 기준으로 다시 매핑한다.
 *   · 소스 실사용자 = 같은 조직 + "현재 시즌 활동중"(user_season_statuses status='active', 기본
 *     2026-summer) 만. rest/기타 상태·시즌 미참가자는 제외 → 실제 카페 댓글 모집단과 일치.
 *     가나다 앞글자 편중을 막기 위해 풀 전체에 균등 간격으로 결정적 선정. --season 으로 시즌 재정의.
 *   · --apply 시 백업 JSON(claudedocs/seed-test-user-realname-copy-backup.json) 기록 →
 *     --rollback 으로 정확히 그 값만 원복.
 *
 * 사용법:
 *   미리보기:  npx tsx --env-file=.env.local scripts/seed-test-user-realname-copy.ts
 *   특정 조직: ... --org=encre
 *   적용:      ... --apply
 *   롤백:      ... --rollback
 *   옵션:      --limit=N (조직별 상한, 기본 10)
 */
import { writeFileSync, readFileSync, existsSync, mkdirSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { fetchTestUserMarkerIds } from "@/lib/testUsers";
import { SUPER_ADMIN_ROLE } from "@/lib/superAdmins";

const BACKUP_PATH = resolve(process.cwd(), "claudedocs", "seed-test-user-realname-copy-backup.json");
const DEFAULT_ORGS = ["encre", "oranke", "phalanx"] as const;
// 소스 실사용자 = "현재 운영 시즌에 실제 활동 중"인 사람만(카페 댓글을 남길 모집단과 일치).
//   user_season_statuses(season_key, status='active'). --season 으로 재정의 가능.
const CURRENT_SEASON_DEFAULT = "2026-summer";

type BackupEntry = {
  org: string;
  test_user_id: string;
  before: string;
  after: string;
  source_real_name: string;
  source_real_user_id: string;
};

function argValue(flag: string): string | null {
  const hit = process.argv.find((a) => a.startsWith(`${flag}=`));
  return hit ? hit.slice(flag.length + 1) : null;
}
function readBackup(): BackupEntry[] {
  if (!existsSync(BACKUP_PATH)) return [];
  try { return JSON.parse(readFileSync(BACKUP_PATH, "utf8")) as BackupEntry[]; } catch { return []; }
}
function writeBackup(entries: BackupEntry[]): void {
  mkdirSync(dirname(BACKUP_PATH), { recursive: true });
  writeFileSync(BACKUP_PATH, JSON.stringify(entries, null, 2), "utf8");
}
const norm = (s: string | null | undefined) => (s ?? "").replace(/\s+/g, "").trim();

type ProfileRow = {
  user_id: string;
  display_name: string | null;
  organization_slug: string | null;
  growth_status: string | null;
  role: string | null;
};

async function loadOrgProfiles(org: string): Promise<ProfileRow[]> {
  const rows: ProfileRow[] = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await supabaseAdmin
      .from("user_profiles")
      .select("user_id,display_name,organization_slug,growth_status,role")
      .eq("organization_slug", org)
      .order("user_id")
      .range(from, from + 999);
    if (error) throw new Error(error.message);
    const batch = (data ?? []) as ProfileRow[];
    rows.push(...batch);
    if (batch.length < 1000) break;
  }
  return rows;
}

// 조직의 "현재 시즌 활동중(active)" 실사용자 id — 카페 댓글 모집단과 일치하는 소스 집합.
async function loadSeasonActiveIds(userIds: string[], season: string): Promise<Set<string>> {
  const set = new Set<string>();
  for (let i = 0; i < userIds.length; i += 500) {
    const slice = userIds.slice(i, i + 500);
    const { data } = await supabaseAdmin
      .from("user_season_statuses")
      .select("user_id,status")
      .eq("season_key", season)
      .eq("status", "active")
      .in("user_id", slice);
    for (const m of (data ?? []) as { user_id: string }[]) set.add(m.user_id);
  }
  return set;
}

async function buildPlanForOrg(
  org: string,
  markerSet: Set<string>,
  limit: number,
  season: string,
): Promise<{ plan: BackupEntry[]; testCount: number; realPool: number }> {
  const profiles = await loadOrgProfiles(org);
  const testUsers = profiles
    .filter((p) => markerSet.has(p.user_id) && p.role !== SUPER_ADMIN_ROLE)
    .sort((a, b) => a.user_id.localeCompare(b.user_id))
    .slice(0, limit);

  const realBase = profiles.filter(
    (p) =>
      !markerSet.has(p.user_id) &&
      p.role !== SUPER_ADMIN_ROLE &&
      norm(p.display_name).length > 0 &&
      !(p.display_name ?? "").trim().startsWith("T"),
  );
  // 소스 = 현재 시즌 실제 활동중(active)인 실사용자만. rest/기타 상태·시즌 미참가자는 제외.
  const activeIds = await loadSeasonActiveIds(realBase.map((p) => p.user_id), season);
  const realActive = realBase.filter((p) => activeIds.has(p.user_id));

  // 이름 가나다 정렬 후 중복 제거(테스트 유저가 서로 다른 실명 — 동명이인 자동확정 방지).
  const seenName = new Set<string>();
  const pool: { name: string; userId: string }[] = [];
  for (const p of [...realActive].sort(
    (a, b) =>
      (a.display_name ?? "").localeCompare(b.display_name ?? "", "ko") ||
      a.user_id.localeCompare(b.user_id),
  )) {
    const nm = (p.display_name ?? "").trim();
    const key = norm(nm);
    if (seenName.has(key)) continue;
    seenName.add(key);
    pool.push({ name: nm, userId: p.user_id });
  }
  // 가나다 앞글자 편중 완화 — 풀이 limit 보다 크면 전체에 걸쳐 균등 간격으로 선정(결정적).
  const realNames: { name: string; userId: string }[] = [];
  if (pool.length <= limit) {
    realNames.push(...pool);
  } else {
    for (let i = 0; i < limit; i++) realNames.push(pool[Math.floor((i * pool.length) / limit)]);
  }

  const count = Math.min(testUsers.length, realNames.length);
  const plan: BackupEntry[] = [];
  for (let i = 0; i < count; i++) {
    const t = testUsers[i];
    const r = realNames[i];
    plan.push({
      org,
      test_user_id: t.user_id,
      before: (t.display_name ?? "").trim(),
      after: `T${r.name}`,
      source_real_name: r.name,
      source_real_user_id: r.userId,
    });
  }
  return { plan, testCount: testUsers.length, realPool: pool.length };
}

async function main() {
  const apply = process.argv.includes("--apply");
  const rollback = process.argv.includes("--rollback");
  const orgFilter = argValue("--org");
  const limit = Number(argValue("--limit") ?? "10");
  const season = argValue("--season") ?? CURRENT_SEASON_DEFAULT;
  const orgs = orgFilter ? [orgFilter] : [...DEFAULT_ORGS];

  const markerSet = await fetchTestUserMarkerIds();
  console.log(`test_user_markers 총: ${markerSet.size}`);
  if (markerSet.size === 0) { console.log("❌ marker 비어있음 — 중단."); process.exit(2); }

  // ── ROLLBACK ──
  if (rollback) {
    const backup = readBackup();
    if (backup.length === 0) { console.log("백업 없음 — 원복 대상 없음."); process.exit(0); }
    const ids = backup.map((b) => b.test_user_id);
    const { data } = await supabaseAdmin
      .from("user_profiles").select("user_id,display_name").in("user_id", ids);
    const cur = new Map(((data ?? []) as { user_id: string; display_name: string | null }[])
      .map((r) => [r.user_id, r.display_name ?? ""]));
    let restored = 0, skipped = 0; const remaining: BackupEntry[] = [];
    for (const b of backup) {
      if (!markerSet.has(b.test_user_id) || cur.get(b.test_user_id) !== b.after) {
        skipped++; remaining.push(b); continue;
      }
      const { error } = await supabaseAdmin
        .from("user_profiles").update({ display_name: b.before }).eq("user_id", b.test_user_id);
      if (error) { console.log(`  ✗ ${b.test_user_id}: ${error.message}`); remaining.push(b); continue; }
      console.log(`  ↩ [${b.org}] "${b.after}" → "${b.before}"`);
      restored++;
    }
    writeBackup(remaining);
    console.log(`✅ 롤백: 원복 ${restored} / 건너뜀 ${skipped} (백업 잔여 ${remaining.length})`);
    process.exit(0);
  }

  // ── SEED (preview / apply) ──
  console.log(`소스 실사용자 기준: ${season} 시즌 활동중(active)`);
  const allPlan: BackupEntry[] = [];
  for (const org of orgs) {
    const { plan, testCount, realPool } = await buildPlanForOrg(org, markerSet, limit, season);
    console.log(`\n[${org}] 테스트유저 ${testCount}명 · ${season} active 실명풀 ${realPool}개 · 매핑 ${plan.length}건`);
    console.log("  org | test_user_id | 변경 전 → 변경 후 | (복사한 실사용자 이름 / 실사용자 id)");
    for (const p of plan) {
      console.log(
        `  ${p.org} | ${p.test_user_id} | "${p.before}" → "${p.after}" | (실명 "${p.source_real_name}" / ${p.source_real_user_id})`,
      );
    }
    allPlan.push(...plan);
  }

  // 최종 가드: 테스트 대상 전원 marker, 소스 실사용자 전원 non-marker.
  const badTest = allPlan.filter((p) => !markerSet.has(p.test_user_id));
  const badReal = allPlan.filter((p) => markerSet.has(p.source_real_user_id));
  const noPrefix = allPlan.filter((p) => !p.after.startsWith("T") || p.after === p.source_real_name);
  if (badTest.length || badReal.length || noPrefix.length) {
    console.log(`❌ [GUARD] test비marker=${badTest.length} 소스marker혼입=${badReal.length} T접두누락=${noPrefix.length} — 중단.`);
    process.exit(1);
  }

  console.log(`\n총 변경 계획: ${allPlan.length}건`);
  if (!apply) { console.log("(미리보기 — 적용 --apply, 원복 --rollback)"); process.exit(0); }
  if (allPlan.length === 0) { console.log("변경 대상 0 — 종료."); process.exit(0); }

  let ok = 0;
  for (const p of allPlan) {
    if (!markerSet.has(p.test_user_id)) { console.log(`  ✗ SKIP 비-marker ${p.test_user_id}`); continue; }
    const { error } = await supabaseAdmin
      .from("user_profiles").update({ display_name: p.after }).eq("user_id", p.test_user_id);
    if (error) { console.log(`  ✗ ${p.test_user_id}: ${error.message}`); continue; }
    console.log(`  ✓ [${p.org}] "${p.before}" → "${p.after}"`);
    ok++;
  }
  writeBackup(allPlan);
  console.log(`\n✅ 적용 ${ok}/${allPlan.length}건 → 백업: ${BACKUP_PATH}`);
  process.exit(0);
}
main().catch((e) => { console.error(e); process.exit(1); });
