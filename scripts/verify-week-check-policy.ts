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
import {
  LEGACY_UNIFIED_LINE_NAME,
  reduceLegacyUnifiedVerdict,
} from "@/lib/lineAvailability";
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

  // 케이스별 샘플 1명 (서로 다른 사용자 우선) — 공표 완료 주차만
  //   (미공표 주차는 tallying 으로 표시되는 게 정상이라 성공/실패 단언 불가).
  const { data: pubWeeks } = await sb
    .from("weeks")
    .select("start_date")
    .not("result_published_at", "is", null);
  const publishedStarts = new Set(
    ((pubWeeks ?? []) as { start_date: string }[]).map((w) => w.start_date),
  );
  const samples = new Map<string, SeedPlan>();
  const usedUsers = new Set<string>();
  for (const k of ["A", "B", "C", "D"] as const) {
    const candidates = seedLog.plans.filter(
      (x) => x.case === k && publishedStarts.has(x.weekStart),
    );
    const p =
      candidates.find((x) => !usedUsers.has(x.userId)) ?? candidates[0] ?? null;
    if (p) {
      samples.set(k, p);
      usedUsers.add(p.userId);
    } else {
      check(`케이스 ${k} 공표 주차 샘플 존재`, false, "공표 완료 주차 내 샘플 없음");
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
        `[${k}] checkGate required=${p.threshold} earned=${p.points} passed=${k === "A"} enforced=true`,
        gate != null &&
          gate.required === p.threshold &&
          gate.earned === p.points &&
          gate.passed === (k === "A") &&
          gate.enforced === true,
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
      // JSONB 저장 시 키 순서가 재배열되므로 필드 단위로 비교한다.
      const hg = http?.experienceGrowth.checkGate ?? null;
      const dg = direct?.experienceGrowth.checkGate ?? null;
      check(
        `[${k}] HTTP checkGate == direct`,
        (hg == null && dg == null) ||
          (hg != null &&
            dg != null &&
            hg.required === dg.required &&
            hg.earned === dg.earned &&
            hg.passed === dg.passed &&
            hg.enforced === dg.enforced),
        `http=${JSON.stringify(hg)} direct=${JSON.stringify(dg)}`,
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

  // ── 7) 실사용자 보존 (check 미이관 fallback) ─────────────────────────
  console.log("\n══ 실사용자 보존 (check 미이관 — 기존 표시 유지) ══");
  {
    const { data: markers } = await sb.from("test_user_markers").select("user_id");
    const testers = new Set((markers ?? []).map((m: any) => m.user_id));
    const { data: uws } = await sb
      .from("user_week_statuses")
      .select("user_id,week_start_date,status")
      .lt("week_start_date", "2026-06-29")
      .eq("status", "success")
      .limit(5000);
    const realSuccess = (uws ?? []).filter((r: any) => !testers.has(r.user_id));
    const sampleUsers = [...new Set(realSuccess.map((r: any) => r.user_id))].slice(0, 3);
    for (const uid of sampleUsers as string[]) {
      const expect = new Set(
        realSuccess
          .filter((r: any) => r.user_id === uid)
          .map((r: any) => r.week_start_date),
      );
      const cards = await getCluster4WeeklyCardsForProfileUser(uid);
      let preserved = true;
      let demotedWeek: string | null = null;
      for (const ws of expect) {
        const card = findCard(cards, ws as string);
        if (card && card.userWeekStatus !== "success") {
          preserved = false;
          demotedWeek = ws as string;
          break;
        }
      }
      const gates = cards
        .filter((c) => expect.has(c.startDate))
        .map((c) => c.experienceGrowth.checkGate)
        .filter(Boolean);
      check(
        `실사용자 ${uid.slice(0, 8)} success ${expect.size}주차 표시 보존`,
        preserved,
        demotedWeek ? `${demotedWeek} 강등됨` : undefined,
      );
      check(
        `실사용자 ${uid.slice(0, 8)} checkGate enforced=false (미이관)`,
        gates.every((g) => g!.enforced === false),
        JSON.stringify(gates[0] ?? null),
      );
    }
  }

  // ── 8) 향후 이관 자동 적용 (순수 함수 시뮬레이션 — checks_migrated 행 단위 플래그) ──
  console.log("\n══ 향후 실사용자 check 이관 시 자동 적용 (reduceLegacyUnifiedVerdict 순수 검증) ══");
  {
    const base = {
      opened: true,
      hasTarget: true,
      deadlinePassed: true,
      rating: 8,
      checkThreshold: 30,
    };
    // 미이관(잔존 3, checks_migrated=false): 강등 없음 — 기존 결과 보존
    const before = reduceLegacyUnifiedVerdict({
      ...base,
      checkCount: 3,
      checkDataMigrated: false,
    });
    check(
      "미이관(check=3, flag=false) → verdict pass(보존)",
      before.status === "pass" && before.checkGate?.enforced === false,
      JSON.stringify(before.checkGate),
    );
    // 이관 후(실값 25 < 30, flag=true): 자동 강등 — 동일 로직 적용
    const afterFail = reduceLegacyUnifiedVerdict({
      ...base,
      checkCount: 25,
      checkDataMigrated: true,
    });
    check(
      "이관 후(check=25<30, flag=true) → verdict fail(자동 적용)",
      afterFail.status === "fail" && afterFail.checkGate?.enforced === true,
      JSON.stringify(afterFail.checkGate),
    );
    // 이관 후(실값 33 >= 30): 성공 유지
    const afterPass = reduceLegacyUnifiedVerdict({
      ...base,
      checkCount: 33,
      checkDataMigrated: true,
    });
    check(
      "이관 후(check=33>=30) → verdict pass",
      afterPass.status === "pass" && afterPass.checkGate?.passed === true,
    );
    // 강화 실패(rating 2)는 게이트와 무관하게 fail + 슬롯도 fail
    const ratingFail = reduceLegacyUnifiedVerdict({
      ...base,
      rating: 2,
      checkCount: 40,
      checkDataMigrated: true,
    });
    check(
      "평점 2 → 강화 실패 + 주차 실패 (게이트 미평가)",
      ratingFail.status === "fail" && ratingFail.checkGate == null,
    );

    // ── 시나리오 1: 일부 사용자만 이관 — 행 단위 플래그라 사용자별 독립 ──
    //   (위 미이관/이관 케이스가 곧 사용자 A/B — 추가 단언 불필요하나 명시적으로 기록)
    check(
      "시나리오1(일부 사용자만 이관): 이관 사용자만 enforce, 미이관 사용자 보존",
      before.status === "pass" && afterFail.status === "fail",
    );
    // ── 시나리오 2: 일부 시즌만 이관 — 같은 사용자라도 주차(행) 단위로 분리 ──
    const springMigrated = reduceLegacyUnifiedVerdict({
      ...base,
      checkCount: 12, // 이관된 봄 주차 — 실값 12 < 30 → fail
      checkDataMigrated: true,
    });
    const autumnNotMigrated = reduceLegacyUnifiedVerdict({
      ...base,
      checkCount: 3, // 미이관 가을 주차 — 잔존값 → 보존
      checkDataMigrated: false,
    });
    check(
      "시나리오2(일부 시즌만 이관): 이관 주차 fail / 같은 사용자의 미이관 주차 보존",
      springMigrated.status === "fail" && autumnNotMigrated.status === "pass",
      `spring=${springMigrated.status} autumn=${autumnNotMigrated.status}`,
    );
    // ── 시나리오 3: 분포가 예상보다 낮아도 — 플래그는 크기와 무관 ──
    const lowMigrated = reduceLegacyUnifiedVerdict({
      ...base,
      checkCount: 3, // 이관됐지만 실제로 3개뿐 → 정책대로 fail
      checkDataMigrated: true,
    });
    check(
      "시나리오3(저분포 이관): check=3 이라도 flag=true 면 정책대로 fail (크기 추론 없음)",
      lowMigrated.status === "fail" && lowMigrated.checkGate?.enforced === true,
      JSON.stringify(lowMigrated.checkGate),
    );
  }

  console.log(`\n결과: ✅ ${pass} / ❌ ${fail}`);
  if (fail > 0) process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
