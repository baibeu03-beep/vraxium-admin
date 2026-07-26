/**
 * READ-ONLY — QA_HIDE_REAL_USERS=true 로 HTTP 가 422 를 내는 표면을, API 가 쓰는 **같은 lib 함수**를
 * 직접 호출해 검증한다(메모리 기록된 우회 경로와 동일).
 *   npx tsx --env-file=.env.local scripts/verify-recovery-direct.ts
 * DB write 0.
 *
 * 검증 대상(실사용자 26명 + 테스트 2명):
 *   · 누적 A/B/C            resolveCumulativePointsBatch      (Cluster3·이력서·roster 공통 원천)
 *   · 주차별 상세표 합계     resolvePointHistoryBatch          (관리자 회원 상세 주차표)
 *   · roster slim 표시값     getRosterPointsScheduleFast       (회원 목록 — stale 캐시 덮어쓰기 확인)
 *   · 관리자 이력서 카드     getResumeCardForCrew
 * 전부 lib/pointResolver.ts 기준값과 일치해야 하고, C 는 항상 양수여야 한다.
 */
import { readFileSync, readdirSync } from "fs";
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { resolveCumulativePointsBatch, resolvePointHistoryBatch } from "@/lib/pointResolver";
import { getRosterPointsScheduleFast } from "@/lib/adminMembersData";
import { getResumeCardForCrew } from "@/lib/adminResumeCardData";

async function pageAll<T>(b: (f: number, t: number) => PromiseLike<{ data: unknown; error: { message: string } | null }>): Promise<T[]> {
  const o: T[] = [];
  for (let f = 0; ; f += 1000) {
    const { data, error } = await b(f, f + 999);
    if (error) throw new Error(error.message);
    const r = (data ?? []) as T[];
    o.push(...r);
    if (r.length < 1000) break;
  }
  return o;
}

async function main() {
  const sampleFile = "claudedocs/" + readdirSync("claudedocs").filter((x) => x.startsWith("recover-uwp-sample20-") && x.endsWith(".json")).sort().pop()!;
  const sample = JSON.parse(readFileSync(sampleFile, "utf8")) as Array<{ user_id: string; 사용자: string; org: string }>;
  const markers = new Set((await pageAll<{ user_id: string }>((f, t) => supabaseAdmin.from("test_user_markers").select("user_id").order("user_id").range(f, t))).map((m) => m.user_id));
  const ids = sample.map((s) => s.user_id);
  const nameOf = new Map(sample.map((s) => [s.user_id, s.사용자]));

  // 기대값 — uwp 직접 합산(pointResolver 규칙)
  const uwp = await pageAll<{ user_id: string; points: number | null; advantages: number | null; penalty: number | null }>(
    (f, t) => supabaseAdmin.from("user_weekly_points").select("user_id,points,advantages,penalty").order("id").range(f, t));
  const exp = new Map<string, { A: number; raw: number; C: number; B: number }>();
  for (const r of uwp) {
    const e = exp.get(r.user_id) ?? { A: 0, raw: 0, C: 0, B: 0 };
    e.A += r.points ?? 0; e.raw += r.advantages ?? 0; e.C += Math.abs(r.penalty ?? 0);
    exp.set(r.user_id, e);
  }
  for (const e of exp.values()) e.B = e.raw - e.C;

  const cum = await resolveCumulativePointsBatch(ids);
  const hist = await resolvePointHistoryBatch(ids);
  const roster = await getRosterPointsScheduleFast(ids);

  let fail = 0;
  console.log("| 사용자 | 원장 기대 A/B/C | resolver 누적 | 주차표 합계 | roster slim | 이력서 카드 | 판정 |");
  console.log("|---|---|---|---|---|---|---|");

  for (const uid of ids) {
    const e = exp.get(uid) ?? { A: 0, raw: 0, C: 0, B: 0 };
    const c = cum.get(uid);
    const weeks = hist.get(uid) ?? new Map();
    let wA = 0, wRaw = 0, wC = 0;
    for (const v of weeks.values()) { wA += v.pointA; wRaw += v.rawAdvantage; wC += v.pointC; }
    const rs = (roster as Map<string, { poA?: number; poB?: number; poC?: number }> | undefined)?.get?.(uid) ?? null;
    let card: { A: number; B: number; C: number } | null = null;
    try {
      const rc = await getResumeCardForCrew(uid) as unknown as { computed?: { totalStars?: number; totalShields?: number; totalPointC?: number } } | null;
      const k = rc?.computed;
      if (k) card = { A: k.totalStars ?? 0, B: k.totalShields ?? 0, C: k.totalPointC ?? 0 };
    } catch { /* 카드 없음 */ }

    const issues: string[] = [];
    if (!c) issues.push("resolver 없음");
    else {
      if (c.pointA !== e.A) issues.push(`누적A ${c.pointA}≠${e.A}`);
      if (c.pointB !== e.B) issues.push(`누적B ${c.pointB}≠${e.B}`);
      if (c.pointC !== e.C) issues.push(`누적C ${c.pointC}≠${e.C}`);
      if (c.pointC < 0) issues.push("누적C 음수");
    }
    if (wA !== e.A || wRaw - wC !== e.B || wC !== e.C) issues.push(`주차표합 ${wA}/${wRaw - wC}/${wC}`);
    if (rs && (rs.poA !== e.A || rs.poB !== e.B || rs.poC !== e.C)) issues.push(`roster ${rs.poA}/${rs.poB}/${rs.poC}`);
    if (card && (card.A !== e.A || card.B !== e.B || card.C !== e.C)) issues.push(`카드 ${card.A}/${card.B}/${card.C}`);
    if (issues.length) fail++;

    const f3 = (x: { A: number; B: number; C: number } | null) => (x ? `${x.A}/${x.B}/${x.C}` : "-");
    console.log(
      `| ${nameOf.get(uid)}${markers.has(uid) ? "(T)" : ""} | ${e.A}/${e.B}/${e.C} | ${c ? `${c.pointA}/${c.pointB}/${c.pointC}` : "-"} | ${wA}/${wRaw - wC}/${wC} | ${rs ? `${rs.poA}/${rs.poB}/${rs.poC}` : "-"} | ${f3(card)} | ${issues.length ? "❌ " + issues.join(" / ") : "✅"} |`,
    );
  }

  console.log(`\n대상 ${ids.length}명 · 실패 ${fail}명`);
  console.log("=== DONE (writes: 0) ===");
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });
