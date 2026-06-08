/**
 * 테스터 check 재시드(37/35) 검증 — direct / HTTP / snapshot / 실사용자 보존.
 *
 *   npx tsx --env-file=.env.local scripts/verify-reseed-37.ts
 *
 * 검증 (read-only):
 *   1) direct: 재시드 행 — userWeekStatus=success 유지 + checkGate.earned=신값(≥37/35)·passed·enforced=true
 *      (required 는 B7 apply 전이라 30 — apply 후 37/35 로 바뀌어도 earned≥신기준이라 flip 0)
 *   2) 케이스 B 보존: uws=fail 주차 — userWeekStatus=fail + 강화 success (분리 표시)
 *   3) HTTP(운영 admin) == direct — userWeekStatus·checkGate 필드 단위
 *   4) snapshot == direct (dto_version 18 · is_stale=false)
 *   5) 실사용자: 감사 주차 uws=success 표시 보존 + checkGate.enforced=false
 */
import { readFileSync } from "fs";
import { createClient } from "@supabase/supabase-js";
import { getCluster4WeeklyCardsForProfileUser } from "@/lib/cluster4WeeklyCardsData";
import { WEEKLY_CARDS_DTO_VERSION } from "@/lib/cluster4WeeklyCardsSnapshot";
import type { Cluster4WeeklyCardDto } from "@/shared/cluster4.contracts";

const ADMIN = "https://vraxium-admin.vercel.app";
const sb = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
);

let pass = 0,
  fail = 0;
const check = (name: string, ok: boolean, detail?: string) => {
  if (ok) {
    pass++;
    console.log(`  ✅ ${name}`);
  } else {
    fail++;
    console.log(`  ❌ ${name}${detail ? ` — ${detail}` : ""}`);
  }
};

const findCard = (cards: Cluster4WeeklyCardDto[], start: string) =>
  cards.find((c) => c.startDate === start) ?? null;

async function httpCards(userId: string): Promise<Cluster4WeeklyCardDto[]> {
  const res = await fetch(`${ADMIN}/api/cluster4/weekly-cards?userId=${encodeURIComponent(userId)}`, {
    headers: { "x-internal-api-key": process.env.INTERNAL_API_KEY ?? "" },
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return ((await res.json()).data ?? []) as Cluster4WeeklyCardDto[];
}

async function main() {
  const runLog = JSON.parse(readFileSync("claudedocs/reseed-tester-check-37-20260606.json", "utf8"));
  const updated = runLog.updated as {
    userId: string;
    week: string;
    weekStart: string;
    oldPoints: number;
    newPoints: number;
    newThr: number;
  }[];
  const seed = JSON.parse(readFileSync("claudedocs/legacy-check-case-seed-20260605.json", "utf8"));

  // 샘플: 재시드 행 최다 테스터 2명 + 케이스 B 1명
  const byUser = new Map<string, typeof updated>();
  for (const u of updated) {
    if (!byUser.has(u.userId)) byUser.set(u.userId, []);
    byUser.get(u.userId)!.push(u);
  }
  const sampleTesters = [...byUser.entries()].sort((a, b) => b[1].length - a[1].length).slice(0, 2);

  const auditStarts = new Set(updated.map((u) => u.weekStart));
  const { data: pubWeeks } = await sb.from("weeks").select("start_date").not("result_published_at", "is", null);
  const published = new Set((pubWeeks ?? []).map((w) => w.start_date as string));
  const caseB = (seed.plans as { userId: string; weekStart: string; case: string }[]).find(
    (p) => p.case === "B" && auditStarts.has(p.weekStart) && published.has(p.weekStart),
  );

  // ── 1)+3)+4) 테스터 샘플 ──
  for (const [userId, rows] of sampleTesters) {
    console.log(`\n══ 테스터 ${userId.slice(0, 8)} (재시드 ${rows.length}행) ══`);
    const direct = await getCluster4WeeklyCardsForProfileUser(userId);
    const http = await httpCards(userId);
    const { data: snap } = await sb
      .from("cluster4_weekly_card_snapshots")
      .select("dto_version,is_stale,cards")
      .eq("user_id", userId)
      .maybeSingle();
    const snapRow = snap as { dto_version: number; is_stale: boolean; cards: Cluster4WeeklyCardDto[] } | null;
    check(`snapshot dto_version=${WEEKLY_CARDS_DTO_VERSION} · is_stale=false`,
      snapRow?.dto_version === WEEKLY_CARDS_DTO_VERSION && snapRow?.is_stale === false,
      `실제 v${snapRow?.dto_version} stale=${snapRow?.is_stale}`);

    let okDirect = 0, okHttp = 0, okSnap = 0;
    const bad: string[] = [];
    for (const r of rows) {
      const d = findCard(direct, r.weekStart);
      const g = d?.experienceGrowth.checkGate ?? null;
      const isPub = published.has(r.weekStart);
      // 미공표(W13)는 tallying 표시가 정상 — 게이트 값만 확인
      const statusOk = isPub ? d?.userWeekStatus === "success" : true;
      const gateOk = g != null && g.earned === r.newPoints && g.enforced === true && g.passed === true;
      if (statusOk && gateOk) okDirect++;
      else bad.push(`${r.week}: status=${d?.userWeekStatus} gate=${JSON.stringify(g)}`);

      const h = findCard(http, r.weekStart);
      const hg = h?.experienceGrowth.checkGate ?? null;
      if (h?.userWeekStatus === d?.userWeekStatus && hg?.earned === g?.earned &&
          hg?.passed === g?.passed && hg?.enforced === g?.enforced) okHttp++;

      const s = snapRow ? findCard(snapRow.cards, r.weekStart) : null;
      const sg = s?.experienceGrowth.checkGate ?? null;
      if (s?.userWeekStatus === d?.userWeekStatus && sg?.earned === g?.earned) okSnap++;
    }
    check(`direct: 재시드 ${rows.length}행 success 유지+earned=신값·passed·enforced`, okDirect === rows.length, bad.slice(0, 3).join(" | "));
    check(`HTTP == direct (${rows.length}행)`, okHttp === rows.length);
    check(`snapshot == direct (${rows.length}행)`, okSnap === rows.length);
  }

  // ── 2) 케이스 B 보존 ──
  if (caseB) {
    console.log(`\n══ 케이스 B 보존 ${caseB.userId.slice(0, 8)} ${caseB.weekStart} ══`);
    const cards = await getCluster4WeeklyCardsForProfileUser(caseB.userId);
    const card = findCard(cards, caseB.weekStart);
    const line = card?.lines.find((l) => l.partType === "experience") ?? null;
    check(`주차상태 fail 유지 (실제 ${card?.userWeekStatus})`, card?.userWeekStatus === "fail");
    check(`강화상태 success 유지 (분리 표시, 실제 ${line?.enhancementStatus})`, line?.enhancementStatus === "success");
  } else {
    check("케이스 B 샘플 존재", false, "감사 주차 내 공표 케이스 B 없음");
  }

  // ── 5) 실사용자 보존 ──
  console.log("\n══ 실사용자 보존 ══");
  const { data: markers } = await sb.from("test_user_markers").select("user_id");
  const testers = new Set((markers ?? []).map((m) => m.user_id as string));
  const { data: uws } = await sb
    .from("user_week_statuses")
    .select("user_id,week_start_date,status")
    .in("week_start_date", [...auditStarts])
    .eq("status", "success")
    .limit(2000);
  const real = (uws ?? []).filter((r) => !testers.has(r.user_id as string));
  const realUsers = [...new Set(real.map((r) => r.user_id as string))].slice(0, 2);
  for (const uid of realUsers) {
    const expect = real.filter((r) => r.user_id === uid).map((r) => r.week_start_date as string);
    const cards = await getCluster4WeeklyCardsForProfileUser(uid);
    let preserved = true,
      enforcedFalse = true;
    for (const ws of expect) {
      const c = findCard(cards, ws);
      if (!c) continue;
      if (published.has(ws) && c.userWeekStatus !== "success") preserved = false;
      const g = c.experienceGrowth.checkGate;
      if (g && g.enforced !== false) enforcedFalse = false;
    }
    check(`실사용자 ${uid.slice(0, 8)} success ${expect.length}주차 표시 보존`, preserved);
    check(`실사용자 ${uid.slice(0, 8)} checkGate enforced=false (미이관)`, enforcedFalse);
  }

  console.log(`\n결과: ✅ ${pass} / ❌ ${fail}`);
  if (fail > 0) process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
