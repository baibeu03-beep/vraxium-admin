/**
 * READ-ONLY 조사 #1 — 2026-07-25 uwp 포인트 소멸 복구를 위한 원천/스키마 실측.
 *   npx tsx --env-file=.env.local scripts/recover-uwp-probe.ts
 * write 0. select 만 발행.
 */
import { supabaseAdmin } from "@/lib/supabaseAdmin";

type Num = number | null;

async function pageAll<T>(
  build: (from: number, to: number) => PromiseLike<{ data: unknown; error: { message: string } | null }>,
): Promise<T[]> {
  const out: T[] = [];
  const PAGE = 1000;
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await build(from, from + PAGE - 1);
    if (error) throw new Error(error.message);
    const rows = (data ?? []) as T[];
    out.push(...rows);
    if (rows.length < PAGE) break;
  }
  return out;
}

async function main() {
  // ── 1. legacy_point_ledger 스키마 ──
  const { data: shape, error: shapeErr } = await supabaseAdmin.from("legacy_point_ledger").select("*").limit(1);
  console.log("=== legacy_point_ledger columns ===");
  console.log(shapeErr ? `ERROR ${shapeErr.message}` : JSON.stringify(Object.keys((shape?.[0] ?? {}) as object)));
  console.log("sample row:", JSON.stringify(shape?.[0] ?? null).slice(0, 1200));

  for (const t of ["legacy_point_ledger", "user_weekly_points", "process_point_awards", "weeks", "user_cumulative_points", "cluster4_roster_card_stats", "cluster4_weekly_card_snapshots"]) {
    const { count, error } = await supabaseAdmin.from(t).select("*", { count: "exact", head: true });
    console.log(`count ${t}:`, error ? `ERROR ${error.message}` : count);
  }

  // ── 2. ledger 전체 적재 ──
  const led = await pageAll<{
    id: string; source_table: string | null; source_pk: number | null; user_id: string | null;
    legacy_user_id: number | null; week_id: string | null; occurred_at: string | null;
    star: Num; shield: Num; entry_type: string | null; created_by: string | null; payload: any;
  }>((f, t) =>
    supabaseAdmin
      .from("legacy_point_ledger")
      .select("id,source_table,source_pk,user_id,legacy_user_id,week_id,occurred_at,star,shield,entry_type,created_by,payload")
      .order("id")
      .range(f, t),
  );
  console.log(`\n=== ledger rows: ${led.length} ===`);

  const byType = new Map<string, { rows: number; star: number; shPos: number; shNeg: number; nullWeek: number; users: Set<string> }>();
  for (const r of led) {
    const k = String(r.entry_type);
    const e = byType.get(k) ?? { rows: 0, star: 0, shPos: 0, shNeg: 0, nullWeek: 0, users: new Set<string>() };
    e.rows++;
    e.star += r.star ?? 0;
    const sh = r.shield ?? 0;
    if (sh > 0) e.shPos += sh;
    else if (sh < 0) e.shNeg += -sh;
    if (!r.week_id) e.nullWeek++;
    if (r.user_id) e.users.add(r.user_id);
    byType.set(k, e);
  }
  console.log("\n=== ledger BY entry_type ===");
  for (const [k, e] of [...byType].sort()) {
    console.log(`${k}: rows=${e.rows} Σstar=${e.star} Σshield+=${e.shPos} Σshield-=${e.shNeg} week_id NULL=${e.nullWeek} users=${e.users.size}`);
  }

  const bySrc = new Map<string, number>();
  for (const r of led) bySrc.set(String(r.source_table), (bySrc.get(String(r.source_table)) ?? 0) + 1);
  console.log("\n=== ledger BY source_table ===", JSON.stringify([...bySrc].sort()));

  const byCreator = new Map<string, number>();
  for (const r of led) byCreator.set(String(r.created_by), (byCreator.get(String(r.created_by)) ?? 0) + 1);
  console.log("=== ledger BY created_by ===", JSON.stringify([...byCreator].sort()));

  // 중복 (source_table, source_pk)
  const spk = new Map<string, number>();
  for (const r of led) {
    const k = `${r.source_table}#${r.source_pk}`;
    spk.set(k, (spk.get(k) ?? 0) + 1);
  }
  const dupSpk = [...spk].filter(([, n]) => n > 1);
  console.log(`\n=== (source_table,source_pk) 중복: ${dupSpk.length} ===`, JSON.stringify(dupSpk.slice(0, 20)));

  // 동일 (user, source_table, source_pk) 외 이벤트 중복 후보: 같은 user·week·star·shield·code 반복
  const ledPayloadIsDeleted = new Map<string, number>();
  for (const r of led) {
    const v = r.payload && typeof r.payload === "object" ? (r.payload as any).IsDeleted : undefined;
    const k = `${r.entry_type}/IsDeleted=${JSON.stringify(v)}`;
    ledPayloadIsDeleted.set(k, (ledPayloadIsDeleted.get(k) ?? 0) + 1);
  }
  console.log("\n=== entry_type ↔ payload.IsDeleted 정합 ===", JSON.stringify([...ledPayloadIsDeleted].sort()));

  // occurred_at 범위
  const occ = led.map((r) => r.occurred_at ?? "").filter(Boolean).sort();
  console.log("occurred_at min/max:", occ[0], "/", occ[occ.length - 1]);

  // ── 3. weeks ──
  const weeks = await pageAll<{ id: string; start_date: string | null; end_date: string | null; iso_year: Num; iso_week: Num; week_number: Num; season_key: string | null; is_official_rest: boolean | null }>(
    (f, t) => supabaseAdmin.from("weeks").select("id,start_date,end_date,iso_year,iso_week,week_number,season_key,is_official_rest").order("start_date").range(f, t),
  );
  console.log(`\n=== weeks: ${weeks.length} ===`);
  const weekById = new Map(weeks.map((w) => [w.id, w]));
  const ledWeekMissing = led.filter((r) => r.week_id && !weekById.has(r.week_id)).length;
  console.log("ledger.week_id 가 weeks 에 없음:", ledWeekMissing);

  // ── 4. uwp 전체 ──
  const uwp = await pageAll<{
    id: string; user_id: string; year: Num; week_number: Num; week_start_date: string | null;
    points: Num; advantages: Num; penalty: Num; checks_migrated: boolean | null; updated_at: string | null; created_at: string | null;
  }>((f, t) =>
    supabaseAdmin
      .from("user_weekly_points")
      .select("id,user_id,year,week_number,week_start_date,points,advantages,penalty,checks_migrated,updated_at,created_at")
      .order("id")
      .range(f, t),
  );
  console.log(`\n=== uwp rows: ${uwp.length} ===`);
  const WIPE = "2026-07-25T04:52:05";
  const wiped = uwp.filter((r) => String(r.updated_at ?? "").startsWith(WIPE));
  console.log(`updated_at ${WIPE}* 인 행: ${wiped.length} (users=${new Set(wiped.map((r) => r.user_id)).size})`);
  console.log("  그중 checks_migrated=true:", wiped.filter((r) => r.checks_migrated).length);
  console.log("  그중 현재 전부 0:", wiped.filter((r) => (r.points ?? 0) === 0 && (r.advantages ?? 0) === 0 && (r.penalty ?? 0) === 0).length);
  console.log("  그중 비영값 잔존:", wiped.filter((r) => (r.points ?? 0) !== 0 || (r.advantages ?? 0) !== 0 || (r.penalty ?? 0) !== 0).length);

  const cmTrue = uwp.filter((r) => r.checks_migrated);
  console.log(`checks_migrated=true: ${cmTrue.length} / false: ${uwp.length - cmTrue.length}`);

  const tot = (rows: typeof uwp) => rows.reduce((a, r) => ({ a: a.a + (r.points ?? 0), adv: a.adv + (r.advantages ?? 0), pen: a.pen + (r.penalty ?? 0) }), { a: 0, adv: 0, pen: 0 });
  console.log("uwp 전체 합:", JSON.stringify(tot(uwp)));
  console.log("uwp cm=true 합:", JSON.stringify(tot(cmTrue)));
  console.log("uwp cm=false 합:", JSON.stringify(tot(uwp.filter((r) => !r.checks_migrated))));
  console.log("uwp penalty<0 인 행:", uwp.filter((r) => (r.penalty ?? 0) < 0).length);

  // uwp 유니크 키 확인
  const uwpKey1 = new Map<string, number>();
  const uwpKey2 = new Map<string, number>();
  for (const r of uwp) {
    const k1 = `${r.user_id}|${r.year}|${r.week_number}`;
    const k2 = `${r.user_id}|${r.week_start_date}`;
    uwpKey1.set(k1, (uwpKey1.get(k1) ?? 0) + 1);
    uwpKey2.set(k2, (uwpKey2.get(k2) ?? 0) + 1);
  }
  console.log("uwp (user,year,week_number) 중복:", [...uwpKey1.values()].filter((n) => n > 1).length);
  console.log("uwp (user,week_start_date) 중복:", [...uwpKey2.values()].filter((n) => n > 1).length);

  // week_start_date 가 weeks 에 없는 uwp
  const startDates = new Set(weeks.map((w) => w.start_date));
  const orphanUwp = uwp.filter((r) => r.week_start_date && !startDates.has(r.week_start_date));
  const orphanByDate = new Map<string, number>();
  for (const r of orphanUwp) orphanByDate.set(String(r.week_start_date), (orphanByDate.get(String(r.week_start_date)) ?? 0) + 1);
  console.log("uwp.week_start_date 가 weeks 에 없음:", orphanUwp.length, JSON.stringify([...orphanByDate].sort().slice(0, 20)));

  // ── 5. process_point_awards ──
  const ppa = await pageAll<{ user_id: string; year: Num; week_number: Num; point_check: Num; point_advantage: Num; point_penalty: Num; cancelled_at: string | null }>(
    (f, t) => supabaseAdmin.from("process_point_awards").select("user_id,year,week_number,point_check,point_advantage,point_penalty,cancelled_at").order("id").range(f, t),
  );
  const ppaActive = ppa.filter((r) => !r.cancelled_at);
  console.log(`\n=== process_point_awards: ${ppa.length} (active ${ppaActive.length}) ===`);
  const ppaKeys = new Set(ppaActive.map((r) => `${r.user_id}|${r.year}|${r.week_number}`));
  console.log("active (user,year,week) 키:", ppaKeys.size);

  // ── 6. users / profiles 매핑 ──
  const users = await pageAll<{ id: string; source_system: string | null; legacy_user_id: number | null }>(
    (f, t) => supabaseAdmin.from("users").select("id,source_system,legacy_user_id").order("id").range(f, t),
  );
  const bySrcSys = new Map<string, number>();
  for (const u of users) bySrcSys.set(String(u.source_system), (bySrcSys.get(String(u.source_system)) ?? 0) + 1);
  console.log(`\n=== users: ${users.length} ===`, JSON.stringify([...bySrcSys].sort()));

  // ledger user 가 users 에 있는지
  const userIds = new Set(users.map((u) => u.id));
  console.log("ledger.user_id 미존재:", new Set(led.filter((r) => r.user_id && !userIds.has(r.user_id)).map((r) => r.user_id)).size);

  // ledger 보유 사용자 ↔ legacy_user_id 정합
  const legacyOf = new Map(users.map((u) => [u.id, `${u.source_system}:${u.legacy_user_id}`]));
  let legacyMismatch = 0;
  for (const r of led) {
    if (!r.user_id || r.legacy_user_id == null || !r.source_table) continue;
    const src = String(r.source_table).split(".")[0];
    if (legacyOf.get(r.user_id) !== `${src}:${r.legacy_user_id}`) legacyMismatch++;
  }
  console.log("ledger(source,legacy_user_id) ↔ users 불일치 행:", legacyMismatch);

  // ── 7. 캐시 updated_at 분포 ──
  for (const [t, col] of [["user_cumulative_points", "updated_at"], ["cluster4_roster_card_stats", "updated_at"]] as const) {
    const rows = await pageAll<{ updated_at: string | null }>((f, x) => supabaseAdmin.from(t).select(col).order(col).range(f, x));
    const s = rows.map((r) => r.updated_at ?? "").filter(Boolean).sort();
    const wipedN = s.filter((x) => x.startsWith(WIPE)).length;
    console.log(`\n${t}: rows=${rows.length} min=${s[0]} max=${s[s.length - 1]} / ${WIPE}* = ${wipedN}`);
  }

  console.log("\n=== DONE (writes: 0) ===");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
