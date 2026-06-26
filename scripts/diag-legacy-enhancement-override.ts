// 읽기 전용 진단: 레거시(start_date < 2026-06-29) 주차의 4허브 라인 강화 판정에서
//   "레거시 submission-based override"가 공용 규칙(타깃+마감=success)과 갈라지는 칸/인원을 집계.
// override 제거 효과 = (마감 후 + 미제출) 칸이 fail(override) → success(공용) 로 교정되는 수.
// 운영 모드 기준: test_user_markers(테스트 계정) 제외.
import { config } from "dotenv";
config({ path: ".env.local" });
import { createClient } from "@supabase/supabase-js";

const sb = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
);

const EFFECTIVE_FROM = "2026-06-29"; // CLUSTER4_SLOT_POLICY_EFFECTIVE_FROM
const NOW = Date.now();

async function pageAll<T>(
  build: (from: number, to: number) => any,
): Promise<T[]> {
  const out: T[] = [];
  const SIZE = 1000;
  for (let from = 0; ; from += SIZE) {
    let attempt = 0;
    let rows: T[] = [];
    for (;;) {
      try {
        const { data, error } = await build(from, from + SIZE - 1);
        if (error) throw new Error(error.message);
        rows = (data ?? []) as T[];
        break;
      } catch (e) {
        if (++attempt >= 5) throw e;
        await new Promise((r) => setTimeout(r, 500 * attempt));
      }
    }
    out.push(...rows);
    if (rows.length < SIZE) break;
  }
  return out;
}

async function main() {
  // 0. 테스트 계정
  const { data: markers } = await sb.from("test_user_markers").select("user_id");
  const testSet = new Set((markers ?? []).map((m: any) => m.user_id));

  // 1. 레거시 주차 id
  const weeks = await pageAll<any>((f, t) =>
    sb.from("weeks").select("id,start_date,season_key,week_number").lt("start_date", EFFECTIVE_FROM).order("start_date").range(f, t),
  );
  const legacyWeekIds = new Set(weeks.map((w) => w.id));
  console.log(`레거시 주차(start_date < ${EFFECTIVE_FROM}): ${legacyWeekIds.size}개`);

  // 2. 레거시 주차의 active 라인 타깃 (part_type 별)
  const rawTargets = await pageAll<any>((f, t) =>
    sb
      .from("cluster4_line_targets")
      .select("id,target_user_id,target_mode,week_id,cluster4_lines!inner(id,part_type,is_active,submission_closes_at,experience_line_master_id)")
      .in("week_id", Array.from(legacyWeekIds))
      .eq("cluster4_lines.is_active", true)
      .range(f, t),
  );
  const targets = rawTargets.filter((r) => r.target_mode === "user" && r.target_user_id);
  console.log(`레거시 주차 active 라인 타깃: ${rawTargets.length}건 (user 모드 ${targets.length}건)`);

  // 3. 제출 존재 여부 (line_target_id 단위; 타깃의 user 제출만 — 타깃 user_id 로 매칭)
  const targetIds = targets.map((x) => x.id);
  const submittedTargetIds = new Set<string>();
  for (let i = 0; i < targetIds.length; i += 100) {
    const chunk = targetIds.slice(i, i + 100);
    const subs = await pageAll<any>((f, t) =>
      sb.from("cluster4_line_submissions").select("line_target_id").in("line_target_id", chunk).range(f, t),
    );
    for (const s of subs) submittedTargetIds.add(s.line_target_id);
  }

  // 4. 허브별 집계
  type Bucket = {
    targets: number;
    deadlinePassed: number;
    deadlinePassedNoSub: number; // override 영향 칸 (fail→success on removal)
    flipUsers: Set<string>;
    flipUsersReal: Set<string>;
  };
  const mk = (): Bucket => ({ targets: 0, deadlinePassed: 0, deadlinePassedNoSub: 0, flipUsers: new Set(), flipUsersReal: new Set() });
  const byPart: Record<string, Bucket> = { info: mk(), experience: mk(), competency: mk(), career: mk() };

  for (const tg of targets) {
    const line = tg.cluster4_lines;
    const part = line?.part_type as string;
    if (!byPart[part]) continue;
    const b = byPart[part];
    b.targets++;
    const closesAt = line?.submission_closes_at;
    const deadlinePassed = Boolean(closesAt) && NOW > new Date(closesAt).getTime();
    const hasSub = submittedTargetIds.has(tg.id);
    if (deadlinePassed) {
      b.deadlinePassed++;
      if (!hasSub) {
        b.deadlinePassedNoSub++;
        b.flipUsers.add(tg.target_user_id);
        if (!testSet.has(tg.target_user_id)) b.flipUsersReal.add(tg.target_user_id);
      }
    }
  }

  console.log(`\n=== 허브별 레거시 override 분석 (마감후+미제출 = override 제거 시 fail→success) ===`);
  for (const part of ["info", "experience", "competency", "career"]) {
    const b = byPart[part];
    console.log(
      `\n[${part}] 타깃 ${b.targets} | 마감후 ${b.deadlinePassed} | 마감후+미제출(divergent 칸) ${b.deadlinePassedNoSub}` +
        ` | 영향 인원(전체) ${b.flipUsers.size} | 영향 인원(운영=실사용자) ${b.flipUsersReal.size}`,
    );
  }

  // 4.5 info 영향 상세: 시즌/주차 분포 + 실사용자 표본 id
  const weekById = new Map(weeks.map((w) => [w.id, w]));
  const infoBySeason = new Map<string, number>();
  const infoRealUserIds = new Set<string>();
  for (const tg of targets) {
    if (tg.cluster4_lines?.part_type !== "info") continue;
    const line = tg.cluster4_lines;
    const closesAt = line?.submission_closes_at;
    const deadlinePassed = Boolean(closesAt) && NOW > new Date(closesAt).getTime();
    if (!deadlinePassed || submittedTargetIds.has(tg.id)) continue;
    const w = weekById.get(tg.week_id);
    const key = w ? `${w.season_key} W${w.week_number}` : "?";
    infoBySeason.set(key, (infoBySeason.get(key) ?? 0) + 1);
    if (!testSet.has(tg.target_user_id)) infoRealUserIds.add(tg.target_user_id);
  }
  console.log(`\n[info] divergent 칸 시즌/주차 분포:`);
  for (const [k, v] of [...infoBySeason.entries()].sort()) console.log(`   ${k}: ${v}`);
  console.log(`\n[info] 실사용자 표본 id (최대 8):`);
  console.log("   " + [...infoRealUserIds].slice(0, 8).join("\n   "));

  // 5. override 가 실제 적용되는 허브 메모
  console.log(`\n현재 override 적용(HEAD): career + info (working tree 는 info 제외됨)`);
  console.log(`override 미적용(공용규칙): competency (항상 제외) / experience(비통합=미렌더, 통합=공용)`);
}
main().catch((e) => {
  console.error(e);
  process.exit(1);
});
