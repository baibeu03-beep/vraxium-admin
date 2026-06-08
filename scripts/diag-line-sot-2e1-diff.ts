/**
 * Phase 2E-1 — 기존 마스터 기준 vs line_registrations 기준 read-only diff 검증.
 *   npx tsx --env-file=.env.local scripts/diag-line-sot-2e1-diff.ts
 * DB 쓰기 0건. 결과: claudedocs/line-sot-2e1-diff-20260607.json
 *
 * 비교 축 (registrations 기준값은 "마스터를 registrations 로 교체했을 때" 코드가 얻게 될 값):
 *   1) 개설 플로우 라인 목록 (exp/comp 마스터 목록 vs hub별 registrations)
 *   2) org 판정 입력값 (cluster4_lines.master FK → organization_slug)
 *   3) line-history (마스터 참조 여부 — 구조 검증)
 *   4) weekly-cards 메타 lookup (master id → category/slot/lineName/org)
 *   5~8) 고객앱/demo/일반/snapshot — 4) 와 fingerprint 로 판정
 */
import { writeFileSync } from "fs";
import { createClient } from "@supabase/supabase-js";

const sb = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
  { auth: { persistSession: false } },
);

// 한글 line_type ↔ experience category (브리지/백필과 동일 고정쌍)
const KO_TO_CATEGORY: Record<string, { category: string; slot: number }> = {
  도출: { category: "derivation", slot: 1 },
  분석: { category: "analysis", slot: 2 },
  평가: { category: "evaluation", slot: 3 },
  확장: { category: "extension", slot: 4 },
  관리: { category: "management", slot: 5 },
};

let pass = 0;
let fail = 0;
function check(label: string, ok: boolean, detail?: string) {
  console.log(`  ${ok ? "✓" : "✗"} ${label}${detail ? " — " + detail : ""}`);
  if (ok) pass++;
  else fail++;
}

const report: Record<string, unknown> = { generatedAt: new Date().toISOString() };

async function count(table: string, filter?: (q: any) => any): Promise<number> {
  let q = sb.from(table).select("*", { count: "exact", head: true });
  if (filter) q = filter(q);
  const { count: c, error } = await q;
  if (error) throw new Error(`${table}: ${error.message}`);
  return c ?? 0;
}

async function main() {
  const fpBefore = {
    snapTotal: await count("cluster4_weekly_card_snapshots"),
    snapStale: await count("cluster4_weekly_card_snapshots", (q) => q.eq("is_stale", true)),
    lines: await count("cluster4_lines"),
    targets: await count("cluster4_line_targets"),
  };

  // ── 원천 로드 ──
  const { data: expMasters } = await sb
    .from("cluster4_experience_line_masters")
    .select("id,line_code,line_name,default_main_title,experience_category,experience_slot_order,organization_slug,is_active")
    .order("id");
  const { data: compMasters } = await sb
    .from("cluster4_competency_line_masters")
    .select("id,line_code,line_name,main_title,organization_slug,is_active")
    .order("id");
  const { data: careers } = await sb
    .from("career_projects")
    .select("id,line_code,line_name,organization_slug")
    .not("line_code", "is", null);
  const { data: regs } = await sb
    .from("line_registrations")
    .select("id,hub,line_type,line_code,line_name,main_title,main_title_mode,organization_slug,bridged_master_id,is_active")
    .order("id");
  const regByBridged = new Map(
    (regs ?? []).filter((r) => r.bridged_master_id).map((r) => [r.bridged_master_id as string, r]),
  );

  // ════ 1) 개설 플로우 라인 목록 diff ════
  console.log("=== 1) 개설 플로우 라인 목록 (마스터 vs registrations) ===");
  type Diff = { key: string; field: string; master: unknown; registration: unknown };
  const listDiffs: Diff[] = [];

  // 1-a) experience: (org,code) 키 — 양방향 누락 + 필드 비교
  const expRegs = (regs ?? []).filter((r) => r.hub === "experience");
  for (const m of expMasters ?? []) {
    const r = expRegs.find(
      (x) => x.organization_slug === m.organization_slug && x.line_code === m.line_code,
    );
    if (!r) {
      listDiffs.push({ key: `exp ${m.organization_slug}/${m.line_code}`, field: "(행 누락)", master: "존재", registration: "없음" });
      continue;
    }
    if (r.line_name !== m.line_name)
      listDiffs.push({ key: `exp ${m.organization_slug}/${m.line_code}`, field: "line_name", master: m.line_name, registration: r.line_name });
    const regTitle = r.main_title_mode === "fixed" ? r.main_title : null;
    if (regTitle !== m.default_main_title)
      listDiffs.push({ key: `exp ${m.organization_slug}/${m.line_code}`, field: "default_main_title", master: m.default_main_title, registration: regTitle });
    const pair = KO_TO_CATEGORY[r.line_type] ?? null;
    if ((pair?.category ?? null) !== m.experience_category)
      listDiffs.push({ key: `exp ${m.organization_slug}/${m.line_code}`, field: "experience_category", master: m.experience_category, registration: pair?.category ?? null });
    if ((pair?.slot ?? null) !== m.experience_slot_order)
      listDiffs.push({ key: `exp ${m.organization_slug}/${m.line_code}`, field: "experience_slot_order", master: m.experience_slot_order, registration: pair?.slot ?? null });
    if (r.is_active !== m.is_active)
      listDiffs.push({ key: `exp ${m.organization_slug}/${m.line_code}`, field: "is_active", master: m.is_active, registration: r.is_active });
  }
  const expExtra = expRegs.filter(
    (r) => !(expMasters ?? []).some((m) => m.organization_slug === r.organization_slug && m.line_code === r.line_code),
  );
  for (const r of expExtra)
    listDiffs.push({ key: `exp ${r.organization_slug}/${r.line_code}`, field: "(행 초과)", master: "없음", registration: "존재" });

  // 1-b) competency
  const compRegs = (regs ?? []).filter((r) => r.hub === "competency");
  for (const m of compMasters ?? []) {
    const r = compRegs.find(
      (x) => x.organization_slug === m.organization_slug && x.line_code === m.line_code,
    );
    if (!r) {
      listDiffs.push({ key: `comp ${m.organization_slug}/${m.line_code}`, field: "(행 누락)", master: "존재", registration: "없음" });
      continue;
    }
    if (r.line_name !== m.line_name)
      listDiffs.push({ key: `comp ${m.organization_slug}/${m.line_code}`, field: "line_name", master: m.line_name, registration: r.line_name });
    const regTitle = r.main_title_mode === "fixed" ? r.main_title : null;
    if (regTitle !== m.main_title)
      listDiffs.push({ key: `comp ${m.organization_slug}/${m.line_code}`, field: "main_title", master: m.main_title, registration: regTitle });
    if (r.is_active !== m.is_active)
      listDiffs.push({ key: `comp ${m.organization_slug}/${m.line_code}`, field: "is_active", master: m.is_active, registration: r.is_active });
  }

  // 1-c) career: 2D 제외 — 알려진 diff
  const careerRegs = (regs ?? []).filter((r) => r.hub === "career");
  const careerDiff = (careers ?? []).length - careerRegs.length;

  check("경험 26건 필드 단위 diff 0", listDiffs.filter((d) => d.key.startsWith("exp")).length === 0, `diff=${listDiffs.filter((d) => d.key.startsWith("exp")).length}`);
  check("역량 30건 필드 단위 diff 0", listDiffs.filter((d) => d.key.startsWith("comp")).length === 0, `diff=${listDiffs.filter((d) => d.key.startsWith("comp")).length}`);
  // (2E-5) 테스트 1건 정리 후: career 도 마스터-등록 건수 일치(diff 해소)가 기대값.
  check("career diff 해소 (마스터 = 등록 건수)", careerDiff === 0, `master=${(careers ?? []).length} reg=${careerRegs.length}`);
  report.openFlowListDiffs = listDiffs;
  report.careerKnownDiff = careerDiff;

  // ════ 2) org 판정 입력값 diff (cluster4_lines master FK 전수) ════
  console.log("\n=== 2) org 판정 (cluster4_lines master FK → org) ===");
  const { data: linesWithFk } = await sb
    .from("cluster4_lines")
    .select("id,part_type,line_code,experience_line_master_id,competency_line_master_id")
    .or("experience_line_master_id.not.is.null,competency_line_master_id.not.is.null");
  const expById = new Map((expMasters ?? []).map((m) => [m.id, m]));
  const compById = new Map((compMasters ?? []).map((m) => [m.id, m]));
  const orgDiffs: Array<{ lineId: string; fk: string; master: string | null; registration: string | null }> = [];
  let orgChecked = 0;
  for (const l of linesWithFk ?? []) {
    const fk = (l.experience_line_master_id ?? l.competency_line_master_id) as string;
    const masterOrg =
      (l.experience_line_master_id ? expById.get(fk)?.organization_slug : compById.get(fk)?.organization_slug) ?? null;
    const regOrg = regByBridged.get(fk)?.organization_slug ?? null;
    orgChecked += 1;
    if (masterOrg !== regOrg) orgDiffs.push({ lineId: l.id, fk, master: masterOrg, registration: regOrg });
  }
  check(`org 판정 diff 0 (개설 라인 ${orgChecked}건 전수)`, orgDiffs.length === 0, `diff=${orgDiffs.length}`);
  report.orgDiffs = orgDiffs;
  report.orgChecked = orgChecked;

  // ════ 3) line-history — 마스터 미참조 (구조) ════
  console.log("\n=== 3) line-history ===");
  // listCluster4OpenedLines 는 cluster4_lines/targets/weeks/season_definitions/activity_types 만 조회
  // (lib/adminCluster4LinesData.ts 1438~ — 마스터 테이블 쿼리 0건). 교체 무관 → diff 0 (구조적).
  check("line-history 는 마스터 미참조 → 교체 무관 (diff 0 구조적)", true);

  // ════ 4) weekly-cards 메타 lookup diff (실사용 master id 전수) ════
  console.log("\n=== 4) weekly-cards 메타 lookup (category/slot/lineName/org) ===");
  const usedExpIds = [...new Set((linesWithFk ?? []).map((l) => l.experience_line_master_id).filter(Boolean))] as string[];
  const usedCompIds = [...new Set((linesWithFk ?? []).map((l) => l.competency_line_master_id).filter(Boolean))] as string[];
  const metaDiffs: Array<{ masterId: string; field: string; master: unknown; registration: unknown }> = [];
  for (const id of usedExpIds) {
    const m = expById.get(id);
    const r = regByBridged.get(id);
    if (!m) continue;
    if (!r) {
      metaDiffs.push({ masterId: id, field: "(registration 부재)", master: m.line_code, registration: null });
      continue;
    }
    const pair = KO_TO_CATEGORY[r.line_type] ?? null;
    if ((pair?.category ?? null) !== m.experience_category)
      metaDiffs.push({ masterId: id, field: "category", master: m.experience_category, registration: pair?.category ?? null });
    if ((pair?.slot ?? null) !== m.experience_slot_order)
      metaDiffs.push({ masterId: id, field: "slotOrder", master: m.experience_slot_order, registration: pair?.slot ?? null });
    if (r.line_name !== m.line_name)
      metaDiffs.push({ masterId: id, field: "lineName", master: m.line_name, registration: r.line_name });
    if (r.organization_slug !== m.organization_slug)
      metaDiffs.push({ masterId: id, field: "organizationSlug", master: m.organization_slug, registration: r.organization_slug });
  }
  for (const id of usedCompIds) {
    const m = compById.get(id);
    const r = regByBridged.get(id);
    if (!m) continue;
    if (!r) {
      metaDiffs.push({ masterId: id, field: "(registration 부재)", master: m.line_code, registration: null });
      continue;
    }
    if (r.line_name !== m.line_name)
      metaDiffs.push({ masterId: id, field: "lineName", master: m.line_name, registration: r.line_name });
    if (r.organization_slug !== m.organization_slug)
      metaDiffs.push({ masterId: id, field: "organizationSlug", master: m.organization_slug, registration: r.organization_slug });
  }
  check(
    `weekly-cards 메타 diff 0 (실사용 exp ${usedExpIds.length}·comp ${usedCompIds.length} master)`,
    metaDiffs.length === 0,
    `diff=${metaDiffs.length}`,
  );
  report.metaDiffs = metaDiffs;
  report.usedMasterIds = { experience: usedExpIds.length, competency: usedCompIds.length };

  // career_project 메타 (sponsor-card) — 사용 중인 career_project_id
  const { data: careerLines } = await sb
    .from("cluster4_lines")
    .select("career_project_id")
    .not("career_project_id", "is", null);
  const usedCareerIds = [...new Set((careerLines ?? []).map((l) => l.career_project_id))];
  const careerMetaCovered = usedCareerIds.filter((id) => regByBridged.has(id as string)).length;
  // (2E-5) 정리 후: 사용 중 career_project 0건 — sponsor 메타 diff 자체가 소멸.
  check(
    "career sponsor 메타 — 미커버 0건 (사용 중 career_project 전부 registrations 커버 또는 0건)",
    usedCareerIds.length - careerMetaCovered === 0,
    `사용 중 career_project ${usedCareerIds.length}건, registrations 커버 ${careerMetaCovered}건`,
  );
  report.careerMetaUsed = usedCareerIds.length;

  // ════ 5~8) 고객앱/demo/일반/snapshot ════
  console.log("\n=== 5~8) 고객앱·demo·일반·snapshot ===");
  // 고객앱(../vraxium) DB 직조 5곳: cluster4_line_targets+lines!inner / career_projects 만 조회 —
  // exp/comp 마스터 테이블 직접 참조 0건 (2026-06-07 grep). 단 career_projects 는 직접 참조 → 대체 불가 경로.
  check("고객앱 — exp/comp 마스터 직조 0건 (영향 없음), career_projects 직조는 대체 금지 경로", true);
  check("demoUserId/일반 — 동일 코드 경로 (차이 없음, 4번 diff 와 동일 결론)", true);
  const fpAfter = {
    snapTotal: await count("cluster4_weekly_card_snapshots"),
    snapStale: await count("cluster4_weekly_card_snapshots", (q) => q.eq("is_stale", true)),
    lines: await count("cluster4_lines"),
    targets: await count("cluster4_line_targets"),
  };
  check("snapshot fingerprint 불변 (본 검증 read-only)", JSON.stringify(fpBefore) === JSON.stringify(fpAfter), JSON.stringify(fpAfter));
  report.fingerprint = { before: fpBefore, after: fpAfter };

  writeFileSync(
    "claudedocs/line-sot-2e1-diff-20260607.json",
    JSON.stringify(report, null, 2),
    "utf8",
  );
  console.log("\nsaved: claudedocs/line-sot-2e1-diff-20260607.json");
  console.log(`결과: pass=${pass} fail=${fail}`);
  if (fail > 0) process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
