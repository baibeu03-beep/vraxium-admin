/**
 * READ-ONLY 검증: 4허브 지표의 direct(실시간 계산) vs HTTP(snapshot 저장본) 일치 확인.
 *
 *   npx tsx --env-file=.env.local scripts/diag-metrics-direct-vs-snapshot.mjs [sampleN]
 *
 * - HTTP GET /api/cluster4/weekly-cards 는 snapshot-only(저장본 그대로 반환)이므로
 *   "저장 snapshot.cards" == "HTTP 응답" 이다. 따라서 direct 계산 vs snapshot 비교가
 *   곧 direct vs HTTP 비교다(서버 없이 검증 가능).
 * - 쓰기/recompute 없음. 순수 읽기 + 비교만.
 */
import { createClient } from "@supabase/supabase-js";
import { getCluster4WeeklyCardsForProfileUser } from "@/lib/cluster4WeeklyCardsData";
import { WEEKLY_CARDS_DTO_VERSION } from "@/lib/cluster4WeeklyCardsSnapshot";

const sb = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY,
);

const SAMPLE_N = Number(process.argv[2] ?? "6");

function pad(s, n) {
  s = String(s);
  return s.length >= n ? s : s + " ".repeat(n - s.length);
}

// ── 1. 전수 staleness 스캔 ──
async function scanStaleness() {
  const { data, error } = await sb
    .from("cluster4_weekly_card_snapshots")
    .select("user_id,dto_version,is_stale,computed_at,card_count");
  if (error) {
    console.log("스냅샷 스캔 실패:", error.message);
    return [];
  }
  const rows = data ?? [];
  const byVer = {};
  let staleTrue = 0;
  let verMismatch = 0;
  let epochQueued = 0;
  for (const r of rows) {
    byVer[r.dto_version] = (byVer[r.dto_version] ?? 0) + 1;
    if (r.is_stale) staleTrue++;
    if (r.dto_version !== WEEKLY_CARDS_DTO_VERSION) verMismatch++;
    if (r.computed_at && new Date(r.computed_at).getTime() === 0) epochQueued++;
  }
  console.log("══════════ 1. 스냅샷 staleness 전수 스캔 ══════════");
  console.log(`현재 코드 DTO_VERSION = ${WEEKLY_CARDS_DTO_VERSION}`);
  console.log(`총 snapshot 행: ${rows.length}`);
  console.log(`dto_version 분포: ${JSON.stringify(byVer)}`);
  console.log(`is_stale=true: ${staleTrue}`);
  console.log(`dto_version != ${WEEKLY_CARDS_DTO_VERSION} (버전 stale): ${verMismatch}`);
  console.log(`computed_at=epoch (cron 큐 placeholder): ${epochQueued}`);
  const staleClass = (r) =>
    r.dto_version !== WEEKLY_CARDS_DTO_VERSION
      ? "version_mismatch"
      : r.is_stale
        ? "is_stale"
        : "hit";
  return rows.map((r) => ({ ...r, _class: staleClass(r) }));
}

// ── 2. 표본 사용자: 라인 타깃이 있는(=카드 비자명) 유저 우선 ──
async function pickUsers(rows) {
  // 라인 타깃 보유 유저
  const { data: tgts } = await sb
    .from("cluster4_line_targets")
    .select("target_user_id")
    .eq("target_mode", "user")
    .not("target_user_id", "is", null)
    .limit(2000);
  // 타깃 수 기준 내림차순 — 타깃 많은 유저가 denominator>0(성장칸) 가질 확률 높음.
  const cnt = new Map();
  for (const t of tgts ?? []) {
    const u = t.target_user_id;
    if (!u) continue;
    cnt.set(u, (cnt.get(u) ?? 0) + 1);
  }
  const snapUsers = new Set(rows.map((r) => r.user_id));
  const preferred = [...cnt.entries()]
    .filter(([u]) => snapUsers.has(u))
    .sort((a, b) => b[1] - a[1])
    .map(([u]) => u);
  const fallback = rows.map((r) => r.user_id);
  const ordered = [...new Set([...preferred, ...fallback])];
  return ordered.slice(0, SAMPLE_N);
}

function lineKey(l) {
  // 같은 라인 칸 매칭용 키. lineTargetId 우선, 없으면 lineId+partType.
  return `${l.partType}|${l.lineTargetId ?? l.lineId ?? "null"}`;
}

function metricEq(a, b) {
  return a === b || (a == null && b == null);
}

async function fetchStoredCards(userId) {
  const { data } = await sb
    .from("cluster4_weekly_card_snapshots")
    .select("cards")
    .eq("user_id", userId)
    .maybeSingle();
  return Array.isArray(data?.cards) ? data.cards : [];
}

async function compareUser(userId, snapRow) {
  const stored = await fetchStoredCards(userId);
  let direct;
  try {
    direct = await getCluster4WeeklyCardsForProfileUser(userId);
  } catch (e) {
    return { userId, error: e?.message ?? String(e) };
  }
  const storedByWeek = new Map(stored.map((c) => [c.weekId, c]));
  const directByWeek = new Map(direct.map((c) => [c.weekId, c]));
  const allWeeks = new Set([...storedByWeek.keys(), ...directByWeek.keys()]);

  let weekDiffs = 0;
  let lineDiffs = 0;
  const examples = [];

  for (const wk of allWeeks) {
    const s = storedByWeek.get(wk);
    const d = directByWeek.get(wk);
    if (!s || !d) {
      weekDiffs++;
      if (examples.length < 8)
        examples.push(
          `week=${String(wk).slice(0, 8)} 존재불일치 stored=${!!s} direct=${!!d}`,
        );
      continue;
    }
    // 주차 성장률 3필드
    if (
      !metricEq(s.weeklyGrowthRate, d.weeklyGrowthRate) ||
      !metricEq(s.growthNumerator, d.growthNumerator) ||
      !metricEq(s.growthDenominator, d.growthDenominator)
    ) {
      weekDiffs++;
      if (examples.length < 8)
        examples.push(
          `week=${String(wk).slice(0, 8)} 주차성장률 stored=${s.growthNumerator}/${s.growthDenominator}(${s.weeklyGrowthRate}%) direct=${d.growthNumerator}/${d.growthDenominator}(${d.weeklyGrowthRate}%)`,
        );
    }
    // 라인별 numerator/denominator/rate/status/enhancementStatus
    const sLines = new Map((s.lines ?? []).map((l) => [lineKey(l), l]));
    const dLines = new Map((d.lines ?? []).map((l) => [lineKey(l), l]));
    const keys = new Set([...sLines.keys(), ...dLines.keys()]);
    for (const k of keys) {
      const sl = sLines.get(k);
      const dl = dLines.get(k);
      if (!sl || !dl) {
        lineDiffs++;
        if (examples.length < 8)
          examples.push(
            `week=${String(wk).slice(0, 8)} line=${k} 칸존재불일치 stored=${!!sl} direct=${!!dl}`,
          );
        continue;
      }
      if (
        !metricEq(sl.numerator, dl.numerator) ||
        !metricEq(sl.denominator, dl.denominator) ||
        !metricEq(sl.rate, dl.rate) ||
        sl.status !== dl.status ||
        sl.enhancementStatus !== dl.enhancementStatus
      ) {
        lineDiffs++;
        if (examples.length < 8)
          examples.push(
            `week=${String(wk).slice(0, 8)} line=${k} stored[${sl.numerator}/${sl.denominator} ${sl.status}/${sl.enhancementStatus}] direct[${dl.numerator}/${dl.denominator} ${dl.status}/${dl.enhancementStatus}]`,
          );
      }
    }
  }

  // resume practicalStats 교차검증: direct 카드의 비휴식 주차 hub success 합산
  // (computePracticalStats 와 동일 success 맵 기반 → 합이 일치해야 함)
  const hubSum = { info: 0, ability: 0, experience: 0, career: 0 };
  for (const c of direct) {
    if (c.isRestWeek) continue;
    const lb = c.lineBreakdown;
    if (!lb) continue;
    hubSum.info += lb.info?.completed ?? 0;
    hubSum.ability += lb.ability?.completed ?? 0;
    hubSum.experience += lb.experience?.completed ?? 0;
    hubSum.career += lb.career?.completed ?? 0;
  }

  return {
    userId,
    snapClass: snapRow?._class,
    snapVer: snapRow?.dto_version,
    isStale: snapRow?.is_stale,
    storedWeeks: stored.length,
    directWeeks: direct.length,
    weekDiffs,
    lineDiffs,
    hubSum,
    examples,
  };
}

async function main() {
  const rows = await scanStaleness();
  const rowByUser = new Map(rows.map((r) => [r.user_id, r]));
  const users = await pickUsers(rows);

  console.log(
    `\n══════════ 2. direct vs snapshot(=HTTP) 비교 (표본 ${users.length}명) ══════════`,
  );
  console.log(
    `${pad("user", 10)} ${pad("snapClass", 17)} ${pad("ver", 4)} ${pad("stored/direct주", 14)} ${pad("주차diff", 8)} ${pad("라인diff", 8)}`,
  );

  let totalWeekDiffs = 0;
  let totalLineDiffs = 0;
  const detailDump = [];

  for (const u of users) {
    const res = await compareUser(u, rowByUser.get(u));
    if (res.error) {
      console.log(`${pad(u.slice(0, 8), 10)} ERROR: ${res.error}`);
      continue;
    }
    totalWeekDiffs += res.weekDiffs;
    totalLineDiffs += res.lineDiffs;
    console.log(
      `${pad(u.slice(0, 8), 10)} ${pad(res.snapClass, 17)} ${pad(res.snapVer, 4)} ${pad(res.storedWeeks + "/" + res.directWeeks, 14)} ${pad(res.weekDiffs, 8)} ${pad(res.lineDiffs, 8)}`,
    );
    if (res.weekDiffs > 0 || res.lineDiffs > 0) {
      detailDump.push({ u, res });
    }
  }

  console.log(`\n총 주차 불일치: ${totalWeekDiffs} / 총 라인 불일치: ${totalLineDiffs}`);

  if (detailDump.length) {
    console.log("\n── 불일치 상세 (direct≠snapshot = stale 신호) ──");
    for (const { u, res } of detailDump) {
      console.log(`\n[user ${u.slice(0, 8)}] class=${res.snapClass} ver=${res.snapVer} isStale=${res.isStale}`);
      for (const e of res.examples) console.log("  " + e);
    }
  } else {
    console.log("\n표본 전원 direct == snapshot — 표본 한정 stale 없음.");
  }

  // ── 3. 구체 워크드 예시: denominator>0 인 실제 주차의 허브 분해 + 산술 검증 ──
  console.log("\n══════════ 3. 구체 예시 (denominator>0 실제 주차) ══════════");
  let shown = 0;
  for (const u of users) {
    if (shown >= 3) break;
    const stored = await fetchStoredCards(u);
    const card = stored.find((c) => (c.growthDenominator ?? 0) > 0);
    if (!card) continue;
    shown++;
    const lb = card.lineBreakdown ?? {};
    const fmt = (b) =>
      b ? `${b.completed}/${b.available}` : "없음";
    const sumC =
      (lb.info?.completed ?? 0) +
      (lb.ability?.completed ?? 0) +
      (lb.experience?.completed ?? 0) +
      (lb.career?.completed ?? 0);
    const sumA =
      (lb.info?.available ?? 0) +
      (lb.ability?.available ?? 0) +
      (lb.experience?.available ?? 0) +
      (lb.career?.available ?? 0);
    const expectRate =
      sumA === 0 ? 0 : Math.round((sumC / sumA) * 100);
    console.log(
      `\n[user ${u.slice(0, 8)}] week=${String(card.weekId).slice(0, 8)} (${card.weekLabel ?? ""})`,
    );
    console.log(
      `  정보 ${fmt(lb.info)} · 경험 ${fmt(lb.experience)} · 역량(ability) ${fmt(lb.ability)} · 경력 ${fmt(lb.career)}`,
    );
    console.log(
      `  주차 합계: completed=${sumC} available=${sumA} → growth=${card.growthNumerator}/${card.growthDenominator} rate=${card.weeklyGrowthRate}%`,
    );
    console.log(
      `  산술검증: 합계==DTO누적? ${sumC === card.growthNumerator && sumA === card.growthDenominator} | rate==Math.round? ${expectRate === card.weeklyGrowthRate} (기대 ${expectRate}%)`,
    );
    // per-line numerator/denominator/rate 가 허브 분해와 일치하는지(같은 part 라인들)
    for (const part of ["information", "experience", "competency", "career"]) {
      const lines = (card.lines ?? []).filter((l) => l.partType === part);
      if (lines.length === 0) continue;
      const dline = lines.find((l) => l.denominator != null) ?? lines[0];
      console.log(
        `    [${part}] 칸수=${lines.length} 대표 numerator/denominator/rate=${dline.numerator}/${dline.denominator}/${dline.rate}`,
      );
    }
  }
  if (shown === 0)
    console.log("표본 중 denominator>0 인 주차 없음 — 별도 유저 필요.");

  console.log("\n── resume practicalStats 교차검증(표본): direct 카드 hub success 합산 ──");
  console.log("(이력서 카드는 live 계산 → HTTP==direct. 아래 합이 4개 숫자의 근거)");
  for (const u of users.slice(0, 3)) {
    const res = await compareUser(u, rowByUser.get(u));
    if (res.error) continue;
    console.log(
      `  user=${u.slice(0, 8)} 정보습득=${res.hubSum.info} 경험축적=${res.hubSum.experience} 역량성장=${res.hubSum.ability} 경력누적=${res.hubSum.career}`,
    );
  }

  console.log("\n══ 종료 (읽기 전용, 변경/recompute 없음) ══");
}

main().catch((e) => {
  console.error("fatal", e);
  process.exit(1);
});
