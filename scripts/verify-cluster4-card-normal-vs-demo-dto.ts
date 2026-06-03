/**
 * cluster-4 주차 카드 DTO: 일반 모드 ↔ demoUserId 모드 동일성 검증.
 *
 *   USER_ID=<uuid> BASE_URL=http://localhost:3000 \
 *     npx tsx --env-file=.env.local scripts/verify-cluster4-card-normal-vs-demo-dto.ts
 *   npx tsx --env-file=.env.local scripts/verify-cluster4-card-normal-vs-demo-dto.ts <uuid>
 *
 * 비교 축:
 *   - direct function (readWeeklyCardsSnapshot = 라우트가 쓰는 snapshot-only 로더)
 *   - HTTP 일반 모드  (GET /api/cluster4/weekly-cards?userId=X + x-internal-api-key)
 *   - HTTP 데모 모드  (GET /api/cluster4/weekly-cards?demoUserId=X)
 *
 * 검증 명제:
 *   direct == HTTP(일반)   — snapshot-only 라우트가 direct 와 동일 payload 인지
 *   HTTP(일반) == HTTP(데모) — demoUserId 가 "조회 대상 override" 일 뿐 DTO 경로 동일인지
 *
 * READ-ONLY. DB 변경 없음.
 */
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import {
  readWeeklyCardsSnapshot,
  WEEKLY_CARDS_DTO_VERSION,
} from "@/lib/cluster4WeeklyCardsSnapshot";
import type { Cluster4WeeklyCardDto } from "@/shared/cluster4.contracts";

function resolveUserId(): string {
  const id = (process.env.USER_ID ?? "").trim() || (process.argv[2] ?? "").trim();
  if (!id) throw new Error("USER_ID 미지정 (env 또는 첫 인자).");
  return id;
}

type CardArr = Cluster4WeeklyCardDto[];

// 카드 배열에서 요약 지표 추출.
function summarize(cards: CardArr) {
  const weekCount = cards.length;
  // getCluster4WeeklyCardsForProfileUser = 최신순 → cards[0]=최신.
  const newest = cards[0] ?? null;
  const oldest = cards[weekCount - 1] ?? null;
  let sumShield = 0,
    sumLightning = 0;
  for (const c of cards) {
    sumShield += c.points?.shield ?? 0;
    sumLightning += c.points?.lightning ?? 0;
  }
  return {
    weekCount,
    firstWeekId: oldest?.weekId ?? null, // 가장 과거
    lastWeekId: newest?.weekId ?? null, // 가장 최신
    cumulativeInjeolmi: newest?.cumulativeInjeolmi ?? null,
    netShield: sumShield - Math.abs(sumLightning), // Σshield - |Σlightning|
    fameScore: newest?.fameScore ?? null,
  };
}

// 첫 불일치 지점 탐색(deep). 동일하면 null.
function firstDiff(a: unknown, b: unknown, path = "$"): string | null {
  if (JSON.stringify(a) === JSON.stringify(b)) return null;
  if (
    typeof a !== "object" ||
    typeof b !== "object" ||
    a === null ||
    b === null
  ) {
    return `${path}: ${JSON.stringify(a)} ≠ ${JSON.stringify(b)}`;
  }
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b))
      return `${path}: array/object mismatch`;
    if (a.length !== b.length)
      return `${path}: length ${a.length} ≠ ${b.length}`;
    for (let i = 0; i < a.length; i++) {
      const d = firstDiff(a[i], b[i], `${path}[${i}]`);
      if (d) return d;
    }
    return null;
  }
  const keys = new Set([
    ...Object.keys(a as object),
    ...Object.keys(b as object),
  ]);
  for (const k of keys) {
    const d = firstDiff(
      (a as Record<string, unknown>)[k],
      (b as Record<string, unknown>)[k],
      `${path}.${k}`,
    );
    if (d) return d;
  }
  return null;
}

async function httpCards(
  baseUrl: string,
  query: string,
  headers: Record<string, string>,
): Promise<{ ok: boolean; status: number; cards: CardArr; raw: unknown; err?: string }> {
  const url = `${baseUrl}/api/cluster4/weekly-cards?${query}`;
  try {
    const res = await fetch(url, { headers });
    const json = (await res.json()) as {
      success?: boolean;
      data?: CardArr;
      error?: unknown;
    };
    return {
      ok: res.ok && json.success === true,
      status: res.status,
      cards: Array.isArray(json.data) ? json.data : [],
      raw: json,
      err: json.success ? undefined : JSON.stringify(json.error),
    };
  } catch (e) {
    return { ok: false, status: 0, cards: [], raw: null, err: (e as Error).message };
  }
}

async function main() {
  const userId = resolveUserId();
  const baseUrl = (process.env.BASE_URL ?? "http://localhost:3000").replace(/\/$/, "");
  const internalKey = process.env.INTERNAL_API_KEY ?? "";

  // ── snapshot 식별자 (원본 row) ──
  const { data: snapRow } = await supabaseAdmin
    .from("cluster4_weekly_card_snapshots")
    .select("user_id,dto_version,is_stale,computed_at,card_count,updated_at")
    .eq("user_id", userId)
    .maybeSingle();
  const snap = (snapRow ?? null) as {
    user_id: string;
    dto_version: number;
    is_stale: boolean;
    computed_at: string;
    card_count: number;
    updated_at?: string;
  } | null;

  // ── direct function (snapshot-only 로더) ──
  const direct = await readWeeklyCardsSnapshot(userId);
  const directCards: CardArr =
    direct.status === "hit" || direct.status === "stale" ? direct.cards : [];
  const snapStale =
    direct.status === "stale"
      ? direct.reason
      : direct.status === "miss"
        ? "miss"
        : direct.status === "error"
          ? "error"
          : "fresh";

  // ── HTTP 일반 모드 (internal key = 세션 normal 과 동일 downstream) ──
  const normal = await httpCards(
    baseUrl,
    `userId=${encodeURIComponent(userId)}`,
    internalKey ? { "x-internal-api-key": internalKey } : {},
  );

  // ── HTTP 데모 모드 (demoUserId) ──
  const demo = await httpCards(
    baseUrl,
    `demoUserId=${encodeURIComponent(userId)}`,
    {},
  );

  // ── 비교 ──
  const directVsNormal = firstDiff(directCards, normal.cards);
  const normalVsDemo = firstDiff(normal.cards, demo.cards);

  // ── 요약 테이블 ──
  const rows = [
    {
      source: "direct(snapshot)",
      user_id: userId,
      mode: "—",
      snapshot_ref: snap ? `${snap.computed_at} v${snap.dto_version}` : "(no row)",
      ...summarize(directCards),
      "direct==HTTP": "—",
      "normal==demo": "—",
      stale: snapStale,
    },
    {
      source: "HTTP normal",
      user_id: userId,
      mode: "normal(userId)",
      snapshot_ref: snap ? `${snap.computed_at} v${snap.dto_version}` : "(no row)",
      ...summarize(normal.cards),
      "direct==HTTP": normal.ok ? (directVsNormal === null ? "✅" : "❌") : `HTTP ${normal.status}`,
      "normal==demo": "—",
      stale: snapStale,
    },
    {
      source: "HTTP demo",
      user_id: userId,
      mode: "demoUserId",
      snapshot_ref: snap ? `${snap.computed_at} v${snap.dto_version}` : "(no row)",
      ...summarize(demo.cards),
      "direct==HTTP": "—",
      "normal==demo": demo.ok ? (normalVsDemo === null ? "✅" : "❌") : `HTTP ${demo.status}`,
      stale: snapStale,
    },
  ];

  console.log(`\n════════ cluster-4 주차 카드 DTO 검증 (BASE_URL=${baseUrl}) ════════`);
  console.log(
    `현재 DTO_VERSION=${WEEKLY_CARDS_DTO_VERSION}` +
      (snap
        ? ` | snapshot: user=${snap.user_id} v${snap.dto_version} is_stale=${snap.is_stale} computed_at=${snap.computed_at} card_count=${snap.card_count}`
        : " | snapshot row 없음(miss)"),
  );
  console.table(rows);

  if (!normal.ok) console.log(`  ⚠ HTTP 일반 응답 실패: status=${normal.status} err=${normal.err}`);
  if (!demo.ok) console.log(`  ⚠ HTTP 데모 응답 실패: status=${demo.status} err=${demo.err}`);

  // ── mismatch JSON diff ──
  console.log("\n──────── 비교 결과 ────────");
  console.log(`  direct == HTTP(일반): ${normal.ok ? (directVsNormal === null ? "✅ 완전 일치" : "❌ 불일치") : "검사불가(HTTP실패)"}`);
  if (directVsNormal) console.log(`     첫 차이: ${directVsNormal}`);
  console.log(`  HTTP(일반) == HTTP(데모): ${normal.ok && demo.ok ? (normalVsDemo === null ? "✅ 완전 일치" : "❌ 불일치") : "검사불가(HTTP실패)"}`);
  if (normalVsDemo) console.log(`     첫 차이: ${normalVsDemo}`);

  // ── 판정 ──
  const allOk =
    normal.ok && demo.ok && directVsNormal === null && normalVsDemo === null;
  console.log("\n──────── 판정 ────────");
  if (snapStale !== "fresh" && snapStale !== "miss") {
    console.log(`  ⚠ snapshot stale (reason=${snapStale}) — 표시값이 최신 정책과 다를 수 있음. 재계산 권장.`);
  } else if (snapStale === "miss") {
    console.log("  ⚠ snapshot 행 없음(miss) — cron/백필 또는 recompute 필요.");
  } else {
    console.log("  snapshot fresh.");
  }
  console.log(
    allOk
      ? "  ✅ 일반/데모 모드가 동일 snapshot DTO 를 반환(완전 일치). demoUserId 는 조회 대상 override 로만 작동."
      : "  ❌ 불일치 발견 — 위 첫 차이 참조.",
  );
  console.log("\n[done] READ-ONLY. DB 변경 없음.\n");

  process.exitCode = allOk ? 0 : 1;
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
