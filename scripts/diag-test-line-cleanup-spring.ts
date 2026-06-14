/**
 * READ-ONLY 조사: 봄 시즌 1~13주차 "테스트 개설 라인" dry-run.
 *   npx tsx --env-file=.env.local scripts/diag-test-line-cleanup-spring.ts
 *
 * 절대 DB 를 변경하지 않는다(SELECT only). 삭제 대상 후보를 산출하고 영향 범위만 보고한다.
 */
import { createClient } from "@supabase/supabase-js";
import { parseLineCodeOrg } from "@/lib/cluster4LineOrg";

const sb = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
  { auth: { persistSession: false, autoRefreshToken: false } },
);

// 백필/시드 스크립트가 cluster4_lines.source_file_name 에 남기는 테스트 마커.
const TEST_SOURCE_MARKERS = ["tester-backfill", "seed", "test"];
const KNOWN_BACKFILL_ADMIN = "c28b2409-4118-49fc-a42e-68e18dbd194c";

async function selectAll<T>(
  table: string,
  select: string,
  filter: (q: any) => any = (q) => q,
  orderCol = "id",
): Promise<T[]> {
  const pageSize = 1000;
  const rows: T[] = [];
  for (let from = 0; ; from += pageSize) {
    const { data, error } = await filter(sb.from(table).select(select))
      .order(orderCol, { ascending: true })
      .range(from, from + pageSize - 1);
    if (error) throw new Error(`${table} select failed: ${error.message}`);
    const batch = (data ?? []) as T[];
    rows.push(...batch);
    if (batch.length < pageSize) return rows;
  }
}

// 청크별 IN 조회 — PostgREST 1000행 cap 회피를 위해 청크 내부에서 range 페이지네이션.
async function inChunks<T>(
  table: string,
  select: string,
  column: string,
  values: string[],
  extra: (q: any) => any = (q) => q,
  orderCol = "id",
): Promise<T[]> {
  const out: T[] = [];
  const chunkSize = 80;
  const pageSize = 1000;
  for (let i = 0; i < values.length; i += chunkSize) {
    const chunk = values.slice(i, i + chunkSize);
    if (chunk.length === 0) continue;
    for (let from = 0; ; from += pageSize) {
      const { data, error } = await extra(sb.from(table).select(select))
        .in(column, chunk)
        .order(orderCol, { ascending: true })
        .range(from, from + pageSize - 1);
      if (error) throw new Error(`${table}.${column} chunk failed: ${error.message}`);
      const batch = (data ?? []) as T[];
      out.push(...batch);
      if (batch.length < pageSize) break;
    }
  }
  return out;
}

type Week = {
  id: string;
  week_number: number | null;
  start_date: string | null;
  season_key: string | null;
  is_official_rest: boolean | null;
};
type Line = {
  id: string;
  part_type: string;
  line_code: string | null;
  main_title: string | null;
  team_id: string | null;
  is_active: boolean;
  week_id: string | null;
  source_file_name: string | null;
  created_by: string | null;
  created_at: string | null;
};
type Target = {
  id: string;
  line_id: string;
  week_id: string | null;
  target_mode: string;
  target_user_id: string | null;
};

function isTestSource(s: string | null): boolean {
  if (!s) return false;
  const low = s.toLowerCase();
  return TEST_SOURCE_MARKERS.some((m) => low.includes(m));
}

async function main() {
  // ── 0) 테스트 유저 집합 ───────────────────────────────────────────────
  const markerRows = await selectAll<{ user_id: string }>(
    "test_user_markers",
    "user_id",
    (q) => q,
    "user_id",
  );
  const testUserIds = new Set(markerRows.map((r) => r.user_id).filter(Boolean));
  console.log(`[0] test_user_markers: ${testUserIds.size}명`);

  // ── 1) 봄 시즌 주차 식별 ──────────────────────────────────────────────
  const allWeeks = await selectAll<Week>(
    "weeks",
    "id,week_number,start_date,season_key,is_official_rest",
  );
  const seasonKeys = [...new Set(allWeeks.map((w) => w.season_key))];
  console.log("\n[1] 전체 season_key 목록:");
  for (const sk of seasonKeys.sort()) {
    const ws = allWeeks
      .filter((w) => w.season_key === sk)
      .sort((a, b) => (a.week_number ?? 0) - (b.week_number ?? 0));
    const nums = ws.map((w) => w.week_number).filter((n) => n != null);
    console.log(
      `   · ${sk ?? "(null)"}  weeks=${ws.length}  week#=${nums.length ? `${Math.min(...nums as number[])}..${Math.max(...nums as number[])}` : "-"}  start=${ws[0]?.start_date ?? "-"}`,
    );
  }

  // 봄(spring) 후보: 기본 '2026-spring'(현재 시즌). argv 로 override 가능.
  //   전체 봄 연도 비교가 필요하면 SEASON=all 로 실행.
  const seasonArg = process.argv.find((a) => a.startsWith("--season="))?.slice(9) ?? "2026-spring";
  const springKeys = (
    seasonArg === "all"
      ? seasonKeys.filter((sk) => sk && (/spring/i.test(sk) || sk.includes("봄")))
      : seasonKeys.filter((sk) => sk === seasonArg)
  ) as string[];
  console.log(`\n[1] 대상 season_key (--season=${seasonArg}): ${springKeys.join(", ") || "(없음)"}`);

  const springWeeks = allWeeks
    .filter(
      (w) =>
        w.season_key != null &&
        springKeys.includes(w.season_key) &&
        w.week_number != null &&
        w.week_number >= 1 &&
        w.week_number <= 13,
    )
    .sort((a, b) => (a.week_number ?? 0) - (b.week_number ?? 0));
  const springWeekIds = springWeeks.map((w) => w.id);
  const weekById = new Map(springWeeks.map((w) => [w.id, w]));
  console.log(
    `[1] 봄 1~13주차: ${springWeeks.length}주 → ${springWeeks.map((w) => `W${w.week_number}(${w.start_date}${w.is_official_rest ? ",휴식" : ""})`).join(", ")}`,
  );
  if (springWeekIds.length === 0) {
    console.log("봄 주차를 찾지 못함 — 중단.");
    return;
  }

  // ── 2) 봄 주차에 걸린 라인 수집 (line.week_id ∪ target.week_id) ────────
  const linesByWeekId = await inChunks<Line>(
    "cluster4_lines",
    "id,part_type,line_code,main_title,team_id,is_active,week_id,source_file_name,created_by,created_at",
    "week_id",
    springWeekIds,
  );
  const targetsByWeekId = await inChunks<Target>(
    "cluster4_line_targets",
    "id,line_id,week_id,target_mode,target_user_id",
    "week_id",
    springWeekIds,
  );

  const lineIdSet = new Set<string>(linesByWeekId.map((l) => l.id));
  for (const t of targetsByWeekId) if (t.line_id) lineIdSet.add(t.line_id);
  const allLineIds = [...lineIdSet];

  // 타깃-경유로만 들어온 라인의 본체도 가져온다.
  const extraLineIds = allLineIds.filter(
    (id) => !linesByWeekId.some((l) => l.id === id),
  );
  const extraLines = await inChunks<Line>(
    "cluster4_lines",
    "id,part_type,line_code,main_title,team_id,is_active,week_id,source_file_name,created_by,created_at",
    "id",
    extraLineIds,
  );
  const lineById = new Map<string, Line>();
  for (const l of [...linesByWeekId, ...extraLines]) lineById.set(l.id, l);

  // 각 라인의 전체 타깃(라인 기준, 주차 무관) — 대상자/테스트 판정용.
  const allTargets = await inChunks<Target>(
    "cluster4_line_targets",
    "id,line_id,week_id,target_mode,target_user_id",
    "line_id",
    allLineIds,
  );
  const targetsByLine = new Map<string, Target[]>();
  for (const t of allTargets) {
    const arr = targetsByLine.get(t.line_id) ?? [];
    arr.push(t);
    targetsByLine.set(t.line_id, arr);
  }

  // 제출 수 (line_target_id 기준).
  const allTargetIds = allTargets.map((t) => t.id);
  const submissions = await inChunks<{ id: string; line_target_id: string; user_id: string }>(
    "cluster4_line_submissions",
    "id,line_target_id,user_id",
    "line_target_id",
    allTargetIds,
  );
  const subByTarget = new Map<string, number>();
  for (const s of submissions) {
    subByTarget.set(s.line_target_id, (subByTarget.get(s.line_target_id) ?? 0) + 1);
  }

  // 팀 이름 매핑(테스트 팀 판정 보조).
  const teamIds = [...new Set([...lineById.values()].map((l) => l.team_id).filter(Boolean))] as string[];
  let teamNameById = new Map<string, { name: string | null; org: string | null }>();
  if (teamIds.length) {
    try {
      const teams = await inChunks<{ id: string; name: string | null; organization_slug: string | null }>(
        "teams",
        "id,name,organization_slug",
        "id",
        teamIds,
      );
      teamNameById = new Map(teams.map((t) => [t.id, { name: t.name, org: t.organization_slug }]));
    } catch (e) {
      console.log("   (teams 조회 실패 — team 이름 생략):", (e as Error).message);
    }
  }

  // ── 3) 라인별 분류 ────────────────────────────────────────────────────
  type Row = {
    lineId: string;
    week: string;
    weekId: string | null;
    partType: string;
    lineName: string;
    org: string;
    isActive: boolean;
    targetTotal: number;
    targetTest: number;
    targetReal: number;
    submissions: number;
    createdBy: string | null;
    source: string | null;
    teamName: string | null;
    classification: "TEST-only" | "MIXED" | "OPERATING" | "NO-TARGET";
    reasons: string[];
  };

  const rows: Row[] = [];
  for (const lineId of allLineIds) {
    const line = lineById.get(lineId);
    if (!line) continue;
    const targets = (targetsByLine.get(lineId) ?? []).filter((t) => t.target_mode === "user");
    const ruleTargets = (targetsByLine.get(lineId) ?? []).filter((t) => t.target_mode === "rule");
    const userTargetIds = targets.map((t) => t.target_user_id).filter(Boolean) as string[];
    const testCount = userTargetIds.filter((u) => testUserIds.has(u)).length;
    const realCount = userTargetIds.filter((u) => !testUserIds.has(u)).length;
    const subs = (targetsByLine.get(lineId) ?? []).reduce(
      (n, t) => n + (subByTarget.get(t.id) ?? 0),
      0,
    );

    // 이 라인이 봄 1~13주차에 실제로 걸려있는지(라인.week_id 또는 타깃.week_id).
    const lineWeek = line.week_id && weekById.has(line.week_id) ? weekById.get(line.week_id) : null;
    const targetWeekIds = new Set(targets.map((t) => t.week_id).filter(Boolean) as string[]);
    const springTargetWeeks = [...targetWeekIds].filter((w) => weekById.has(w));
    const weekLabel = lineWeek
      ? `W${lineWeek.week_number}`
      : springTargetWeeks.length
        ? springTargetWeeks.map((w) => `W${weekById.get(w)!.week_number}`).join("/")
        : "(봄범위밖)";

    const reasons: string[] = [];
    if (isTestSource(line.source_file_name)) reasons.push(`source=${line.source_file_name}`);
    if (line.created_by === KNOWN_BACKFILL_ADMIN) reasons.push("created_by=backfill-admin");
    const team = line.team_id ? teamNameById.get(line.team_id) : null;
    if (team?.name && team.name.includes("(T)")) reasons.push(`team=${team.name}`);
    if (userTargetIds.length > 0 && realCount === 0) reasons.push("타깃 전원 테스트유저");
    if (realCount > 0) reasons.push(`실유저타깃 ${realCount}명`);

    let classification: Row["classification"];
    if (userTargetIds.length === 0 && ruleTargets.length === 0) classification = "NO-TARGET";
    else if (realCount > 0 && testCount > 0) classification = "MIXED";
    else if (realCount > 0) classification = "OPERATING";
    else classification = "TEST-only";

    const org = parseLineCodeOrg(line.line_code) ?? "(unknown)";

    rows.push({
      lineId,
      week: weekLabel,
      weekId: line.week_id,
      partType: line.part_type,
      lineName: (line.main_title ?? "").slice(0, 40),
      org,
      isActive: line.is_active,
      targetTotal: userTargetIds.length,
      targetTest: testCount,
      targetReal: realCount,
      submissions: subs,
      createdBy: line.created_by,
      source: line.source_file_name,
      teamName: team?.name ?? null,
      classification,
      reasons,
    });
  }

  // ── 4) 출력 ───────────────────────────────────────────────────────────
  const byClass = (c: Row["classification"]) => rows.filter((r) => r.classification === c);
  console.log(`\n[2] 봄 1~13주차 관련 라인 총 ${rows.length}건`);
  console.log(
    `    TEST-only=${byClass("TEST-only").length}  MIXED=${byClass("MIXED").length}  OPERATING=${byClass("OPERATING").length}  NO-TARGET=${byClass("NO-TARGET").length}`,
  );

  const partOrder = ["info", "experience", "competency", "career"];
  for (const part of partOrder) {
    const pr = rows.filter((r) => r.partType === part);
    if (pr.length === 0) continue;
    console.log(`\n── ${part} (${pr.length}건) ──`);
    for (const r of pr.sort((a, b) => a.week.localeCompare(b.week))) {
      console.log(
        `  [${r.classification}] ${r.week} ${r.org} act=${r.isActive ? "Y" : "N"} ` +
          `tgt=${r.targetTotal}(T${r.targetTest}/R${r.targetReal}) sub=${r.submissions} ` +
          `"${r.lineName}" line=${r.lineId.slice(0, 8)} ${r.reasons.join("; ")}`,
      );
    }
  }

  // ── 4b) source 마커가 찍힌 라인(테스트 백필) 별도 집계 ────────────────
  const sourceMarked = rows.filter((r) => isTestSource(r.source));
  const sourceMarkedNoTarget = sourceMarked.filter((r) => r.targetTotal === 0);
  console.log(
    `\n[2b] source 마커(test/seed/backfill) 라인=${sourceMarked.length}건 (그중 타깃0=${sourceMarkedNoTarget.length}건=다운스트림 무영향 더미)`,
  );

  // ── 5) 삭제 대상 후보(TEST-only) 상세 ─────────────────────────────────
  // 후보 = TEST-only(타깃 전원 테스트) ∪ source 마커 + 타깃0 더미.
  const candidateSet = new Map<string, Row>();
  for (const r of byClass("TEST-only")) candidateSet.set(r.lineId, r);
  for (const r of sourceMarkedNoTarget) candidateSet.set(r.lineId, r);
  const candidates = [...candidateSet.values()];
  console.log(`\n[3] 삭제 대상 후보(TEST-only) = ${candidates.length}건`);
  const candTargetUserIds = new Set<string>();
  let candTargetRows = 0;
  let candSubRows = 0;
  for (const r of candidates) {
    const targets = (targetsByLine.get(r.lineId) ?? []).filter((t) => t.target_mode === "user");
    candTargetRows += targets.length;
    candSubRows += r.submissions;
    for (const t of targets) if (t.target_user_id) candTargetUserIds.add(t.target_user_id);
  }

  // ── 6) snapshot 영향 ─────────────────────────────────────────────────
  const affectedUserIds = [...candTargetUserIds];
  const realAffected = affectedUserIds.filter((u) => !testUserIds.has(u));
  let snapRows: { user_id: string; is_stale: boolean }[] = [];
  if (affectedUserIds.length) {
    snapRows = await inChunks(
      "cluster4_weekly_card_snapshots",
      "user_id,is_stale",
      "user_id",
      affectedUserIds,
      (q) => q,
      "user_id",
    );
  }

  // 후보 라인의 line_target_id 전수 → 평가/드래프트 child 테이블 영향.
  const candTargetIds: string[] = [];
  for (const r of candidates) {
    for (const t of targetsByLine.get(r.lineId) ?? []) candTargetIds.push(t.id);
  }
  async function countChild(table: string, col: string): Promise<number | string> {
    try {
      let total = 0;
      for (let i = 0; i < candTargetIds.length; i += 100) {
        const { count, error } = await sb
          .from(table)
          .select("*", { count: "exact", head: true })
          .in(col, candTargetIds.slice(i, i + 100));
        if (error) return `ERR:${error.message}`;
        total += count ?? 0;
      }
      return total;
    } catch (e) {
      return `ERR:${(e as Error).message}`;
    }
  }
  const expEval = await countChild("cluster4_experience_line_evaluations", "line_target_id");
  const carEval = await countChild("cluster4_career_line_evaluations", "line_target_id");
  const expDraft = await countChild("cluster4_experience_line_drafts", "line_target_id");

  console.log(JSON.stringify({
    삭제대상_TEST_only_및_더미_라인수: candidates.length,
    삭제될_cluster4_lines: candidates.length,
    삭제될_cluster4_line_targets: candTargetRows,
    삭제될_cluster4_line_submissions: candSubRows,
    child_cluster4_experience_line_evaluations: expEval,
    child_cluster4_career_line_evaluations: carEval,
    child_cluster4_experience_line_drafts: expDraft,
    영향받는_대상자수: affectedUserIds.length,
    영향받는_실유저수_경고: realAffected.length,
    snapshot_보유_영향유저: snapRows.length,
    snapshot_재계산_필요_유저: snapRows.length,
  }, null, 2));

  // 후보 전수 UUID + 타깃/제출 export (기록·삭제 스크립트 입력용).
  const fs = await import("fs");
  fs.writeFileSync(
    "claudedocs/diag-test-line-cleanup-2026spring-candidates.json",
    JSON.stringify(
      {
        season: "2026-spring",
        weekRange: "W1..W13",
        generatedFor: "dry-run only — no deletion",
        candidateLineCount: candidates.length,
        candidateLineIds: candidates.map((r) => r.lineId),
        candidateTargetIds: candTargetIds,
        affectedUserIds,
        mixedOperatingLineIds: byClass("MIXED").map((r) => r.lineId),
      },
      null,
      2,
    ),
  );

  if (realAffected.length > 0) {
    console.log(
      `\n⚠ 경고: TEST-only 로 분류됐지만 실유저로 보이는 대상자 ${realAffected.length}명 — 재검토 필요:`,
      realAffected.slice(0, 10),
    );
  }

  // MIXED/OPERATING 에 봄 주차 테스트 타깃이 섞인 경우(운영 라인에 테스트 타깃만 빼야 하는 케이스).
  const mixed = byClass("MIXED");
  if (mixed.length) {
    console.log(`\n[4] ⚠ MIXED 라인 ${mixed.length}건 — 운영+테스트 타깃 혼재(라인 통삭제 금지, 타깃 단위 검토):`);
    for (const r of mixed) {
      console.log(`   ${r.week} ${r.partType} "${r.lineName}" T${r.targetTest}/R${r.targetReal} line=${r.lineId.slice(0, 8)}`);
    }
  }

  console.log("\n완료 (read-only, DB 변경 없음).");
}

main().catch((e) => {
  console.error("ERR", e);
  process.exit(1);
});
