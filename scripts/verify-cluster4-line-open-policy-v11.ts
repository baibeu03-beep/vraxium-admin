/**
 * v11 라인 개설/강화상태 정책 검증 (2026-06-04).
 *
 *   npx tsx --env-file=.env.local scripts/verify-cluster4-line-open-policy-v11.ts [userId] [--recompute] [--http]
 *
 * 1) direct(getCluster4WeeklyCardsForProfileUser) 결과에 대해 정책 불변식 검사:
 *    - experience: 모든 주차에 슬롯 1·2·3·5 + 4 칸 존재. "신정책 적용 주차"(판정 완료
 *      success/fail && 비전환 && (테스트 사용자 || start >= CLUSTER4_SLOT_POLICY_EFFECTIVE_FROM))
 *      에서는 필수 슬롯 not_applicable 금지(해당 없음 불가 → fail/pending/success).
 *      진행(running)/집계(tallying)/휴식/전환/실사용자 과거 주차는 placeholder not_applicable
 *      허용(fail 선반영 금지 + 과거 보존) — 단 그 주차의 "내용 없는 placeholder fail"(lineId=null)
 *      은 금지(선반영 검출).
 *    - career: 칸 수 ≥ 6 (부족분 보이드 패딩).
 *    - competency: enhancementStatus=fail 칸은 status="void"(보이드 표시).
 *    - 강화율 정합: part denominator == enh!=not_applicable 칸 수, numerator == success 칸 수,
 *      카드 growthNumerator/Denominator == part 합.
 * 2) --recompute: 해당 유저 snapshot 재계산(v11 저장) 후 snapshot.cards 와 direct 비교.
 * 3) --http: 로컬 dev 서버(3000)에 internal key 로 GET 하여 HTTP 응답과 direct 비교.
 */
import { getCluster4WeeklyCardsForProfileUser } from "@/lib/cluster4WeeklyCardsData";
import {
  readWeeklyCardsSnapshot,
  recomputeAndStoreWeeklyCardsSnapshot,
  WEEKLY_CARDS_DTO_VERSION,
} from "@/lib/cluster4WeeklyCardsSnapshot";
import {
  CLUSTER4_SLOT_POLICY_EFFECTIVE_FROM,
  EXPERIENCE_MANAGEMENT_SLOT_ORDER,
  fetchManagementSlotOpen,
} from "@/lib/lineAvailability";
import { fetchIsTestUser } from "@/lib/cluster4WeeklyGrowthData";
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import type { Cluster4WeeklyCardDto } from "@/shared/cluster4.contracts";

const args = process.argv.slice(2);
const flagRecompute = args.includes("--recompute");
const flagHttp = args.includes("--http");
const userIdArg = args.find((a) => !a.startsWith("--")) ?? null;

const REQUIRED_SLOTS = [1, 2, 3, 5];

type Issue = { week: string; msg: string };

function summarizeLines(card: Cluster4WeeklyCardDto): string {
  const byPart: Record<string, string[]> = {};
  for (const l of card.lines) {
    const key = l.partType;
    const slot =
      l.partType === "experience" && l.experienceSlotOrder != null
        ? `s${l.experienceSlotOrder}`
        : "";
    (byPart[key] ??= []).push(
      `${slot}${l.status}/${l.enhancementStatus}${l.lineTargetId ? "*" : ""}`,
    );
  }
  return Object.entries(byPart)
    .map(([p, v]) => `${p}=[${v.join(",")}]`)
    .join(" ");
}

function checkCards(
  label: string,
  cards: Cluster4WeeklyCardDto[],
  isTestUser: boolean,
  // 관리(5) 슬롯 개방 여부(membership_level 심화/운영진) — 잠금 사용자는 슬롯 5 가
  // 신정책 주차에도 not_applicable(해당 없음)이어야 한다(분모 제외·고객앱 잠금 정합).
  managementSlotOpen: boolean,
): Issue[] {
  const issues: Issue[] = [];
  for (const card of cards) {
    const wk = `${card.seasonKey ?? "?"} W${card.weekNumber}`;
    // 신정책(필수 슬롯 fail) 적용 주차: 판정 완료 + 비전환 + (테스트 || EFFECTIVE_FROM 이후).
    const slotPolicyWeek =
      (card.userWeekStatus === "success" || card.userWeekStatus === "fail") &&
      !card.isTransition &&
      (isTestUser || card.startDate >= CLUSTER4_SLOT_POLICY_EFFECTIVE_FROM);
    const exp = card.lines.filter((l) => l.partType === "experience");
    const car = card.lines.filter((l) => l.partType === "career");
    const comp = card.lines.filter((l) => l.partType === "competency");

    // experience 슬롯 불변식
    const slotSet = new Set(
      exp.map((l) => l.experienceSlotOrder).filter((s) => s != null),
    );
    for (const s of [...REQUIRED_SLOTS, 4]) {
      if (!slotSet.has(s)) issues.push({ week: wk, msg: `experience slot ${s} 칸 없음` });
    }
    for (const l of exp) {
      const isRequiredSlot =
        l.experienceSlotOrder != null &&
        REQUIRED_SLOTS.includes(l.experienceSlotOrder);
      if (!isRequiredSlot) continue;
      // 관리(5) 슬롯 잠금 사용자: 슬롯 5 는 신정책 주차에도 해당 없음이 정상(분모 제외).
      const managementLocked =
        l.experienceSlotOrder === EXPERIENCE_MANAGEMENT_SLOT_ORDER &&
        !managementSlotOpen;
      if (slotPolicyWeek && !managementLocked && l.enhancementStatus === "not_applicable") {
        issues.push({
          week: wk,
          msg: `experience 필수 슬롯 ${l.experienceSlotOrder} 이 not_applicable (신정책 주차 — 해당 없음 불가 위반)`,
        });
      }
      // 잠금 사용자의 관리(5) 슬롯은 placeholder fail/synthetic fail(본인 타깃 없음) 금지 —
      // 고객앱이 카드를 노출하지 않으므로 분모에 들어가면 "총 N개 > 표시 칸" 불일치.
      if (managementLocked && l.lineTargetId == null && l.enhancementStatus === "fail") {
        issues.push({
          week: wk,
          msg: `experience 관리 슬롯(5) 잠금 사용자에 fail 칸 (분모 누수 — 해당 없음이어야 함)`,
        });
      }
      // fail 선반영/과거 보존 검출: 신정책 미적용 주차에 내용 없는 placeholder fail(lineId=null) 금지.
      if (!slotPolicyWeek && l.lineId === null && l.enhancementStatus === "fail") {
        issues.push({
          week: wk,
          msg: `experience 슬롯 ${l.experienceSlotOrder} placeholder fail 선반영 (status=${card.userWeekStatus}, start=${card.startDate})`,
        });
      }
    }

    // career 6칸
    if (car.length < 6) issues.push({ week: wk, msg: `career 칸 ${car.length} < 6` });

    // competency fail → void 표시
    for (const l of comp) {
      if (l.enhancementStatus === "fail" && l.status !== "void") {
        issues.push({ week: wk, msg: `competency fail 칸 status=${l.status} (void 여야 함)` });
      }
    }
    // competency 단일 정규화 (v14): 비휴식·비전환 주차는 역량 칸 정확히 1개 + 해당 없음 금지.
    if (!card.isRestWeek && !card.isTransition) {
      if (comp.length !== 1) {
        issues.push({ week: wk, msg: `competency 칸 ${comp.length}개 (항상 1이어야 함 — v14 단일 정규화)` });
      }
      for (const l of comp) {
        if (l.enhancementStatus === "not_applicable") {
          issues.push({ week: wk, msg: `competency 칸 not_applicable (역량은 해당 없음 금지 — 강화 대기여야 함)` });
        }
      }
    }

    // 강화율 정합 (휴식 주차는 denominator null — 스킵)
    if (!card.isRestWeek) {
      const parts: ["information" | "competency" | "experience" | "career", string][] = [
        ["information", "info"],
        ["competency", "ability"],
        ["experience", "experience"],
        ["career", "career"],
      ];
      let sumA = 0;
      let sumB = 0;
      for (const [partType] of parts) {
        const ls = card.lines.filter((l) => l.partType === partType);
        const a = ls.filter((l) => l.enhancementStatus !== "not_applicable").length;
        const b = ls.filter((l) => l.enhancementStatus === "success").length;
        sumA += a;
        sumB += b;
        const denom = ls[0]?.denominator ?? null;
        const numer = ls[0]?.numerator ?? null;
        if (a > 0 && (denom !== a || numer !== b)) {
          issues.push({
            week: wk,
            msg: `${partType} 강화율 불일치: 칸 기준 ${b}/${a} vs DTO ${numer}/${denom}`,
          });
        }
        if (a === 0 && denom !== null) {
          issues.push({ week: wk, msg: `${partType} A=0 인데 denominator=${denom} (null 이어야 함)` });
        }
      }
      if (card.growthNumerator !== sumB || card.growthDenominator !== sumA) {
        issues.push({
          week: wk,
          msg: `카드 종합 불일치: 칸 합 ${sumB}/${sumA} vs 헤더 ${card.growthNumerator}/${card.growthDenominator}`,
        });
      }
    }
  }
  console.log(
    `\n[${label}] 카드 ${cards.length}개 검사 → 위반 ${issues.length}건`,
  );
  for (const i of issues.slice(0, 30)) console.log(`  ✗ ${i.week}: ${i.msg}`);
  return issues;
}

// 라인 상태 비교 키 (direct vs snapshot/HTTP). 시간 민감 필드(canEdit 등) 제외,
// 정책 핵심 축(status/enhancementStatus/submissionStatus/슬롯/분자/분모)만 비교.
function lineKey(card: Cluster4WeeklyCardDto): string {
  return JSON.stringify(
    card.lines.map((l) => ({
      p: l.partType,
      s: l.status,
      e: l.enhancementStatus,
      sub: l.submissionStatus,
      slot: l.experienceSlotOrder,
      n: l.numerator,
      d: l.denominator,
      r: l.rate,
      lt: l.lineTargetId,
    })),
  );
}

function compareCardSets(
  labelA: string,
  a: Cluster4WeeklyCardDto[],
  labelB: string,
  b: Cluster4WeeklyCardDto[],
): number {
  const byWeekB = new Map(b.map((c) => [`${c.startDate}`, c]));
  let mismatches = 0;
  for (const ca of a) {
    const cb = byWeekB.get(ca.startDate);
    if (!cb) {
      console.log(`  ✗ ${ca.startDate}: ${labelB} 에 카드 없음`);
      mismatches++;
      continue;
    }
    const ga = `${ca.growthNumerator}/${ca.growthDenominator}@${ca.weeklyGrowthRate}`;
    const gb = `${cb.growthNumerator}/${cb.growthDenominator}@${cb.weeklyGrowthRate}`;
    if (ga !== gb) {
      console.log(`  ✗ ${ca.startDate} 강화율: ${labelA}=${ga} vs ${labelB}=${gb}`);
      mismatches++;
    }
    if (lineKey(ca) !== lineKey(cb)) {
      console.log(`  ✗ ${ca.startDate} 라인 상태 불일치`);
      const la = JSON.parse(lineKey(ca));
      const lb = JSON.parse(lineKey(cb));
      console.log(`    ${labelA}:`, JSON.stringify(la));
      console.log(`    ${labelB}:`, JSON.stringify(lb));
      mismatches++;
    }
  }
  console.log(
    `[비교] ${labelA}(${a.length}) vs ${labelB}(${b.length}) → 불일치 ${mismatches}건`,
  );
  return mismatches;
}

async function pickTestUser(): Promise<string> {
  // 라인 타깃이 가장 많은 테스트 유저(display_name 에 t/T) 우선.
  const { data: tgts } = await supabaseAdmin
    .from("cluster4_line_targets")
    .select("target_user_id")
    .eq("target_mode", "user")
    .not("target_user_id", "is", null)
    .limit(3000);
  const cnt = new Map<string, number>();
  for (const t of (tgts ?? []) as { target_user_id: string }[]) {
    cnt.set(t.target_user_id, (cnt.get(t.target_user_id) ?? 0) + 1);
  }
  const ids = [...cnt.keys()];
  const { data: profs } = await supabaseAdmin
    .from("user_profiles")
    .select("user_id,display_name")
    .in("user_id", ids.slice(0, 200));
  const test = ((profs ?? []) as { user_id: string; display_name: string | null }[])
    .filter((p) => p.display_name && /t/i.test(p.display_name))
    .sort((x, y) => (cnt.get(y.user_id) ?? 0) - (cnt.get(x.user_id) ?? 0));
  const picked = test[0]?.user_id ?? [...cnt.entries()].sort((x, y) => y[1] - x[1])[0]?.[0];
  if (!picked) throw new Error("라인 타깃 보유 유저 없음");
  console.log(
    `대상 유저: ${picked} (${test[0]?.display_name ?? "비테스트 유저 폴백"}, 타깃 ${cnt.get(picked)}개)`,
  );
  return picked;
}

async function main() {
  console.log(`DTO_VERSION=${WEEKLY_CARDS_DTO_VERSION}`);
  const userId = userIdArg ?? (await pickTestUser());

  // 1) direct
  const [isTestUser, managementSlotOpen] = await Promise.all([
    fetchIsTestUser(userId),
    fetchManagementSlotOpen(userId),
  ]);
  console.log(
    `테스트 사용자=${isTestUser} | 관리(5) 슬롯 개방=${managementSlotOpen} | EFFECTIVE_FROM=${CLUSTER4_SLOT_POLICY_EFFECTIVE_FROM}`,
  );
  const direct = await getCluster4WeeklyCardsForProfileUser(userId);
  const issues = checkCards("direct", direct, isTestUser, managementSlotOpen);

  // 샘플 주차 상태표 출력 (최신 비휴식 3주)
  const sample = direct.filter((c) => !c.isRestWeek).slice(0, 3);
  console.log("\n── 샘플 주차 라인 상태 (slot status/enhancement, * = 본인 타깃) ──");
  for (const c of sample) {
    console.log(`▸ ${c.seasonKey} W${c.weekNumber} (${c.userWeekStatus}) 종합 ${c.growthNumerator}/${c.growthDenominator}@${c.weeklyGrowthRate}%`);
    console.log(`  ${summarizeLines(c)}`);
  }

  // 2) snapshot 재계산 + 비교
  if (flagRecompute) {
    console.log("\n── snapshot 재계산(v11 저장) ──");
    await recomputeAndStoreWeeklyCardsSnapshot(userId);
    const snap = await readWeeklyCardsSnapshot(userId);
    if (snap.status !== "hit") {
      console.log(`✗ snapshot 상태=${snap.status} (hit 이어야 함)`);
      process.exitCode = 1;
    } else {
      const m = compareCardSets("direct", direct, "snapshot", snap.cards);
      if (m > 0) process.exitCode = 1;
    }
  }

  // 3) HTTP 비교 (dev 서버 필요)
  if (flagHttp) {
    const key = process.env.INTERNAL_API_KEY;
    if (!key) throw new Error("INTERNAL_API_KEY 미설정");
    const res = await fetch(
      `http://localhost:3000/api/cluster4/weekly-cards?userId=${encodeURIComponent(userId)}`,
      { headers: { "x-internal-api-key": key } },
    );
    const body = (await res.json()) as {
      success: boolean;
      data: Cluster4WeeklyCardDto[];
      error: unknown;
    };
    console.log(`\n── HTTP 비교 ── status=${res.status} success=${body.success} cards=${body.data?.length}`);
    if (!res.ok || !body.success) {
      console.log("✗ HTTP 실패:", JSON.stringify(body.error));
      process.exitCode = 1;
    } else {
      const issuesHttp = checkCards("http", body.data, isTestUser, managementSlotOpen);
      const m = compareCardSets("direct", direct, "http", body.data);
      if (m > 0 || issuesHttp.length > 0) process.exitCode = 1;
    }
  }

  if (issues.length > 0) process.exitCode = 1;
  console.log(`\n결과: ${process.exitCode === 1 ? "FAIL" : "PASS"}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
