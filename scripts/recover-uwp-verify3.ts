/**
 * READ-ONLY 검증 #3 — 예외 2명 규명 · 중복(이중적립) 위험 분석 · 테스트계정 잔여손상 규모.
 *   npx tsx --env-file=.env.local scripts/recover-uwp-verify3.ts
 * write 0.
 */
import { readdirSync, readFileSync } from "fs";
import { supabaseAdmin } from "@/lib/supabaseAdmin";

const WIPE = "2026-07-25T04:52:00Z";
const WIPE_PREFIX = "2026-07-25T04:52:05";

type Row = {
  user_id: string; display_name: string; org: string; is_test: boolean; week_start_date: string; week_kind: string;
  cur_a: number; exp_a: number; cur_adv: number; exp_adv: number; cur_pen: number; exp_pen: number;
  checks_migrated: boolean; wiped: boolean; has_award: boolean; ledger_rows: number; voided_rows: number; protected_zeroed: number;
};

async function pageAll<T>(b: (f: number, t: number) => PromiseLike<{ data: unknown; error: { message: string } | null }>, page = 1000): Promise<T[]> {
  const o: T[] = [];
  for (let f = 0; ; f += page) {
    const { data, error } = await b(f, f + page - 1);
    if (error) throw new Error(error.message);
    const r = (data ?? []) as T[];
    o.push(...r);
    if (r.length < page) break;
  }
  return o;
}

async function main() {
  const file = "claudedocs/" + readdirSync("claudedocs").filter((x) => x.startsWith("recover-uwp-dryrun-") && x.endsWith(".json")).sort().pop()!;
  const { rows } = JSON.parse(readFileSync(file, "utf8")) as { rows: Row[] };
  const byKey = new Map(rows.map((r) => [`${r.user_id}|${r.week_start_date}`, r]));

  const weeks = await pageAll<{ id: string; start_date: string | null; iso_year: number | null; iso_week: number | null; week_number: number | null; season_key: string | null }>(
    (f, t) => supabaseAdmin.from("weeks").select("id,start_date,iso_year,iso_week,week_number,season_key").order("start_date").range(f, t));
  const weekById = new Map(weeks.map((w) => [w.id, w]));

  // ═══ ① 예외 2명 (최윤하 / 김성훈) 규명 ═══
  console.log("═══ ① 누적 기준선 불일치 2명 규명 ═══");
  for (const name of ["최윤하", "김성훈"]) {
    const { data: prof } = await supabaseAdmin.from("user_profiles").select("user_id,display_name,organization_slug,activity_started_at").eq("display_name", name);
    for (const p of (prof ?? []) as any[]) {
      const uid = p.user_id;
      const { data: u } = await supabaseAdmin.from("users").select("source_system,legacy_user_id,created_at").eq("id", uid).maybeSingle();
      const led = await pageAll<{ source_table: string | null; source_pk: number | null; week_id: string | null; occurred_at: string | null; star: number | null; shield: number | null; entry_type: string | null; created_by: string | null; code: string | null; reason: string | null }>(
        (f, t) => supabaseAdmin.from("legacy_point_ledger").select("source_table,source_pk,week_id,occurred_at,star,shield,entry_type,created_by,code,reason").eq("user_id", uid).order("occurred_at").range(f, t));
      if (led.length === 0) continue;
      console.log(`\n▸ ${name} ${uid} src=${(u as any)?.source_system}:${(u as any)?.legacy_user_id} org=${p.organization_slug} started=${p.activity_started_at}`);
      const cb = new Map<string, number>(); for (const r of led) cb.set(String(r.created_by), (cb.get(String(r.created_by)) ?? 0) + 1);
      const st = new Map<string, number>(); for (const r of led) st.set(String(r.source_table), (st.get(String(r.source_table)) ?? 0) + 1);
      console.log(`   ledger ${led.length}행 created_by=${JSON.stringify([...cb])} source_table=${JSON.stringify([...st])}`);
      // 재구성값이 스냅샷 기준선보다 큰 주차 찾기
      const drRows = rows.filter((r) => r.user_id === uid);
      const { data: snapRow } = await supabaseAdmin.from("cluster4_weekly_card_snapshots").select("cards,computed_at").eq("user_id", uid).maybeSingle();
      const base = new Map<string, { a: number; adv: number; c: number }>();
      for (const c of ((snapRow as any)?.cards ?? [])) {
        if (!c?.startDate || !c?.points) continue;
        const pc = Number(c.points.pointC ?? 0);
        base.set(c.startDate, { a: Number(c.points.star ?? 0), adv: Number(c.points.shield ?? 0) + pc, c: pc });
      }
      console.log(`   snapshot computed_at=${(snapRow as any)?.computed_at} 카드 ${((snapRow as any)?.cards ?? []).length}장`);
      for (const r of drRows) {
        const b = base.get(r.week_start_date);
        const bs = b ? `${b.a}/${b.adv}/${b.c}` : "(카드없음)";
        if (!b || b.a !== r.exp_a || b.adv !== r.exp_adv || b.c !== r.exp_pen) {
          const w = weeks.find((x) => x.start_date === r.week_start_date);
          console.log(`   · ${r.week_start_date}[${r.week_kind}] snapshot=${bs} 복구예상=${r.exp_a}/${r.exp_adv}/${r.exp_pen} 현재=${r.cur_a}/${r.cur_adv}/${r.cur_pen} wiped=${r.wiped} cm=${r.checks_migrated} ledgerRows=${r.ledger_rows} voided=${r.voided_rows} protected=${r.protected_zeroed} (${w?.season_key} W${w?.week_number})`);
          // 해당 주차 원장 원문
          if (w) {
            const detail = led.filter((x) => x.week_id === w.id);
            for (const d of detail.slice(0, 10))
              console.log(`       ledger ${d.source_table}#${d.source_pk} ${String(d.occurred_at).slice(0, 10)} star=${d.star} shield=${d.shield} ${d.entry_type} by=${d.created_by} "${String(d.reason ?? "").slice(0, 40)}"`);
          }
        }
      }
    }
  }

  // ═══ ② 중복(이중적립) 위험 ═══
  console.log("\n\n═══ ② 중복(이중적립) 위험 분석 ═══");
  const ppa = await pageAll<{ id: string; user_id: string; year: number | null; week_number: number | null; point_check: number | null; point_advantage: number | null; point_penalty: number | null; cancelled_at: string | null; source_type?: string | null }>(
    (f, t) => supabaseAdmin.from("process_point_awards").select("*").order("id").range(f, t));
  const ppaActive = ppa.filter((r) => !r.cancelled_at);
  const ppaKey = new Map<string, { a: number; adv: number; pen: number; rows: number }>();
  for (const r of ppaActive) {
    const k = `${r.user_id}|${r.year}|${r.week_number}`;
    const e = ppaKey.get(k) ?? { a: 0, adv: 0, pen: 0, rows: 0 };
    e.a += r.point_check ?? 0; e.adv += r.point_advantage ?? 0; e.pen += Math.abs(r.point_penalty ?? 0); e.rows++;
    ppaKey.set(k, e);
  }
  // 원장(ledger) 재구성이 비영인 (user,year,week) 키
  const ledKey = new Set<string>();
  for (const r of rows) {
    if (r.exp_a === 0 && r.exp_adv === 0 && r.exp_pen === 0) continue;
    const w = weeks.find((x) => x.start_date === r.week_start_date);
    if (w) ledKey.add(`${r.user_id}|${w.iso_year}|${w.iso_week}`);
  }
  const overlap = [...ppaKey.keys()].filter((k) => ledKey.has(k));
  console.log(`process_point_awards active 키 ${ppaKey.size} · 원장 비영 키 ${ledKey.size}`);
  console.log(`두 원장이 같은 (user,year,week) 를 동시 보유: ${overlap.length}키  ← 단순 합산 시 이중적립 지점`);
  for (const k of overlap) {
    const [uid, y, wn] = k.split("|");
    const w = weeks.find((x) => String(x.iso_year) === y && String(x.iso_week) === wn);
    const dr = w ? byKey.get(`${uid}|${w.start_date}`) : undefined;
    const a = ppaKey.get(k)!;
    console.log(`   ${dr?.display_name ?? uid}(${dr?.org ?? "?"}) ${w?.start_date} awards=${a.a}/${a.adv}/${a.pen}(${a.rows}행) 원장재구성=${dr?.exp_a}/${dr?.exp_adv}/${dr?.exp_pen} 현재uwp=${dr?.cur_a}/${dr?.cur_adv}/${dr?.cur_pen} → 복구 스코프 제외(has_award=${dr?.has_award})`);
  }

  // 복구 스코프가 awards 키를 건드리는지
  const scope = rows.filter((r) => r.wiped && r.checks_migrated && !r.has_award && r.cur_a === 0 && r.cur_adv === 0 && r.cur_pen === 0 && (r.exp_a !== 0 || r.exp_adv !== 0 || r.exp_pen !== 0));
  let scopeTouchingAward = 0;
  for (const r of scope) {
    const w = weeks.find((x) => x.start_date === r.week_start_date);
    if (w && ppaKey.has(`${r.user_id}|${w.iso_year}|${w.iso_week}`)) scopeTouchingAward++;
  }
  console.log(`\n복구 스코프 ${scope.length}행 중 active award 키와 겹치는 행: ${scopeTouchingAward}  (0 이어야 안전)`);
  console.log(`복구는 "기존값 + 원장값" 가산이 아니라 원장 재구성값으로 **교체(SET)** — 재실행해도 동일값(idempotent).`);

  // 취소된 award 가 있는 키
  const cancelledOnly = new Set<string>();
  for (const r of ppa) if (r.cancelled_at) { const k = `${r.user_id}|${r.year}|${r.week_number}`; if (!ppaKey.has(k)) cancelledOnly.add(k); }
  console.log(`취소(cancelled_at≠null)만 있는 키: ${cancelledOnly.size} — §2 는 이 키를 0 으로 덮었고 복구 스코프에 포함될 수 있다.`);
  let scopeCancelled = 0;
  for (const r of scope) { const w = weeks.find((x) => x.start_date === r.week_start_date); if (w && cancelledOnly.has(`${r.user_id}|${w.iso_year}|${w.iso_week}`)) scopeCancelled++; }
  console.log(`   그중 복구 스코프에 포함: ${scopeCancelled}행`);

  // ═══ ③ 테스트 계정 잔여 손상 ═══
  console.log("\n\n═══ ③ 테스트 계정 잔여 손상 (원장 미보유 = ledger 로 복구 불가) ═══");
  const markers = new Set((await pageAll<{ user_id: string }>((f, t) => supabaseAdmin.from("test_user_markers").select("user_id").order("user_id").range(f, t))).map((m) => m.user_id));
  const uwp = await pageAll<{ user_id: string; week_start_date: string | null; points: number | null; advantages: number | null; penalty: number | null; checks_migrated: boolean | null; updated_at: string | null }>(
    (f, t) => supabaseAdmin.from("user_weekly_points").select("user_id,week_start_date,points,advantages,penalty,checks_migrated,updated_at").order("id").range(f, t));
  const wipedTest = uwp.filter((r) => markers.has(r.user_id) && String(r.updated_at ?? "").startsWith(WIPE_PREFIX));
  console.log(`테스트 계정 ${markers.size}명 중 §2 wiped 행: ${wipedTest.length} / ${new Set(wipedTest.map((r) => r.user_id)).size}명`);
  const ledUsers = new Set((await pageAll<{ user_id: string | null }>((f, t) => supabaseAdmin.from("legacy_point_ledger").select("user_id").order("id").range(f, t))).map((r) => r.user_id));
  console.log(`   그중 ledger 보유자: ${[...new Set(wipedTest.map((r) => r.user_id))].filter((u) => ledUsers.has(u)).length}명 (0 이면 전량 ledger 복구 불가)`);
  // 스냅샷 기준선 커버리지
  const snapPre = await pageAll<{ user_id: string }>((f, t) => supabaseAdmin.from("cluster4_weekly_card_snapshots").select("user_id").lt("computed_at", WIPE).order("user_id").range(f, t));
  const snapPreIds = new Set(snapPre.map((s) => s.user_id));
  const damagedTestUsers = [...new Set(wipedTest.map((r) => r.user_id))];
  console.log(`   pre-wipe 스냅샷으로 값 복원 가능한 테스트 사용자: ${damagedTestUsers.filter((u) => snapPreIds.has(u)).length} / ${damagedTestUsers.length}`);
  console.log(`   ⚠ pre-wipe 스냅샷은 재계산될 때마다 소실된다(현재 pre-wipe 보존 ${snapPreIds.size}/730). 이 기준선을 즉시 백업할 것.`);

  console.log("\n=== DONE (writes: 0) ===");
}

main().catch((e) => { console.error(e); process.exit(1); });
