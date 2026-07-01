/**
 * READ-ONLY QA 진단: QA_FIXED_TEST_ONLY=true 상태에서 어드민 화면이 비는 원인을
 * 데이터 테이블별 테스트 유저(test_user_markers) 커버리지로 정량화한다.
 * 정책/데이터 무변경. 단순 SELECT count 만 수행.
 *
 *   npx tsx --env-file=.env.local scripts/diag-qa-test-data-coverage.ts
 */
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { fetchTestUserMarkerIds } from "@/lib/testUsers";
import { resolveCurrentSeasonKey } from "@/lib/currentSeasonRest";
import { getCurrentActivityDateIso } from "@/lib/seasonCalendar";

type Row = Record<string, unknown>;

function chunk<T>(arr: T[], n: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n));
  return out;
}

// 테이블에서 ids(컬럼=col) 중 행이 있는 distinct user 수 + 총 행 수. 1000개씩 .in() 분할.
async function coverage(
  table: string,
  col: string,
  ids: string[],
  extra?: (q: any) => any,
): Promise<{ users: number; rows: number; err?: string }> {
  const users = new Set<string>();
  let rows = 0;
  for (const part of chunk(ids, 800)) {
    let q = supabaseAdmin.from(table).select(`${col}`, { count: "exact" }).in(col, part);
    if (extra) q = extra(q);
    const { data, error, count } = await q;
    if (error) return { users: users.size, rows, err: error.message };
    for (const r of (data ?? []) as Row[]) {
      const v = r[col];
      if (typeof v === "string") users.add(v);
    }
    rows += count ?? (data?.length ?? 0);
  }
  return { users: users.size, rows };
}

async function safeCount(label: string, fn: () => Promise<{ count: number | null; error: any }>) {
  try {
    const { count, error } = await fn();
    if (error) return `${label}: ERR ${error.message}`;
    return `${label}: ${count ?? 0}`;
  } catch (e) {
    return `${label}: EXC ${(e as Error).message}`;
  }
}

async function main() {
  const today = getCurrentActivityDateIso();
  const testIds = [...(await fetchTestUserMarkerIds())];
  console.log("════════════════════════════════════════════════════════");
  console.log(`오늘(활동일 기준): ${today}`);
  console.log(`test_user_markers 총 인원: ${testIds.length}`);
  if (testIds.length === 0) {
    console.log("❌ 테스트 유저 0명 — 모든 스코프-게이트 화면이 빈다.");
    process.exit(0);
  }

  // 현재 시즌 / 최근 주차
  const seasonKey = await resolveCurrentSeasonKey(today);
  console.log(`현재 시즌 season_key(오늘 포함 주차): ${seasonKey ?? "(없음 - 시즌 갭/전환)"}`);

  // 최근 주차들(현재 시즌)
  let weekRows: Array<{ id: string; week_number: number; start_date: string; end_date: string; season_key: string }>= [];
  {
    const { data } = await supabaseAdmin
      .from("weeks")
      .select("id,week_number,start_date,end_date,season_key")
      .order("start_date", { ascending: false })
      .limit(8);
    weekRows = (data ?? []) as any[];
  }
  console.log("\n최근 주차 8개:");
  for (const w of weekRows)
    console.log(`  ${w.season_key} W${w.week_number}  ${w.start_date}~${w.end_date}  id=${w.id}`);
  const currentWeek = weekRows.find((w) => w.start_date <= today && today <= w.end_date) ?? null;
  console.log(`오늘 포함 주차: ${currentWeek ? `${currentWeek.season_key} W${currentWeek.week_number} (${currentWeek.id})` : "(없음)"}`);
  const seasonWeekIds = weekRows.filter((w) => seasonKey && w.season_key === seasonKey).map((w) => w.id);

  // ── org 분포(테스트 유저) ──
  console.log("\n── 1) user_profiles 테스트 유저 org 분포 ──");
  {
    const orgDist: Record<string, number> = {};
    const roleDist: Record<string, number> = {};
    for (const part of chunk(testIds, 800)) {
      const { data } = await supabaseAdmin
        .from("user_profiles")
        .select("user_id,organization_slug,role,status,growth_status")
        .in("user_id", part);
      for (const r of (data ?? []) as Row[]) {
        const org = (r.organization_slug as string) ?? "(null)";
        orgDist[org] = (orgDist[org] || 0) + 1;
        const role = (r.role as string) ?? "(null)";
        roleDist[role] = (roleDist[role] || 0) + 1;
      }
    }
    console.log("  org:", JSON.stringify(orgDist));
    console.log("  role:", JSON.stringify(roleDist));
  }

  // ── 멤버십(팀/파트) ──
  console.log("\n── 2) user_memberships (팀/파트 배정) ──");
  {
    const cur = await coverage("user_memberships", "user_id", testIds, (q) => q.eq("is_current", true));
    console.log(`  is_current=true 보유 테스트 유저: ${cur.users} / ${testIds.length}  (행 ${cur.rows})${cur.err ? "  ERR " + cur.err : ""}`);
    const any = await coverage("user_memberships", "user_id", testIds);
    console.log(`  membership 행(아무거나) 보유: ${any.users} / ${testIds.length}${any.err ? "  ERR " + any.err : ""}`);
  }

  // ── 시즌 참여(현재 시즌) ──
  console.log("\n── 3) user_season_statuses (시즌 참여) ──");
  {
    if (seasonKey) {
      const cur = await coverage("user_season_statuses", "user_id", testIds, (q) => q.eq("season_key", seasonKey));
      console.log(`  현재 시즌(${seasonKey}) 참여 테스트 유저: ${cur.users} / ${testIds.length}${cur.err ? "  ERR " + cur.err : ""}`);
      // 상태 분포
      const dist: Record<string, number> = {};
      for (const part of chunk(testIds, 800)) {
        const { data } = await supabaseAdmin
          .from("user_season_statuses").select("user_id,status,note").eq("season_key", seasonKey).in("user_id", part);
        for (const r of (data ?? []) as Row[]) {
          const s = (r.status as string) ?? "(null)";
          dist[s] = (dist[s] || 0) + 1;
        }
      }
      console.log(`  상태 분포: ${JSON.stringify(dist)}`);
    } else {
      console.log("  현재 시즌 키 없음 — 스킵");
    }
    const anySeason = await coverage("user_season_statuses", "user_id", testIds);
    console.log(`  아무 시즌이나 참여 행 보유: ${anySeason.users} / ${testIds.length}`);
  }

  // ── 주차 활동(uws / uwp) ──
  console.log("\n── 4) 주차 활동 (user_week_statuses / user_weekly_points) ──");
  {
    // uws/uwp 키: season_key(uws) / week_start_date(uwp, season_key 컬럼 없음).
    const summerStarts = weekRows.filter((w) => seasonKey && w.season_key === seasonKey).map((w) => w.start_date);
    if (seasonKey) {
      const uwsCur = await coverage("user_week_statuses", "user_id", testIds, (q) => q.eq("season_key", seasonKey));
      console.log(`  user_week_statuses (현재 시즌 ${seasonKey}) 보유: ${uwsCur.users} / ${testIds.length}  (행 ${uwsCur.rows})${uwsCur.err ? "  ERR " + uwsCur.err : ""}`);
    }
    const uws = await coverage("user_week_statuses", "user_id", testIds);
    console.log(`  user_week_statuses (아무 주차나) 보유: ${uws.users} / ${testIds.length}  (행 ${uws.rows})${uws.err ? "  ERR " + uws.err : ""}`);
    if (summerStarts.length > 0) {
      const uwp = await coverage("user_weekly_points", "user_id", testIds, (q) => q.in("week_start_date", summerStarts));
      console.log(`  user_weekly_points (현재 시즌 주차) 보유: ${uwp.users} / ${testIds.length}  (행 ${uwp.rows})${uwp.err ? "  ERR " + uwp.err : ""}`);
    }
    const uwpAny = await coverage("user_weekly_points", "user_id", testIds);
    console.log(`  user_weekly_points (아무 주차나) 보유: ${uwpAny.users} / ${testIds.length}  (행 ${uwpAny.rows})${uwpAny.err ? "  ERR " + uwpAny.err : ""}`);
  }

  // ── cluster4 라인 (개설된 라인의 target 이 테스트 유저) ──
  console.log("\n── 5) cluster4_line_targets (개설 라인의 대상자=테스트 유저) ──");
  {
    // 테스트 유저가 target 인 라인 target 행 — part_type 별로 집계
    const byPart: Record<string, { lines: Set<string>; users: Set<string>; weeks: Set<string> }> = {};
    for (const part of chunk(testIds, 600)) {
      const { data, error } = await supabaseAdmin
        .from("cluster4_line_targets")
        .select("line_id,target_user_id,week_id,target_mode,cluster4_lines!inner(part_type,is_active)")
        .eq("target_mode", "user")
        .eq("cluster4_lines.is_active", true)
        .in("target_user_id", part);
      if (error) { console.log("  ERR", error.message); break; }
      for (const r of (data ?? []) as any[]) {
        const pt = r.cluster4_lines?.part_type ?? "(null)";
        byPart[pt] ??= { lines: new Set(), users: new Set(), weeks: new Set() };
        byPart[pt].lines.add(r.line_id);
        if (r.target_user_id) byPart[pt].users.add(r.target_user_id);
        if (r.week_id) byPart[pt].weeks.add(r.week_id);
      }
    }
    if (Object.keys(byPart).length === 0) {
      console.log("  ❌ 테스트 유저가 대상자인 활성 라인 0건 (전 part_type)");
    } else {
      for (const [pt, v] of Object.entries(byPart)) {
        console.log(`  part_type=${pt}: 활성 라인 ${v.lines.size}개 · 대상 테스트유저 ${v.users.size}명 · 주차 ${v.weeks.size}개`);
      }
    }
    // 현재 주차에 테스트 유저 대상 라인 있는지
    if (currentWeek) {
      const { data } = await supabaseAdmin
        .from("cluster4_line_targets")
        .select("line_id,cluster4_lines!inner(part_type,is_active)")
        .eq("target_mode", "user").eq("week_id", currentWeek.id).eq("cluster4_lines.is_active", true)
        .in("target_user_id", testIds.slice(0, 800));
      const ptset: Record<string, number> = {};
      for (const r of (data ?? []) as any[]) {
        const pt = r.cluster4_lines?.part_type ?? "(null)";
        ptset[pt] = (ptset[pt] || 0) + 1;
      }
      console.log(`  현재 주차(${currentWeek.season_key} W${currentWeek.week_number}) 테스트유저 대상 라인(첫 800명 한정): ${JSON.stringify(ptset)}`);
    }
  }

  // ── cluster4_line_submissions (테스트 유저 제출) ──
  console.log("\n── 6) cluster4_line_submissions / snapshots ──");
  {
    // submissions: user_id 컬럼 추정 — 실패시 표시
    const sub = await coverage("cluster4_line_submissions", "user_id", testIds.slice(0, 800));
    console.log(`  cluster4_line_submissions 보유(첫 800명): ${sub.users}명 (행 ${sub.rows})${sub.err ? "  ERR " + sub.err : ""}`);
    const snap = await coverage("cluster4_weekly_card_snapshots", "user_id", testIds.slice(0, 800));
    console.log(`  cluster4_weekly_card_snapshots 보유(첫 800명): ${snap.users}명 (행 ${snap.rows})${snap.err ? "  ERR " + snap.err : ""}`);
    const roster = await coverage("cluster4_roster_card_stats", "user_id", testIds.slice(0, 800));
    console.log(`  cluster4_roster_card_stats 보유(첫 800명): ${roster.users}명 (행 ${roster.rows})${roster.err ? "  ERR " + roster.err : ""}`);
    const grade = await coverage("user_grade_stats", "user_id", testIds.slice(0, 800));
    console.log(`  user_grade_stats 보유(첫 800명): ${grade.users}명 (행 ${grade.rows})${grade.err ? "  ERR " + grade.err : ""}`);
  }

  // ── 프로세스 체크 ──
  console.log("\n── 7) 프로세스 체크 (process_check_statuses) ──");
  {
    // 정의 카탈로그(인원 무관)
    console.log(await safeCount("  process_acts(정의 카탈로그)", () =>
      supabaseAdmin.from("process_acts").select("id", { count: "exact", head: true }) as any));
    console.log(await safeCount("  process_check_statuses(전체)", () =>
      supabaseAdmin.from("process_check_statuses").select("id", { count: "exact", head: true }) as any));
    console.log(await safeCount("  process_irregular_acts(전체)", () =>
      supabaseAdmin.from("process_irregular_acts").select("id", { count: "exact", head: true }) as any));
  }

  console.log("\n════════════════════════════════════════════════════════");
  console.log("진단 완료 (read-only · 데이터 무변경)");
  process.exit(0);
}

main().catch((e) => { console.error("FATAL", e); process.exit(1); });
