import { createClient } from "@supabase/supabase-js";
import { config } from "dotenv";
import { resolve } from "path";

config({ path: resolve(__dirname, "..", ".env.local") });

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);

// ── Distribution rules (realistic, non-uniform) ──

interface Slot { team: string; part: string; count: number }

// ── 조직 라벨 교정(2026-06-01) ──
// 이전 버전은 encre↔oranke 라벨이 뒤바뀐 채로 정의되어, encre 유저에게 oranke 팀/파트가,
// oranke 유저에게 encre 팀/파트가 배정됐다. cluster4_teams 정규 마스터 기준으로 바로잡는다:
//   encre  = 갤러리 / 비주얼 / 팬마케팅 / 프로듀싱 / A&R
//   oranke = 스타일 / F&B / 콘텐츠 / 엔터테인먼트 / 커머스
const encreSlots: Slot[] = [
  { team: "갤러리",   part: "컬쳐",    count: 5 },
  { team: "갤러리",   part: "매거진",   count: 3 },
  { team: "갤러리",   part: "코믹스",   count: 2 },  // 갤러리 소계: 10
  { team: "팬마케팅",  part: "FanFlow", count: 5 },
  { team: "팬마케팅",  part: "FanLog",  count: 2 },  // 팬마케팅 소계: 7
  { team: "비주얼",   part: "일반",    count: 2 },  // 비주얼 소계: 2
  { team: "프로듀싱",  part: "이야기",   count: 4 },
  { team: "프로듀싱",  part: "소리",    count: 3 },
  { team: "프로듀싱",  part: "결",     count: 2 },  // 프로듀싱 소계: 9
  { team: "A&R",     part: "일반",    count: 2 },  // A&R 소계: 2
];

const orankeSlots: Slot[] = [
  { team: "스타일",     part: "패션",    count: 3 },
  { team: "스타일",     part: "뷰티",    count: 2 },  // 스타일 소계: 5
  { team: "F&B",       part: "릴스",    count: 3 },
  { team: "F&B",       part: "카드뉴스",  count: 3 },
  { team: "F&B",       part: "쇼츠",    count: 2 },  // F&B 소계: 8
  { team: "콘텐츠",     part: "코믹스",   count: 2 },  // 콘텐츠 소계: 2
  { team: "엔터테인먼트", part: "플랫폼",   count: 4 },
  { team: "엔터테인먼트", part: "팬마케팅",  count: 3 },
  { team: "엔터테인먼트", part: "컬쳐",    count: 3 },  // 엔터 소계: 10
  { team: "커머스",     part: "솔루션",   count: 3 },
  { team: "커머스",     part: "베네핏",   count: 2 },  // 커머스 소계: 5
];

const phalanxSlots: Slot[] = [
  { team: "IT",    part: "일반", count: 13 },
  { team: "서비스",  part: "일반", count: 11 },
  { team: "브랜딩",  part: "일반", count: 6 },
];

function shuffleDeterministic<T>(arr: T[], seed: number): T[] {
  const result = [...arr];
  let s = seed;
  for (let i = result.length - 1; i > 0; i--) {
    s = (s * 1103515245 + 12345) & 0x7fffffff;
    const j = s % (i + 1);
    [result[i], result[j]] = [result[j], result[i]];
  }
  return result;
}

interface UserInfo {
  user_id: string;
  display_name: string;
  auth_email: string;
  organization_slug: string;
  status: string;
  user_type: string;
}

function assignUsers(users: UserInfo[], slots: Slot[]): Array<UserInfo & { team: string; part: string }> {
  // Shuffle users so user_types are mixed across slots
  const shuffled = shuffleDeterministic(users, 42);

  const result: Array<UserInfo & { team: string; part: string }> = [];
  let idx = 0;
  for (const slot of slots) {
    for (let i = 0; i < slot.count; i++) {
      result.push({ ...shuffled[idx], team: slot.team, part: slot.part });
      idx++;
    }
  }
  return result;
}

function getMembershipLevel(userType: string): string {
  if (userType === "excellent" || userType === "near_graduation") return "심화";
  return "일반";
}

function getMembershipState(status: string): string {
  if (status === "weekly_rest") return "weekly_rest";
  if (status === "graduated") return "graduated";
  return "active";
}

async function main() {
  // Fetch B-group markers + profiles
  const { data: markers } = await supabase
    .from("test_user_markers")
    .select("user_id, seed_batch_id, user_type")
    .eq("seed_batch_id", "2026-05-26_seed_90users_v2");

  const bIds = (markers || []).map(m => m.user_id);
  const markerMap = new Map((markers || []).map(m => [m.user_id, m]));

  const { data: profiles } = await supabase
    .from("user_profiles")
    .select("user_id, display_name, auth_email, organization_slug, status")
    .in("user_id", bIds);

  const users: UserInfo[] = (profiles || []).map((p: any) => ({
    ...p,
    user_type: markerMap.get(p.user_id)?.user_type || "?",
  }));

  const byOrg = new Map<string, UserInfo[]>();
  for (const u of users) {
    if (!byOrg.has(u.organization_slug)) byOrg.set(u.organization_slug, []);
    byOrg.get(u.organization_slug)!.push(u);
  }

  // Verify slot totals
  const verify = (name: string, slots: Slot[]) => {
    const total = slots.reduce((s, sl) => s + sl.count, 0);
    console.log(`[${name}] slots total: ${total}, users: ${byOrg.get(name)?.length || 0}`);
  };
  verify("oranke", orankeSlots);
  verify("encre", encreSlots);
  verify("phalanx", phalanxSlots);

  // ── Distribution Tables ──
  console.log("\n" + "=".repeat(85));
  console.log("REVISED DISTRIBUTION TABLES");
  console.log("=".repeat(85));

  const printDistribTable = (orgName: string, slots: Slot[]) => {
    console.log(`\n[${orgName}]`);
    let lastTeam = "";
    let teamTotal = 0;
    const teamTotals: [string, number][] = [];

    for (let i = 0; i < slots.length; i++) {
      const s = slots[i];
      if (s.team !== lastTeam && lastTeam) {
        teamTotals.push([lastTeam, teamTotal]);
        teamTotal = 0;
      }
      lastTeam = s.team;
      teamTotal += s.count;
      console.log(`  ${s.team.padEnd(10)} → ${s.part.padEnd(10)} : ${s.count}명`);
    }
    teamTotals.push([lastTeam, teamTotal]);

    console.log(`  ${"─".repeat(35)}`);
    console.log(`  팀별 소계: ${teamTotals.map(([t, c]) => `${t}(${c})`).join(", ")}`);
    console.log(`  조직 합계: ${slots.reduce((s, sl) => s + sl.count, 0)}명`);
  };

  printDistribTable("oranke", orankeSlots);
  printDistribTable("encre", encreSlots);
  printDistribTable("phalanx", phalanxSlots);

  // ── Assign users ──
  const orankeAssign = assignUsers(byOrg.get("oranke") || [], orankeSlots);
  const encreAssign = assignUsers(byOrg.get("encre") || [], encreSlots);
  const phalanxAssign = assignUsers(byOrg.get("phalanx") || [], phalanxSlots);
  const allAssign = [...orankeAssign, ...encreAssign, ...phalanxAssign];

  // ── User Type Mix Verification ──
  console.log("\n" + "=".repeat(85));
  console.log("USER_TYPE MIX PER TEAM (셔플 검증)");
  console.log("=".repeat(85));

  const orgs = ["oranke", "encre", "phalanx"];
  const assigns = [orankeAssign, encreAssign, phalanxAssign];
  for (let oi = 0; oi < orgs.length; oi++) {
    console.log(`\n[${orgs[oi]}]`);
    const teamTypes = new Map<string, Map<string, number>>();
    for (const a of assigns[oi]) {
      if (!teamTypes.has(a.team)) teamTypes.set(a.team, new Map());
      const t = teamTypes.get(a.team)!;
      t.set(a.user_type, (t.get(a.user_type) || 0) + 1);
    }
    for (const [team, types] of [...teamTypes.entries()].sort()) {
      const typeStr = [...types.entries()].sort().map(([t, c]) => `${t}(${c})`).join(", ");
      console.log(`  ${team.padEnd(10)}: ${typeStr}`);
    }
  }

  // ── Full Assignment Preview ──
  console.log("\n" + "=".repeat(85));
  console.log("FULL ROW PREVIEW (90 rows to INSERT)");
  console.log("=".repeat(85));

  console.log(`\n${"#".padStart(3)} | ${"org".padEnd(8)} | ${"team".padEnd(10)} | ${"part".padEnd(10)} | ${"level".padEnd(5)} | ${"state".padEnd(12)} | ${"cur".padEnd(5)} | ${"user_type".padEnd(16)} | ${"name".padEnd(15)} | email`);
  console.log("─".repeat(130));

  for (let i = 0; i < allAssign.length; i++) {
    const a = allAssign[i];
    const level = getMembershipLevel(a.user_type);
    const state = getMembershipState(a.status);
    const isCurrent = state !== "graduated";
    console.log(
      `${(i + 1).toString().padStart(3)} | ${a.organization_slug.padEnd(8)} | ${a.team.padEnd(10)} | ${a.part.padEnd(10)} | ${level.padEnd(5)} | ${state.padEnd(12)} | ${isCurrent.toString().padEnd(5)} | ${a.user_type.padEnd(16)} | ${(a.display_name || "").padEnd(15)} | ${a.auth_email}`
    );
  }

  // ── Summary Stats ──
  console.log("\n" + "=".repeat(85));
  console.log("SUMMARY");
  console.log("=".repeat(85));
  console.log(`Total rows to insert: ${allAssign.length}`);
  console.log(`Unique user_ids: ${new Set(allAssign.map(a => a.user_id)).size}`);

  const levelDist = new Map<string, number>();
  const stateDist = new Map<string, number>();
  const currentDist = new Map<string, number>();
  for (const a of allAssign) {
    const level = getMembershipLevel(a.user_type);
    const state = getMembershipState(a.status);
    const cur = state !== "graduated" ? "true" : "false";
    levelDist.set(level, (levelDist.get(level) || 0) + 1);
    stateDist.set(state, (stateDist.get(state) || 0) + 1);
    currentDist.set(cur, (currentDist.get(cur) || 0) + 1);
  }
  console.log(`membership_level: ${[...levelDist.entries()].map(([k, v]) => `${k}(${v})`).join(", ")}`);
  console.log(`membership_state: ${[...stateDist.entries()].map(([k, v]) => `${k}(${v})`).join(", ")}`);
  console.log(`is_current: ${[...currentDist.entries()].map(([k, v]) => `${k}(${v})`).join(", ")}`);
  console.log(`Constraint conflicts expected: 0 (B-group has 0 existing memberships)`);
}

main().catch(console.error);
