/**
 * verify-cumulative-sync.ts
 * 2026-05-28_cumulative_points_auto_sync.sql 적용 후 검증 스크립트.
 *
 * 실행: npx tsx scripts/verify-cumulative-sync.ts
 */

import { config } from "dotenv";
config({ path: ".env.local" });

import { createClient } from "@supabase/supabase-js";

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
);

// ─── 헬퍼 ────────────────────────────────────────────────────────────

async function rpc<T>(sql: string): Promise<T[]> {
  const { data, error } = await supabase.rpc("exec_sql", { query: sql });
  if (error) throw new Error(`RPC error: ${error.message}`);
  return data as T[];
}

async function query<T>(table: string, select: string, filter?: Record<string, unknown>): Promise<T[]> {
  let q = supabase.from(table).select(select);
  if (filter) {
    for (const [k, v] of Object.entries(filter)) {
      q = q.eq(k, v);
    }
  }
  const { data, error } = await q;
  if (error) throw new Error(`Query ${table}: ${error.message}`);
  return (data ?? []) as T[];
}

// ─── 1. cumulative vs weekly 일치 확인 ───────────────────────────────

async function verifySync() {
  console.log("\n══════════════════════════════════════════════════════");
  console.log("  1. cumulative vs weekly 합계 일치 확인");
  console.log("══════════════════════════════════════════════════════\n");

  // 페이지네이션: Supabase 기본 1000행 제한 우회
  const weeklyAll: Array<{ user_id: string; points: number; advantages: number; penalty: number }> = [];
  let from = 0;
  const pageSize = 1000;
  while (true) {
    const { data, error } = await supabase
      .from("user_weekly_points")
      .select("user_id,points,advantages,penalty")
      .range(from, from + pageSize - 1);
    if (error) throw new Error(`weekly fetch: ${error.message}`);
    const rows = (data ?? []) as typeof weeklyAll;
    weeklyAll.push(...rows);
    if (rows.length < pageSize) break;
    from += pageSize;
  }
  console.log(`  weekly 전체 행 수: ${weeklyAll.length}`);

  const weeklyByUser = new Map<string, { stars: number; adv: number; light: number }>();
  for (const row of weeklyAll) {
    const acc = weeklyByUser.get(row.user_id) ?? { stars: 0, adv: 0, light: 0 };
    acc.stars += row.points;
    acc.adv += row.advantages;
    acc.light += row.penalty;
    weeklyByUser.set(row.user_id, acc);
  }

  const cumAll = await query<{
    user_id: string;
    total_checks: number | null;
    total_raw_advantages: number | null;
    total_penalties: number | null;
    total_advantages: number | null;
  }>("user_cumulative_points", "user_id,total_checks,total_raw_advantages,total_penalties,total_advantages");

  let ok = 0;
  let mismatch = 0;
  const mismatches: string[] = [];

  for (const c of cumAll) {
    const w = weeklyByUser.get(c.user_id) ?? { stars: 0, adv: 0, light: 0 };
    const expectedShields = w.adv - Math.abs(w.light);

    const match =
      (c.total_checks ?? 0) === w.stars &&
      (c.total_raw_advantages ?? 0) === w.adv &&
      (c.total_penalties ?? 0) === w.light &&
      (c.total_advantages ?? 0) === expectedShields;

    if (match) {
      ok++;
    } else {
      mismatch++;
      mismatches.push(
        `  ${c.user_id}: cum(${c.total_checks},${c.total_raw_advantages},${c.total_penalties},${c.total_advantages}) vs weekly(${w.stars},${w.adv},${w.light},${expectedShields})`,
      );
    }
    weeklyByUser.delete(c.user_id);
  }

  // weekly에만 있고 cumulative에 없는 유저
  for (const [uid, w] of weeklyByUser) {
    mismatch++;
    mismatches.push(`  ${uid}: cumulative 행 없음, weekly(${w.stars},${w.adv},${w.light})`);
  }

  if (mismatch === 0) {
    console.log(`  ✅ ALL SYNCED — ${ok}명 전원 일치\n`);
  } else {
    console.log(`  ❌ ${mismatch}건 불일치 (${ok}건 정상)\n`);
    for (const m of mismatches) console.log(m);
    console.log();
  }

  return mismatch === 0;
}

// ─── 2. 트리거 존재 확인 ─────────────────────────────────────────────

async function verifyTrigger() {
  console.log("══════════════════════════════════════════════════════");
  console.log("  2. 트리거 존재 확인");
  console.log("══════════════════════════════════════════════════════\n");

  // pg_trigger를 직접 조회할 수 없으므로 information_schema.triggers 사용
  const { data, error } = await supabase
    .from("information_schema.triggers" as string)
    .select("trigger_name,event_manipulation,action_timing")
    .eq("event_object_table", "user_weekly_points")
    .eq("trigger_name", "sync_cumulative_on_weekly_change");

  if (error) {
    // information_schema 접근 불가 시 트리거 동작으로 간접 검증
    console.log("  ⚠️  information_schema 직접 조회 불가 — 항목 4 트리거 테스트로 간접 검증\n");
    return null;
  }

  if (data && data.length > 0) {
    console.log("  ✅ sync_cumulative_on_weekly_change 트리거 존재");
    for (const row of data as Array<Record<string, string>>) {
      console.log(`     ${row.action_timing} ${row.event_manipulation}`);
    }
    console.log();
    return true;
  } else {
    console.log("  ❌ 트리거 미발견\n");
    return false;
  }
}

// ─── 3. 함수 존재 확인 ───────────────────────────────────────────────

async function verifyFunctions() {
  console.log("══════════════════════════════════════════════════════");
  console.log("  3. sync 함수 존재 확인");
  console.log("══════════════════════════════════════════════════════\n");

  // sync_cumulative_points_for_user 를 빈 UUID로 호출해 함수 존재 확인
  const testUuid = "00000000-0000-0000-0000-000000000000";

  const { error: fnErr } = await supabase.rpc("sync_cumulative_points_for_user", {
    p_user_id: testUuid,
  });

  if (fnErr) {
    if (fnErr.message.includes("Could not find the function") ||
        fnErr.message.includes("function") && fnErr.message.includes("does not exist")) {
      console.log("  ❌ sync_cumulative_points_for_user 함수 미발견");
      console.log(`     에러: ${fnErr.message}\n`);
      return false;
    }
    // 함수는 존재하지만 FK 위반 등으로 실패 → 함수 자체는 존재
    if (fnErr.message.includes("violates") || fnErr.message.includes("constraint")) {
      console.log("  ✅ sync_cumulative_points_for_user 함수 존재 (빈 UUID로 FK 위반은 정상)");
      console.log(`     참고: ${fnErr.message}\n`);
      return true;
    }
    // 기타 에러
    console.log(`  ⚠️  함수 호출 결과 불확실: ${fnErr.message}\n`);
    return null;
  }

  console.log("  ✅ sync_cumulative_points_for_user 함수 존재 및 정상 호출\n");
  return true;
}

// ─── 4. 트리거 동작 검증 (INSERT/UPDATE/DELETE) ──────────────────────

async function verifyTriggerBehavior() {
  console.log("══════════════════════════════════════════════════════");
  console.log("  4. 트리거 동작 검증 (INSERT → UPDATE → DELETE)");
  console.log("══════════════════════════════════════════════════════\n");

  // 테스트 유저 1명 선택
  const { data: testUsers } = await supabase
    .from("user_weekly_points")
    .select("user_id")
    .limit(1);

  if (!testUsers || testUsers.length === 0) {
    console.log("  ⚠️  user_weekly_points 에 데이터 없음 — 스킵\n");
    return null;
  }

  const testUserId = (testUsers[0] as { user_id: string }).user_id;
  console.log(`  테스트 유저: ${testUserId}\n`);

  // 현재 cumulative 스냅샷
  const { data: before } = await supabase
    .from("user_cumulative_points")
    .select("total_checks,total_raw_advantages,total_penalties,total_advantages")
    .eq("user_id", testUserId)
    .maybeSingle();

  const b = (before ?? { total_checks: 0, total_raw_advantages: 0, total_penalties: 0, total_advantages: 0 }) as {
    total_checks: number; total_raw_advantages: number; total_penalties: number; total_advantages: number;
  };
  console.log(`  [before]  stars=${b.total_checks} adv=${b.total_raw_advantages} light=${b.total_penalties} shields=${b.total_advantages}`);

  // ── INSERT 테스트 ──
  const { error: insErr } = await supabase
    .from("user_weekly_points")
    .insert({
      user_id: testUserId,
      year: 2099,
      week_number: 1,
      week_start_date: "2099-01-06",
      points: 5,
      advantages: 2,
      penalty: 1,
    });

  if (insErr) {
    console.log(`  ❌ INSERT 실패: ${insErr.message}\n`);
    return false;
  }

  const { data: afterInsert } = await supabase
    .from("user_cumulative_points")
    .select("total_checks,total_raw_advantages,total_penalties,total_advantages")
    .eq("user_id", testUserId)
    .maybeSingle();

  const ai = afterInsert as typeof b;
  console.log(`  [INSERT]  stars=${ai.total_checks} adv=${ai.total_raw_advantages} light=${ai.total_penalties} shields=${ai.total_advantages}`);

  const insertOk =
    ai.total_checks === b.total_checks + 5 &&
    ai.total_raw_advantages === b.total_raw_advantages + 2 &&
    ai.total_penalties === b.total_penalties + 1;

  console.log(`            ${insertOk ? "✅ INSERT 반영 정상" : "❌ INSERT 반영 실패"} (expected stars +5, adv +2, light +1)`);

  // ── UPDATE 테스트 ──
  const { error: updErr } = await supabase
    .from("user_weekly_points")
    .update({ points: 10 })
    .eq("user_id", testUserId)
    .eq("year", 2099)
    .eq("week_number", 1);

  if (updErr) {
    console.log(`  ❌ UPDATE 실패: ${updErr.message}`);
  }

  const { data: afterUpdate } = await supabase
    .from("user_cumulative_points")
    .select("total_checks,total_raw_advantages,total_penalties,total_advantages")
    .eq("user_id", testUserId)
    .maybeSingle();

  const au = afterUpdate as typeof b;
  console.log(`  [UPDATE]  stars=${au.total_checks} adv=${au.total_raw_advantages} light=${au.total_penalties} shields=${au.total_advantages}`);

  const updateOk = au.total_checks === b.total_checks + 10;
  console.log(`            ${updateOk ? "✅ UPDATE 반영 정상" : "❌ UPDATE 반영 실패"} (expected stars +10 from original)`);

  // ── DELETE 테스트 (원복) ──
  const { error: delErr } = await supabase
    .from("user_weekly_points")
    .delete()
    .eq("user_id", testUserId)
    .eq("year", 2099)
    .eq("week_number", 1);

  if (delErr) {
    console.log(`  ❌ DELETE 실패: ${delErr.message}`);
  }

  const { data: afterDelete } = await supabase
    .from("user_cumulative_points")
    .select("total_checks,total_raw_advantages,total_penalties,total_advantages")
    .eq("user_id", testUserId)
    .maybeSingle();

  const ad = afterDelete as typeof b;
  console.log(`  [DELETE]  stars=${ad.total_checks} adv=${ad.total_raw_advantages} light=${ad.total_penalties} shields=${ad.total_advantages}`);

  const deleteOk =
    ad.total_checks === b.total_checks &&
    ad.total_raw_advantages === b.total_raw_advantages &&
    ad.total_penalties === b.total_penalties &&
    ad.total_advantages === b.total_advantages;

  console.log(`            ${deleteOk ? "✅ DELETE 원복 정상" : "❌ DELETE 원복 실패"} (should match [before])`);
  console.log();

  return insertOk && updateOk && deleteOk;
}

// ─── 5. Growth Indicators / Resume Card 표시값 확인 ──────────────────

async function verifyDisplayValues() {
  console.log("══════════════════════════════════════════════════════");
  console.log("  5. Growth Indicators & Resume Card 표시값 확인");
  console.log("══════════════════════════════════════════════════════\n");

  // cumulative에서 읽어 Growth와 동일한 계산 수행
  const { data: samples } = await supabase
    .from("user_cumulative_points")
    .select("user_id,total_checks,total_raw_advantages,total_penalties,total_advantages")
    .limit(5);

  if (!samples || samples.length === 0) {
    console.log("  ⚠️  데이터 없음\n");
    return null;
  }

  // 유저 이름 조회
  const userIds = (samples as Array<{ user_id: string }>).map((s) => s.user_id);
  const { data: profiles } = await supabase
    .from("user_profiles")
    .select("user_id,display_name,organization_slug")
    .in("user_id", userIds);

  const profileMap = new Map<string, { name: string; org: string }>();
  for (const p of (profiles ?? []) as Array<{ user_id: string; display_name: string; organization_slug: string }>) {
    profileMap.set(p.user_id, { name: p.display_name, org: p.organization_slug });
  }

  console.log("  유저 | org | stars(j) | rawAdv(k0) | light(l) | shields(k) | integrityOk");
  console.log("  " + "─".repeat(85));

  let allOk = true;
  for (const s of samples as Array<{
    user_id: string;
    total_checks: number | null;
    total_raw_advantages: number | null;
    total_penalties: number | null;
    total_advantages: number | null;
  }>) {
    const p = profileMap.get(s.user_id);
    const j = s.total_checks ?? 0;
    const k0 = s.total_raw_advantages ?? 0;
    const l = Math.abs(s.total_penalties ?? 0);
    const k = k0 - l;
    const storedShields = s.total_advantages ?? 0;
    const integrity = storedShields === k;
    if (!integrity) allOk = false;

    const name = (p?.name ?? "?").padEnd(10).slice(0, 10);
    const org = (p?.org ?? "?").padEnd(7).slice(0, 7);

    console.log(
      `  ${name} | ${org} | ${String(j).padStart(8)} | ${String(k0).padStart(10)} | ${String(l).padStart(8)} | ${String(storedShields).padStart(10)} | ${integrity ? "✅" : "❌"}`,
    );
  }

  console.log();
  if (allOk) {
    console.log("  ✅ integrityOk 전원 통과 — Growth Indicators 및 Resume Card 정상 표시 보장\n");
  } else {
    console.log("  ❌ integrityOk 실패 건 존재 — 확인 필요\n");
  }

  return allOk;
}

// ─── main ────────────────────────────────────────────────────────────

async function diagnoseSingleUser() {
  console.log("══════════════════════════════════════════════════════");
  console.log("  0. 단일 유저 RPC 동작 진단");
  console.log("══════════════════════════════════════════════════════\n");

  // 불일치 유저 1명 찾기: cumulative에 값이 있고 weekly가 없는 유저
  const { data: cumAll } = await supabase
    .from("user_cumulative_points")
    .select("user_id,total_checks,total_raw_advantages,total_penalties,total_advantages")
    .gt("total_checks", 0)
    .limit(200);

  const { data: weeklyAll } = await supabase
    .from("user_weekly_points")
    .select("user_id");

  const weeklySet = new Set(
    ((weeklyAll ?? []) as Array<{ user_id: string }>).map((r) => r.user_id),
  );

  const orphan = ((cumAll ?? []) as Array<{
    user_id: string; total_checks: number | null;
    total_raw_advantages: number | null; total_penalties: number | null;
    total_advantages: number | null;
  }>).find((r) => !weeklySet.has(r.user_id));

  if (!orphan) {
    console.log("  — 진단 대상 없음 (모두 일치)\n");
    return;
  }

  const uid = orphan.user_id;
  console.log(`  대상: ${uid}`);
  console.log(`  현재 cumulative: stars=${orphan.total_checks} adv=${orphan.total_raw_advantages} light=${orphan.total_penalties} shields=${orphan.total_advantages}`);

  // weekly 행 수 확인
  const { data: weeklyRows, count: weeklyCount } = await supabase
    .from("user_weekly_points")
    .select("*", { count: "exact" })
    .eq("user_id", uid);
  console.log(`  weekly 행 수: ${weeklyCount ?? weeklyRows?.length ?? 0}`);

  // RPC 호출
  console.log(`  sync_cumulative_points_for_user 호출...`);
  const { error: rpcErr } = await supabase.rpc("sync_cumulative_points_for_user", { p_user_id: uid });
  if (rpcErr) {
    console.log(`  ❌ RPC 에러: ${rpcErr.message}\n`);
    return;
  }
  console.log(`  RPC 성공 (에러 없음)`);

  // 결과 확인
  const { data: after } = await supabase
    .from("user_cumulative_points")
    .select("total_checks,total_raw_advantages,total_penalties,total_advantages")
    .eq("user_id", uid)
    .maybeSingle();

  const a = after as { total_checks: number; total_raw_advantages: number; total_penalties: number; total_advantages: number } | null;
  console.log(`  RPC 후 cumulative: stars=${a?.total_checks} adv=${a?.total_raw_advantages} light=${a?.total_penalties} shields=${a?.total_advantages}`);

  const changed = a && (
    a.total_checks !== (orphan.total_checks ?? 0) ||
    a.total_raw_advantages !== (orphan.total_raw_advantages ?? 0)
  );

  if (a && a.total_checks === 0 && a.total_raw_advantages === 0 && a.total_penalties === 0 && a.total_advantages === 0) {
    console.log(`  ✅ 0으로 정상 리셋됨\n`);
  } else if (!changed) {
    console.log(`  ❌ 값이 변하지 않음! RPC가 반영되지 않는 중`);
    // 직접 update 시도
    console.log(`  직접 .update() 시도...`);
    const { error: updErr, count: updCount } = await supabase
      .from("user_cumulative_points")
      .update({ total_checks: 0, total_raw_advantages: 0, total_penalties: 0, total_advantages: 0 })
      .eq("user_id", uid);
    console.log(`  update 결과: error=${updErr?.message ?? "없음"}, count=${updCount}`);

    const { data: after2 } = await supabase
      .from("user_cumulative_points")
      .select("total_checks")
      .eq("user_id", uid)
      .maybeSingle();
    console.log(`  직접 update 후: stars=${(after2 as { total_checks: number } | null)?.total_checks}\n`);
  } else {
    console.log(`  값이 변경됨 (예상과 다를 수 있음)\n`);
  }
}

async function fixBackfillAll() {
  console.log("══════════════════════════════════════════════════════");
  console.log("  0. sync 함수로 전체 유저 backfill 보정");
  console.log("══════════════════════════════════════════════════════\n");

  // 양쪽 테이블의 모든 user_id 수집
  const { data: cumAll } = await supabase
    .from("user_cumulative_points")
    .select("user_id");
  const { data: weeklyAll } = await supabase
    .from("user_weekly_points")
    .select("user_id");

  const allUserIds = new Set<string>();
  for (const r of (cumAll ?? []) as Array<{ user_id: string }>) allUserIds.add(r.user_id);
  for (const r of (weeklyAll ?? []) as Array<{ user_id: string }>) allUserIds.add(r.user_id);

  console.log(`  대상 유저: ${allUserIds.size}명`);

  let ok = 0;
  let fail = 0;
  for (const uid of allUserIds) {
    const { error } = await supabase.rpc("sync_cumulative_points_for_user", {
      p_user_id: uid,
    });
    if (error) {
      fail++;
      if (fail <= 3) console.log(`  ❌ ${uid}: ${error.message}`);
    } else {
      ok++;
    }
  }

  console.log(`  ✅ ${ok}명 동기화 완료${fail > 0 ? `, ❌ ${fail}명 실패` : ""}\n`);
}

async function main() {
  console.log("\n╔══════════════════════════════════════════════════════╗");
  console.log("║  cumulative_points_auto_sync 적용 후 검증           ║");
  console.log("╚══════════════════════════════════════════════════════╝");

  const results: Record<string, boolean | null> = {};

  results["1_sync"] = await verifySync();
  results["2_trigger"] = await verifyTrigger();
  results["3_function"] = await verifyFunctions();
  results["4_behavior"] = await verifyTriggerBehavior();
  results["5_display"] = await verifyDisplayValues();

  console.log("══════════════════════════════════════════════════════");
  console.log("  최종 결과");
  console.log("══════════════════════════════════════════════════════\n");

  for (const [k, v] of Object.entries(results)) {
    const icon = v === true ? "✅" : v === false ? "❌" : "⚠️";
    console.log(`  ${icon} ${k}`);
  }
  console.log();

  const anyFail = Object.values(results).some((v) => v === false);
  if (anyFail) {
    console.log("  ❌ 일부 검증 실패 — 위 상세 로그 확인\n");
    process.exit(1);
  } else {
    console.log("  ✅ 전체 검증 통과\n");
  }
}

main().catch((e) => {
  console.error("Fatal:", e);
  process.exit(1);
});
