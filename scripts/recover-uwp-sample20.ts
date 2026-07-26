/**
 * READ-ONLY — §4 대표 사용자 검증표(최소 20명, 필수 카테고리 전부 포함).
 *   npx tsx --env-file=.env.local scripts/recover-uwp-sample20.ts
 * write 0.
 *
 * 비교 축:
 *   ① migration 이전 roster slim (po_a / po_b=raw advantage / po_c)  ← 독립 검증 기준(정답 아님)
 *   ② legacy ledger 재구성 (dry-run exp_*)
 *   ③ 현재 user_weekly_points
 *   ④ 복구 예상 user_weekly_points
 *   ⑤ 현재 cumulative(=uwp 전체합, pointResolver 규칙)
 *   ⑥ 복구 예상 cumulative
 */
import { readdirSync, readFileSync, writeFileSync } from "fs";
import { supabaseAdmin } from "@/lib/supabaseAdmin";

const WIPE = "2026-07-25T04:52:00Z";
const STAMP = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);

type Row = {
  user_id: string; display_name: string; org: string; is_test: boolean; week_start_date: string; week_kind: string;
  cur_a: number; exp_a: number; cur_adv: number; exp_adv: number; cur_pen: number; exp_pen: number;
  checks_migrated: boolean; wiped: boolean; has_award: boolean;
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
  const SCOPE = rows.filter((r) => r.wiped && r.checks_migrated && !r.has_award && r.cur_a === 0 && r.cur_adv === 0 && r.cur_pen === 0 && (r.exp_a !== 0 || r.exp_adv !== 0 || r.exp_pen !== 0));

  const uwp = await pageAll<{ user_id: string; week_start_date: string | null; points: number | null; advantages: number | null; penalty: number | null }>(
    (f, t) => supabaseAdmin.from("user_weekly_points").select("user_id,week_start_date,points,advantages,penalty").order("id").range(f, t));
  const curCum = new Map<string, { a: number; adv: number; pen: number }>();
  for (const r of uwp) {
    const e = curCum.get(r.user_id) ?? { a: 0, adv: 0, pen: 0 };
    e.a += r.points ?? 0; e.adv += r.advantages ?? 0; e.pen += r.penalty ?? 0;
    curCum.set(r.user_id, e);
  }
  const delta = new Map<string, { a: number; adv: number; pen: number; rows: number }>();
  for (const r of SCOPE) {
    const e = delta.get(r.user_id) ?? { a: 0, adv: 0, pen: 0, rows: 0 };
    e.a += r.exp_a; e.adv += r.exp_adv; e.pen += r.exp_pen; e.rows++;
    delta.set(r.user_id, e);
  }
  const roster = new Map((await pageAll<{ user_id: string; po_a: number | null; po_b: number | null; po_c: number | null }>(
    (f, t) => supabaseAdmin.from("cluster4_roster_card_stats").select("user_id,po_a,po_b,po_c").lt("updated_at", WIPE).order("user_id").range(f, t))).map((r) => [r.user_id, r]));
  const markers = new Set((await pageAll<{ user_id: string }>((f, t) => supabaseAdmin.from("test_user_markers").select("user_id").order("user_id").range(f, t))).map((m) => m.user_id));
  const ucp = new Map((await pageAll<{ user_id: string; total_checks: number | null; total_raw_advantages: number | null; total_penalties: number | null }>(
    (f, t) => supabaseAdmin.from("user_cumulative_points").select("user_id,total_checks,total_raw_advantages,total_penalties").order("user_id").range(f, t))).map((r) => [r.user_id, r]));
  const ppa = await pageAll<{ user_id: string; cancelled_at: string | null }>((f, t) => supabaseAdmin.from("process_point_awards").select("user_id,cancelled_at").order("id").range(f, t));
  const awardUsers = new Set(ppa.filter((r) => !r.cancelled_at).map((r) => r.user_id));
  const usersRows = await pageAll<{ id: string; source_system: string | null }>((f, t) => supabaseAdmin.from("users").select("id,source_system").order("id").range(f, t));
  const srcOf = new Map(usersRows.map((u) => [u.id, u.source_system]));
  const profs = new Map((await pageAll<{ user_id: string; display_name: string | null; organization_slug: string | null }>(
    (f, t) => supabaseAdmin.from("user_profiles").select("user_id,display_name,organization_slug").order("user_id").range(f, t))).map((p) => [p.user_id, p]));

  // 사용자 특성
  type U = { id: string; name: string; org: string; test: boolean; src: string; rows: number; expA: number; expAdv: number; expPen: number; curA: number; allZeroNow: boolean; onlyRestNonZero: boolean; hasAward: boolean; restoredA: number };
  const chars = new Map<string, U>();
  const nzByUser = new Map<string, { act: number; restLike: number }>();
  for (const r of rows) {
    const nz = r.cur_a !== 0 || r.cur_adv !== 0 || r.cur_pen !== 0;
    if (!nz) continue;
    const e = nzByUser.get(r.user_id) ?? { act: 0, restLike: 0 };
    if (r.week_kind === "activity") e.act++; else if (r.week_kind === "rest" || r.week_kind === "transition") e.restLike++;
    nzByUser.set(r.user_id, e);
  }
  for (const [uid, d] of delta) {
    const cur = curCum.get(uid) ?? { a: 0, adv: 0, pen: 0 };
    const nz = nzByUser.get(uid) ?? { act: 0, restLike: 0 };
    const p = profs.get(uid);
    chars.set(uid, {
      id: uid, name: p?.display_name ?? "?", org: p?.organization_slug ?? "?", test: markers.has(uid), src: srcOf.get(uid) ?? "null",
      rows: d.rows, expA: d.a, expAdv: d.adv, expPen: d.pen, curA: cur.a,
      allZeroNow: nz.act === 0 && nz.restLike === 0,
      onlyRestNonZero: nz.act === 0 && nz.restLike > 0,
      hasAward: awardUsers.has(uid),
      restoredA: cur.a + d.a,
    });
  }
  const pool = [...chars.values()];
  const pick = new Map<string, string[]>(); // uid → 충족 카테고리
  const add = (u: U | undefined, cat: string) => { if (!u) return; const l = pick.get(u.id) ?? []; if (!l.includes(cat)) l.push(cat); pick.set(u.id, l); };
  const top = (f: (u: U) => boolean, by: (u: U) => number, n: number, cat: string) =>
    pool.filter(f).sort((a, b) => by(b) - by(a)).slice(0, n).forEach((u) => add(u, cat));

  top((u) => u.restoredA >= 100, (u) => u.restoredA, 8, "A 세자릿수↑");
  top((u) => u.allZeroNow, (u) => u.expA, 5, "전주차 0");
  top((u) => u.onlyRestNonZero, (u) => u.expA, 5, "휴식주차만 잔존");
  top((u) => u.hasAward, (u) => u.expA, 5, "신규 award 보유");
  top((u) => !u.hasAward, (u) => u.expA, 5, "레거시만");
  top((u) => u.expPen > 0, (u) => u.expPen, 5, "penalty 보유");
  top((u) => u.expAdv > 0, (u) => u.expAdv, 5, "advantage 보유");
  top((u) => u.org === "oranke", (u) => u.expA, 3, "org=oranke");
  top((u) => u.org === "encre", (u) => u.expA, 3, "org=encre");
  top((u) => u.org === "phalanx", (u) => u.expA, 3, "org=phalanx");
  top((u) => u.src === "olympus", (u) => u.expA, 2, "src=olympus");
  top((u) => u.src === "hrdb", (u) => u.expA, 2, "src=hrdb");
  top((u) => u.src === "oranke", (u) => u.expA, 2, "src=oranke");
  top((u) => u.curA < 0, (u) => -u.curA, 3, "현재 A 음수");
  top((u) => u.rows >= 60, (u) => u.rows, 3, "복구행 60↑");
  // 예외 2명(기준선 불일치) 필수 포함
  for (const n of ["최윤하", "김성훈"]) { const u = pool.find((x) => x.name === n); add(u, "기준선 불일치 예외"); }
  // 테스트 사용자 — 복구 스코프에는 없으므로 §2 피해 테스트 계정에서 별도 선정
  const wipedTestUsers = [...new Set(rows.filter((r) => r.is_test).map((r) => r.user_id))];

  const chosen = [...pick.keys()];
  console.log(`대표 사용자 ${chosen.length}명 선정 (복구 스코프 내) + 테스트 계정 별도 3명`);

  type Out = {
    사용자: string; org: string; src: string; 카테고리: string;
    "①roster slim(A/rawAdv/C)": string; "②원장재구성 Δ(A/rawAdv/C)": string;
    "③현재 uwp(A/rawAdv/C)": string; "④복구예상 uwp(A/rawAdv/C)": string;
    "⑤현재 cumulative(A/B/C)": string; "⑥복구예상 cumulative(A/B/C)": string;
    "판정": string; 복구행수: number; user_id: string;
  };
  const out: Out[] = [];
  for (const uid of chosen) {
    const u = chars.get(uid)!;
    const cur = curCum.get(uid) ?? { a: 0, adv: 0, pen: 0 };
    const d = delta.get(uid) ?? { a: 0, adv: 0, pen: 0, rows: 0 };
    const rs = roster.get(uid);
    const resA = cur.a + d.a, resAdv = cur.adv + d.adv, resC = cur.pen + d.pen;
    const base = rs ? `${rs.po_a}/${rs.po_b}/${rs.po_c}` : "(캐시 이미 덮임)";
    const ok = !rs ? "기준선 없음" : (rs.po_a === resA && rs.po_b === resAdv && rs.po_c === resC) ? "✅ 일치" : `⚠ Δ=${resA - (rs.po_a ?? 0)}/${resAdv - (rs.po_b ?? 0)}/${resC - (rs.po_c ?? 0)}`;
    const c = ucp.get(uid);
    out.push({
      사용자: u.name, org: u.org, src: u.src, 카테고리: (pick.get(uid) ?? []).join(", "),
      "①roster slim(A/rawAdv/C)": base,
      "②원장재구성 Δ(A/rawAdv/C)": `+${d.a}/+${d.adv}/+${d.pen}`,
      "③현재 uwp(A/rawAdv/C)": `${cur.a}/${cur.adv}/${cur.pen}`,
      "④복구예상 uwp(A/rawAdv/C)": `${resA}/${resAdv}/${resC}`,
      "⑤현재 cumulative(A/B/C)": c ? `${c.total_checks}/${(c.total_raw_advantages ?? 0) - (c.total_penalties ?? 0)}/${c.total_penalties}` : "-",
      "⑥복구예상 cumulative(A/B/C)": `${resA}/${resAdv - resC}/${resC}`,
      "판정": ok, 복구행수: d.rows, user_id: uid,
    });
  }
  out.sort((a, b) => Number(b["④복구예상 uwp(A/rawAdv/C)"].split("/")[0]) - Number(a["④복구예상 uwp(A/rawAdv/C)"].split("/")[0]));

  console.log("\n| 사용자 | org | src | 카테고리 | ①roster slim A/rawAdv/C | ②원장재구성 Δ | ③현재 uwp | ④복구예상 uwp | ⑤현재 cum A/B/C | ⑥복구예상 cum A/B/C | 판정 | 복구행 |");
  console.log("|---|---|---|---|---|---|---|---|---|---|---|---|");
  for (const r of out)
    console.log(`| ${r.사용자} | ${r.org} | ${r.src} | ${r.카테고리} | ${r["①roster slim(A/rawAdv/C)"]} | ${r["②원장재구성 Δ(A/rawAdv/C)"]} | ${r["③현재 uwp(A/rawAdv/C)"]} | ${r["④복구예상 uwp(A/rawAdv/C)"]} | ${r["⑤현재 cumulative(A/B/C)"]} | ${r["⑥복구예상 cumulative(A/B/C)"]} | ${r.판정} | ${r.복구행수} |`);

  console.log("\n── 테스트 계정(§2 피해 · 원장 미보유 → 이번 복구 스코프 제외) ──");
  console.log("| 사용자 | org | 현재 cumulative A | §2 wiped 행 | 원장 행 | 비고 |");
  console.log("|---|---|---|---|---|---|");
  for (const uid of wipedTestUsers.slice(0, 5)) {
    const cur = curCum.get(uid) ?? { a: 0, adv: 0, pen: 0 };
    const p = profs.get(uid);
    const wipedRows = rows.filter((r) => r.user_id === uid && r.wiped).length;
    const ledRows = rows.filter((r) => r.user_id === uid).reduce((s, r) => s + (r.exp_a !== 0 || r.exp_adv !== 0 || r.exp_pen !== 0 ? 1 : 0), 0);
    console.log(`| ${p?.display_name ?? "?"} | ${p?.organization_slug ?? "?"} | ${cur.a} | ${wipedRows} | ${ledRows} | QA 시드 — legacy_point_ledger 미보유 |`);
  }

  const outFile = `claudedocs/recover-uwp-sample20-${STAMP}.json`;
  writeFileSync(outFile, JSON.stringify(out, null, 1), "utf8");
  console.log(`\n→ ${outFile}`);
  console.log("\n=== DONE (writes: 0) ===");
}

main().catch((e) => { console.error(e); process.exit(1); });
