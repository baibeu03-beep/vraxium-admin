/**
 * Pilot apply 최종 검증 (read-only) — 지정 순서 1~5 + 실측 write 집계.
 *   npx tsx --env-file=.env.local scripts/verify-pilot-final.ts [--http http://localhost:3000]
 */
import { config } from "dotenv";
config({ path: ".env.local" });
import { writeFileSync, readFileSync } from "fs";
import { createHash } from "crypto";
import { createClient } from "@supabase/supabase-js";
import { getCluster4WeeklyCardsForProfileUser } from "@/lib/cluster4WeeklyCardsData";

const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);
const httpIdx = process.argv.indexOf("--http");
const HTTP = httpIdx >= 0 ? process.argv[httpIdx + 1] : "http://localhost:3000";
const OUT = "claudedocs/pilot-apply-5-final-verify-20260607.json";
const sha1 = (s: string) => createHash("sha1").update(s).digest("hex").slice(0, 16);
const canon = (v: unknown): string =>
  JSON.stringify(v, (_k, val) =>
    val && typeof val === "object" && !Array.isArray(val)
      ? Object.fromEntries(Object.entries(val as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : 1)))
      : val,
  );

let pass = 0, fail = 0;
const results: Array<{ name: string; ok: boolean; detail?: string }> = [];
const check = (name: string, ok: boolean, detail?: string) => {
  results.push({ name, ok, detail });
  ok ? pass++ : fail++;
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? ` — ${detail}` : ""}`);
};

const PILOT = [
  { p: "P1", src: "oranke", uid: 1092, name: "장승완", expCards: 28 },
  { p: "P2", src: "hrdb", uid: 1463, name: "안은비", expCards: 42 },
  { p: "P3", src: "olympus", uid: 249, name: "성채윤", expCards: 19 },
  { p: "P4", src: "olympus", uid: 248, name: "박시은", expCards: 19 },
  { p: "P5", src: "olympus", uid: 251, name: "정혜빈", expCards: 29 },
];

async function main() {
  // 페어로 uuid 식별
  const uuids = new Map<string, string>();
  for (const t of PILOT) {
    const { data } = await sb.from("users").select("id").eq("source_system", t.src).eq("legacy_user_id", t.uid).maybeSingle();
    if (!data) throw new Error(`${t.p} 페어 미존재`);
    uuids.set(t.p, (data as { id: string }).id);
  }
  check("[0] 페어 기록 5/5 — (source_system, legacy_user_id) 전원 점유", uuids.size === 5);

  // ── 실측 write 집계 ──
  const tally: Record<string, unknown> = {};
  {
    const ids = [...uuids.values()];
    const cnt = async (t: string, col: string, extra?: (q: any) => any) => {
      let q: any = sb.from(t).select(col, { count: "exact", head: true }).in(col === "id" ? "id" : col, ids);
      if (extra) q = extra(q);
      const { count } = await q;
      return count ?? 0;
    };
    const { count: ledger } = await sb.from("legacy_point_ledger").select("id", { count: "exact", head: true }).eq("created_by", "pilot-apply-5");
    const { count: lines } = await sb.from("cluster4_lines").select("id", { count: "exact", head: true }).eq("source_file_name", "pilot-apply-5");
    const { data: lineCodes } = await sb.from("cluster4_lines").select("line_code").eq("source_file_name", "pilot-apply-5").order("line_code");
    const { count: uws } = await sb.from("user_week_statuses").select("id", { count: "exact", head: true }).in("user_id", ids);
    const { count: uwp } = await sb.from("user_weekly_points").select("id", { count: "exact", head: true }).in("user_id", ids);
    const { count: sentinels } = await sb.from("user_weekly_points").select("id", { count: "exact", head: true }).in("user_id", ids).eq("week_start_date", "1900-01-01");
    const { data: sentinelRows } = await sb.from("user_weekly_points").select("user_id,year,week_number,points,advantages,penalty,checks_migrated").in("user_id", ids).eq("week_start_date", "1900-01-01");
    const { count: cmFalse } = await sb.from("user_weekly_points").select("id", { count: "exact", head: true }).in("user_id", ids).eq("checks_migrated", false).neq("week_start_date", "1900-01-01");
    const { count: targets } = await sb.from("cluster4_line_targets").select("id", { count: "exact", head: true }).in("target_user_id", ids);
    const { count: profs } = await sb.from("user_profiles").select("user_id", { count: "exact", head: true }).in("user_id", ids);
    const { count: snaps } = await sb.from("cluster4_weekly_card_snapshots").select("user_id", { count: "exact", head: true }).in("user_id", ids);
    tally.ledger = ledger; tally.ensureLines = lines; tally.lineCodes = (lineCodes ?? []).map((l: any) => l.line_code);
    tally.uwsRows = uws; tally.uwpRows = uwp; tally.sentinels = sentinels; tally.sentinelRows = sentinelRows;
    tally.cmFalse = cmFalse; tally.targets = targets; tally.profiles = profs; tally.snapshots = snaps;
    void cnt;
    check("[A] ledger 3,048 (3,043+ADJ 5)", ledger === 3048, `actual=${ledger}`);
    check("[B] ensure 라인 11 — 전부 EXBS-EN", lines === 11 && (lineCodes ?? []).every((l: any) => String(l.line_code).startsWith("EXBS-EN")), (lineCodes ?? []).map((l: any) => l.line_code).join(","));
    check("[C] sentinel 5행 — 1900-W1·cm=false", sentinels === 5 && (sentinelRows ?? []).every((r: any) => r.year === 1900 && r.week_number === 1 && r.checks_migrated === false), JSON.stringify((sentinelRows ?? []).map((r: any) => r.points)));
    check("[D] FLIP cm=false 2행 (sentinel 제외)", cmFalse === 2, `actual=${cmFalse}`);
    check("[E] snapshot 5명 보유", snaps === 5);
  }

  // ── 1~3) direct / HTTP / canonical ──
  type GateCard = { startDate?: string; userWeekStatus?: string; experienceGrowth?: { checkGate?: unknown } | null };
  let allEq = true;
  for (const t of PILOT) {
    const uuid = uuids.get(t.p)!;
    const direct = (await getCluster4WeeklyCardsForProfileUser(uuid)) as unknown as GateCard[];
    const res = await fetch(`${HTTP}/api/cluster4/weekly-cards?userId=${uuid}`, {
      headers: { "x-internal-api-key": process.env.INTERNAL_API_KEY ?? "" },
    });
    const http = ((await res.json()).data ?? []) as GateCard[];
    const eq = canon(direct) === canon(http);
    if (!eq) allEq = false;
    const sentinelLeak = direct.some((c) => String(c.startDate ?? "").startsWith("1900"));
    check(
      `[1-3] ${t.p} ${t.name} direct ${direct.length}카드 · HTTP ${http.length} · 일치 ${eq} · sentinel 미노출 ${!sentinelLeak}`,
      res.ok && eq && !sentinelLeak && direct.length >= t.expCards,
      `expected≥${t.expCards}`,
    );
  }
  check("[3] direct == HTTP 5/5 (canonical)", allEq);

  // ── 4) 비대상 무영향 (before fingerprint 대비) ──
  {
    const before = JSON.parse(readFileSync("claudedocs/pilot-baseline-before-20260607.json", "utf8"));
    const exclude = new Set([...uuids.values()]);
    const fetchAll = async (t: string, sel: string, ord: string) => {
      const out: any[] = [];
      for (let from = 0; ; from += 1000) {
        const { data, error } = await sb.from(t).select(sel).order(ord, { ascending: true }).range(from, from + 999);
        if (error) throw new Error(error.message);
        out.push(...(data ?? []));
        if ((data ?? []).length < 1000) break;
      }
      return out;
    };
    let ok = true;
    const det: string[] = [];
    for (const [t, sel, ord] of [
      ["users", "id,legacy_user_id,source_system", "id"],
      ["user_profiles", "user_id,display_name,organization_slug,updated_at", "user_id"],
      ["user_week_statuses", "id,user_id,week_start_date,status", "id"],
      ["user_weekly_points", "id,user_id,week_start_date,points,advantages,penalty,checks_migrated", "id"],
      ["cluster4_weekly_card_snapshots", "user_id,computed_at,is_stale,dto_version", "user_id"],
    ] as const) {
      const rows = (await fetchAll(t, sel, ord)).filter((r) => !exclude.has(r.user_id ?? r.id));
      const h = sha1(JSON.stringify(rows));
      const b = before.fp[t];
      if (h !== b.hash || rows.length !== b.rows) { ok = false; det.push(`${t}: ${b.rows}/${b.hash} → ${rows.length}/${h}`); }
    }
    check("[4] 비대상 사용자 영향 0 — 5개 테이블 fingerprint 전후 동일", ok, det.join(" ; ") || "5/5 동일");
  }

  // ── 5) snapshot 재계산 결과 ──
  {
    const { data } = await sb.from("cluster4_weekly_card_snapshots").select("user_id,dto_version,is_stale,computed_at").in("user_id", [...uuids.values()]);
    const okAll = (data ?? []).length === 5 && (data ?? []).every((s: any) => s.dto_version === 18 && s.is_stale === false && s.computed_at >= "2026-06-07T12:3");
    check("[5] snapshot 5명 — v18 · is_stale=false · apply 시점 재계산", okAll, JSON.stringify((data ?? []).map((s: any) => s.computed_at.slice(11, 19))));
  }

  // demo 경로 회귀 (테스터 1명 — 경로 동일성)
  {
    const { data: tu } = await sb.from("test_user_markers").select("user_id").limit(1).maybeSingle();
    const tid = (tu as { user_id: string } | null)?.user_id;
    if (tid) {
      const a = ((await (await fetch(`${HTTP}/api/cluster4/weekly-cards?userId=${tid}`, { headers: { "x-internal-api-key": process.env.INTERNAL_API_KEY ?? "" } })).json()).data ?? []);
      const b = ((await (await fetch(`${HTTP}/api/cluster4/weekly-cards?demoUserId=${tid}`)).json()).data ?? []);
      check("[demo] demoUserId == internal-key (테스터 회귀)", canon(a) === canon(b));
    }
  }

  writeFileSync(OUT, JSON.stringify({ pass, fail, results, tally, uuids: Object.fromEntries(uuids) }, null, 1));
  console.log(`\n결과: PASS ${pass} / FAIL ${fail} → ${OUT}`);
  process.exit(fail ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(1); });
