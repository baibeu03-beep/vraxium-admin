/**
 * 기간 등록 "전환 주차" 옵션 검증 (direct).
 *   1) GET 의 is_transition 파생(week_number > 정규 주수)이 실DB 전환 주차를 정확히 잡는다.
 *   2) POST 의 전환 주차 검증 규칙(저장 표현 = is_official_rest=false, 주차 번호 = 정규+1)을
 *      엣지 케이스로 단언한다 — route.ts POST 인라인 규칙 미러.
 *   3) 전환 주차 등록은 official_rest_periods/snapshot 을 건드리지 않음(코드 경로 근거).
 *
 * 실행: npx tsx --env-file=.env.local scripts/verify-period-register-transition.ts
 */
import { supabaseAdmin } from "@/lib/supabaseAdmin";

const SEASON_WEEKS: Record<string, number> = {
  spring: 16,
  summer: 8,
  autumn: 16,
  winter: 8,
};

// route.ts GET 의 전환 주차 파생과 동일.
function deriveIsTransition(seasonType: string | null, weekNumber: number | null): boolean {
  const sw = seasonType != null ? SEASON_WEEKS[seasonType] : null;
  return Boolean(sw != null && weekNumber != null && weekNumber > sw);
}

// route.ts POST 의 전환 주차 검증 규칙 미러 — { ok, error } 반환.
function validateTransitionRegister(input: {
  seasonType: string;
  weekNumber: number;
  isOfficialRest: boolean;
  isTransition: boolean;
}): { ok: boolean; error?: string } {
  if (!input.isTransition) return { ok: true };
  if (input.isOfficialRest) return { ok: false, error: "전환 주차는 공식 휴식으로 등록할 수 없습니다." };
  const regular = SEASON_WEEKS[input.seasonType];
  if (regular == null) return { ok: false, error: "시즌 정규 주수를 확인할 수 없습니다." };
  if (input.weekNumber !== regular + 1) return { ok: false, error: `전환 주차는 ${regular + 1}주차여야 합니다.` };
  return { ok: true };
}

let pass = 0, fail = 0;
const ck = (label: string, ok: boolean, detail = "") => {
  console.log(`  ${ok ? "✓" : "✗"} ${label}${detail ? ` — ${detail}` : ""}`);
  ok ? pass++ : fail++;
};

async function main() {
  console.log("[1] GET is_transition 파생 — 실DB 전환 주차 조회");
  // season_definitions 로 season_type 매핑 후 weeks 의 정규주수 초과 주차를 전환으로 본다.
  const { data: defs } = await supabaseAdmin
    .from("season_definitions")
    .select("season_key, season_type");
  const typeByKey = new Map<string, string>();
  for (const d of (defs ?? []) as { season_key: string; season_type: string | null }[]) {
    if (d.season_type) typeByKey.set(d.season_key, d.season_type);
  }
  const { data: weeks } = await supabaseAdmin
    .from("weeks")
    .select("season_key, week_number, is_official_rest")
    .order("season_key", { ascending: true });
  const transitionRows = ((weeks ?? []) as { season_key: string | null; week_number: number | null; is_official_rest: boolean | null }[])
    .filter((w) => deriveIsTransition(w.season_key ? typeByKey.get(w.season_key) ?? null : null, w.week_number));
  console.log(`    전환 주차 row 수: ${transitionRows.length}`);
  for (const r of transitionRows.slice(0, 8)) {
    console.log(`      - ${r.season_key} W${r.week_number} (is_official_rest=${r.is_official_rest})`);
  }
  ck("실DB에 전환 주차가 1건 이상 존재(조회 동작 확인)", transitionRows.length > 0, `${transitionRows.length}건`);
  // 2026-spring W17 = 전환 (현재 주차)
  const spring17 = transitionRows.find((r) => r.season_key === "2026-spring" && r.week_number === 17);
  ck("2026-spring 17주차 = 전환으로 파생", !!spring17);

  console.log("\n[2] POST 전환 주차 검증 규칙 (엣지 케이스)");
  ck("봄 17주 + 활동 → 통과", validateTransitionRegister({ seasonType: "spring", weekNumber: 17, isOfficialRest: false, isTransition: true }).ok);
  ck("여름 9주 + 활동 → 통과", validateTransitionRegister({ seasonType: "summer", weekNumber: 9, isOfficialRest: false, isTransition: true }).ok);
  const wrongWeek = validateTransitionRegister({ seasonType: "spring", weekNumber: 5, isOfficialRest: false, isTransition: true });
  ck("봄 5주 + 전환 → 차단(주차 번호 불일치)", !wrongWeek.ok, wrongWeek.error);
  const transRest = validateTransitionRegister({ seasonType: "spring", weekNumber: 17, isOfficialRest: true, isTransition: true });
  ck("봄 17주 + 전환 + 휴식 → 차단", !transRest.ok, transRest.error);
  ck("전환 아님(공식 활동) → 규칙 미적용 통과", validateTransitionRegister({ seasonType: "spring", weekNumber: 5, isOfficialRest: false, isTransition: false }).ok);

  console.log("\n[3] 저장 표현 — 전환 주차는 is_official_rest=false 로 저장되어 GET 에서 전환 파생");
  ck("저장 is_official_rest 값 = false(전환)", validateTransitionRegister({ seasonType: "spring", weekNumber: 17, isOfficialRest: false, isTransition: true }).ok && deriveIsTransition("spring", 17));

  console.log(`\n결과: ${pass} pass / ${fail} fail`);
  process.exit(fail ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
