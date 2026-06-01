import { createClient } from "@supabase/supabase-js";
import { config } from "dotenv";
import { resolve } from "path";

config({ path: resolve(__dirname, "..", ".env.local") });

// ─────────────────────────────────────────────────────────────────────
// 더미 테스터 part_name 교정 (encre ↔ oranke 뒤바뀜 보정).
//
//  - organization_slug (user_profiles) : 변경 안 함.
//  - team_name (user_memberships)       : 변경 안 함 (이미 정규 교정됨).
//  - part_name (user_memberships)       : 현재 팀에 맞는 canonical part 로 재배정.
//  - phalanx                            : 전 팀 '일반' → 변경 없음.
//
// 팀 내 분배는 legacy_user_id 순서로 가중 배열을 순환 인덱싱(SQL 버전과 동일 규칙):
//   db/fix_test_user_part_names.sql 와 1:1 동치.
// ─────────────────────────────────────────────────────────────────────

const APPLY = process.argv.includes("--apply"); // 기본은 dry-run

// (organization_slug, team_name) → 가중 part 배열. cardinality 모듈로 순환.
const PART_PLAN: Record<string, Record<string, string[]>> = {
  encre: {
    "갤러리": ["컬쳐", "컬쳐", "컬쳐", "매거진", "매거진", "코믹스"],
    "비주얼": ["일반"],
    "팬마케팅": ["FanFlow", "FanFlow", "FanFlow", "FanFlow", "FanLog", "FanLog"],
    "프로듀싱": ["이야기", "이야기", "이야기", "소리", "소리", "결"],
    "A&R": ["일반"],
  },
  oranke: {
    "스타일": ["패션", "패션", "패션", "패션", "뷰티", "뷰티"],
    "F&B": ["릴스", "릴스", "카드뉴스", "카드뉴스", "쇼츠", "쇼츠"],
    "콘텐츠": ["코믹스"],
    "엔터테인먼트": ["플랫폼", "플랫폼", "팬마케팅", "팬마케팅", "컬쳐", "컬쳐"],
    "커머스": ["솔루션", "솔루션", "솔루션", "솔루션", "베네핏", "베네핏"],
    "신입": ["일반"],
  },
};
// phalanx 는 의도적으로 제외 (이미 '일반' 으로 정상).

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
  { auth: { persistSession: false, autoRefreshToken: false } },
);

type Marker = { user_id: string; legacy_user_id: number | null };
type Profile = { user_id: string; organization_slug: string | null };
type Membership = {
  id: string;
  user_id: string;
  team_name: string | null;
  part_name: string | null;
  is_current: boolean | null;
};

async function selectAll<T>(table: string, select: string, filter: (q: any) => any): Promise<T[]> {
  const pageSize = 1000;
  const rows: T[] = [];
  for (let from = 0; ; from += pageSize) {
    const { data, error } = await filter(supabase.from(table).select(select)).range(from, from + pageSize - 1);
    if (error) throw new Error(`${table}: ${error.message}`);
    const batch = (data ?? []) as T[];
    rows.push(...batch);
    if (batch.length < pageSize) return rows;
  }
}

function printDistribution(label: string, rows: Array<{ org: string; team: string; part: string }>) {
  const dist = new Map<string, number>();
  for (const r of rows) {
    const key = `${r.org} | ${r.team} | ${r.part}`;
    dist.set(key, (dist.get(key) ?? 0) + 1);
  }
  console.log(`\n=== ${label}: organization_slug | team_name | part_name | count ===`);
  for (const [key, cnt] of [...dist.entries()].sort()) {
    console.log(`  ${key}  ::  ${cnt}`);
  }
}

async function main() {
  const markers = await selectAll<Marker>(
    "test_user_markers", "user_id,legacy_user_id", (q) => q,
  );
  const ids = markers.map((m) => m.user_id);
  const legacyByUser = new Map(markers.map((m) => [m.user_id, m.legacy_user_id]));

  const profiles = await selectAll<Profile>(
    "user_profiles", "user_id,organization_slug", (q) => q.in("user_id", ids),
  );
  const orgByUser = new Map(profiles.map((p) => [p.user_id, p.organization_slug]));

  const memberships = (await selectAll<Membership>(
    "user_memberships", "id,user_id,team_name,part_name,is_current", (q) => q.in("user_id", ids),
  )).filter((m) => m.is_current !== false);

  // 팀 단위로 legacy_user_id 순 정렬 → 가중 배열 순환 인덱싱.
  const groups = new Map<string, Membership[]>();
  for (const m of memberships) {
    const org = orgByUser.get(m.user_id) ?? "";
    const team = m.team_name ?? "";
    if (!PART_PLAN[org]?.[team]) continue; // phalanx / 미정의 팀 제외
    const key = `${org}|${team}`;
    (groups.get(key) ?? groups.set(key, []).get(key)!).push(m);
  }

  const beforeRows: Array<{ org: string; team: string; part: string }> = [];
  for (const m of memberships) {
    beforeRows.push({
      org: orgByUser.get(m.user_id) ?? "?",
      team: m.team_name ?? "null",
      part: m.part_name ?? "null",
    });
  }
  printDistribution("BEFORE", beforeRows);

  // 목표 part 계산.
  const updates: Array<{ membership: Membership; targetPart: string }> = [];
  for (const [key, members] of groups.entries()) {
    const [org, team] = key.split("|");
    const arr = PART_PLAN[org][team];
    members
      .sort((a, b) => {
        const la = legacyByUser.get(a.user_id) ?? Number.MAX_SAFE_INTEGER;
        const lb = legacyByUser.get(b.user_id) ?? Number.MAX_SAFE_INTEGER;
        return (la ?? 0) - (lb ?? 0) || a.id.localeCompare(b.id);
      })
      .forEach((m, idx) => {
        const targetPart = arr[idx % arr.length];
        if (m.part_name !== targetPart) updates.push({ membership: m, targetPart });
      });
  }

  console.log(`\nrows needing part_name change: ${updates.length}`);
  for (const u of updates.slice(0, 100)) {
    console.log(
      `  legacy=${legacyByUser.get(u.membership.user_id)} ${orgByUser.get(u.membership.user_id)} | ${u.membership.team_name} | ${u.membership.part_name} → ${u.targetPart}`,
    );
  }

  if (!APPLY) {
    console.log("\n[DRY-RUN] --apply 미지정 → DB 변경 없음. 적용하려면 `--apply` 옵션을 주세요.");
    return;
  }

  for (const u of updates) {
    const { error } = await supabase
      .from("user_memberships")
      .update({ part_name: u.targetPart })
      .eq("id", u.membership.id);
    if (error) throw new Error(`update ${u.membership.id} 실패: ${error.message}`);
  }
  console.log(`\n[APPLIED] ${updates.length} rows updated.`);

  // 적용 후 분포 재조회 + 검증.
  const after = (await selectAll<Membership>(
    "user_memberships", "id,user_id,team_name,part_name,is_current", (q) => q.in("user_id", ids),
  )).filter((m) => m.is_current !== false);

  const afterRows = after.map((m) => ({
    org: orgByUser.get(m.user_id) ?? "?",
    team: m.team_name ?? "null",
    part: m.part_name ?? "null",
  }));
  printDistribution("AFTER", afterRows);

  // 잔여 invalid 검증 (phalanx 의 '일반' 포함 전체 허용표).
  const ALLOWED: Record<string, Record<string, string[]>> = {
    ...PART_PLAN,
    phalanx: { "IT": ["일반"], "서비스": ["일반"], "브랜딩": ["일반"] },
  };
  let invalid = 0;
  for (const m of after) {
    const org = orgByUser.get(m.user_id) ?? "";
    const allowed = ALLOWED[org]?.[m.team_name ?? ""];
    if (allowed && !allowed.includes(m.part_name ?? "")) invalid++;
  }
  console.log(`\n=== VALIDITY AFTER: invalid part↔team = ${invalid} (기대: 0) ===`);
  if (invalid !== 0) process.exitCode = 1;
}

main().catch((e) => { console.error(e); process.exit(1); });
