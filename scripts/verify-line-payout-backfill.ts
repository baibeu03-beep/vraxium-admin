/**
 * 백필 검증(§8) — 실행 전 capture / 실행 후 check.
 *   npx tsx --env-file=.env.local scripts/verify-line-payout-backfill.ts capture
 *   (apply --apply 2회 실행)
 *   npx tsx --env-file=.env.local scripts/verify-line-payout-backfill.ts check
 *
 * 기대 대상(payable 19쌍)은 dry-run JSON 에서 읽는다(status==payable 의 payableUsers).
 * capture 는 읽기 전용으로 before 상태를 scratchpad 스냅샷에 저장, check 는 after 상태와 대조.
 */
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import * as fs from "node:fs";

const MODE = process.argv[2];
const DRYRUN = "claudedocs/line-payout-backfill-dryrun-2026-07-15.json";
const SNAP = "scratchpad-backfill-before.json"; // repo 외부 상대경로(작업 디렉터리)
const YEAR = 2026, ISOWK = 28;

type Pair = { lineId: string; userId: string; pointA: number; pointB: number };

function expectedPairs(): Pair[] {
  const j = JSON.parse(fs.readFileSync(DRYRUN, "utf8"));
  const pairs: Pair[] = [];
  for (const p of j.perLine as any[]) {
    if (p.status !== "payable") continue;
    for (const u of p.payableUsers as string[]) pairs.push({ lineId: p.lineId, userId: u, pointA: p.pointA ?? 0, pointB: p.pointB ?? 0 });
  }
  return pairs;
}

async function allLineAwards() {
  const { data } = await supabaseAdmin.from("process_point_awards")
    .select("id,ref_id,user_id,point_check,point_advantage,scope_mode,year,week_number,cancelled_at").eq("source", "line");
  return (data ?? []) as Array<{ id: string; ref_id: string; user_id: string; point_check: number; point_advantage: number; scope_mode: string; year: number; week_number: number; cancelled_at: string | null }>;
}
async function uwpFor(userIds: string[]) {
  const out: Record<string, { points: number; advantages: number }> = {};
  for (let i = 0; i < userIds.length; i += 100) {
    const { data } = await supabaseAdmin.from("user_weekly_points").select("user_id,points,advantages").eq("year", YEAR).eq("week_number", ISOWK).in("user_id", userIds.slice(i, i + 100));
    for (const r of (data ?? []) as any[]) out[r.user_id] = { points: r.points, advantages: r.advantages };
  }
  return out;
}

async function main() {
  const pairs = expectedPairs();
  const users = [...new Set(pairs.map((p) => p.userId))];

  if (MODE === "capture") {
    const awards = await allLineAwards();
    const before = {
      capturedAt: new Date().toISOString(),
      lineAwardTotal: awards.length,
      fingerprint: awards.map((a) => `${a.id}:${a.ref_id}:${a.user_id}:${a.point_check}:${a.point_advantage}:${a.scope_mode}:${a.cancelled_at ?? ""}`).sort(),
      operatingCount: awards.filter((a) => a.scope_mode === "operating").length,
      uwpBefore: await uwpFor(users),
    };
    fs.writeFileSync(SNAP, JSON.stringify(before, null, 2));
    console.log(`[capture] lineAwards=${before.lineAwardTotal} operating=${before.operatingCount} expectedPairs=${pairs.length} users=${users.length}`);
    process.exit(0);
  }

  if (MODE === "check") {
    const before = JSON.parse(fs.readFileSync(SNAP, "utf8"));
    const beforeIds = new Set<string>((before.fingerprint as string[]).map((f) => f.split(":")[0]));
    const awards = await allLineAwards();
    const fresh = awards.filter((a) => !beforeIds.has(a.id)); // 백필로 신규 생성된 원장
    let fail = 0;
    const ck = (n: string, ok: boolean, d?: unknown) => { console.log(`${ok ? "✅" : "❌"} ${n}${d !== undefined ? " :: " + JSON.stringify(d) : ""}`); if (!ok) fail++; };

    // ① 신규 원장 전부 test scope + test 유저 + 올바른 주차
    const testIds = await (await import("@/lib/testUsers")).fetchTestUserMarkerIds();
    ck(`① 신규 원장 ${fresh.length}행 전부 scope_mode=test·test유저·${YEAR}/${ISOWK}`,
      fresh.length > 0 && fresh.every((a) => a.scope_mode === "test" && testIds.has(a.user_id) && a.year === YEAR && a.week_number === ISOWK),
      { fresh: fresh.length });

    // ② 신규 원장은 실제 (line,user) 타깃과 일치(팬텀 아님)
    const freshLines = [...new Set(fresh.map((a) => a.ref_id))];
    const tgtSet = new Set<string>();
    for (let i = 0; i < freshLines.length; i += 100) {
      const { data } = await supabaseAdmin.from("cluster4_line_targets").select("line_id,target_user_id").eq("target_mode", "user").in("line_id", freshLines.slice(i, i + 100));
      for (const t of (data ?? []) as any[]) if (t.target_user_id) tgtSet.add(`${t.line_id}:${t.target_user_id}`);
    }
    ck(`② 신규 원장 전부 실제 대상자 타깃과 일치`, fresh.every((a) => tgtSet.has(`${a.ref_id}:${a.user_id}`)));

    const aSum = fresh.reduce((s, a) => s + a.point_check, 0), bSum = fresh.reduce((s, a) => s + a.point_advantage, 0);
    console.log(`   → 신규 지급 쌍=${fresh.length} · 라인=${freshLines.length} · Point A 합=${aSum} · Point B 합=${bSum}`);

    // ③ 기존 원장 지문 전부 불변(값·취소상태 보존)
    const afterFp = new Set(awards.map((a) => `${a.id}:${a.ref_id}:${a.user_id}:${a.point_check}:${a.point_advantage}:${a.scope_mode}:${a.cancelled_at ?? ""}`));
    const preserved = (before.fingerprint as string[]).every((f) => afterFp.has(f));
    ck(`③ 기존 ${before.lineAwardTotal}개 원장 값·취소상태 불변(전부 보존)`, preserved);

    // ④ operating scope 원장 증가 0
    const opAfter = awards.filter((a) => a.scope_mode === "operating").length;
    ck(`④ operating scope 원장 증가 0(${before.operatingCount}→${opAfter})`, opAfter === before.operatingCount);

    // ⑤ uwp SoT 불변식 — 영향 사용자마다 uwp == (해당 주차 전 소스 원장 합, 취소 제외)
    const affected = [...new Set(fresh.map((a) => a.user_id))];
    const uwpAfter = await uwpFor(affected);
    let uwpOk = true;
    for (const u of affected) {
      const { data } = await supabaseAdmin.from("process_point_awards")
        .select("point_check,point_advantage").eq("user_id", u).eq("year", YEAR).eq("week_number", ISOWK).is("cancelled_at", null);
      const sumC = ((data ?? []) as any[]).reduce((s, r) => s + (r.point_check || 0), 0);
      const sumA = ((data ?? []) as any[]).reduce((s, r) => s + (r.point_advantage || 0), 0);
      const w = uwpAfter[u] ?? { points: 0, advantages: 0 };
      if (w.points !== sumC || w.advantages !== sumA) { uwpOk = false; console.log("  ✗ uwp≠ledger", u, { uwp: w, ledgerC: sumC, ledgerA: sumA }); }
    }
    ck(`⑤ user_weekly_points == 원장 합(영향 ${affected.length}명, SoT 재합산 반영)`, uwpOk);

    console.log(fail === 0 ? "\nALL PASS" : `\n${fail} FAIL`);
    process.exit(fail === 0 ? 0 : 1);
  }

  console.error("mode must be 'capture' or 'check'");
  process.exit(1);
}
main().catch((e) => { console.error(e); process.exit(1); });
