// POST /api/cluster4/weekly-cards-projection
//
// /weekly-ranking(크루) 전용 슬림 랭킹 projection 배치 API.
//   기존 GET /api/cluster4/weekly-cards 는 사용자당 전체 카드 DTO(~160KB)를 반환해서, 랭킹
//   화면이 30~98명분을 팬아웃으로 받으면 수 MB payload 가 된다. 이 API 는 "계산을 새로 하지
//   않고" 기존 카드 로딩 서비스(loadFinalizedWeeklyCards — GET 과 동일 함수·동일 snapshot 경로)를
//   사용자별로 호출한 뒤, 크루 metricFromCard 가 실제로 읽는 필드만 골라(pure projection) 반환한다.
//
// ⚠️ 계산 엔진/business rule/snapshot 생성·조회/DTO 의미를 복제하거나 변경하지 않는다:
//   · 카드 값은 전부 loadFinalizedWeeklyCards 결과 그대로(강화/2차기입 overlay·성장중단 truncation
//     적용본 = GET data 배열과 byte-identical). 이 route 는 그 카드에서 8개 필드만 얕게 뽑는다.
//   · snapshot miss/stale/boundary 에서 재계산·저장(WRITE)하는 동작도 GET 단건과 동일하다(같은 함수).
//   · mode/actAs/demo 로 계산 경로를 분기하지 않는다 — 주체는 userId 뿐이고 mode 는 카드 값에
//     영향을 주지 않는다(GET 과 동일 — 계약상 accept 만 하고 계산엔 미사용).
//
// 인증  : x-internal-api-key == process.env.INTERNAL_API_KEY (timing-safe). server-to-server 전용.
// body  : { userIds: string[](필수), organizationSlug?: string, seasonKey?: string, mode?: string }
// 응답  : { success, organizationSlug, seasonKey, users: [{ userId, ok, outcome, cards? }] }
//
// 계약(contract):
//   · users[] 순서 = 요청 userIds[](공백제거·중복제거 후, 첫 등장 순서 보존) 순서와 1:1 동일.
//   · 중복 userId : 첫 등장만 남기고 제거(크루 loadGrowthMetricSnapshots 도 Set 으로 중복 제거 — 정합).
//   · 빈 userIds  : 400.
//   · userIds 최대: MAX_USERS 초과 시 400.
//   · 존재하지 않는 userId: 단건 GET 과 동일하게 loadFinalizedWeeklyCards 가 처리(대개 miss→빈 카드).
//   · 부분 실패(partial success 허용): 사용자별로 격리한다. 단건 GET 이 success:false(outcome=error)
//     이거나 예외면 그 사용자만 { ok:false } 로 반환하고 배치 전체는 200/success:true 를 유지한다.
//     → 크루는 ok:false(=cards 없음) 사용자를 팬아웃 실패와 동일하게 스킵(emptyMetric)한다.
//   · 카드가 없는(빈) 사용자: { ok:true, cards:[] } (단건 GET success:true, data:[] 와 정합).

import type { NextRequest } from "next/server";
import { loadFinalizedWeeklyCards } from "@/lib/cluster4WeeklyCardsService";
import type { Cluster4WeeklyCardDto, Cluster4RateDto } from "@/shared/cluster4.contracts";

export const maxDuration = 60;
export const dynamic = "force-dynamic";

// 98명(최대 조직) + 여유. 초과 요청은 400(크루는 조직 단위라 이 상한을 넘지 않는다).
const MAX_USERS = 200;
// 내부 팬아웃 동시성 — 기존 크루 팬아웃(12)과 동일 기본값. env 로 실측/튜닝 가능(값만, 로직 불변).
const DEFAULT_CONCURRENCY = 12;
const CONCURRENCY = (() => {
  const raw = Number(process.env.WEEKLY_RANKING_PROJECTION_CONCURRENCY);
  return Number.isFinite(raw) && raw >= 1 && raw <= 64 ? Math.floor(raw) : DEFAULT_CONCURRENCY;
})();

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

// 크루 metricFromCard 가 읽는 필드만 얕게 픽(pure projection — 계산·환원 없음).
//   metricFromCard 입력 = weekId · accumulatedApprovedWeeks · weeklyGrowthRate · experienceRate ·
//                         growthRate · infoRate · competencyRate · careerRate.
//   실측(91명·2190 카드): 뒤의 4개(growthRate/infoRate/competencyRate/careerRate)는 현재 DTO(v43)에
//   전량 부재(undefined) → metricFromCard 가 rateValue(undefined)=0 으로 환원(fat/slim 동일).
//   그래도 향후 상위 필드로 승격될 가능성에 대비해 "존재하면 그대로" 전달한다(부재 시 JSON 에서 생략).
//   undefined 필드는 JSON.stringify 에서 생략되므로 크루가 fat 카드와 동일 값을 본다.
type ProjectedCard = {
  weekId: Cluster4WeeklyCardDto["weekId"];
  accumulatedApprovedWeeks?: number;
  weeklyGrowthRate?: number;
  experienceRate?: Cluster4RateDto;
  growthRate?: Cluster4RateDto;
  infoRate?: Cluster4RateDto;
  competencyRate?: Cluster4RateDto;
  careerRate?: Cluster4RateDto;
};

function projectCard(card: Cluster4WeeklyCardDto): ProjectedCard {
  // 4개 허브율은 현행 타입에 미선언(런타임 부재) → 존재 시에만 얕게 전달하기 위해 인덱스 접근.
  const raw = card as unknown as Record<string, Cluster4RateDto | undefined>;
  return {
    weekId: card.weekId,
    accumulatedApprovedWeeks: card.accumulatedApprovedWeeks,
    weeklyGrowthRate: card.weeklyGrowthRate,
    experienceRate: card.experienceRate,
    growthRate: raw.growthRate,
    infoRate: raw.infoRate,
    competencyRate: raw.competencyRate,
    careerRate: raw.careerRate,
  };
}

type ProjectedUser = {
  userId: string;
  ok: boolean;
  outcome: string | null;
  cards?: ProjectedCard[];
};

export async function POST(request: NextRequest) {
  // ── 인증: 내부 API 키(timing-safe) ──
  const expected = process.env.INTERNAL_API_KEY;
  const provided = request.headers.get("x-internal-api-key");
  if (!expected || !provided || !timingSafeEqual(provided, expected)) {
    return Response.json({ success: false, error: "Unauthorized" }, { status: 401 });
  }

  // ── body 파싱/검증 ──
  let body: { userIds?: unknown; organizationSlug?: unknown; seasonKey?: unknown };
  try {
    body = await request.json();
  } catch {
    return Response.json({ success: false, error: "Invalid JSON body." }, { status: 400 });
  }

  if (!Array.isArray(body.userIds)) {
    return Response.json({ success: false, error: "userIds must be an array." }, { status: 400 });
  }

  // 문자열만, 공백 제거, 중복 제거(첫 등장 순서 보존).
  const userIds = Array.from(
    new Set(
      body.userIds
        .filter((id): id is string => typeof id === "string")
        .map((id) => id.trim())
        .filter((id) => id.length > 0),
    ),
  );

  if (userIds.length === 0) {
    return Response.json({ success: false, error: "userIds is empty." }, { status: 400 });
  }
  if (userIds.length > MAX_USERS) {
    return Response.json(
      { success: false, error: `Too many userIds (max ${MAX_USERS}).` },
      { status: 400 },
    );
  }

  const organizationSlug = typeof body.organizationSlug === "string" ? body.organizationSlug : null;
  const seasonKey = typeof body.seasonKey === "string" ? body.seasonKey : null;

  // ── 슬림 팬아웃 — 사용자별 loadFinalizedWeeklyCards(GET 과 동일 함수) + 필드 projection ──
  //   동시성 제한(CONCURRENCY=12). 무제한 Promise.all 금지. 사용자별 실패 격리(부분 성공).
  //   실측(로컬 warm-HIT, 5회): 30명 c12≈0.94s / c20≈1.03s, 91명 c12≈2.98s / c20≈2.87s / c30≈2.77s
  //   → 12 초과는 한계효익 미미(91명 12→20 약 4% 개선)한데 Supabase 동시 연결만 증가. p95 안정.
  const t0 = Date.now();
  const results = new Array<ProjectedUser>(userIds.length);
  for (let offset = 0; offset < userIds.length; offset += CONCURRENCY) {
    const slice = userIds.slice(offset, offset + CONCURRENCY);
    await Promise.all(
      slice.map(async (userId, i) => {
        const idx = offset + i;
        try {
          const finalized = await loadFinalizedWeeklyCards(userId);
          if (finalized.outcome === "error") {
            // 단건 GET error 분기(success:false)와 동일 취급 → 크루가 스킵(emptyMetric).
            results[idx] = { userId, ok: false, outcome: finalized.outcome };
            return;
          }
          results[idx] = {
            userId,
            ok: true,
            outcome: finalized.outcome,
            cards: finalized.cards.map(projectCard),
          };
        } catch (error) {
          // 단건 GET 예외(HTTP 5xx)와 동일 취급 → 크루가 스킵.
          console.warn("[weekly-cards-projection] user failed", {
            userId,
            message: error instanceof Error ? error.message : String(error),
          });
          results[idx] = { userId, ok: false, outcome: null };
        }
      }),
    );
  }

  const okCount = results.filter((r) => r.ok).length;
  console.log(
    "[weekly-cards-projection] done",
    `| ${Date.now() - t0}ms | users=${userIds.length} ok=${okCount} concurrency=${CONCURRENCY}`,
  );

  return Response.json({
    success: true,
    organizationSlug,
    seasonKey,
    users: results,
  });
}
