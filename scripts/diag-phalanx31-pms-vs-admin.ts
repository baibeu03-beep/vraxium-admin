// =====================================================================
// READ-ONLY 조사: phalanx 실사용자 전체에 대해 PMS(olympus) vs admin 비교.
//   - DB write 없음 · 재계산 없음 · snapshot 생성 없음. 순수 SELECT + 메모리 집계.
//
// 모집단: olympus usersinfo State='일반' (weekly-league printUsers 로스터의 PMS 원천).
// PMS 기준:
//   - UserWeek        = usersinfo.Week (PMS 자체 누적 인정주차 카운터)
//   - 누적인정주차(재현) = useractivities∪manageractivities 중 IsActive=1 인
//                          distinct (Season,SeasonWeek), isExcludedPmsSeason 제외
//   - 활동시작일      = usersinfo.StartDate
// admin 기준:
//   - user_growth_stats.cumulative_weeks / approved_weeks
//   - user_profiles.activity_started_at
//   - (교차검증) user_week_statuses 행수 · cluster4_weekly_card_snapshots.card_count
// 매핑: admin users(source_system='olympus', legacy_user_id=UserID) → id, 실패시 이름매칭.
// =====================================================================
import { readFileSync, writeFileSync } from "node:fs";
import mysql from "mysql2/promise";
import { isExcludedPmsSeason } from "@/lib/pmsSeasonAttribution";

const env = readFileSync(".env.local", "utf8");
const G = (k: string) => env.match(new RegExp(`^${k}=(.+)$`, "m"))?.[1]?.trim();
const sbUrl = G("NEXT_PUBLIC_SUPABASE_URL")!;
const sbKey = G("SUPABASE_SERVICE_ROLE_KEY")!;
const SH = { apikey: sbKey, Authorization: `Bearer ${sbKey}` };
async function sbAll(p: string): Promise<any[]> {
  const A: any[] = [];
  for (let f = 0; ; f += 1000) {
    const s = p.includes("?") ? "&" : "?";
    const r = await fetch(`${sbUrl}/rest/v1/${p}${s}limit=1000&offset=${f}`, { headers: SH });
    if (!r.ok) throw new Error(`${p} ${r.status} ${await r.text()}`);
    const j = await r.json();
    A.push(...j);
    if (j.length < 1000) break;
  }
  return A;
}

async function main() {
  const SRC = "olympus";
  const conn = await mysql.createConnection({
    host: G("MYSQL_HOST"), port: Number(G("MYSQL_PORT") ?? 3306),
    user: G("MYSQL_USER"), password: G("MYSQL_PASSWORD"), dateStrings: true,
    ssl: { rejectUnauthorized: false },
  });
  const q = async (s: string, p: any[] = []) => (await conn.query(s, p))[0] as any[];

  // ── 1) PMS 모집단: usersinfo State='일반' (latest by Week) ──
  const ui = await q(`SELECT UserID,State,Team,Week,CAST(StartDate AS CHAR) sd FROM ${SRC}.usersinfo`);
  const latest = new Map<number, any>();
  for (const r of ui) { const c = latest.get(r.UserID); if (!c || Number(r.Week || 0) >= Number(c.Week || 0)) latest.set(r.UserID, r); }
  const ilban = [...latest.values()].filter((r) => r.State === "일반" && !(r.Team || "").includes("시즌전체휴식"));
  const names = new Map((await q(`SELECT UserId,Name,School FROM ${SRC}.users`)).map((r) => [r.UserId, { name: (r.Name || "").trim(), school: r.School }]));

  // PMS 누적인정주차 재현 (IsActive=1 distinct weeks, 제외시즌 빼고) — ua+ma 합집합
  const recognizedByLg = new Map<number, number>();
  const totalActRowsByLg = new Map<number, number>();
  for (const table of ["useractivities", "manageractivities"]) {
    const rows = await q(`SELECT UserId,Season,SeasonWeek,IsActive FROM ${SRC}.${table}`);
    for (const r of rows) {
      const lg = r.UserId;
      totalActRowsByLg.set(lg, (totalActRowsByLg.get(lg) ?? 0) + 1);
    }
  }
  // distinct recognized weeks per user (union across ua+ma)
  const recSet = new Map<number, Set<string>>();
  for (const table of ["useractivities", "manageractivities"]) {
    const rows = await q(`SELECT UserId,Season,SeasonWeek,IsActive FROM ${SRC}.${table}`);
    for (const r of rows) {
      if (r.IsActive !== 1) continue;
      if (isExcludedPmsSeason(r.Season)) continue;
      const lg = r.UserId;
      let s = recSet.get(lg); if (!s) { s = new Set(); recSet.set(lg, s); }
      s.add(`${r.Season}|${r.SeasonWeek}`);
    }
  }
  for (const [lg, s] of recSet) recognizedByLg.set(lg, s.size);

  await conn.end();

  // ── 2) admin 매핑 ──
  const usersOlympus = await sbAll(`users?select=id,legacy_user_id&source_system=eq.${SRC}`);
  const idByLegacy = new Map<number, string>(usersOlympus.map((u) => [Number(u.legacy_user_id), u.id]));
  const test = new Set((await sbAll("test_user_markers?select=user_id")).map((t) => t.user_id));
  const phProf = await sbAll("user_profiles?select=user_id,display_name,status,activity_started_at,current_team_name,organization_slug&organization_slug=eq.phalanx");
  const profByUid = new Map(phProf.map((p) => [p.user_id, p]));
  const profByName = new Map<string, any[]>();
  for (const p of phProf) { if (test.has(p.user_id)) continue; const k = (p.display_name || "").trim(); const a = profByName.get(k) || []; a.push(p); profByName.set(k, a); }

  // admin 집계 테이블 (전 사용자 → 필요한 uid만 추후 lookup)
  const gsAll = await sbAll("user_growth_stats?select=user_id,approved_weeks,cumulative_weeks");
  const gsByUid = new Map(gsAll.map((g) => [g.user_id, g]));
  const snapAll = await sbAll("cluster4_weekly_card_snapshots?select=user_id,card_count");
  const snapByUid = new Map(snapAll.map((s) => [s.user_id, s]));

  // ── 3) 행 빌드 ──
  type Row = {
    lg: number; name: string; pmsWeek: number; pmsRecognized: number; pmsStart: string;
    uid: string | null; mapBy: string; adminCum: number | null; adminApproved: number | null;
    adminStart: string | null; uwsCount: number | null; snapCount: number | null; status: string | null;
  };
  const out: Row[] = [];
  for (const r of ilban) {
    const lg = r.UserID;
    const nm = names.get(lg)?.name ?? `?${lg}`;
    let uid: string | null = idByLegacy.get(lg) ?? null;
    let mapBy = "legacy";
    let prof = uid ? profByUid.get(uid) : null;
    if (!prof) { // legacy 매핑 실패 or 매핑된 uid가 phalanx 프로필 아님 → 이름매칭
      const m = profByName.get(nm);
      if (m && m.length === 1) { prof = m[0]; uid = prof.user_id; mapBy = "name"; }
      else if (m && m.length > 1) { mapBy = `name-ambiguous(${m.length})`; }
      else { mapBy = uid ? "legacy(no-phalanx-prof)" : "unmapped"; }
    }
    const gs = uid ? gsByUid.get(uid) : null;
    const sn = uid ? snapByUid.get(uid) : null;
    out.push({
      lg, name: nm, pmsWeek: Number(r.Week || 0), pmsRecognized: recognizedByLg.get(lg) ?? 0,
      pmsStart: (r.sd || "").slice(0, 10), uid, mapBy,
      adminCum: gs ? gs.cumulative_weeks : null, adminApproved: gs ? gs.approved_weeks : null,
      adminStart: prof?.activity_started_at ? prof.activity_started_at.slice(0, 10) : null,
      uwsCount: null, snapCount: sn ? sn.card_count : null, status: prof?.status ?? null,
    });
  }

  // uws 행수 (매핑된 uid만)
  const mappedUids = out.map((o) => o.uid).filter(Boolean) as string[];
  const uwsCountByUid = new Map<string, number>();
  if (mappedUids.length) {
    const uws = await sbAll(`user_week_statuses?select=user_id&user_id=in.(${mappedUids.join(",")})`);
    for (const u of uws) uwsCountByUid.set(u.user_id, (uwsCountByUid.get(u.user_id) ?? 0) + 1);
  }
  for (const o of out) if (o.uid) o.uwsCount = uwsCountByUid.get(o.uid) ?? 0;

  // ── 4) 출력 ──
  out.sort((a, b) => b.pmsWeek - a.pmsWeek);
  console.log(`\n■ phalanx PMS 일반 모집단: ${ilban.length}명 (admin source_system=olympus users ${usersOlympus.length}행)`);
  console.log(`\n${"lg".padStart(4)} ${"이름".padEnd(8)} ${"PMSwk".padStart(5)} ${"PMS인정".padStart(6)} ${"PMS시작".padEnd(10)} | ${"admCum".padStart(6)} ${"admAppr".padStart(7)} ${"uws".padStart(4)} ${"snap".padStart(4)} ${"adm시작".padEnd(10)} ${"Δcum".padStart(5)} ${"Δappr".padStart(5)} map`);
  for (const o of out) {
    const dcum = o.adminCum == null ? null : o.pmsWeek - o.adminCum;
    const dappr = o.adminApproved == null ? null : o.pmsRecognized - o.adminApproved;
    console.log(
      `${String(o.lg).padStart(4)} ${o.name.padEnd(8)} ${String(o.pmsWeek).padStart(5)} ${String(o.pmsRecognized).padStart(6)} ${(o.pmsStart || "-").padEnd(10)} | ${String(o.adminCum ?? "—").padStart(6)} ${String(o.adminApproved ?? "—").padStart(7)} ${String(o.uwsCount ?? "—").padStart(4)} ${String(o.snapCount ?? "—").padStart(4)} ${(o.adminStart || "—").padEnd(10)} ${(dcum == null ? "—" : String(dcum)).padStart(5)} ${(dappr == null ? "—" : String(dappr)).padStart(5)} ${o.mapBy}`,
    );
  }

  // ── 5) 차이 분류 (UserWeek vs admin cumulative_weeks) ──
  const mapped = out.filter((o) => o.adminCum != null);
  const unmapped = out.filter((o) => o.adminCum == null);
  const diffs = mapped.map((o) => o.pmsWeek - (o.adminCum as number));
  const band = { A: 0, B: 0, mid4: 0, C: 0, D: 0 };
  for (const d of diffs) {
    if (d === 0) band.A++;
    else if (d >= 1 && d <= 3) band.B++;
    else if (d === 4) band.mid4++;
    else if (d >= 5 && d <= 9) band.C++;
    else if (d >= 10) band.D++;
    else band.A++; // 음수(admin>PMS)는 A쪽으로 두되 별도 표기
  }
  const neg = diffs.filter((d) => d < 0).length;
  // 차이값별 인원 분포
  const distCount = new Map<number, number>();
  for (const d of diffs) distCount.set(d, (distCount.get(d) ?? 0) + 1);

  console.log(`\n${"=".repeat(70)}\n[차이 분류] UserWeek − admin.cumulative_weeks (매핑된 ${mapped.length}명, 미매핑/무growth_stats ${unmapped.length}명)`);
  console.log(`  A 동일(Δ=0): ${band.A}명${neg ? ` (그중 음수 ${neg})` : ""}`);
  console.log(`  B 1~3주: ${band.B}명`);
  console.log(`  (Δ=4): ${band.mid4}명`);
  console.log(`  C 5~9주: ${band.C}명`);
  console.log(`  D 10주 이상: ${band.D}명`);
  console.log(`\n  차이값별 인원: ${[...distCount.entries()].sort((a, b) => b[0] - a[0]).map(([d, n]) => `Δ${d}:${n}명`).join("  ")}`);

  // 권원중/권희윤 위치
  const kwj = out.find((o) => o.lg === 253), khy = out.find((o) => o.lg === 259);
  const fmt = (o?: Row) => o ? `Δcum=${o.adminCum == null ? "무growth_stats" : o.pmsWeek - (o.adminCum as number)} (PMS ${o.pmsWeek} vs admCum ${o.adminCum ?? "—"})` : "없음";
  console.log(`\n[권원중 253] ${fmt(kwj)}`);
  console.log(`[권희윤 259] ${fmt(khy)}`);

  // approved diff 분포도
  const apprDiffs = out.filter((o) => o.adminApproved != null).map((o) => o.pmsRecognized - (o.adminApproved as number));
  const apprDist = new Map<number, number>();
  for (const d of apprDiffs) apprDist.set(d, (apprDist.get(d) ?? 0) + 1);
  console.log(`\n[참고] 누적인정 − approved_weeks 차이값별: ${[...apprDist.entries()].sort((a, b) => b[0] - a[0]).map(([d, n]) => `Δ${d}:${n}명`).join("  ")}`);

  // snapshot 동일 문제 여부 (snap card_count vs PMS Week)
  const withSnap = out.filter((o) => o.snapCount != null);
  console.log(`\n[snapshot] card_count 보유 ${withSnap.length}명 / 매핑 ${mapped.length}명`);
  const snapDiffs = withSnap.map((o) => o.pmsWeek - (o.snapCount as number));
  const snapDist = new Map<number, number>();
  for (const d of snapDiffs) snapDist.set(d, (snapDist.get(d) ?? 0) + 1);
  console.log(`  PMS Week − snap.card_count 차이값별: ${[...snapDist.entries()].sort((a, b) => b[0] - a[0]).map(([d, n]) => `Δ${d}:${n}명`).join("  ") || "(없음)"}`);

  // growth_stats 캐시 신선도: cumulative_weeks vs uws 실제 행수
  const stale = mapped.filter((o) => o.uwsCount != null && o.adminCum != null && o.uwsCount !== o.adminCum);
  console.log(`\n[growth_stats 캐시] cumulative_weeks ≠ uws실제행수: ${stale.length}명${stale.length ? " → " + stale.map((o) => `${o.name}(${o.adminCum}vs${o.uwsCount})`).join(", ") : " (전부 일치)"}`);

  writeFileSync("claudedocs/diag-phalanx31-pms-vs-admin.json", JSON.stringify({ population: ilban.length, mapped: mapped.length, unmapped: unmapped.length, band, distCount: [...distCount.entries()], rows: out }, null, 2));
  console.log("\n📄 claudedocs/diag-phalanx31-pms-vs-admin.json");
}
main().catch((e) => { console.error(e); process.exit(1); });
