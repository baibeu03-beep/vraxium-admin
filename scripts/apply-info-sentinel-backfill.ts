/**
 * apply-info-sentinel-backfill.ts   (B안 적용 — DRY 기본, --execute 로만 write)
 *
 * 0-target info 라인(엑셀 임포트/백필, user=0 AND sentinel=0)에 zeroTargetOpen sentinel 1행을 보장.
 *   → 고객 weekly-cards openedByWeek 가 라인을 "개설됨"으로 인식 → 미배정 크루 = 전체 강화 실패.
 *   admin UI 0명 개설 경로와 동일 SoT(구조). 멱등(기존 sentinel 있으면 skip).
 *
 * 절차(--execute):
 *   1) 대상 라인 + 영향 유저(uws∩org 가시) 재산정
 *   2) BEFORE 캡처 = 현재 snapshot(고객 실제값)에서 영향 유저 info/successWeeks/카드수 tally
 *   3) sentinel insert (rollback 로그 기록)
 *   4) oranke audience snapshot 재계산 (recomputeWeeklyCardsSnapshotsForUsers — snapshot==live)
 *   5) AFTER 캡처 + 델타 검증(실패칸 Δ·카드수 Δ=0·successWeeks Δ=0·휴식주차 무영향)
 *
 * 실행: npx tsx --env-file=.env.local scripts/apply-info-sentinel-backfill.ts [--execute]
 */
import { config } from "dotenv";
config({ path: ".env.local" });
import { writeFileSync } from "fs";
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { resolveLineScopeFromValues, isLineScopeVisibleForOrg } from "@/lib/lineScope";
import { recomputeWeeklyCardsSnapshotsForUsers } from "@/lib/cluster4WeeklyCardsSnapshot";

const EXECUTE = process.argv.includes("--execute");
const ACTOR = "aac4639b-7c22-4a53-9f2e-08076d5aa620"; // 기존 sentinel 생성 admin (일관 귀속)
const SNAP_TABLE = "cluster4_weekly_card_snapshots";
const MAX_INSERT = 150; // 폭주 방지 가드

type LineRow = { id: string; activity_type_id: string | null; line_code: string | null; week_id: string | null };
type TargetRow = { line_id: string; target_mode: string; target_rule: Record<string, unknown> | null };
type WeekRow = { id: string; start_date: string | null; is_official_rest: boolean | null };

async function fetchAll<T>(table: string, cols: string, apply: (q: any) => any): Promise<T[]> {
  const out: T[] = [];
  let from = 0;
  for (;;) {
    let q = supabaseAdmin.from(table).select(cols).order("id", { ascending: true });
    q = apply(q).range(from, from + 999);
    const { data, error } = await q;
    if (error) throw new Error(`${table}: ${error.message}`);
    const batch = (data ?? []) as T[];
    out.push(...batch);
    if (batch.length < 1000) break;
    from += 1000;
  }
  return out;
}

type Tally = { infoFail: number; infoSuccess: number; infoPending: number; infoNA: number; cards: number; successWeeks: number };

function tallySnapshotRow(cards: any[]): Tally {
  let infoFail = 0, infoSuccess = 0, infoPending = 0, infoNA = 0, successWeeks = 0;
  for (const c of cards ?? []) {
    if (c?.userWeekStatus === "success") successWeeks++;
    for (const ln of c?.lines ?? []) {
      if (ln?.partType !== "information") continue;
      if (ln.enhancementStatus === "fail") infoFail++;
      else if (ln.enhancementStatus === "success") infoSuccess++;
      else if (ln.enhancementStatus === "pending") infoPending++;
      else infoNA++;
    }
  }
  return { infoFail, infoSuccess, infoPending, infoNA, cards: (cards ?? []).length, successWeeks };
}

async function readSnapshotTallies(userIds: string[]): Promise<Map<string, Tally>> {
  const m = new Map<string, Tally>();
  for (let i = 0; i < userIds.length; i += 100) {
    const slice = userIds.slice(i, i + 100);
    const { data, error } = await supabaseAdmin
      .from(SNAP_TABLE)
      .select("user_id,cards")
      .in("user_id", slice);
    if (error) throw new Error("snapshot read: " + error.message);
    for (const r of (data ?? []) as Array<{ user_id: string; cards: any[] }>) {
      m.set(r.user_id, tallySnapshotRow(r.cards));
    }
  }
  return m;
}

async function main() {
  console.log(`════ B안 sentinel 백필 ${EXECUTE ? "(EXECUTE)" : "(DRY-RUN)"} ════`);

  // 1) 대상 라인.
  const lines = await fetchAll<LineRow>(
    "cluster4_lines",
    "id,activity_type_id,line_code,week_id",
    (q) => q.eq("part_type", "info").eq("is_active", true),
  );
  const lineIds = lines.map((l) => l.id);
  const targets: TargetRow[] = [];
  for (let i = 0; i < lineIds.length; i += 200) {
    targets.push(
      ...(await fetchAll<TargetRow>("cluster4_line_targets", "line_id,target_mode,target_rule", (q) =>
        q.in("line_id", lineIds.slice(i, i + 200)),
      )),
    );
  }
  const agg = new Map<string, { user: number; sentinel: number }>();
  for (const t of targets) {
    const a = agg.get(t.line_id) ?? { user: 0, sentinel: 0 };
    if (t.target_mode === "user") a.user++;
    else if (t.target_mode === "rule" && (t.target_rule as any)?.zeroTargetOpen === true) a.sentinel++;
    agg.set(t.line_id, a);
  }
  const targetLines = lines.filter((l) => {
    const a = agg.get(l.id);
    return (!a || (a.user === 0 && a.sentinel === 0)) && l.week_id;
  });
  console.log(`백필 대상 라인: ${targetLines.length}`);
  if (targetLines.length === 0) {
    console.log("대상 없음(이미 멱등 완료?) — 종료.");
    return;
  }
  if (targetLines.length > MAX_INSERT) {
    throw new Error(`대상 ${targetLines.length} > MAX_INSERT ${MAX_INSERT} — 폭주 가드 중단`);
  }

  // activity_type 별 insert 예정 수.
  const byAct = new Map<string, number>();
  for (const l of targetLines) byAct.set(l.activity_type_id ?? "(null)", (byAct.get(l.activity_type_id ?? "(null)") ?? 0) + 1);
  console.log("activity_type별 insert 예정:", JSON.stringify(Object.fromEntries([...byAct].sort())));

  // 2) week 메타(휴식주차 식별).
  const weekIds = Array.from(new Set(targetLines.map((l) => l.week_id!)));
  const weeks: WeekRow[] = [];
  for (let i = 0; i < weekIds.length; i += 200) {
    const { data } = await supabaseAdmin.from("weeks").select("id,start_date,is_official_rest").in("id", weekIds.slice(i, i + 200));
    weeks.push(...((data ?? []) as WeekRow[]));
  }
  const weekById = new Map(weeks.map((w) => [w.id, w]));
  const restLineCount = targetLines.filter((l) => weekById.get(l.week_id!)?.is_official_rest).length;

  // 3) 영향 유저(uws∩org 가시) — 비휴식 주차만.
  const okScope = resolveLineScopeFromValues({ partType: "info", lineCode: "info-OK-wisdom-2025w46" });
  const nonRestStarts = Array.from(
    new Set(
      targetLines
        .map((l) => weekById.get(l.week_id!))
        .filter((w): w is WeekRow => Boolean(w && w.start_date && !w.is_official_rest))
        .map((w) => w.start_date!),
    ),
  );
  const uwsUsers = new Set<string>();
  for (let i = 0; i < nonRestStarts.length; i += 50) {
    const rows = await fetchAll<{ user_id: string }>("user_week_statuses", "id,user_id", (q) =>
      q.in("week_start_date", nonRestStarts.slice(i, i + 50)),
    );
    for (const r of rows) uwsUsers.add(r.user_id);
  }
  const uidArr = Array.from(uwsUsers);
  const orgByUser = new Map<string, string | null>();
  for (let i = 0; i < uidArr.length; i += 200) {
    const { data } = await supabaseAdmin.from("user_profiles").select("user_id,organization_slug").in("user_id", uidArr.slice(i, i + 200));
    for (const r of (data ?? []) as Array<{ user_id: string; organization_slug: string | null }>) orgByUser.set(r.user_id, r.organization_slug);
  }
  const affectedUsers = uidArr.filter((u) => isLineScopeVisibleForOrg(okScope, (orgByUser.get(u) as any) ?? null, { allowUnknown: false }));
  console.log(`영향 유저(direct 검증 대상): ${affectedUsers.length} · 휴식주차 라인(무영향): ${restLineCount}`);

  // 4) 재계산 audience = oranke snapshot 유저(앱 무효화 경로와 동일 org 산정) ∪ 영향 유저.
  const snapUsers: string[] = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await supabaseAdmin.from(SNAP_TABLE).select("user_id").order("user_id").range(from, from + 999);
    if (error) throw new Error(error.message);
    snapUsers.push(...((data ?? []) as Array<{ user_id: string }>).map((r) => r.user_id));
    if (!data || data.length < 1000) break;
  }
  const snapOrg = new Map<string, string | null>();
  for (let i = 0; i < snapUsers.length; i += 200) {
    const { data } = await supabaseAdmin.from("user_profiles").select("user_id,organization_slug").in("user_id", snapUsers.slice(i, i + 200));
    for (const r of (data ?? []) as Array<{ user_id: string; organization_slug: string | null }>) snapOrg.set(r.user_id, r.organization_slug);
  }
  const orgAudience = snapUsers.filter((u) => isLineScopeVisibleForOrg(okScope, (snapOrg.get(u) as any) ?? null, { allowUnknown: false }));
  const audience = Array.from(new Set([...orgAudience, ...affectedUsers]));
  console.log(`재계산 audience: ${audience.length} (oranke snapshot ${orgAudience.length} ∪ 영향 ${affectedUsers.length})`);

  // 5) BEFORE 캡처. --execute 시에는 sentinel 없는 fresh-live 베이스라인을 먼저 구워(드리프트 분리)
  //    BEFORE↔AFTER 델타가 순수 sentinel 효과만 담게 한다. DRY 는 현재 snapshot(고객 실제값) 미리보기.
  if (EXECUTE) {
    console.log(`\nBEFORE 베이스라인 재계산(sentinel 미적용, 영향 ${affectedUsers.length})...`);
    const baseRec = await recomputeWeeklyCardsSnapshotsForUsers(affectedUsers, { concurrency: 4 });
    console.log(`베이스라인 재계산: ${JSON.stringify(baseRec)}`);
  }
  const before = await readSnapshotTallies(affectedUsers);
  const sumBefore = [...before.values()].reduce((a, t) => ({ fail: a.fail + t.infoFail, sw: a.sw + t.successWeeks, cards: a.cards + t.cards, na: a.na + t.infoNA }), { fail: 0, sw: 0, cards: 0, na: 0 });
  console.log(`\nBEFORE(snapshot): infoFail합=${sumBefore.fail} infoNA합=${sumBefore.na} successWeeks합=${sumBefore.sw} 카드합=${sumBefore.cards}`);

  if (!EXECUTE) {
    console.log(`\n[DRY-RUN] insert/recompute 없이 종료. 반영하려면 --execute.`);
    return;
  }

  // 6) sentinel insert.
  const insertRows = targetLines.map((l) => ({
    line_id: l.id,
    week_id: l.week_id!,
    target_mode: "rule" as const,
    target_user_id: null,
    target_rule: { zeroTargetOpen: true },
    created_by: ACTOR,
    updated_by: ACTOR,
  }));
  const { data: inserted, error: insErr } = await supabaseAdmin
    .from("cluster4_line_targets")
    .insert(insertRows)
    .select("id,line_id,week_id");
  if (insErr) throw new Error("insert 실패: " + insErr.message);
  const insertedRows = (inserted ?? []) as Array<{ id: string; line_id: string; week_id: string }>;
  writeFileSync(
    "claudedocs/info-sentinel-backfill-inserted.json",
    JSON.stringify({ insertedAt_note: "stamp externally", actor: ACTOR, count: insertedRows.length, ids: insertedRows.map((r) => r.id), rows: insertedRows }, null, 2),
  );
  console.log(`\n✅ sentinel insert: ${insertedRows.length}건 (rollback 로그: claudedocs/info-sentinel-backfill-inserted.json)`);

  // 7) snapshot 재계산.
  console.log(`\n재계산 시작(audience ${audience.length})...`);
  const rec = await recomputeWeeklyCardsSnapshotsForUsers(audience, { concurrency: 4 });
  console.log(`재계산 결과: ${JSON.stringify(rec)}`);

  // 8) AFTER 캡처 + 델타.
  const after = await readSnapshotTallies(affectedUsers);
  let usersWithNewFail = 0, totalNewFail = 0, swChanged = 0, cardsChanged = 0;
  const swChangedUsers: string[] = [];
  const cardsChangedUsers: string[] = [];
  for (const uid of affectedUsers) {
    const b = before.get(uid);
    const a = after.get(uid);
    if (!b || !a) continue;
    const df = a.infoFail - b.infoFail;
    if (df > 0) { usersWithNewFail++; totalNewFail += df; }
    if (a.successWeeks !== b.successWeeks) { swChanged++; swChangedUsers.push(uid); }
    if (a.cards !== b.cards) { cardsChanged++; cardsChangedUsers.push(uid); }
  }
  const sumAfter = [...after.values()].reduce((a, t) => ({ fail: a.fail + t.infoFail, sw: a.sw + t.successWeeks, cards: a.cards + t.cards, na: a.na + t.infoNA }), { fail: 0, sw: 0, cards: 0, na: 0 });

  console.log(`\n──── 검증 결과 ────`);
  console.log(`AFTER(snapshot): infoFail합=${sumAfter.fail} infoNA합=${sumAfter.na} successWeeks합=${sumAfter.sw} 카드합=${sumAfter.cards}`);
  console.log(`신규 info 실패칸 Δ: +${sumAfter.fail - sumBefore.fail} (유저별 누적 +${totalNewFail}, 신규실패 유저 ${usersWithNewFail}명)`);
  console.log(`successWeeks 변동 유저: ${swChanged} ${swChanged ? JSON.stringify(swChangedUsers.slice(0, 10)) : "(메달/성공주차 불변 ✓)"}`);
  console.log(`카드수 변동 유저: ${cardsChanged} ${cardsChanged ? JSON.stringify(cardsChangedUsers.slice(0, 10)) : "(주차 모집단 불변 = 가입/활동전 소급 없음 ✓)"}`);
  console.log(`infoNA Δ: ${sumAfter.na - sumBefore.na} (na→fail 전환분)`);
}

main().catch((e) => {
  console.error("ERR", e instanceof Error ? e.message : e);
  process.exit(1);
});
