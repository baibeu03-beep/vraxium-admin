/**
 * exec-info-target-backfill.ts — phalanx info 라인 cluster4_line_targets 백필 EXECUTE + 검증
 *
 *  EXECUTE=1 일 때만 실제 insert. cluster4_line_targets 외 테이블은 일절 건드리지 않는다
 *  (process_acts, process_check_statuses, process_check_review_recipients,
 *   process_point_awards, user_weekly_points 무수정).
 *
 *  흐름: plan 산출(JSON) → BEFORE snapshot 캡처 → insert(+rollback 매니페스트) →
 *        영향 사용자 snapshot 재계산 → AFTER snapshot → 강화 flip 집계 → direct==snapshot 검증
 *        → 비영향 사용자 불변 검증. (HTTP==snapshot 은 dev 서버 기동 후 별도 스크립트.)
 *
 *  실행(실제):  EXECUTE=1 npx tsx --env-file=.env.local scripts/exec-info-target-backfill.ts
 */
import { readFileSync, writeFileSync } from "node:fs";
import { createClient } from "@supabase/supabase-js";
import {
  recomputeWeeklyCardsSnapshotsForUsers,
  readWeeklyCardsSnapshot,
} from "@/lib/cluster4WeeklyCardsSnapshot";
import { getCluster4WeeklyCardsForProfileUser } from "@/lib/cluster4WeeklyCardsData";

const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } });
const EXECUTE = process.env.EXECUTE === "1";
const SRC = "claudedocs/phalanx-info-autoreview-dryrun-full.json";
const ROLLBACK_OUT = "claudedocs/phalanx-info-target-backfill-rollback.json";

type JsonLine = { lineId: string; weekId: string | null; seasonKey: string | null; variant: { matchedUserIds: string[] } };

// snapshot/direct 카드에서 특정 lineId 의 info 라인 enhancementStatus 추출(없으면 null).
function lineEnh(cards: any[], lineId: string): string | null {
  for (const c of cards ?? []) {
    for (const l of c.lines ?? []) {
      if (l.lineId === lineId && l.partType === "information") return l.enhancementStatus ?? null;
    }
  }
  return null;
}
function infoSuccessCount(cards: any[]): number {
  let n = 0;
  for (const c of cards ?? []) for (const l of c.lines ?? []) if (l.partType === "information" && l.enhancementStatus === "success") n++;
  return n;
}

async function snapCards(userId: string): Promise<any[]> {
  const s = await readWeeklyCardsSnapshot(userId);
  return s.status === "hit" || s.status === "stale" ? (s.cards as any[]) : [];
}

async function main() {
  console.log(`=== info target 백필 ${EXECUTE ? "EXECUTE" : "DRY-RUN(EXECUTE!=1)"} ===\n`);
  const json = JSON.parse(readFileSync(SRC, "utf8")) as { lines: JsonLine[] };

  // ── plan 산출(권위 재조회 + dedup) ──
  const lineIds = json.lines.map((l) => l.lineId);
  const lineMeta = new Map<string, { weekId: string | null; isActive: boolean; partType: string }>();
  for (let i = 0; i < lineIds.length; i += 200) {
    const { data } = await sb.from("cluster4_lines").select("id,week_id,is_active,part_type").in("id", lineIds.slice(i, i + 200));
    for (const r of (data ?? []) as any[]) lineMeta.set(r.id, { weekId: r.week_id, isActive: r.is_active, partType: r.part_type });
  }
  const existingByLine = new Map<string, Set<string>>();
  // PostgREST 1000행 cap 회피 — order+range 전수 페이지네이션(dedup 정확성 필수).
  for (let i = 0; i < lineIds.length; i += 100) {
    const slice = lineIds.slice(i, i + 100);
    let from = 0;
    for (;;) {
      const { data } = await sb.from("cluster4_line_targets").select("line_id,target_user_id").in("line_id", slice).eq("target_mode", "user").order("id", { ascending: true }).range(from, from + 999);
      const rows = (data ?? []) as any[];
      for (const r of rows) { if (!r.target_user_id) continue; let s = existingByLine.get(r.line_id); if (!s) existingByLine.set(r.line_id, (s = new Set())); s.add(r.target_user_id); }
      if (rows.length < 1000) break;
      from += 1000;
    }
  }
  const allUsers = new Set<string>(); json.lines.forEach((l) => l.variant.matchedUserIds.forEach((u) => allUsers.add(u)));
  const userOrg = new Map<string, string | null>();
  const uArr = Array.from(allUsers);
  for (let i = 0; i < uArr.length; i += 300) {
    const { data } = await sb.from("user_profiles").select("user_id,organization_slug").in("user_id", uArr.slice(i, i + 300));
    for (const r of (data ?? []) as any[]) userOrg.set(r.user_id, r.organization_slug);
  }

  type Row = { line_id: string; week_id: string; target_mode: "user"; target_user_id: string; target_rule: Record<string, never> };
  const plan: Row[] = [];
  let dedupSkip = 0;
  const affectedUsers = new Set<string>();
  const affectedPairs: Array<{ userId: string; lineId: string }> = [];
  for (const l of json.lines) {
    const meta = lineMeta.get(l.lineId);
    if (!meta || !meta.isActive || meta.partType !== "info" || !meta.weekId) continue;
    const existing = existingByLine.get(l.lineId) ?? new Set<string>();
    for (const uid of Array.from(new Set(l.variant.matchedUserIds))) {
      if (userOrg.get(uid) !== "phalanx") continue;
      if (existing.has(uid)) { dedupSkip++; continue; }
      plan.push({ line_id: l.lineId, week_id: meta.weekId, target_mode: "user", target_user_id: uid, target_rule: {} });
      existing.add(uid);
      affectedUsers.add(uid);
      affectedPairs.push({ userId: uid, lineId: l.lineId });
    }
  }
  const affectedUserIds = Array.from(affectedUsers);
  console.log(`plan: insert ${plan.length} · 고유user ${affectedUserIds.length} · dedupSkip ${dedupSkip}`);

  // ── BEFORE: 영향 사용자 snapshot 의 (user,line) enhancementStatus + 비영향 표본 해시 ──
  const beforeEnh = new Map<string, string | null>(); // `${user}|${line}` → status
  for (const uid of affectedUserIds) {
    const cards = await snapCards(uid);
    for (const p of affectedPairs) if (p.userId === uid) beforeEnh.set(`${uid}|${p.lineId}`, lineEnh(cards, p.lineId));
  }
  const beforeFail = Array.from(beforeEnh.values()).filter((v) => v === "fail").length;
  const beforeSuccess = Array.from(beforeEnh.values()).filter((v) => v === "success").length;
  console.log(`BEFORE 영향 (user,line) ${beforeEnh.size}건 — fail ${beforeFail} · success ${beforeSuccess} · 기타 ${beforeEnh.size - beforeFail - beforeSuccess}`);

  // 비영향 표본(phalanx 비대상 사용자 10명) before 카드 직렬화 — 불변 검증용.
  const { data: phalanxUsers } = await sb.from("user_profiles").select("user_id").eq("organization_slug", "phalanx").order("user_id").limit(400);
  const nonAffected = ((phalanxUsers ?? []) as any[]).map((r) => r.user_id).filter((u) => !affectedUsers.has(u)).slice(0, 10);
  const beforeNonAffected = new Map<string, string>();
  for (const u of nonAffected) beforeNonAffected.set(u, JSON.stringify(await snapCards(u)));

  if (!EXECUTE) {
    console.log("\n(EXECUTE!=1 — insert/재계산 생략. plan/before 캡처만.)");
    return;
  }

  // ── INSERT (배치 500, id 캡처) ──
  console.log("\n[INSERT] cluster4_line_targets …");
  const inserted: Array<{ id: string; line_id: string; target_user_id: string; week_id: string }> = [];
  for (let i = 0; i < plan.length; i += 500) {
    const batch = plan.slice(i, i + 500);
    const { data, error } = await sb.from("cluster4_line_targets").insert(batch).select("id,line_id,target_user_id,week_id");
    if (error) { console.error(`INSERT 실패 @batch ${i}:`, error.message); break; }
    inserted.push(...((data ?? []) as any[]));
    console.log(`  inserted ${inserted.length}/${plan.length}`);
  }
  // 롤백 매니페스트 — 생성된 id 만 정확히 삭제하면 원복.
  writeFileSync(ROLLBACK_OUT, JSON.stringify({ createdAt: new Date().toISOString().slice(0, 10), table: "cluster4_line_targets", insertedCount: inserted.length, ids: inserted.map((r) => r.id), rows: inserted }, null, 2));
  console.log(`[ROLLBACK] ${ROLLBACK_OUT} — ${inserted.length} ids (삭제 = 원복)`);

  // ── RECOMPUTE: 영향 사용자만 snapshot 재계산(이들만 카드 변화) ──
  console.log("\n[RECOMPUTE] 영향 사용자 snapshot 재계산 …");
  const rec = await recomputeWeeklyCardsSnapshotsForUsers(affectedUserIds, { concurrency: 2 });
  console.log(`  requested ${rec.requested} · recomputed ${rec.recomputed} · failed ${rec.failed}`);

  // ── AFTER: flip 집계 + direct==snapshot 표본 + 비영향 불변 ──
  let flip = 0; let stillFail = 0; let other = 0;
  for (const uid of affectedUserIds) {
    const cards = await snapCards(uid);
    for (const p of affectedPairs) {
      if (p.userId !== uid) continue;
      const before = beforeEnh.get(`${uid}|${p.lineId}`);
      const after = lineEnh(cards, p.lineId);
      if (before === "fail" && after === "success") flip++;
      else if (after === "fail") stillFail++;
      else other++;
    }
  }
  console.log(`\n[FLIP] 강화 실패→성공 전환 = ${flip} · 여전히 fail ${stillFail} · 기타 ${other}`);

  // direct==snapshot (영향 표본 12명) — info success 카운트 동일성.
  const sample = affectedUserIds.slice(0, 12);
  let eqCount = 0;
  for (const uid of sample) {
    const live = await getCluster4WeeklyCardsForProfileUser(uid);
    const snap = await snapCards(uid);
    if (infoSuccessCount(live) === infoSuccessCount(snap)) eqCount++;
    else console.log(`  ⚠ direct!=snapshot user=${uid.slice(0,8)} live=${infoSuccessCount(live)} snap=${infoSuccessCount(snap)}`);
  }
  console.log(`[direct==snapshot] 표본 ${sample.length}명 info success 일치 = ${eqCount}/${sample.length}`);

  // 비영향 사용자 불변(변경 스코프 검증).
  let unchanged = 0;
  for (const u of nonAffected) { if (JSON.stringify(await snapCards(u)) === beforeNonAffected.get(u)) unchanged++; }
  console.log(`[비영향 불변] phalanx 비대상 표본 ${nonAffected.length}명 snapshot 동일 = ${unchanged}/${nonAffected.length}`);

  // ── 최종 direct DB 카운트 ──
  let dbTargetCount = 0;
  for (let i = 0; i < lineIds.length; i += 200) {
    const { count } = await sb.from("cluster4_line_targets").select("*", { count: "exact", head: true }).in("line_id", lineIds.slice(i, i + 200)).eq("target_mode", "user");
    dbTargetCount += count ?? 0;
  }
  console.log(`\n[direct DB] 309 라인 user-target 총수 = ${dbTargetCount} (백필 전 0 → 기대 ${plan.length})`);
  console.log(`\n검증요약: insert ${inserted.length} · dedupSkip ${dedupSkip} · flip ${flip} · direct==snapshot ${eqCount}/${sample.length} · 비영향불변 ${unchanged}/${nonAffected.length}`);
  // 표본 user_id 를 HTTP 검증 스크립트가 쓰도록 출력.
  writeFileSync("claudedocs/phalanx-info-backfill-sample-users.json", JSON.stringify({ sample, affectedCount: affectedUserIds.length }, null, 2));
}

main().catch((e) => { console.error("ERR", e instanceof Error ? e.stack : e); process.exit(1); });
