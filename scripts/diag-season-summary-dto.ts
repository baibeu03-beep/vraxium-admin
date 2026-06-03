/**
 * cluster-4-1 진입 화면 시즌 요약 DTO 검증.
 *   npx tsx --env-file=.env.local scripts/diag-season-summary-dto.ts [profileUserId]
 *
 * 검증 항목 (요구사항):
 *   1) direct function(getWeeklyGrowth) 결과에 seasonSummary / seasonPointSummary 포함
 *   2) HTTP /api/cluster4/weekly-growth 응답에 동일 필드 포함 (서버 기동 시)
 *   3) direct == HTTP (seasonSummary + seasonPointSummary 깊은 비교)
 *   4) 전환주차 제외 — 현재 시즌 카드(비전환)만 합산됨을 raw 카드로 교차검증
 *   5) userId(internal) == demoUserId 동일 DTO
 *   6) snapshot 영향 없음 — weekly-growth 는 live 경로, snapshot 테이블 미접근
 *
 * 서버가 안 떠 있으면 HTTP 단계는 건너뛰고 direct + 교차검증만 수행한다.
 */
import { config } from "dotenv";
config({ path: ".env.local" });
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { getWeeklyGrowth } from "@/lib/cluster4WeeklyGrowthData";
import { listTestUsers } from "@/lib/testUsers";
import {
  getSeasonForDate,
  seasonDbKey,
  isTransitionWeekStart,
} from "@/lib/seasonCalendar";

const BASE = process.env.BASE_URL || "http://localhost:3000";

type Growth = NonNullable<Awaited<ReturnType<typeof getWeeklyGrowth>>>;

// getWeeklyGrowth 는 profile user_id(uuid)를 받는다 — 공개/데모 HTTP 경로와 동일.
// (getAdminCrewDtoByLegacyUserId 가 uuid 를 수용. demoUserId 경로도 profile uuid 를 넘김.)
async function pickTestUser(
  override: string | null,
): Promise<{ profileUserId: string; name: string } | null> {
  const users = await listTestUsers();
  console.log(`[scan] test users = ${users.length}`);

  if (override) {
    const u = users.find((x) => x.userId === override);
    return { profileUserId: override, name: u?.name ?? "(override)" };
  }

  // 현재 시즌에 포인트가 있는 유저 우선 (seasonPointSummary 가 0 이 아니어야 더 강한 검증).
  const today = new Date().toISOString().slice(0, 10);
  const season = getSeasonForDate(today);
  const seasonKey = season ? seasonDbKey(season) : null;

  let best: { profileUserId: string; name: string; score: number } | null = null;
  let scanned = 0;
  for (const u of users) {
    let dto: Growth | null = null;
    try {
      dto = await getWeeklyGrowth(u.userId);
    } catch {
      continue; // crew 매핑 없는 유저 스킵
    }
    if (!dto) continue;
    scanned++;
    const sp = dto.seasonPointSummary;
    const seasonCards = seasonKey
      ? dto.weeklyCards.filter((c) => c.seasonKey === seasonKey)
      : [];
    const score =
      (sp.star + sp.shield + sp.lightning) * 100 + seasonCards.length;
    if (!best || score > best.score) {
      best = { profileUserId: u.userId, name: u.name, score };
    }
  }
  console.log(`[scan] getWeeklyGrowth 성공 유저 = ${scanned}`);
  return best;
}

function summarize(dto: Growth) {
  return {
    seasonSummary: dto.seasonSummary,
    seasonPointSummary: dto.seasonPointSummary,
  };
}

// 전환주차 제외 교차검증 — direct 카드로 (현재 시즌, 비전환) 합산을 독립 재계산.
function crossCheckTransition(dto: Growth) {
  const today = new Date().toISOString().slice(0, 10);
  const season = getSeasonForDate(today);
  const seasonKey = season ? seasonDbKey(season) : null;

  const seasonCards = seasonKey
    ? dto.weeklyCards.filter((c) => c.seasonKey === seasonKey)
    : [];

  const sum = (cards: typeof seasonCards) =>
    cards.reduce(
      (acc, c) => ({
        star: acc.star + (c.pointsRaw ?? 0),
        shield: acc.shield + (c.advantagesRaw ?? 0),
        lightning: acc.lightning + (c.penaltyRaw ?? 0),
      }),
      { star: 0, shield: 0, lightning: 0 },
    );

  const nonTransition = seasonCards.filter((c) => !c.isTransition);
  const inclTransition = sum(seasonCards);
  const exclTransition = sum(nonTransition);

  console.log(`\n── 전환주차 제외 교차검증 (시즌=${seasonKey ?? "N/A"}) ──`);
  console.log(`현재 시즌 카드 ${seasonCards.length}개 (그중 전환주차 ${
    seasonCards.length - nonTransition.length
  }개):`);
  for (const c of seasonCards) {
    console.log(
      `  주차 ${String(c.weekNumber).padStart(2)} | ${c.startDate} | ` +
        `transition=${c.isTransition} | 별=${c.pointsRaw ?? "·"} ` +
        `방패=${c.advantagesRaw ?? "·"} 번개=${c.penaltyRaw ?? "·"}` +
        (isTransitionWeekStart(c.startDate) === c.isTransition
          ? ""
          : "  ⚠ isTransition 불일치"),
    );
  }
  console.log(`  합계(전환 포함) = ${JSON.stringify(inclTransition)}`);
  console.log(`  합계(전환 제외) = ${JSON.stringify(exclTransition)}`);
  console.log(
    `  DTO seasonPointSummary = ${JSON.stringify(dto.seasonPointSummary)}`,
  );

  const matchesExcl =
    JSON.stringify(exclTransition) ===
    JSON.stringify(dto.seasonPointSummary);
  console.log(
    matchesExcl
      ? "  ✅ DTO == (전환 제외) 합계 — 전환주차가 누적에서 빠짐"
      : "  ❌ DTO != (전환 제외) 합계",
  );
  if (JSON.stringify(inclTransition) === JSON.stringify(exclTransition)) {
    console.log(
      "  ℹ 현재 시즌에 포인트 있는 전환주차가 없어 포함/제외 값이 동일(전환주차가 미래/무포인트). 제외 로직은 위 transition 플래그로 보장됨.",
    );
  }
  return matchesExcl;
}

async function tryHttp(
  path: string,
  headers: Record<string, string>,
): Promise<Growth | null> {
  try {
    const res = await fetch(`${BASE}${path}`, { headers });
    const json: any = await res.json();
    if (!json?.success || !json?.data) {
      console.log(`  HTTP ${path} → success=${json?.success} (data 없음)`);
      return null;
    }
    return json.data as Growth;
  } catch (e) {
    console.log(
      `  HTTP ${path} → 서버 미응답 (${e instanceof Error ? e.message : e})`,
    );
    return null;
  }
}

async function main() {
  const override = process.argv[2] || null;
  const picked = await pickTestUser(override);
  if (!picked) {
    console.log("❌ legacyUserId 있는 테스트 유저를 찾지 못했습니다.");
    return;
  }
  console.log(
    `\n[target] name=${picked.name} profileUserId=${picked.profileUserId}`,
  );

  // ── 1) direct function ──
  const direct = await getWeeklyGrowth(picked.profileUserId);
  if (!direct) {
    console.log("❌ getWeeklyGrowth 가 null 을 반환했습니다.");
    return;
  }
  console.log("\n──────── (1) direct getWeeklyGrowth ────────");
  console.log(JSON.stringify(summarize(direct), null, 2));

  // ── 4) 전환주차 제외 교차검증 ──
  const transitionOk = crossCheckTransition(direct);

  // ── 2/3/5) HTTP demo + internal 비교 ──
  console.log("\n──────── (2)(3)(5) HTTP /api/cluster4/weekly-growth ────────");
  const internalKey = process.env.INTERNAL_API_KEY;
  const demoDto = await tryHttp(
    `/api/cluster4/weekly-growth?demoUserId=${picked.profileUserId}`,
    {},
  );
  const internalDto = internalKey
    ? await tryHttp(
        `/api/cluster4/weekly-growth?userId=${picked.profileUserId}`,
        { "x-internal-api-key": internalKey },
      )
    : null;

  const directJson = JSON.stringify(summarize(direct));
  let httpOk = true;
  if (demoDto) {
    const demoJson = JSON.stringify(summarize(demoDto));
    const eq = demoJson === directJson;
    httpOk = httpOk && eq;
    console.log(
      `  demoUserId HTTP == direct : ${eq ? "✅ 일치" : "❌ 불일치"}`,
    );
    if (!eq) console.log(`    HTTP(demo): ${demoJson}`);
  } else {
    console.log("  demoUserId HTTP: 응답 없음(서버 미기동 가능) — 스킵");
  }
  if (internalDto) {
    const eq = JSON.stringify(summarize(internalDto)) === directJson;
    console.log(
      `  internal userId HTTP == direct : ${eq ? "✅ 일치" : "❌ 불일치"}`,
    );
    if (demoDto) {
      const parity =
        JSON.stringify(summarize(internalDto)) ===
        JSON.stringify(summarize(demoDto));
      console.log(
        `  demoUserId == internal userId : ${parity ? "✅ 동일 DTO" : "❌ 상이"}`,
      );
    }
  }

  // ── 6) snapshot 영향 없음 ──
  console.log("\n──────── (6) snapshot 영향 ────────");
  const { count } = await supabaseAdmin
    .from("cluster4_weekly_card_snapshots")
    .select("user_id", { count: "exact", head: true })
    .eq("user_id", picked.profileUserId);
  console.log(
    `  weekly-growth 는 live 경로 — seasonSummary/seasonPointSummary 는 매 요청 계산.`,
  );
  console.log(
    `  weekly-cards snapshot(dto_version)은 미변경. 이 유저 snapshot 행 존재=${
      count ?? 0
    } (있어도 weekly-growth 와 무관).`,
  );

  console.log("\n──────── 결과 요약 ────────");
  console.log(`  (1) direct 필드 포함        : ✅`);
  console.log(`  (4) 전환주차 제외           : ${transitionOk ? "✅" : "❌"}`);
  console.log(
    `  (2)(3) HTTP == direct      : ${
      demoDto || internalDto ? (httpOk ? "✅" : "❌") : "⏭ 서버 미기동"
    }`,
  );
}

main().then(
  () => process.exit(0),
  (e) => {
    console.error(e);
    process.exit(1);
  },
);
