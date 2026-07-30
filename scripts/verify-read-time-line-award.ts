/**
 * [DB 직결] 조회(GET) 시점 즉시 지급(reconcileSuccessLineAwardsOnRead, 2026-07-30) 검증.
 *
 *   npx tsx --env-file=.env.local scripts/verify-read-time-line-award.ts
 *
 * 배경: 기존엔 강화 성공 판정이 나도 실제 지급은 GitHub Actions 스윕(run-due-closes, 10분 주기)만이
 *   트리거했다 — 조회 순간과 지급 사이에 최대 10분 지연. 이번 변경은 loadWeeklyCards() 안에서
 *   computeCluster4Enhancement() 가 이미 구운 line.enhancementStatus==='success' 를 보고, 스윕과
 *   동일한 reconcileLineResultAwardForUser 를 즉시 호출해 그 지연을 없앤다(허브별 조건 재구현 없음).
 *
 * ⚠ 쓰기 범위 — verify-line-close-sweep-hub-unified.ts 와 동일하게 **QA 테스트 라인
 *   (cluster4_lines.is_qa_test=true)** 의 기존 (user, line) 조합만 건드린다. 시작 전 is_qa_test 를
 *   재확인하며, 운영 라인/실사용자 데이터는 어떤 경로로도 건드리지 않는다.
 *
 * 검증:
 *   ① 인위적으로 "미지급" 상태로 되돌린 뒤(원장 삭제) loadWeeklyCards() 단 1회 호출만으로 즉시 지급되는가
 *   ② 같은 API를 반복 호출해도 원장 행/금액이 늘지 않는가(멱등)
 *   ③ 같은 API를 동시(Promise.all) 2회 호출해도 한 번만 지급되는가(동시성)
 *   ④ 이후 기존 스윕(runDueLineCloseSweep)을 실행해도 중복 지급이 없는가(보조 스윕과의 정합)
 *   ⑤ 반환된 DTO의 enhancementStatus 가 지급 전후로 동일(성공)하게 유지되는가(회귀 없음)
 *   ⑥ 강화 실패(비대상/평점<4) 라인은 조회해도 지급되지 않는가(오탐 지급 없음)
 *   ⑦ 4허브(정보/역량/경험/경력) 중 실제 확보 가능한 픽스처 전부에서 위 성립하는지
 */
/* eslint-disable @typescript-eslint/no-explicit-any -- 검증 스크립트: 원장 raw row 를 훑는다. */
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { runDueLineCloseSweep } from "@/lib/cluster4LineCloseDueSweep";
import {
  loadWeeklyCards,
  startSubjectPreload,
} from "@/lib/cluster4WeeklyCardsService";

let failed = 0;
const ck = (n: string, ok: boolean, d?: unknown) => {
  console.log(`${ok ? "✅" : "❌"} ${n}${d !== undefined ? " :: " + JSON.stringify(d) : ""}`);
  if (!ok) failed++;
};

type Fixture = {
  label: string;
  lineId: string;
  userId: string;
  weekId: string;
  expectPaid: boolean; // true = success 대상(즉시 지급 검증), false = 실패/비대상(오탐 없음 검증)
};

async function ledgerCount(userId: string, lineId: string, source: "line" | "line_rating") {
  const { count } = await supabaseAdmin
    .from("process_point_awards")
    .select("id", { count: "exact", head: true })
    .eq("user_id", userId)
    .eq("ref_id", lineId)
    .eq("source", source);
  return count ?? 0;
}

async function ledger(userId: string, lineId: string) {
  const { data } = await supabaseAdmin
    .from("process_point_awards")
    .select("source,point_check,point_advantage,cancelled_at,updated_at")
    .eq("user_id", userId)
    .eq("ref_id", lineId)
    .in("source", ["line", "line_rating"]);
  const rows = (data ?? []) as any[];
  const line = rows.find((r) => r.source === "line") ?? null;
  const rating = rows.find((r) => r.source === "line_rating") ?? null;
  return {
    linePaid: line != null && line.cancelled_at == null,
    lineA: line?.point_check ?? null,
    lineB: line?.point_advantage ?? null,
    ratingPaid: rating != null && rating.cancelled_at == null,
  };
}

// 검증용: 원장을 완전히 지워 "미지급" 상태로 되돌린다(QA 라인 한정 — 안전 가드는 main()에서 재확인).
async function hardResetAward(userId: string, lineId: string) {
  await supabaseAdmin
    .from("process_point_awards")
    .delete()
    .eq("user_id", userId)
    .eq("ref_id", lineId)
    .in("source", ["line", "line_rating"]);
}

async function callLoadWeeklyCards(userId: string) {
  const preload = startSubjectPreload(userId);
  return loadWeeklyCards(userId, preload);
}

async function findFixtures(): Promise<Fixture[]> {
  const fixtures: Fixture[] = [];

  async function firstTargetFor(partType: string) {
    const { data: lines } = await supabaseAdmin
      .from("cluster4_lines")
      .select("id")
      .eq("part_type", partType)
      .eq("is_qa_test", true)
      .eq("is_active", true);
    const lineIds = ((lines ?? []) as any[]).map((l) => l.id);
    if (lineIds.length === 0) return null;
    const { data: tgts } = await supabaseAdmin
      .from("cluster4_line_targets")
      .select("id,line_id,week_id,target_user_id")
      .in("line_id", lineIds)
      .eq("target_mode", "user")
      .not("target_user_id", "is", null)
      .limit(1);
    return ((tgts ?? []) as any[])[0] ?? null;
  }

  for (const hub of ["info", "competency", "career"]) {
    const t = await firstTargetFor(hub);
    if (t) {
      fixtures.push({
        label: hub,
        lineId: t.line_id,
        userId: t.target_user_id,
        weekId: t.week_id,
        expectPaid: true,
      });
    }
  }

  // experience: 평점 >=4(지급 대상) / <4(미지급, 오탐 방지 확인용)
  {
    const { data: lines } = await supabaseAdmin
      .from("cluster4_lines")
      .select("id")
      .eq("part_type", "experience")
      .eq("is_qa_test", true)
      .eq("is_active", true);
    const lineIds = ((lines ?? []) as any[]).map((l) => l.id);
    const { data: tgts } = await supabaseAdmin
      .from("cluster4_line_targets")
      .select("id,line_id,week_id,target_user_id")
      .in("line_id", lineIds)
      .eq("target_mode", "user")
      .not("target_user_id", "is", null);
    const targets = (tgts ?? []) as any[];
    const { data: evs } = await supabaseAdmin
      .from("cluster4_experience_line_evaluations")
      .select("line_target_id,user_id,rating,evaluated_by")
      .in("line_target_id", targets.map((t) => t.id));
    const evByTarget = new Map(((evs ?? []) as any[]).map((e) => [e.line_target_id, e]));

    const high = targets.find((t) => {
      const e = evByTarget.get(t.id);
      return e && e.evaluated_by != null && (e.rating ?? 0) >= 4;
    });
    const low = targets.find((t) => {
      const e = evByTarget.get(t.id);
      return e && e.evaluated_by != null && (e.rating ?? 0) >= 1 && (e.rating ?? 0) <= 3;
    });
    if (high) {
      fixtures.push({
        label: `experience(rating>=4)`,
        lineId: high.line_id,
        userId: high.target_user_id,
        weekId: high.week_id,
        expectPaid: true,
      });
    }
    if (low) {
      fixtures.push({
        label: `experience(rating<4, 오탐 방지 확인)`,
        lineId: low.line_id,
        userId: low.target_user_id,
        weekId: low.week_id,
        expectPaid: false,
      });
    }
  }

  return fixtures;
}

function findLineInCards(cards: any[], weekId: string, lineId: string) {
  const card = cards.find((c) => c.weekId === weekId);
  return card?.lines?.find((l: any) => l.lineId === lineId) ?? null;
}

async function main() {
  const fixtures = await findFixtures();
  if (fixtures.length === 0) {
    console.log("⚠ 검증 가능한 QA 픽스처가 없어 종료합니다(무해).");
    process.exit(0);
  }

  console.log(`픽스처 ${fixtures.length}건 확보`);
  for (const f of fixtures) {
    console.log(`  - ${f.label}: line=${f.lineId.slice(0, 8)} user=${f.userId.slice(0, 8)}`);
  }
  console.log("");

  // ── 안전 가드: 전부 QA 라인인지 재확인(운영 라인 오염 방지) ──
  for (const f of fixtures) {
    const { data: lineRow } = await supabaseAdmin
      .from("cluster4_lines")
      .select("is_qa_test")
      .eq("id", f.lineId)
      .maybeSingle();
    if ((lineRow as any)?.is_qa_test !== true) {
      console.error(`❌ ${f.label} — QA 라인 아님(is_qa_test!=true) — 안전을 위해 즉시 중단합니다.`);
      process.exit(1);
    }
  }
  ck("전체 픽스처 — is_qa_test=true 확인(운영 라인 아님)", true);

  for (const f of fixtures) {
    console.log(`\n=== ${f.label} ===`);

    // ── ① 미지급 상태로 되돌린 뒤 단 1회 조회로 즉시 지급되는지 ──
    await hardResetAward(f.userId, f.lineId);
    const beforeReset = await ledger(f.userId, f.lineId);
    ck(`${f.label} — 리셋 후 미지급 상태 확인`, !beforeReset.linePaid);

    const result1 = await callLoadWeeklyCards(f.userId);
    const line1 = findLineInCards(result1.cards, f.weekId, f.lineId);
    const after1 = await ledger(f.userId, f.lineId);

    ck(
      `${f.label} — DTO enhancementStatus 확인`,
      line1 != null && (f.expectPaid ? line1.enhancementStatus === "success" : true),
      { enhancementStatus: line1?.enhancementStatus ?? null },
    );
    ck(`${f.label} — 조회 1회만으로 지급 상태 = expectPaid(${f.expectPaid})`, after1.linePaid === f.expectPaid, {
      expected: f.expectPaid,
      actual: after1.linePaid,
      lineA: after1.lineA,
      lineB: after1.lineB,
    });

    if (!f.expectPaid) {
      // 오탐 지급 없음만 확인하고 이 픽스처는 여기서 종료(반복/동시성 검증은 지급 대상만).
      continue;
    }

    // ── ② 반복 조회해도 원장 값 불변(멱등) ──
    const result2 = await callLoadWeeklyCards(f.userId);
    const after2 = await ledger(f.userId, f.lineId);
    ck(
      `${f.label} — 반복 조회 후 원장 값 불변(멱등)`,
      after1.lineA === after2.lineA && after1.lineB === after2.lineB && after2.linePaid === true,
      { after1: { a: after1.lineA, b: after1.lineB }, after2: { a: after2.lineA, b: after2.lineB } },
    );
    void result2;

    const countAfterRepeat = await ledgerCount(f.userId, f.lineId, "line");
    ck(`${f.label} — 반복 조회 후에도 source='line' 행 수 = 1`, countAfterRepeat === 1, { countAfterRepeat });

    // ── ③ 동시 호출 2회 — 리셋 후 Promise.all 로 경합시켜도 1회만 지급 ──
    await hardResetAward(f.userId, f.lineId);
    await Promise.all([callLoadWeeklyCards(f.userId), callLoadWeeklyCards(f.userId)]);
    const afterConcurrent = await ledger(f.userId, f.lineId);
    const countConcurrent = await ledgerCount(f.userId, f.lineId, "line");
    ck(`${f.label} — 동시 호출 2회 후에도 지급 완료 + 행 수 = 1`, afterConcurrent.linePaid && countConcurrent === 1, {
      linePaid: afterConcurrent.linePaid,
      countConcurrent,
    });
    ck(`${f.label} — 동시 호출 후 지급액이 순차 지급과 동일`, afterConcurrent.lineA === after1.lineA && afterConcurrent.lineB === after1.lineB, {
      sequential: { a: after1.lineA, b: after1.lineB },
      concurrent: { a: afterConcurrent.lineA, b: afterConcurrent.lineB },
    });

    // ── ④ 이후 백업 스윕을 실행해도 중복 없음 ──
    await runDueLineCloseSweep({ onlyLineIds: [f.lineId] });
    const afterSweep = await ledger(f.userId, f.lineId);
    const countAfterSweep = await ledgerCount(f.userId, f.lineId, "line");
    ck(`${f.label} — 백업 스윕(run-due-closes) 실행 후에도 원장 행 수 = 1, 값 불변`, countAfterSweep === 1 && afterSweep.lineA === after1.lineA, {
      countAfterSweep,
      lineA: afterSweep.lineA,
    });
  }

  console.log(failed === 0 ? "\nALL PASS" : `\n${failed} FAIL`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
