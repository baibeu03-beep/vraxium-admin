/**
 * diag-info-target-backfill-dryrun.ts — encre info 라인 cluster4_line_targets 백필 DRY-RUN
 *
 * 입력: claudedocs/encre-info-autoreview-dryrun-full.json (이미 생성된 전수 크롤 산출물)
 *       각 라인의 variant.matchedUserIds(자동 매칭, 미매칭/모호 제외)를 그 라인의
 *       cluster4_line_targets(target_mode='user') 로 add 하는 계획을 산출한다.
 *
 * 규칙: 기존 target 유지(삭제/replace 금지) · matched user_id만 add · (line_id,user_id) 중복 skip
 *       · target_mode='user' · rollback 계획 파일 생성 · DRY-RUN(기본 write 0).
 *
 * ⚠ DB write 없음. 계획 + 검증 수치만 산출. 실제 insert 는 별도(승인 후).
 *
 * 실행: npx tsx --env-file=.env.local scripts/diag-info-target-backfill-dryrun.ts
 */
import { readFileSync, writeFileSync } from "node:fs";
import { createClient } from "@supabase/supabase-js";

const sb = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
  { auth: { persistSession: false } },
);

const SRC = "claudedocs/encre-info-autoreview-dryrun-full.json";
const PLAN_OUT = "claudedocs/encre-info-target-backfill-plan.json";

type JsonLine = { lineId: string; lineCode: string | null; seasonKey: string | null; weekLabel: string; weekId: string | null; variant: { matchedUserIds: string[] } };

async function main() {
  console.log("=== encre info cluster4_line_targets 백필 DRY-RUN (write 0) ===\n");
  const json = JSON.parse(readFileSync(SRC, "utf8")) as { lines: JsonLine[] };
  const jsonLines = json.lines;
  console.log(`입력 JSON: ${SRC} · 라인 ${jsonLines.length}건`);

  // 매칭(line_id → user_id 집합). JSON 내 라인별 matched 는 이미 라인 내 user dedup 됨.
  const matchByLine = new Map<string, string[]>();
  const allUserIds = new Set<string>();
  let jsonPairCount = 0;
  for (const l of jsonLines) {
    const ids = Array.from(new Set(l.variant.matchedUserIds.filter(Boolean)));
    matchByLine.set(l.lineId, ids);
    ids.forEach((u) => allUserIds.add(u));
    jsonPairCount += ids.length;
  }
  console.log(`JSON matched (라인×user) = ${jsonPairCount} · 고유 user = ${allUserIds.size}\n`);

  const lineIds = jsonLines.map((l) => l.lineId);

  // ── 1) 라인 현재 상태 재조회 (권위 week_id·is_active·part_type 검증) ──────────
  const lineMeta = new Map<string, { weekId: string | null; isActive: boolean; partType: string; lineCode: string | null }>();
  for (let i = 0; i < lineIds.length; i += 200) {
    const slice = lineIds.slice(i, i + 200);
    const { data, error } = await sb
      .from("cluster4_lines")
      .select("id,week_id,is_active,part_type,line_code")
      .in("id", slice);
    if (error) throw new Error(`cluster4_lines 재조회 실패: ${error.message}`);
    for (const r of (data ?? []) as Array<{ id: string; week_id: string | null; is_active: boolean; part_type: string; line_code: string | null }>) {
      lineMeta.set(r.id, { weekId: r.week_id, isActive: r.is_active, partType: r.part_type, lineCode: r.line_code });
    }
  }

  // ── 2) 기존 user-target 조회 (dedup 기준) ────────────────────────────────────
  const existingByLine = new Map<string, Set<string>>(); // line_id → existing target_user_id set
  let existingUserTargetTotal = 0;
  // ⚠ PostgREST 1000행 cap 회피 — order(id)+range 페이지네이션으로 전수 읽는다(미페이징 시
  //   기존 target 누락 → dedup 실패 → 재실행 중복 insert). slice 도 작게(100라인) 잡는다.
  for (let i = 0; i < lineIds.length; i += 100) {
    const slice = lineIds.slice(i, i + 100);
    let from = 0;
    for (;;) {
      const { data, error } = await sb
        .from("cluster4_line_targets")
        .select("line_id,target_user_id")
        .in("line_id", slice)
        .eq("target_mode", "user")
        .order("id", { ascending: true })
        .range(from, from + 999);
      if (error) throw new Error(`cluster4_line_targets 조회 실패: ${error.message}`);
      const rows = (data ?? []) as Array<{ line_id: string; target_user_id: string | null }>;
      for (const r of rows) {
        if (!r.target_user_id) continue;
        let s = existingByLine.get(r.line_id);
        if (!s) existingByLine.set(r.line_id, (s = new Set()));
        s.add(r.target_user_id);
        existingUserTargetTotal++;
      }
      if (rows.length < 1000) break;
      from += 1000;
    }
  }

  // ── 3) 매칭 user_id 가 user_profiles(encre) 에 실존하는지 검증 ─────────────────
  const validUser = new Map<string, string | null>(); // user_id → org
  const uArr = Array.from(allUserIds);
  for (let i = 0; i < uArr.length; i += 300) {
    const slice = uArr.slice(i, i + 300);
    const { data } = await sb.from("user_profiles").select("user_id,organization_slug").in("user_id", slice);
    for (const r of (data ?? []) as Array<{ user_id: string; organization_slug: string | null }>) {
      validUser.set(r.user_id, r.organization_slug);
    }
  }

  // ── 4) 계획 산출 ──────────────────────────────────────────────────────────────
  type PlanRow = { line_id: string; week_id: string; target_mode: "user"; target_user_id: string; target_rule: Record<string, never> };
  const plan: PlanRow[] = [];
  const perLineAdd = new Map<string, number>();
  let dedupSkip = 0;
  let inactiveSkip = 0;
  let nonInfoSkip = 0;
  let nullWeekSkip = 0;
  let missingUserSkip = 0;
  let nonEncreUserSkip = 0;
  const skippedDetail: Record<string, number> = {};

  for (const l of jsonLines) {
    const meta = lineMeta.get(l.lineId);
    const matched = matchByLine.get(l.lineId) ?? [];
    if (!meta) { skippedDetail[`라인 미존재(${l.lineId.slice(0,8)})`] = matched.length; continue; }
    if (!meta.isActive) { inactiveSkip += matched.length; continue; }
    if (meta.partType !== "info") { nonInfoSkip += matched.length; continue; }
    if (!meta.weekId) { nullWeekSkip += matched.length; continue; }
    const existing = existingByLine.get(l.lineId) ?? new Set<string>();
    let added = 0;
    for (const uid of matched) {
      if (!validUser.has(uid)) { missingUserSkip++; continue; }
      if (validUser.get(uid) !== "encre") { nonEncreUserSkip++; continue; }
      if (existing.has(uid)) { dedupSkip++; continue; } // 이미 같은 line+user target 존재
      plan.push({ line_id: l.lineId, week_id: meta.weekId, target_mode: "user", target_user_id: uid, target_rule: {} });
      existing.add(uid); // 같은 라인 내 JSON 중복 방어
      added++;
    }
    if (added > 0) perLineAdd.set(l.lineId, added);
  }

  // ── 5) 검증 수치 ──────────────────────────────────────────────────────────────
  const distinctPlannedUsers = new Set(plan.map((p) => p.target_user_id));
  const linesAffected = perLineAdd.size;
  const addCounts = Array.from(perLineAdd.values()).sort((a, b) => a - b);
  const minAdd = addCounts[0] ?? 0;
  const maxAdd = addCounts[addCounts.length - 1] ?? 0;
  const medAdd = addCounts.length ? addCounts[Math.floor(addCounts.length / 2)] : 0;

  console.log("================= 백필 DRY-RUN 계획 =================");
  console.log(`기존 user-target(대상 309라인 전체) : ${existingUserTargetTotal}`);
  console.log(`insert 예정 target 수               : ${plan.length}`);
  console.log(`  └ 고유 user 수                     : ${distinctPlannedUsers.size}`);
  console.log(`  └ 영향 라인 수                     : ${linesAffected}/${jsonLines.length}`);
  console.log(`  └ 라인당 추가(min/median/max)      : ${minAdd}/${medAdd}/${maxAdd}`);
  console.log(`중복 skip(이미 같은 line+user target): ${dedupSkip}`);
  console.log(`기타 skip — 비활성 ${inactiveSkip} · 비info ${nonInfoSkip} · week_id 없음 ${nullWeekSkip} · user 미존재 ${missingUserSkip} · 비encre ${nonEncreUserSkip}`);
  if (Object.keys(skippedDetail).length) console.log(`  라인 미존재 skip:`, skippedDetail);
  console.log(`정합: JSON pair ${jsonPairCount} = insert ${plan.length} + dedup ${dedupSkip} + skip ${inactiveSkip + nonInfoSkip + nullWeekSkip + missingUserSkip + nonEncreUserSkip}`);

  // ── 6) 라인별 증가 수(시즌별 집계) ───────────────────────────────────────────
  const bySeasonAdd = new Map<string, { lines: number; adds: number }>();
  for (const l of jsonLines) {
    const add = perLineAdd.get(l.lineId) ?? 0;
    if (add === 0) continue;
    const k = l.seasonKey ?? "unknown";
    const a = bySeasonAdd.get(k) ?? { lines: 0, adds: 0 };
    a.lines++; a.adds += add;
    bySeasonAdd.set(k, a);
  }
  console.log("\n── 시즌별 target 증가 ──");
  for (const k of Array.from(bySeasonAdd.keys()).sort()) {
    const a = bySeasonAdd.get(k)!;
    console.log(`  ${k.padEnd(16)} 라인 ${String(a.lines).padStart(3)} · target +${a.adds}`);
  }

  // ── 7) 계획/롤백 파일 ────────────────────────────────────────────────────────
  // 실제 insert 시 이 plan 을 그대로 쓰고, 생성된 id 를 rollback 매니페스트에 적재한다.
  // dry-run 단계에서는 (line_id, week_id, target_user_id) 키 목록 = 롤백 대상 식별자.
  writeFileSync(
    PLAN_OUT,
    JSON.stringify(
      {
        generatedFrom: SRC,
        rule: "matched user_id → cluster4_line_targets(target_mode='user'), dedup by (line_id,user_id), additive(기존 유지)",
        plannedInsertCount: plan.length,
        distinctUsers: distinctPlannedUsers.size,
        linesAffected,
        dedupSkip,
        otherSkip: { inactiveSkip, nonInfoSkip, nullWeekSkip, missingUserSkip, nonEncreUserSkip },
        // 롤백 식별 키 — 이 정확한 (line_id,target_user_id,week_id,target_mode='user') 조합만 삭제하면 원복.
        plannedRows: plan,
      },
      null,
      2,
    ),
  );
  console.log(`\n계획/롤백 식별 파일 → ${PLAN_OUT} (${plan.length} rows)`);
  console.log("\n⚠ DB write 0 — 실제 insert 안 함. execute 는 승인 후 별도 진행.");
}

main().catch((e) => { console.error("ERR", e instanceof Error ? e.stack : e); process.exit(1); });
