/**
 * 라인 강화 내역 — 유형 컬럼 + 허브별 행 생성 규칙 + 정합 검증 (READ-ONLY, 무손실).
 *   run: npx tsx --env-file=.env.local scripts/verify-line-history-type-and-shape.ts
 *
 * 실제 production 함수(getCrewWeekLineSummary / getCrewWeekLineDetail)를 실데이터 (사용자, 주차)로
 * 호출해 요구사항 불변식을 검산한다(HTTP 라우트가 그대로 감싸는 동일 loader — mode 무관 동일 DTO).
 * 관심 케이스(경험 유령행·역량 대상자)를 우선순위로 뽑아 핵심 fix 를 실데이터로 반드시 exercise 한다.
 *
 * 검증 항목:
 *   §3-1 정보  : 기타A 제외 정확히 8행, 유형 전부 '일반', 라인명 = register 정식 라인명(Main Title 아님).
 *   §3-2/§4 경험: 유형 슬롯당 ≤1행, 유형 ∈ {도출,분석,견문,관리,확장}, 유령 실패행(개설·본인 미배정) 0.
 *   §3-3 역량  : ≤1행. 성공(대상자)=유형 ∈ {원리,기술,관점,자원}+라인명, 실패/미선택=유형 '-'·라인명 '-'.
 *   §3-4 경력  : 오픈된 라인만(전 행 clubOpen), 유형 '일반'.
 *   불변식     : total==open+unopened / 확정주차 success+fail+na==total.
 *   §7 정합    : 경험 표행(성공/집계대상) == breakdownFromLines(성장률 SoT) = 크루/스냅샷.
 *   §5 팝업    : getCrewWeekLineDetail(lineId).type == 표 row.type (별도 계산 아님).
 */
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import {
  getCrewWeekLineSummary,
  type CrewWeekLineDetailRow,
} from "@/lib/adminCrewWeekLineSummary";
import { getCrewWeekLineDetail } from "@/lib/adminCrewWeekLineDetail";
import { resolveCrewWeekCard } from "@/lib/adminCrewWeekDetail";
import { breakdownFromLines } from "@/lib/cluster4WeeklyCardsData";
import { loadInfoLineCatalog } from "@/lib/adminLineHistoryType";
import { readWeeklyCardsSnapshot } from "@/lib/cluster4WeeklyCardsSnapshot";
import type { Cluster4LineDetailDto } from "@/shared/cluster4.contracts";

const EXP_TYPES = new Set(["도출", "분석", "견문", "관리", "확장"]);
const COMP_TYPES = new Set(["원리", "기술", "관점", "자원"]);

type Fail = { userId: string; weekLabel: string; check: string; detail: string };
const fails: Fail[] = [];
function check(cond: boolean, f: Fail) {
  if (!cond) fails.push(f);
}

// 실제 슬롯 행에만 유형을 요구. 레거시/휴식 주차의 순수 해당없음 placeholder(lineId 없음·na·카테고리
//   부재)는 슬롯이 아니므로 type=null("-")이 정상.
const isBareNaExp = (r: CrewWeekLineDetailRow) =>
  r.type == null && r.lineId == null && r.enhancementStatus === "not_applicable";

async function main() {
  const { data: markerRows } = await supabaseAdmin.from("test_user_markers").select("user_id");
  const testIds = ((markerRows ?? []) as Array<{ user_id: string }>).map((r) => r.user_id);
  const { data: sampleRows } = await supabaseAdmin
    .from("user_profiles")
    .select("user_id")
    .limit(600);
  const sampleIds = ((sampleRows ?? []) as Array<{ user_id: string }>).map((r) => r.user_id);
  const userIds = Array.from(new Set([...testIds, ...sampleIds]));

  // ── 1차: 스냅샷에서 후보 (사용자,주차) 수집 + 관심 케이스 우선순위 ──
  type Cand = {
    uid: string;
    weekId: string;
    weekLabel: string;
    ls: Cluster4LineDetailDto[];
    phantom: number;
    compTarget: boolean;
  };
  const cands: Cand[] = [];
  for (const uid of userIds) {
    let snap;
    try {
      snap = await readWeeklyCardsSnapshot(uid);
    } catch {
      continue;
    }
    const cards = snap.status === "hit" || snap.status === "stale" ? snap.cards : [];
    for (const c of cards) {
      if (!c.weekId) continue;
      const ls = c.lines ?? [];
      if (ls.length < 2) continue;
      const phantom = ls.filter(
        (l) => l.partType === "experience" && l.lineId != null && l.lineTargetId == null,
      ).length;
      const compTarget = ls.some(
        (l) => l.partType === "competency" && l.lineId != null && l.lineTargetId != null,
      );
      cands.push({ uid, weekId: c.weekId, weekLabel: c.weekLabel ?? c.weekId, ls, phantom, compTarget });
    }
    if (cands.length >= 6000) break;
  }
  cands.sort(
    (a, b) =>
      (b.phantom > 0 ? 1 : 0) - (a.phantom > 0 ? 1 : 0) ||
      (b.compTarget ? 1 : 0) - (a.compTarget ? 1 : 0) ||
      b.ls.length - a.ls.length,
  );
  const chosen = cands.slice(0, 150);
  console.log(
    `[후보] 총 ${cands.length} · 유령행 보유 ${cands.filter((c) => c.phantom > 0).length} · ` +
      `역량대상자 보유 ${cands.filter((c) => c.compTarget).length} → 검증 ${chosen.length}건`,
  );

  let evaluated = 0;
  let phantomRemovedExamples = 0;
  let compRealTypeExamples = 0;
  const infoCatalogCache = new Map<string, number>();
  let printedPhantomExample = false;
  // 성장률(breakdownFromLines)과 표시 슬롯의 의도적 divergence 측정(사용자 수용: 성장률은 비배정 제외 OK).
  let expDivergenceWeeks = 0;
  let expDivergenceSlots = 0;
  let restWeeks = 0;

  // ── 2차: production loader 로 재계산 + 검산 ──
  for (const cand of chosen) {
    const { uid, weekId, weekLabel, ls } = cand;
    const res = await getCrewWeekLineSummary(uid, weekId);
    if (!res.ok) continue;
    const rows = res.data.lineDetails;
    const org = res.data.organizationSlug;
    const F = (checkName: string, detail: string): Fail => ({ userId: uid, weekLabel, check: checkName, detail });
    evaluated++;

    // 휴식 주차 — 라인 목록 없음(조회 전용 휴식 상태). lineDetails 는 비어야 한다.
    if (res.data.isRestWeek) {
      restWeeks++;
      check(rows.length === 0, F("rest-empty", `휴식주인데 라인 ${rows.length}행 존재`));
      continue;
    }

    // ── 정보 §3-1 ──
    const infoRows = rows.filter((r) => r.partType === "information");
    let expectedInfoCount = infoCatalogCache.get(org ?? "");
    if (expectedInfoCount == null) {
      expectedInfoCount = (await loadInfoLineCatalog(org)).length;
      infoCatalogCache.set(org ?? "", expectedInfoCount);
    }
    check(infoRows.length === expectedInfoCount, F("info-count", `정보 행 ${infoRows.length} ≠ 카탈로그 ${expectedInfoCount}`));
    check(infoRows.every((r) => r.type === "일반"), F("info-type", `정보 유형 ≠ 일반: ${infoRows.map((r) => r.type).join(",")}`));
    check(infoRows.every((r) => r.lineName !== "기타" && r.lineName !== "기타A"), F("info-etcA", "기타A 가 정보 행에 포함됨"));
    const infoMainTitles = new Set(
      ls.filter((l) => l.partType === "information" && l.mainTitle).map((l) => l.mainTitle),
    );
    check(infoRows.every((r) => !infoMainTitles.has(r.lineName)), F("info-name-not-maintitle", "정보 라인명이 Main Title 과 동일"));

    // ── 경험 §3-2/§4 ──
    const expRows = rows.filter((r) => r.partType === "experience");
    check(expRows.length <= 5, F("exp-max5", `경험 ${expRows.length}행 > 5`));
    check(
      expRows.every((r) => isBareNaExp(r) || (r.type != null && EXP_TYPES.has(r.type))),
      F("exp-type", `경험 유형 이탈: ${expRows.map((r) => r.type ?? "∅").join(",")}`),
    );
    const byExpType = new Map<string, number>();
    for (const r of expRows) {
      if (isBareNaExp(r)) continue;
      byExpType.set(r.type ?? "?", (byExpType.get(r.type ?? "?") ?? 0) + 1);
    }
    check([...byExpType.values()].every((n) => n <= 1), F("exp-one-per-type", `유형당 >1행: ${JSON.stringify(Object.fromEntries(byExpType))}`));
    // 타인 라인명 미노출: 본인 배정(lineTargetId!=null)만 실제 라인명. 비대상 행은 라인명·lineId 숨김("-"·null).
    check(
      expRows.every((r) => r.lineTargetId != null || (r.lineName === "-" && r.lineId == null)),
      F("exp-no-foreign-name", "경험 비대상 행에 타인 라인명/ lineId 노출"),
    );
    // 클럽 오픈 여부 = enhancementStatus !== 'not_applicable'(정책).
    check(
      expRows.every((r) => r.clubOpen === (r.enhancementStatus !== "not_applicable")),
      F("exp-clubopen", "경험 clubOpen ≠ (enh≠na)"),
    );

    // 원본 card.lines 에 개설 비대상(타인 라인) 유령이 있었으면, 표가 슬롯을 유지하되 라인명을 숨겼는지 예시.
    const rawPhantom = ls.filter(
      (l) => l.partType === "experience" && l.lineId != null && l.lineTargetId == null,
    );
    if (rawPhantom.length > 0) {
      phantomRemovedExamples++;
      if (!printedPhantomExample) {
        printedPhantomExample = true;
        console.log(`\n[슬롯 유지 + 타인 라인명 숨김 예시] user=${uid.slice(0, 8)}… ${weekLabel}`);
        const rawExp = ls.filter((l) => l.partType === "experience");
        console.log(`  · 원본 card.lines 경험 행 ${rawExp.length}개 (개설 비대상=${rawPhantom.length}):`);
        for (const l of rawExp) {
          console.log(
            `      slot=${l.experienceSlotOrder ?? "-"} cat=${l.experienceCategory ?? "-"} ` +
              `enh=${l.enhancementStatus} ${l.lineTargetId ? "배정" : "미배정"} name=${l.lineName ?? "-"}`,
          );
        }
        console.log(`  · 표시 경험 슬롯 ${expRows.length}행 (슬롯 유지·타인명 "-"):`);
        for (const r of expRows) {
          console.log(
            `      유형=${r.type ?? "-"} | 클럽오픈=${r.clubOpen ? "오픈" : "미오픈"} | ` +
              `본인lineId=${r.lineId ? r.lineId.slice(0, 8) : "없음"} | 표시명=${r.lineName} | enh=${r.enhancementStatus}`,
          );
        }
      }
    }

    // ── 역량 §3-3 ──
    const compRows = rows.filter((r) => r.partType === "competency");
    check(compRows.length <= 1, F("comp-max1", `역량 ${compRows.length}행 > 1`));
    for (const r of compRows) {
      if (r.lineId != null && r.lineTargetId != null) {
        check(r.type != null && COMP_TYPES.has(r.type), F("comp-type-real", `역량 성공행 유형 이탈: ${r.type}`));
        check(r.lineName !== "-", F("comp-name-real", "역량 성공행 라인명 '-'"));
        if (r.type && COMP_TYPES.has(r.type)) compRealTypeExamples++;
      } else {
        check(r.type == null, F("comp-type-dash", `역량 미선택행 유형 ≠ null: ${r.type}`));
        check(r.lineName === "-", F("comp-name-dash", `역량 미선택행 라인명 ≠ '-': ${r.lineName}`));
      }
    }

    // ── 경력 §3-4 ── (오픈된 라인만)
    const careerRows = rows.filter((r) => r.partType === "career");
    check(careerRows.every((r) => r.clubOpen && r.lineId != null), F("career-open-only", "경력 미오픈 행이 표에 존재"));
    check(careerRows.every((r) => r.type === "일반"), F("career-type", `경력 유형 ≠ 일반: ${careerRows.map((r) => r.type).join(",")}`));

    // ── 불변식 ──
    check(res.data.lines.total === res.data.lines.open + res.data.lines.unopened, F("inv-total", "total ≠ open + unopened"));
    check(res.data.lines.open === rows.filter((r) => r.clubOpen).length, F("inv-open", "요약 open ≠ 표 clubOpen 수"));
    if (res.data.confirmed) {
      const s = res.data.results.success + res.data.results.failure + res.data.results.notApplicable;
      check(s === res.data.lines.total, F("inv-confirmed-sum", `확정주차 성공+실패+na(${s}) ≠ total(${res.data.lines.total})`));
    }

    // ── §7 정합(단정): 표시 경험 슬롯 집계 == breakdownFromLines(성장률 SoT). 공통 resolver 라 동일해야. ──
    //   분모=오픈 유형 수(오픈+대상=성공/오픈+비대상=실패/미오픈=제외), 분자=본인 배정·성공 유형 수.
    //   관리자 라인 강화 내역·크루 카드 배지·허브 강화율이 모두 같은 값(예: 3/4=75%)이 되는지 검증.
    const card = await resolveCrewWeekCard(uid, weekId);
    if (card.ok && !card.card.isRestWeek) {
      const bd = breakdownFromLines(card.card.lines).experience;
      const displayAvail = expRows.filter((r) => r.enhancementStatus !== "not_applicable").length;
      const displaySucc = expRows.filter((r) => r.enhancementStatus === "success").length;
      check(displayAvail === bd.available, F("parity-exp-available", `경험 오픈 슬롯 ${displayAvail} ≠ 성장 available ${bd.available}`));
      check(displaySucc === bd.completed, F("parity-exp-success", `경험 성공 슬롯 ${displaySucc} ≠ 성장 completed ${bd.completed}`));
      // 비대상 오픈 슬롯(실패)이 분모에 포함되는 케이스 관찰(정책 exercise 카운트).
      const nonOwnFail = expRows.filter((r) => r.lineTargetId == null && r.enhancementStatus === "fail").length;
      if (nonOwnFail > 0) expDivergenceWeeks++;
      expDivergenceSlots += nonOwnFail;
    }

    // ── §5 팝업 유형 == 표 유형 (표본: 라인 보유 행 최대 3개) ──
    for (const r of rows.filter((x) => x.lineId != null).slice(0, 3)) {
      const det = await getCrewWeekLineDetail(uid, weekId, r.lineId!);
      if (det.ok) {
        check(det.data.identity.type === r.type, F("popup-type", `팝업 유형 '${det.data.identity.type}' ≠ 표 '${r.type}' (line ${r.lineId})`));
      }
    }
  }

  console.log(`\n════════ 라인 강화 내역 유형/형태/정합 검증 ════════`);
  console.log(`평가한 (사용자,주차): ${evaluated}건 (그중 휴식주 ${restWeeks}건=라인목록 비움)`);
  console.log(`개설 비대상 슬롯(타인 라인)이 있던 (사용자,주차): ${phantomRemovedExamples}건 — 슬롯 유지·라인명 숨김`);
  console.log(`역량 실유형(원리/기술/관점/자원) 표시 케이스: ${compRealTypeExamples}건`);
  console.log(
    `비대상 오픈 슬롯(강화실패·분모 포함): ${expDivergenceWeeks}주차·총 ${expDivergenceSlots}슬롯 ` +
      `— 관리자 표=breakdownFromLines(성장률) 동일 집계(분모 포함).`,
  );
  console.log(`불변식/정합 위반: ${fails.length}건`);
  const byCheck = new Map<string, number>();
  for (const f of fails) byCheck.set(f.check, (byCheck.get(f.check) ?? 0) + 1);
  if (fails.length > 0) {
    console.log("위반 분포:", Object.fromEntries(byCheck));
    for (const f of fails.slice(0, 25)) {
      console.log(`  ✗ [${f.check}] user=${f.userId.slice(0, 8)}… ${f.weekLabel} — ${f.detail}`);
    }
    process.exitCode = 1;
  } else {
    console.log("✅ 전 항목 PASS — 위반 0건");
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
