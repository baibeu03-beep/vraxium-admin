/**
 * DRY-RUN (READ-ONLY): 라인 개설 Point A·B 소급 보정 대상 산정.
 *   npx tsx --env-file=.env.local scripts/backfill-line-open-payout-dryrun.ts
 *
 * payLineOpenTargetsOnce(lineId) 와 "동일한 판정 로직"을 쓰되 DB 는 절대 수정하지 않는다:
 *   대상자(user 타깃) 존재 · config A|B>0 · 원장(source='line',ref_id=line_id,user_id) 부재 · era 허용
 *   · 스코프(assertUserIdsInScope) 통과. QA_HIDE_REAL_USERS=true 면 스코프가 test 로 고정되므로
 *   실사용자(operating) 타깃은 scope_blocked 로 분리된다(공통 함수가 그대로 422 를 던지는 지점).
 * 결과 JSON/CSV 를 claudedocs/ 에 기록. DB write 0.
 */
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { resolveLineScope } from "@/lib/lineScope";
import { isAccrualAllowedWeek } from "@/lib/processPointAccrual";
import { fetchTestUserMarkerIds } from "@/lib/testUsers";
import { QA_HIDE_REAL_USERS } from "@/lib/qaFixedScope";
import * as fs from "node:fs";

// processPointAccrual.ts EXP_CATEGORY_TO_CONFIG_KEY 와 동일.
const EXP_MAP: Record<string, string> = {
  derivation: "derive", analysis: "analysis", evaluation: "research", extension: "expansion", management: "management",
};

type LineRow = {
  id: string; part_type: string; line_code: string | null; activity_type_id: string | null;
  experience_line_master_id: string | null; competency_line_master_id: string | null;
  career_project_id: string | null; is_qa_test: boolean | null;
};
type WeekRow = { id: string; start_date: string; season_key: string | null; week_number: number | null; iso_year: number | null; iso_week: number | null };

async function loadAllLines(): Promise<LineRow[]> {
  const out: LineRow[] = [];
  const PAGE = 1000;
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await supabaseAdmin
      .from("cluster4_lines")
      .select("id,part_type,line_code,activity_type_id,experience_line_master_id,competency_line_master_id,career_project_id,is_qa_test")
      .order("id", { ascending: true })
      .range(from, from + PAGE - 1);
    if (error) throw error;
    const rows = (data ?? []) as LineRow[];
    out.push(...rows);
    if (rows.length < PAGE) break;
  }
  return out;
}

async function main() {
  const testIds = await fetchTestUserMarkerIds();
  const lines = await loadAllLines();
  const lineIds = lines.map((l) => l.id);

  // config 전량 → 맵 (org:hub:key) → {a,b}
  const cfgMap = new Map<string, { a: number | null; b: number | null }>();
  {
    const { data } = await supabaseAdmin.from("cluster4_line_point_configs").select("organization_slug,hub,config_key,point_a,point_b");
    for (const r of (data ?? []) as Array<{ organization_slug: string; hub: string; config_key: string; point_a: number | null; point_b: number | null }>)
      cfgMap.set(`${r.organization_slug}:${r.hub}:${r.config_key}`, { a: r.point_a, b: r.point_b });
  }
  // 마스터 룩업(competency line_code · experience category)
  const compCode = new Map<string, string>();
  const expCat = new Map<string, string>();
  const compIds = [...new Set(lines.filter((l) => l.part_type === "competency" && l.competency_line_master_id).map((l) => l.competency_line_master_id!))];
  const expIds = [...new Set(lines.filter((l) => l.part_type === "experience" && l.experience_line_master_id).map((l) => l.experience_line_master_id!))];
  for (let i = 0; i < compIds.length; i += 200) {
    const { data } = await supabaseAdmin.from("cluster4_competency_line_masters").select("id,line_code").in("id", compIds.slice(i, i + 200));
    for (const r of (data ?? []) as Array<{ id: string; line_code: string | null }>) if (r.line_code) compCode.set(r.id, r.line_code);
  }
  for (let i = 0; i < expIds.length; i += 200) {
    const { data } = await supabaseAdmin.from("cluster4_experience_line_masters").select("id,experience_category").in("id", expIds.slice(i, i + 200));
    for (const r of (data ?? []) as Array<{ id: string; experience_category: string | null }>) if (r.experience_category) expCat.set(r.id, r.experience_category);
  }

  // 타깃(user) 전량 — 라인 청크로 조회
  const targetsByLine = new Map<string, { users: Set<string>; weekIds: Set<string> }>();
  for (let i = 0; i < lineIds.length; i += 100) {
    const chunk = lineIds.slice(i, i + 100);
    const { data } = await supabaseAdmin.from("cluster4_line_targets").select("line_id,target_user_id,week_id").eq("target_mode", "user").in("line_id", chunk);
    for (const t of (data ?? []) as Array<{ line_id: string; target_user_id: string | null; week_id: string | null }>) {
      if (!t.target_user_id) continue;
      let e = targetsByLine.get(t.line_id);
      if (!e) { e = { users: new Set(), weekIds: new Set() }; targetsByLine.set(t.line_id, e); }
      e.users.add(t.target_user_id);
      if (t.week_id) e.weekIds.add(t.week_id);
    }
  }

  // 기존 line-source 원장 → (line_id → Set<user_id>)  (취소행 포함 = 공통 함수와 동일 dedup)
  const paidByLine = new Map<string, Set<string>>();
  for (let i = 0; i < lineIds.length; i += 100) {
    const chunk = lineIds.slice(i, i + 100);
    const { data } = await supabaseAdmin.from("process_point_awards").select("ref_id,user_id").eq("source", "line").in("ref_id", chunk);
    for (const a of (data ?? []) as Array<{ ref_id: string; user_id: string }>) {
      let s = paidByLine.get(a.ref_id); if (!s) { s = new Set(); paidByLine.set(a.ref_id, s); } s.add(a.user_id);
    }
  }

  // 주차 룩업
  const weekIdsAll = [...new Set([...targetsByLine.values()].flatMap((e) => [...e.weekIds]))];
  const weekById = new Map<string, WeekRow>();
  for (let i = 0; i < weekIdsAll.length; i += 200) {
    const { data } = await supabaseAdmin.from("weeks").select("id,start_date,season_key,week_number,iso_year,iso_week").in("id", weekIdsAll.slice(i, i + 200));
    for (const w of (data ?? []) as WeekRow[]) weekById.set(w.id, w);
  }

  function deriveConfigKey(l: LineRow): string | null {
    if (l.part_type === "info") return l.activity_type_id?.trim() || null;
    if (l.part_type === "career") return l.line_code?.trim() || null;
    if (l.part_type === "competency") return l.competency_line_master_id ? compCode.get(l.competency_line_master_id) ?? null : null;
    if (l.part_type === "experience") { const c = l.experience_line_master_id ? expCat.get(l.experience_line_master_id) : null; return c ? EXP_MAP[c] ?? null : null; }
    return null;
  }
  function lookupPoints(org: string | null, hub: string, key: string): { a: number | null; b: number | null } | null {
    const orgRow = org && org !== "common" ? cfgMap.get(`${org}:${hub}:${key}`) : undefined;
    const commonRow = cfgMap.get(`common:${hub}:${key}`);
    return orgRow ?? commonRow ?? null;
  }

  type PerLine = {
    lineId: string; hub: string; org: string | null; isQaTest: boolean; mode: "operating" | "test";
    configKey: string | null; pointA: number | null; pointB: number | null;
    targetUserCount: number; alreadyPaid: number; missingCount: number;
    payableUsers: string[]; blockedUsers: string[]; status: string; reason?: string;
  };
  const perLine: PerLine[] = [];
  const exceptions: Array<{ lineId: string; hub: string; reason: string; detail?: string }> = [];

  for (const l of lines) {
    const tg = targetsByLine.get(l.id);
    const mode: "operating" | "test" = l.is_qa_test ? "test" : "operating";
    const base = { lineId: l.id, hub: l.part_type, isQaTest: !!l.is_qa_test, mode };
    if (!tg || tg.users.size === 0) continue; // 대상자 없음 = 누락 아님(센티넬 등)
    if (tg.weekIds.size === 0) { exceptions.push({ lineId: l.id, hub: l.part_type, reason: "no_week" }); continue; }
    if (tg.weekIds.size > 1) { exceptions.push({ lineId: l.id, hub: l.part_type, reason: "multi_week_line", detail: `${tg.weekIds.size}주차` }); continue; }
    const week = weekById.get([...tg.weekIds][0]);
    if (!week) { exceptions.push({ lineId: l.id, hub: l.part_type, reason: "week_not_found" }); continue; }
    if (week.iso_year == null || week.iso_week == null) { exceptions.push({ lineId: l.id, hub: l.part_type, reason: "week_iso_missing" }); continue; }
    if (!isAccrualAllowedWeek(mode, week)) { exceptions.push({ lineId: l.id, hub: l.part_type, reason: "era_blocked", detail: `${week.season_key} W${week.week_number}` }); continue; }

    const configKey = deriveConfigKey(l);
    if (!configKey) { exceptions.push({ lineId: l.id, hub: l.part_type, reason: "config_key_unresolved" }); continue; }
    const org = (await resolveLineScope(l)).org;
    const pts = lookupPoints(org, l.part_type, configKey);
    const a = pts?.a ?? null, b = pts?.b ?? null;
    const payCheck = a ?? 0, payAdv = b ?? 0;
    // org+common 동시 존재 & 값 상이 → 다중 매칭 자문(공통 함수는 org 우선 결정적).
    const hasOrgRow = org && org !== "common" && cfgMap.has(`${org}:${l.part_type}:${configKey}`);
    const hasCommon = cfgMap.has(`common:${l.part_type}:${configKey}`);
    if (hasOrgRow && hasCommon) {
      const o = cfgMap.get(`${org}:${l.part_type}:${configKey}`)!, c = cfgMap.get(`common:${l.part_type}:${configKey}`)!;
      if (o.a !== c.a || o.b !== c.b) exceptions.push({ lineId: l.id, hub: l.part_type, reason: "multi_config_match_advisory", detail: `org=${JSON.stringify(o)} common=${JSON.stringify(c)} → org 우선` });
    }
    if (!pts) { exceptions.push({ lineId: l.id, hub: l.part_type, reason: "config_missing", detail: `${org}:${l.part_type}:${configKey}` }); continue; }
    if (payCheck <= 0 && payAdv <= 0) { // 지급 없음(불필요한 0 원장 방지) — 예외 아님, 단순 제외
      perLine.push({ ...base, org, configKey, pointA: a, pointB: b, targetUserCount: tg.users.size, alreadyPaid: (paidByLine.get(l.id)?.size ?? 0), missingCount: 0, payableUsers: [], blockedUsers: [], status: "excluded_zero_reward" });
      continue;
    }

    const paid = paidByLine.get(l.id) ?? new Set<string>();
    const targetUsers = [...tg.users];
    const newUsers = targetUsers.filter((u) => !paid.has(u));
    // 스코프(공통 함수와 동일): QA_HIDE_REAL_USERS 면 test 로 고정. in-scope = test 여부 일치.
    const isTestScope = QA_HIDE_REAL_USERS || mode === "test";
    const inScope = (u: string) => (isTestScope ? testIds.has(u) : !testIds.has(u));
    const payableUsers = newUsers.filter(inScope);
    const blockedUsers = newUsers.filter((u) => !inScope(u));
    let status = "ok";
    if (newUsers.length === 0) status = "fully_paid";
    else if (blockedUsers.length > 0 && payableUsers.length === 0) status = "scope_blocked_qa"; // 공통 함수가 라인 전체 422
    else if (blockedUsers.length > 0) status = "partial_scope_blocked"; // ⚠ 공통 함수는 라인당 all-or-nothing → 실제로는 라인 전체 422
    else status = "payable";

    perLine.push({ ...base, org, configKey, pointA: a, pointB: b, targetUserCount: tg.users.size, alreadyPaid: paid.size, missingCount: newUsers.length, payableUsers, blockedUsers, status });
  }

  // ── 집계 ──
  const universeMissing = perLine.filter((p) => p.missingCount > 0);
  // 공통 함수 all-or-nothing: 라인에 blocked 가 하나라도 있으면 그 라인은 실제 지급 0 → payable 라인만 실지급.
  const payableLines = perLine.filter((p) => p.status === "payable");
  const blockedLines = perLine.filter((p) => p.status === "scope_blocked_qa" || p.status === "partial_scope_blocked");

  const sum = (arr: PerLine[], f: (p: PerLine) => number) => arr.reduce((s, p) => s + f(p), 0);
  const groupCount = (arr: PerLine[], key: (p: PerLine) => string, val: (p: PerLine) => number) => {
    const m: Record<string, number> = {}; for (const p of arr) m[key(p)] = (m[key(p)] ?? 0) + val(p); return m;
  };
  const missingPairs = sum(universeMissing, (p) => p.missingCount);
  const payablePairs = sum(payableLines, (p) => p.payableUsers.length);
  const blockedPairs = sum(blockedLines, (p) => p.blockedUsers.length + p.payableUsers.length);

  const report = {
    generatedAt: new Date().toISOString(),
    qaHideRealUsers: QA_HIDE_REAL_USERS,
    note: "QA_HIDE_REAL_USERS=true 이므로 payLineOpenTargetsOnce 는 실사용자 타깃 라인을 422(scope)로 거부한다. payable=현재 공통함수로 실제 지급 가능한 라인(test 스코프). scope_blocked_qa=QA 종료(QA_HIDE_REAL_USERS=false) 후 재실행 필요.",
    totals: {
      totalLines: lines.length,
      linesWithUserTargets: [...targetsByLine.keys()].length,
      totalUserTargetPairs: [...targetsByLine.values()].reduce((s, e) => s + e.users.size, 0),
      alreadyPaidPairs: [...paidByLine.values()].reduce((s, e) => s + e.size, 0),
      missingPairs,
      payableNowPairs: payablePairs,
      scopeBlockedByQaPairs: blockedPairs,
      exceptionLines: exceptions.length,
      zeroRewardLines: perLine.filter((p) => p.status === "excluded_zero_reward").length,
    },
    payableNow: {
      lines: payableLines.length,
      pairs: payablePairs,
      pointATotal: sum(payableLines, (p) => (p.pointA ?? 0) * p.payableUsers.length),
      pointBTotal: sum(payableLines, (p) => (p.pointB ?? 0) * p.payableUsers.length),
      byHub: groupCount(payableLines, (p) => p.hub, (p) => p.payableUsers.length),
      byOrg: groupCount(payableLines, (p) => p.org ?? "common", (p) => p.payableUsers.length),
      byMode: groupCount(payableLines, (p) => p.mode, (p) => p.payableUsers.length),
    },
    missingUniverse: {
      pairs: missingPairs,
      byHub: groupCount(universeMissing, (p) => p.hub, (p) => p.missingCount),
      byOrg: groupCount(universeMissing, (p) => p.org ?? "common", (p) => p.missingCount),
      byMode: groupCount(universeMissing, (p) => p.mode, (p) => p.missingCount),
    },
    scopeBlockedByQa: {
      lines: blockedLines.length,
      pairs: blockedPairs,
      byHub: groupCount(blockedLines, (p) => p.hub, (p) => p.blockedUsers.length + p.payableUsers.length),
      byOrg: groupCount(blockedLines, (p) => p.org ?? "common", (p) => p.blockedUsers.length + p.payableUsers.length),
    },
    exceptionsByReason: exceptions.reduce((m, e) => { m[e.reason] = (m[e.reason] ?? 0) + 1; return m; }, {} as Record<string, number>),
    payableLineIds: payableLines.map((p) => p.lineId),
  };

  const stamp = new Date().toISOString().slice(0, 10);
  const dir = "claudedocs";
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  const jsonPath = `${dir}/line-payout-backfill-dryrun-${stamp}.json`;
  fs.writeFileSync(jsonPath, JSON.stringify({ report, perLine, exceptions }, null, 2));
  // CSV(라인별)
  const csvRows = [
    "line_id,hub,org,mode,is_qa_test,config_key,point_a,point_b,target_users,already_paid,missing,payable,blocked,status",
    ...perLine.map((p) => [p.lineId, p.hub, p.org ?? "common", p.mode, p.isQaTest, p.configKey ?? "", p.pointA ?? "", p.pointB ?? "", p.targetUserCount, p.alreadyPaid, p.missingCount, p.payableUsers.length, p.blockedUsers.length, p.status].join(",")),
  ];
  const csvPath = `${dir}/line-payout-backfill-dryrun-${stamp}.csv`;
  fs.writeFileSync(csvPath, csvRows.join("\n"));

  console.log(JSON.stringify(report, null, 2));
  console.log(`\n[files] ${jsonPath}\n[files] ${csvPath}`);
  process.exit(0);
}
main().catch((e) => { console.error(e); process.exit(1); });
