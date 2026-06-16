// info 라인 org 스코프 검증 (direct SoT 함수 + 고객 weekly-cards DTO 강화율 분모).
//   FIXED 라인(line_code=IFEC 토큰 = 수정된 POST 산출형) 과 LEGACY 라인(line_code=null = 버그형)을
//   각각 만들어, org SoT 함수 3종 + 고객 DTO 에서 org 격리/누수를 대조한다.
//   고객앱 반영 측정 = growthDenominator(강화율 분모) 델타 — 타org 사용자 분모가 오르면 누수.
//   임시 라인 생성 → finally 에서 반드시 cleanup. 운영 데이터 무접촉(전용 sentinel 타이틀 + W13 과거).
// 사용법: npx tsx --env-file=.env.local scripts/verify-info-line-org-scope.ts
import { createClient } from "@supabase/supabase-js";
import {
  resolveCluster4LineOrgScope,
  collectLineOrgAudience,
  listCluster4InfoLinesDetailed,
} from "../lib/adminCluster4LinesData";
import { getCluster4WeeklyCardsForProfileUser } from "../lib/cluster4WeeklyCardsData";

const sb = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
);

const WEEK_ID = "a2112b50-64d2-42d6-a243-faf9fcdc6ffc"; // 2026-spring W13(과거·비휴식·3 org 공통)
const ACT = "etc_a";
const ENCRE = "3c4fc830-a465-4a00-a26a-a0c37fa3052c"; // encre(W13 비휴식) — 라인 타깃 배정
const ORANKE = "2ac6d5e9-f650-4bfc-99bc-36895aa8c9a2"; // oranke(W13 비휴식)
const PHALANX = "33cd8f8a-a412-49dc-914c-01b1251871f9"; // phalanx(W13 비휴식)

let pass = 0, fail = 0;
const check = (label: string, ok: boolean, detail = "") => {
  console.log(`  ${ok ? "✓" : "✗"} ${label}${detail ? ` — ${detail}` : ""}`);
  ok ? pass++ : fail++;
};

async function createLine(lineCode: string | null, title: string): Promise<string> {
  const { data: line, error } = await sb
    .from("cluster4_lines")
    .insert({
      part_type: "info", activity_type_id: ACT, line_code: lineCode, main_title: title,
      output_links: [{ url: "https://example.com", label: "t" }], output_images: [],
      submission_opens_at: "2026-05-25T00:00:00.000Z",
      submission_closes_at: "2026-05-31T00:00:00.000Z",
      week_id: WEEK_ID, is_active: true,
    })
    .select("id").single();
  if (error) throw new Error(error.message);
  const id = (line as { id: string }).id;
  const { error: tErr } = await sb.from("cluster4_line_targets").insert({
    line_id: id, week_id: WEEK_ID, target_mode: "user", target_user_id: ENCRE, target_rule: {},
  });
  if (tErr) throw new Error(tErr.message);
  return id;
}
async function deleteLine(id: string) {
  await sb.from("cluster4_line_targets").delete().eq("line_id", id);
  await sb.from("cluster4_lines").delete().eq("id", id);
}

// 고객 DTO 의 W13 카드에서 (강화율 분모, 라인 title 노출 여부) 추출.
async function w13Card(userId: string, title: string): Promise<{ den: number; hasLine: boolean }> {
  const cards = (await getCluster4WeeklyCardsForProfileUser(userId)) as unknown as Array<any>;
  const c = cards.find((x) => x.weekId === WEEK_ID);
  const den = Number(c?.growthDenominator ?? 0);
  const hasLine = (c?.lines ?? []).some((ln: any) => ln.mainTitle === title);
  return { den, hasLine };
}
async function listHas(org: "encre" | "oranke" | "phalanx", title: string): Promise<boolean> {
  const { rows } = await listCluster4InfoLinesDetailed({ weekId: WEEK_ID, activityTypeId: ACT, organization: org });
  return (rows ?? []).some((r: any) => r.mainTitle === title);
}

async function main() {
  const TS = Date.now();
  const FIXED_TITLE = `__ORGSCOPE_FIXED_${TS}`;
  const LEGACY_TITLE = `__ORGSCOPE_LEGACY_${TS}`;

  // 0) 베이스라인 분모(라인 없음).
  const baseE = (await w13Card(ENCRE, "")).den;
  const baseO = (await w13Card(ORANKE, "")).den;
  const baseP = (await w13Card(PHALANX, "")).den;
  console.log(`\n베이스라인 분모  encre=${baseE} oranke=${baseO} phalanx=${baseP}`);

  // ── FIXED 라인(IFEC = encre 전용) ──────────────────────────────────
  console.log("\n## FIXED 라인 (line_code=IFEC-OPEN…, encre 전용 = 수정된 POST 산출형) ##");
  const fixedId = await createLine(`IFEC-OPEN${TS}`, FIXED_TITLE);
  try {
    check("resolveCluster4LineOrgScope → encre",
      (await resolveCluster4LineOrgScope({ part_type: "info", line_code: `IFEC-OPEN${TS}` })) === "encre");
    const fAud = await collectLineOrgAudience(fixedId);
    check("collectLineOrgAudience: encre 포함·oranke/phalanx 제외(snapshot 재계산 범위)",
      fAud.includes(ENCRE) && !fAud.includes(ORANKE) && !fAud.includes(PHALANX));
    check("admin GET org=encre 노출", await listHas("encre", FIXED_TITLE));
    check("admin GET org=oranke 미노출", !(await listHas("oranke", FIXED_TITLE)));
    check("admin GET org=phalanx 미노출", !(await listHas("phalanx", FIXED_TITLE)));

    const fE = await w13Card(ENCRE, FIXED_TITLE);
    const fO = await w13Card(ORANKE, FIXED_TITLE);
    const fP = await w13Card(PHALANX, FIXED_TITLE);
    check("고객 DTO encre 반영(배정 라인 노출)", fE.hasLine, `den ${baseE}→${fE.den}`);
    check("고객 DTO oranke 분모 불변(누수 0)", fO.den === baseO, `den ${baseO}→${fO.den}`);
    check("고객 DTO phalanx 분모 불변(누수 0)", fP.den === baseP, `den ${baseP}→${fP.den}`);
  } finally {
    await deleteLine(fixedId);
  }

  // ── LEGACY 라인(null = 버그형 common) : 누수 재현 대조 ───────────────
  console.log("\n## LEGACY 라인 (line_code=null = 버그형, common 전체 누수 재현) ##");
  const legacyId = await createLine(null, LEGACY_TITLE);
  try {
    check("resolveCluster4LineOrgScope → common(누수 원인)",
      (await resolveCluster4LineOrgScope({ part_type: "info", line_code: null })) === "common");
    const lAud = await collectLineOrgAudience(legacyId);
    check("collectLineOrgAudience: oranke/phalanx 까지 포함(누수 = 분모 오염)",
      lAud.includes(ORANKE) && lAud.includes(PHALANX));
    const lO = await w13Card(ORANKE, LEGACY_TITLE);
    const lP = await w13Card(PHALANX, LEGACY_TITLE);
    check("고객 DTO oranke 분모 상승(버그 재현)", lO.den > baseO, `den ${baseO}→${lO.den}`);
    check("고객 DTO phalanx 분모 상승(버그 재현)", lP.den > baseP, `den ${baseP}→${lP.den}`);
  } finally {
    await deleteLine(legacyId);
    console.log("\n[cleanup] 임시 라인 삭제 완료");
  }

  console.log(`\n결과: pass=${pass} fail=${fail}`);
  if (fail > 0) process.exitCode = 1;
}
main().catch((e) => { console.error(e); process.exit(1); });
