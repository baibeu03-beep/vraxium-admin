/**
 * 레거시 통합 라인 check 게이트 정책 검증 (2026-06-05 정책 정정).
 *
 *   npx tsx --env-file=.env.local scripts/verify-week-check-policy.ts [--http http://localhost:3000]
 *
 * 검증 항목:
 *   1) direct: getCluster4WeeklyCardsForProfileUser — 케이스 A/B/C/D 샘플 테스터의
 *      레거시 주차 카드에서 userWeekStatus / 통합 라인 enhancementStatus(강화) /
 *      experienceGrowth.checkGate 가 정책과 일치하는지.
 *   2) HTTP: GET /api/cluster4/weekly-cards?userId=... (x-internal-api-key) 응답이
 *      direct 와 동일한지 (--http 로 base URL 지정 시).
 *   3) 강화/주차 분리: 케이스 B = 라인 enhancementStatus=success AND userWeekStatus=fail.
 *   4) 기준값 변경 flip: 케이스 A 샘플 주차의 check_threshold 를 earned+1 로 올리면
 *      직후 direct 재계산에서 주차 fail, 원복하면 success 로 복귀하는지
 *      (updateWeekCheckThreshold 직접 호출 — snapshot 재계산 hook 포함 검증).
 *   5) snapshot: cluster4_weekly_card_snapshots dto_version=18 / is_stale=false /
 *      cards 내용이 direct 와 동일한지.
 *   6) 케이스 분포: 테스터 90명에서 A/B/C/D 전부 존재하는지.
 */
import { config } from "dotenv";
config({ path: ".env.local" });

import { createClient } from "@supabase/supabase-js";
import { readFileSync } from "fs";
import { getCluster4WeeklyCardsForProfileUser } from "@/lib/cluster4WeeklyCardsData";
import {
  updateWeekCheckThreshold,
} from "@/lib/adminWeekRecognitionsData";
import {
  WEEKLY_CARDS_DTO_VERSION,
  recomputeAndStoreWeeklyCardsSnapshot,
} from "@/lib/cluster4WeeklyCardsSnapshot";
import { LEGACY_UNIFIED_LINE_NAME } from "@/lib/lineAvailability";
import type { Cluster4WeeklyCardDto } from "@/shared/cluster4.contracts";

const sb = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
);

const httpIdx = process.argv.indexOf("--http");
const HTTP_BASE = httpIdx >= 0 ? process.argv[httpIdx + 1] : null;
const LOG_PATH = "claudedocs/legacy-check-case-seed-20260605.json";

let pass = 0;
let fail = 0;
function check(name: string, ok: boolean, detail?: string) {
  if (ok) {
    pass++;
    console.log(`  ✅ ${name}`);
  } else {
    fail++;
    console.log(`  ❌ ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

type SeedPlan = {
  userId: string;
  weekStart: string;
  case: "A" | "B" | "C" | "D";
  threshold: number;
  rating: number;
  points: number;
};

function findCard(cards: Cluster4WeeklyCardDto[], weekStart: string) {
  return cards.find((c) => c.startDate === weekStart) ?? null;
}
function unifiedLine(card: Cluster4WeeklyCardDto) {
  return (
    card.lines.find(
      (l) =>
        l.partType === "experience" && l.lineName === LEGACY_UNIFIED_LINE_NAME,
    ) ?? card.lines.find((l) => l.partType === "experience") ?? null
  );
}

async function fetchHttpCards(userId: string): Promise<Cluster4WeeklyCardDto[] | null> {
  if (!HTTP_BASE) return null;
  const res = await fetch(
    `${HTTP_BASE}/api/cluster4/weekly-cards?userId=${encodeURIComponent(userId)}`,
    { headers: { "x-internal-api-key": process.env.INTERNAL_API_KEY ?? "" } },
  );
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${userId}`);
  const json = await res.json();
  return (json.data ?? []) as Cluster4WeeklyCardDto[];
}

async function main() {
  const seedLog = JSON.parse(readFileSync(LOG_PATH, "utf-8")) as {
    plans: SeedPlan[];
    caseCounts: Record<string, number>;
  };

  // ── 6) 케이스 분포 ────────────────────────────────────────────────────
  console.log("\n══ 케이스 분포 (시드 로그) ══");
  for (const k of ["A", "B", "C", "D"] as const) {
    check(`케이스 ${k} 존재 (${seedLog.caseCounts[k]}건)`, (seedLog.caseCounts[k] ?? 0) > 0);
  }

  // 케이스별 샘플 1명 (서로 다른 사용자 우선)
  const samples = new Map<string, SeedPlan>();
  const usedUsers = new Set<string>();
  for (const k of ["A", "B", "C", "D"] as const) {
    const p =
      seedLog.plans.find((x) => x.case === k && !usedUsers.has(x.userId)) ??
      seedLog.plans.find((x) => x.case === k);
    if (p) {
      samples.set(k, p);
      usedUsers.add(p.userId);
    }
  }

  // ── 1)+3) direct 판정 ────────────────────────────────────────────────
  console.log("\n══ direct 판정 (케이스별 샘플) ══");
  const directCardsByUser = new Map<string, Cluster4WeeklyCardDto[]>();
  for (const [k, p] of samples) {
    const cards =
      directCardsByUser.get(p.userId) ??
      (await getCluster4WeeklyCardsForProfileUser(p.userId));
    directCardsByUser.set(p.userId, cards);
    const card = findCard(cards, p.weekStart);
    if (!card) {
      check(`[${k}] ${p.userId.slice(0, 8)} ${p.weekStart} 카드 존재`, false, "카드 없음");
      continue;
    }
    const line = unifiedLine(card);
    const gate = card.experienceGrowth.checkGate ?? null;
    const expectWeek = k === "A" ? "success" : "fail";
    const expectEnh = k === "A" || k === "B" ? "success" : "fail";
    check(
      `[${k}] 주차상태=${expectWeek} (실제 ${card.userWeekStatus})`,
      card.userWeekStatus === expectWeek,
    );
    check(
      `[${k}] 강화상태=${expectEnh} (실제 ${line?.enhancementStatus})`,
      line?.enhancementStatus === expectEnh,
    );
    if (k === "A" || k === "B") {
      check(
        `[${k}] checkGate required=${p.threshold} earned=${p.points} passed=${k === "A"}`,
        gate != null &&
          gate.required === p.threshold &&
          gate.earned === p.points &&
          gate.passed === (k === "A"),
        gate ? JSON.stringify(gate) : "checkGate 없음",
      );
    } else {
      // C/D: 강화 실패 → 게이트 미평가 (rating fail 이 주차 실패 사유)
      check(`[${k}] checkGate 미평가(null)`, gate == null, gate ? JSON.stringify(gate) : "");
    }
    if (k === "B") {
      check(
        `[B] 강화 성공+주차 실패 분리 표시`,
        line?.enhancementStatus === "success" && card.userWeekStatus === "fail",
      );
    }
  }

  // ── 2) HTTP == direct ────────────────────────────────────────────────
  if (HTTP_BASE) {
    console.log("\n══ HTTP == direct ══");
    for (const [k, p] of samples) {
      const httpCards = await fetchHttpCards(p.userId);
      const direct = findCard(directCardsByUser.get(p.userId)!, p.weekStart);
      const http = httpCards ? findCard(httpCards, p.weekStart) : null;
      check(
        `[${k}] HTTP userWeekStatus == direct (${direct?.userWeekStatus})`,
        http != null && direct != null && http.userWeekStatus === direct.userWeekStatus,
        `http=${http?.userWeekStatus}`,
      );
      check(
        `[${k}] HTTP checkGate == direct`,
        JSON.stringify(http?.experienceGrowth.checkGate ?? null) ===
          JSON.stringify(direct?.experienceGrowth.checkGate ?? null),
      );
    }
  } else {
    console.log("\n(HTTP 검증 생략 — --http <base> 지정 시 수행)");
  }

  // ── 5) snapshot 검증 ─────────────────────────────────────────────────
  console.log("\n══ snapshot ══");
  for (const [k, p] of samples) {
    const { data: snap } = await sb
      .from("cluster4_weekly_card_snapshots")
      .select("dto_version,is_stale,cards")
      .eq("user_id", p.userId)
      .maybeSingle();
    const row = snap as { dto_version: number; is_stale: boolean; cards: Cluster4WeeklyCardDto[] } | null;
    check(
      `[${k}] snapshot dto_version=${WEEKLY_CARDS_DTO_VERSION}`,
      row?.dto_version === WEEKLY_CARDS_DTO_VERSION,
      `실제 ${row?.dto_version}`,
    );
    check(`[${k}] snapshot is_stale=false`, row?.is_stale === false);
    const snapCard = row ? findCard(row.cards, p.weekStart) : null;
    const direct = findCard(directCardsByUser.get(p.userId)!, p.weekStart);
    check(
      `[${k}] snapshot userWeekStatus == direct`,
      snapCard?.userWeekStatus === direct?.userWeekStatus,
      `snap=${snapCard?.userWeekStatus} direct=${direct?.userWeekStatus}`,
    );
  }

  // ── 4) 기준값 변경 flip (케이스 A 샘플) ──────────────────────────────
  console.log("\n══ 기준값 변경 flip (케이스 A) ══");
  const a = samples.get("A");
  if (a) {
    const { data: weekRow } = await sb
      .from("weeks")
      .select("id,check_threshold")
      .eq("start_date", a.weekStart)
      .maybeSingle();
    const week = weekRow as { id: string; check_threshold: number | null } | null;
    if (!week) {
      check("주차 행 조회", false);
    } else {
      const original = week.check_threshold ?? null;
      // earned(points)+1 로 올리면 케이스 A 주차가 fail 로 바뀌어야 한다.
      const up = await updateWeekCheckThreshold(week.id, {
        check_threshold: a.points + 1,
      });
      check(
        `기준 상향 ${a.points + 1} 저장 (snapshot ${up.snapshot_recompute?.recomputed ?? 0}명 재계산)`,
        up.effective_check_threshold === a.points + 1,
      );
      const cardsUp = await getCluster4WeeklyCardsForProfileUser(a.userId);
      const cardUp = findCard(cardsUp, a.weekStart);
      check(
        `상향 후 주차상태 fail (실제 ${cardUp?.userWeekStatus})`,
        cardUp?.userWeekStatus === "fail",
      );
      check(
        `상향 후에도 강화상태 success 유지`,
        unifiedLine(cardUp!)?.enhancementStatus === "success",
      );
      // snapshot hook 으로 재계산된 snapshot 도 fail 인지
      const { data: snapUp } = await sb
        .from("cluster4_weekly_card_snapshots")
        .select("cards,is_stale,dto_version")
        .eq("user_id", a.userId)
        .maybeSingle();
      const snapCardUp = snapUp
        ? findCard((snapUp as any).cards as Cluster4WeeklyCardDto[], a.weekStart)
        : null;
      check(
        `상향 후 snapshot 도 fail (실제 ${snapCardUp?.userWeekStatus})`,
        snapCardUp?.userWeekStatus === "fail",
      );

      if (HTTP_BASE) {
        const httpCards = await fetchHttpCards(a.userId);
        const httpCard = httpCards ? findCard(httpCards, a.weekStart) : null;
        check(
          `상향 후 HTTP 도 fail (실제 ${httpCard?.userWeekStatus})`,
          httpCard?.userWeekStatus === "fail",
        );
      }

      // 원복 → success 복귀 (read-time 판정 — uws 불변이므로 양방향).
      const down = await updateWeekCheckThreshold(week.id, {
        check_threshold: original,
      });
      check(
        `기준 원복(${original ?? "기본값"}) 저장`,
        (down.check_threshold ?? null) === original,
      );
      const cardsDown = await getCluster4WeeklyCardsForProfileUser(a.userId);
      const cardDown = findCard(cardsDown, a.weekStart);
      check(
        `원복 후 주차상태 success 복귀 (실제 ${cardDown?.userWeekStatus})`,
        cardDown?.userWeekStatus === "success",
      );
      // 최종 snapshot 정합 보장(테스트 잔재 제거).
      await recomputeAndStoreWeeklyCardsSnapshot(a.userId);
    }
  }

  console.log(`\n결과: ✅ ${pass} / ❌ ${fail}`);
  if (fail > 0) process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
