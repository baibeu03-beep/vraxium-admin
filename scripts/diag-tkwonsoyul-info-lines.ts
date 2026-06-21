/**
 * diag-tkwonsoyul-info-lines.ts  (READ-ONLY — DB 무변경)
 *
 * 운영 모드 practical-info(part_type='info') 개설 대상 크루에 테스트 사용자 T권소율이
 * 잘못 들어간 라인을 식별한다.
 *   - T권소율 userId 확정(user_profiles + test_user_markers 등재 확인).
 *   - T권소율이 user 타깃으로 들어간 모든 info 라인(is_active 무관)을 나열.
 *   - 각 라인: line_code, 파생 org, 주차, is_active, 같은 라인+주차의 다른 user 타깃과
 *     그 타깃들의 test 여부 → "운영 라인"(다른 타깃 중 실사용자 존재) vs "테스트 라인"(전원 test) 분류.
 *
 * 실행: npx tsx --env-file=.env.local scripts/diag-tkwonsoyul-info-lines.ts
 */
import { config } from "dotenv";
config({ path: ".env.local" });
import { createClient } from "@supabase/supabase-js";
import { fetchTestUserMarkerIds } from "@/lib/testUsers";
import { resolveLineScopeFromValues } from "@/lib/lineScope";
import { isInfoCrewEditableWeek } from "@/lib/cluster4InfoCrewEditWindow";

const sb = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
);

const TARGET_NAME = "T권소율";
const KNOWN_UID = "28a39131-a719-4264-b2a4-96dbda64cbb6"; // 기존 verify 픽스처가 T권소율로 표기

async function resolveTargetUserId(testIds: ReadonlySet<string>): Promise<string> {
  // 1) display_name 정확 매칭.
  const { data: byName } = await sb
    .from("user_profiles")
    .select("user_id,display_name,organization_slug")
    .eq("display_name", TARGET_NAME);
  const rows = (byName ?? []) as Array<{
    user_id: string;
    display_name: string;
    organization_slug: string | null;
  }>;
  console.log(`\n[T권소율 후보 — display_name='${TARGET_NAME}']`);
  for (const r of rows) {
    console.log(
      `   user_id=${r.user_id} org=${r.organization_slug} test=${testIds.has(r.user_id)}`,
    );
  }
  // 알려진 UID 우선 확인.
  const { data: known } = await sb
    .from("user_profiles")
    .select("user_id,display_name,organization_slug")
    .eq("user_id", KNOWN_UID)
    .maybeSingle();
  if (known) {
    const k = known as { display_name: string; organization_slug: string | null };
    console.log(
      `\n[알려진 UID ${KNOWN_UID}] display_name='${k.display_name}' org=${k.organization_slug} test=${testIds.has(KNOWN_UID)}`,
    );
  }
  // 결정: display_name 정확 매칭이 1개면 그것, 아니면 알려진 UID.
  if (rows.length === 1) return rows[0].user_id;
  if (rows.some((r) => r.user_id === KNOWN_UID)) return KNOWN_UID;
  if (known) return KNOWN_UID;
  if (rows.length > 0) return rows[0].user_id;
  throw new Error("T권소율 user_id 를 해소할 수 없습니다");
}

async function main() {
  const testIds = await fetchTestUserMarkerIds();
  const targetUid = await resolveTargetUserId(testIds);
  console.log(`\n>>> 처리 대상 userId = ${targetUid}  (test_user_markers 등재=${testIds.has(targetUid)})`);

  // T권소율이 user 타깃으로 들어간 모든 라인 타깃 행.
  const { data: tgtRows, error: tgtErr } = await sb
    .from("cluster4_line_targets")
    .select("id,line_id,week_id,target_mode")
    .eq("target_user_id", targetUid)
    .eq("target_mode", "user");
  if (tgtErr) throw new Error(tgtErr.message);
  const targets = (tgtRows ?? []) as Array<{
    id: string;
    line_id: string;
    week_id: string;
  }>;
  console.log(`\nT권소율 user 타깃 행 총 ${targets.length}건 (전 part_type)`);

  const lineIds = Array.from(new Set(targets.map((t) => t.line_id)));
  const { data: lineRows } = await sb
    .from("cluster4_lines")
    .select("id,part_type,is_active,line_code,main_title,week_id")
    .in("id", lineIds);
  const lineById = new Map(
    ((lineRows ?? []) as Array<{
      id: string;
      part_type: string;
      is_active: boolean | null;
      line_code: string | null;
      main_title: string | null;
      week_id: string | null;
    }>).map((l) => [l.id, l]),
  );

  // info 라인만.
  const infoTargets = targets.filter((t) => lineById.get(t.line_id)?.part_type === "info");
  console.log(`그 중 part_type='info' = ${infoTargets.length}건\n`);

  const weekIds = Array.from(new Set(infoTargets.map((t) => t.week_id)));
  const { data: weekRows } = await sb
    .from("weeks")
    .select("id,season_key,week_number,start_date,end_date")
    .in("id", weekIds);
  const weekById = new Map(
    ((weekRows ?? []) as Array<{
      id: string;
      season_key: string | null;
      week_number: number | null;
      start_date: string | null;
      end_date: string | null;
    }>).map((w) => [w.id, w]),
  );

  type Classified = {
    lineId: string;
    weekId: string;
    lineCode: string | null;
    org: string | null;
    isActive: boolean | null;
    weekLabel: string;
    editable: boolean;
    otherUsers: string[];
    otherTestUsers: string[];
    otherRealUsers: string[];
    classification: "operating" | "test-only" | "solo";
  };

  const classified: Classified[] = [];

  for (const t of infoTargets) {
    const line = lineById.get(t.line_id)!;
    const week = weekById.get(t.week_id);
    // 같은 라인+주차의 다른 user 타깃.
    const { data: peers } = await sb
      .from("cluster4_line_targets")
      .select("target_user_id")
      .eq("line_id", t.line_id)
      .eq("week_id", t.week_id)
      .eq("target_mode", "user");
    const allUsers = ((peers ?? []) as Array<{ target_user_id: string | null }>)
      .map((p) => p.target_user_id)
      .filter((id): id is string => Boolean(id));
    const others = allUsers.filter((id) => id !== targetUid);
    const otherTest = others.filter((id) => testIds.has(id));
    const otherReal = others.filter((id) => !testIds.has(id));
    const scope = resolveLineScopeFromValues({ partType: "info", lineCode: line.line_code });
    const weekLabel = week
      ? `${week.season_key} W${week.week_number} (${week.start_date}~${week.end_date})`
      : t.week_id;
    const editable = week ? isInfoCrewEditableWeek(week.start_date, week.end_date) : false;

    let classification: Classified["classification"];
    if (others.length === 0) classification = "solo";
    else if (otherReal.length > 0) classification = "operating";
    else classification = "test-only";

    classified.push({
      lineId: t.line_id,
      weekId: t.week_id,
      lineCode: line.line_code,
      org: scope.org,
      isActive: line.is_active,
      weekLabel,
      editable,
      otherUsers: others,
      otherTestUsers: otherTest,
      otherRealUsers: otherReal,
      classification,
    });
  }

  for (const c of classified) {
    console.log(
      [
        `── ${c.classification.toUpperCase()} ──`,
        `   line=${c.lineId}`,
        `   code=${c.lineCode}  org=${c.org}  active=${c.isActive}  editableWindow=${c.editable}`,
        `   week=${c.weekLabel}`,
        `   다른 user 타깃 ${c.otherUsers.length} (실사용자 ${c.otherRealUsers.length} / test ${c.otherTestUsers.length})`,
      ].join("\n"),
    );
  }

  const operating = classified.filter((c) => c.classification === "operating");
  const testOnly = classified.filter((c) => c.classification === "test-only");
  const solo = classified.filter((c) => c.classification === "solo");
  console.log(
    `\n=== 분류 요약 ===\n  operating(실사용자 동석) = ${operating.length}\n  test-only(전원 test) = ${testOnly.length}\n  solo(T권소율 단독) = ${solo.length}`,
  );
  console.log(
    `\n  operating 중 editableWindow=true = ${operating.filter((c) => c.editable).length}` +
      ` / active=true = ${operating.filter((c) => c.isActive).length}`,
  );

  const fs = await import("node:fs");
  fs.writeFileSync(
    "claudedocs/diag-tkwonsoyul-info-lines.json",
    JSON.stringify({ targetUid, isTest: testIds.has(targetUid), classified }, null, 2),
  );
  console.log("\n→ claudedocs/diag-tkwonsoyul-info-lines.json 기록");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
