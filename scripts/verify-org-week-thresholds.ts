/**
 * org_week_thresholds 적용 검증 (2026-06-07 B안).
 *
 *   npx tsx --env-file=.env.local scripts/verify-org-week-thresholds.ts
 *     [--http http://localhost:3000]  # HTTP/snapshot/demo 동일성까지
 *     [--skip-probe]                  # org 격리 probe(임시 행 insert/delete) 생략
 *     [--limit N]                     # flip-0 모집단 상한 (기본 전수)
 *
 * 검증 항목:
 *   [1] 테이블 존재 (DDL 적용 여부)
 *   [2] ORANKE seed 불변식: weeks.check_threshold NOT NULL ⟺ oranke org 행 존재+값 동일
 *   [3] ORANKE flip 0: checks_migrated=true 행 보유 사용자 전수 —
 *       공통 폴백(organizationSlug:null = 구 동작) vs 실제 org 해석(신 동작)의
 *       checkThreshold·verdict.status 전수 diff = 0
 *   [4] org 격리 probe: encre 임시 행(값+7) → encre 는 자기 행 / phalanx(행 없음) 는
 *       weeks 폴백 / oranke 는 seed 값. probe 행은 finally 에서 삭제.
 *       (phalanx 폴백 = 현재 weeks 값(ORANKE 달력) — hrdb/olympus **threshold 백필이
 *        사용자 이관보다 먼저**여야 하는 근거를 실측으로 남긴다.)
 *   [5] --http: direct(실시간 계산) vs HTTP weekly-cards(snapshot-only) checkGate 동일성
 *   [6] --http: demoUserId 경로 vs internal-key 경로 cards 완전 동일성 (DTO 계약 동일)
 *
 * write 범위: probe 행(org_week_thresholds, source_table='verify-probe') insert→delete 만.
 *   uws/user_weekly_points/weeks/snapshot write 0.
 */
import { config } from "dotenv";
config({ path: ".env.local" });

import { writeFileSync } from "fs";
import { createClient } from "@supabase/supabase-js";
import {
  CLUSTER4_SLOT_POLICY_EFFECTIVE_FROM,
  fetchLegacyUnifiedExperienceByWeek,
  reduceLegacyUnifiedVerdict,
} from "@/lib/lineAvailability";
import { getCluster4WeeklyCardsForProfileUser } from "@/lib/cluster4WeeklyCardsData";
import type { OrganizationSlug } from "@/lib/organizations";

const sb = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
);

const httpIdx = process.argv.indexOf("--http");
const HTTP_BASE = httpIdx >= 0 ? process.argv[httpIdx + 1] : null;
const SKIP_PROBE = process.argv.includes("--skip-probe");
const limitIdx = process.argv.indexOf("--limit");
const LIMIT = limitIdx >= 0 ? Number(process.argv[limitIdx + 1]) : Infinity;
const OUT = "claudedocs/org-week-thresholds-verify-20260607.json";

let pass = 0;
let fail = 0;
const results: Array<{ name: string; ok: boolean; detail?: string }> = [];
function check(name: string, ok: boolean, detail?: string) {
  results.push({ name, ok, detail });
  if (ok) pass++;
  else fail++;
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? ` — ${detail}` : ""}`);
}

type WeekRow = { id: string; start_date: string | null; check_threshold: number | null };

async function fetchAllWeeks(): Promise<WeekRow[]> {
  const out: WeekRow[] = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await sb
      .from("weeks")
      .select("id,start_date,check_threshold")
      .order("id", { ascending: true })
      .range(from, from + 999);
    if (error) throw new Error(error.message);
    out.push(...((data ?? []) as WeekRow[]));
    if ((data ?? []).length < 1000) break;
  }
  return out;
}

async function fetchEnforcedUserIds(): Promise<string[]> {
  const ids = new Set<string>();
  for (let from = 0; ; from += 1000) {
    const { data, error } = await sb
      .from("user_weekly_points")
      .select("user_id")
      .eq("checks_migrated", true)
      .order("id", { ascending: true })
      .range(from, from + 999);
    if (error) throw new Error(error.message);
    for (const r of (data ?? []) as { user_id: string }[]) ids.add(r.user_id);
    if ((data ?? []).length < 1000) break;
  }
  return [...ids];
}

async function fetchOrgSlug(userId: string): Promise<OrganizationSlug | null> {
  const { data } = await sb
    .from("user_profiles")
    .select("organization_slug")
    .eq("user_id", userId)
    .maybeSingle();
  const s = (data as { organization_slug: string | null } | null)?.organization_slug;
  return s === "encre" || s === "oranke" || s === "phalanx" ? s : null;
}

async function httpCards(query: string): Promise<unknown[]> {
  const res = await fetch(`${HTTP_BASE}/api/cluster4/weekly-cards?${query}`, {
    headers: { "x-internal-api-key": process.env.INTERNAL_API_KEY ?? "" },
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} (${query})`);
  // 응답 계약: { success, data: Cluster4WeeklyCardDto[] } — data 가 곧 카드 배열.
  const json = (await res.json()) as { data?: unknown };
  const d = json.data;
  return Array.isArray(d) ? d : ((d as { cards?: unknown[] } | null)?.cards ?? []);
}

async function main() {
  // ── [1] 테이블 존재 ──
  {
    const { error } = await sb.from("org_week_thresholds").select("week_id").limit(1);
    check("[1] org_week_thresholds 테이블 존재", !error, error?.message);
    if (error) finish();
  }

  // ── [2] seed 불변식 ──
  const weeks = await fetchAllWeeks();
  const weeksWithThr = weeks.filter((w) => w.check_threshold != null);
  {
    const { data, error } = await sb
      .from("org_week_thresholds")
      .select("week_id,check_threshold,source_table")
      .eq("organization_slug", "oranke")
      .order("week_id", { ascending: true })
      .range(0, 4999);
    if (error) throw new Error(error.message);
    const orgRows = new Map(
      ((data ?? []) as { week_id: string; check_threshold: number }[]).map((r) => [
        r.week_id,
        r.check_threshold,
      ]),
    );
    const missing = weeksWithThr.filter((w) => !orgRows.has(w.id));
    const mismatched = weeksWithThr.filter(
      (w) => orgRows.has(w.id) && orgRows.get(w.id) !== w.check_threshold,
    );
    const thrIds = new Set(weeksWithThr.map((w) => w.id));
    const extra = [...orgRows.keys()].filter((id) => !thrIds.has(id));
    check(
      "[2] oranke seed = weeks.check_threshold 전수 일치",
      missing.length === 0 && mismatched.length === 0 && extra.length === 0,
      `weeks(thr)=${weeksWithThr.length} orgRows=${orgRows.size} missing=${missing.length} mismatch=${mismatched.length} extra=${extra.length}`,
    );
  }

  // ── [3] ORANKE flip 0 (enforced 모집단 전수 — checks_migrated 플래그 직독만) ──
  const legacyWeekIds = weeks
    .filter((w) => w.start_date && w.start_date < CLUSTER4_SLOT_POLICY_EFFECTIVE_FROM)
    .map((w) => w.id);
  const enforcedUsers = (await fetchEnforcedUserIds()).slice(
    0,
    Number.isFinite(LIMIT) ? LIMIT : undefined,
  );
  //   기대값 (hrdb/olympus 백필 후 정책-정합):
  //     - oranke org 사용자: flip 0 필수 (oranke 행 = weeks 값 복사 — 불변).
  //     - encre/phalanx org 사용자: 자기 org 행을 읽으므로 공통 폴백 대비 변화가 "의도된 효과".
  //       변화량은 정보성으로 집계만 한다 (백필 전에는 행이 없어 0 이었다).
  {
    const now = Date.now();
    let usersChecked = 0;
    let weeksCompared = 0;
    const byOrg = new Map<string, { users: number; thresholdDiffs: number; verdictFlips: number }>();
    const stat = (org: string) => {
      let s = byOrg.get(org);
      if (!s) {
        s = { users: 0, thresholdDiffs: 0, verdictFlips: 0 };
        byOrg.set(org, s);
      }
      return s;
    };
    const orankeFlipDetails: string[] = [];
    for (const uid of enforcedUsers) {
      const orgSlug = await fetchOrgSlug(uid);
      const s = stat(orgSlug ?? "null");
      s.users++;
      const [commonStates, orgStates] = await Promise.all([
        // 공통 폴백 강제 = org 오버라이드 도입 전(구) 동작 재현
        fetchLegacyUnifiedExperienceByWeek(uid, legacyWeekIds, now, { organizationSlug: null }),
        // 신 동작: 실제 org 해석 (null 사용자면 동일 경로)
        fetchLegacyUnifiedExperienceByWeek(uid, legacyWeekIds, now, { organizationSlug: orgSlug }),
      ]);
      for (const [weekId, oldState] of commonStates) {
        const newState = orgStates.get(weekId);
        if (!newState) continue;
        weeksCompared++;
        if (oldState.checkThreshold !== newState.checkThreshold) s.thresholdDiffs++;
        const oldV = reduceLegacyUnifiedVerdict(oldState).status;
        const newV = reduceLegacyUnifiedVerdict(newState).status;
        if (oldV !== newV) {
          s.verdictFlips++;
          if ((orgSlug ?? "null") === "oranke" && orankeFlipDetails.length < 20)
            orankeFlipDetails.push(`${uid} ${weekId}: ${oldV}→${newV}`);
        }
      }
      usersChecked++;
      if (usersChecked % 25 === 0)
        console.log(`  …flip 비교 진행 ${usersChecked}/${enforcedUsers.length}`);
    }
    const o = byOrg.get("oranke") ?? { users: 0, thresholdDiffs: 0, verdictFlips: 0 };
    const n = byOrg.get("null") ?? { users: 0, thresholdDiffs: 0, verdictFlips: 0 };
    check(
      "[3a] oranke org 사용자 flip 0건 (필수)",
      o.verdictFlips === 0 && o.thresholdDiffs === 0 && n.verdictFlips === 0,
      `oranke users=${o.users} thresholdDiffs=${o.thresholdDiffs} flips=${o.verdictFlips}${orankeFlipDetails.length ? " | " + orankeFlipDetails.join(" ; ") : ""}`,
    );
    const e = byOrg.get("encre") ?? { users: 0, thresholdDiffs: 0, verdictFlips: 0 };
    const p = byOrg.get("phalanx") ?? { users: 0, thresholdDiffs: 0, verdictFlips: 0 };
    console.log(
      `INFO [3b] encre/phalanx org 변화 (정책상 의도 — 자기 org 행 적용): ` +
        `encre users=${e.users} thrDiffs=${e.thresholdDiffs} flips=${e.verdictFlips} | ` +
        `phalanx users=${p.users} thrDiffs=${p.thresholdDiffs} flips=${p.verdictFlips} | weeksCompared=${weeksCompared}`,
    );
    results.push({
      name: "[3b] encre/phalanx 변화량 (정보성)",
      ok: true,
      detail: `encre flips=${e.verdictFlips} phalanx flips=${p.verdictFlips} (백필 전 0 — org 행 적용 효과)`,
    });
  }

  // ── [4] org 격리 probe ──
  //   ⚠ hrdb/olympus 백필 후에는 실제 encre 행이 존재할 수 있다 — upsert probe 가 실행 전에
  //   기존 encre 행이 "없는" 주차만 고른다 (실데이터 덮어쓰기 방지, fail-safe).
  if (!SKIP_PROBE) {
    const { data: encreRows } = await sb
      .from("org_week_thresholds")
      .select("week_id")
      .eq("organization_slug", "encre")
      .order("week_id", { ascending: true })
      .range(0, 4999);
    const encreWeekIds = new Set(
      ((encreRows ?? []) as { week_id: string }[]).map((r) => r.week_id),
    );
    const probeUser = enforcedUsers[0];
    // probe 주차 = 사용자 상태(state)가 실제로 만들어지는 주차 ∩ encre 행 부재 ∩ thr 보유.
    let probeWeek: WeekRow | undefined;
    if (probeUser) {
      const userStates = await fetchLegacyUnifiedExperienceByWeek(
        probeUser,
        weeksWithThr
          .filter((w) => w.start_date && w.start_date < CLUSTER4_SLOT_POLICY_EFFECTIVE_FROM)
          .map((w) => w.id),
        Date.now(),
        { organizationSlug: null },
      );
      probeWeek = weeksWithThr.find(
        (w) =>
          w.start_date &&
          w.start_date < CLUSTER4_SLOT_POLICY_EFFECTIVE_FROM &&
          !encreWeekIds.has(w.id) &&
          userStates.has(w.id),
      );
    }
    if (!probeWeek || !probeUser) {
      console.log(
        "[4] org 격리 probe skip — 후보 주차 부재(백필 완료 상태에서 정상). 실데이터 resolution 검증은 verify-owt-hrdb-olympus-apply.ts [4] 가 대체.",
      );
    } else {
      const v = probeWeek.check_threshold as number;
      const probeValue = v + 7;
      try {
        const { error: insErr } = await sb.from("org_week_thresholds").upsert(
          {
            week_id: probeWeek.id,
            organization_slug: "encre",
            check_threshold: probeValue,
            source_system: null,
            source_table: "verify-probe",
            source_pk: null,
            inferred: true,
            payload: { note: "verify-org-week-thresholds org 격리 probe — 일시 행" },
          },
          { onConflict: "week_id,organization_slug" },
        );
        if (insErr) throw new Error(`probe insert: ${insErr.message}`);
        const now = Date.now();
        const get = async (slug: OrganizationSlug | null) =>
          (
            await fetchLegacyUnifiedExperienceByWeek(probeUser, [probeWeek.id], now, {
              organizationSlug: slug,
            })
          ).get(probeWeek.id)?.checkThreshold;
        const [encreThr, phalanxThr, orankeThr, commonThr] = [
          await get("encre"),
          await get("phalanx"),
          await get("oranke"),
          await get(null),
        ];
        check(
          "[4a] encre = 자기 org 행 (oranke 값 미경유)",
          encreThr === probeValue,
          `encre=${encreThr} expected=${probeValue}`,
        );
        check(
          "[4b] phalanx(행 없음) = weeks 공통 폴백",
          phalanxThr === v,
          `phalanx=${phalanxThr} weeks=${v} ⚠ 폴백값=B7 ORANKE 달력 — threshold 백필이 사용자 이관보다 선행 필수`,
        );
        check("[4c] oranke = seed 값", orankeThr === v, `oranke=${orankeThr} weeks=${v}`);
        check("[4d] org null = 공통 폴백", commonThr === v, `common=${commonThr}`);
      } finally {
        const { error: delErr } = await sb
          .from("org_week_thresholds")
          .delete()
          .eq("source_table", "verify-probe");
        if (delErr) console.error("probe cleanup 실패 — 수동 삭제 필요:", delErr.message);
        else console.log("  probe 행 정리 완료 (source_table='verify-probe' 삭제)");
      }
    }
  }

  // ── [5][6] HTTP / snapshot / demo 동일성 ──
  //   [5] 는 oranke org 사용자 한정 필수 — encre/phalanx 는 백필 직후 snapshot 이 의도적으로
  //   구값(stale)이므로 direct≠HTTP 가 "예상" 상태다 (재계산 별도 결정 전까지). 정보성 집계만.
  if (HTTP_BASE) {
    const orgCache = new Map<string, OrganizationSlug | null>();
    for (const uid of enforcedUsers) {
      orgCache.set(uid, await fetchOrgSlug(uid));
      if ([...orgCache.values()].filter((o) => o === "oranke").length >= 5) break;
    }
    const sampleUsers = [...orgCache.entries()]
      .filter(([, o]) => o === "oranke")
      .map(([u]) => u)
      .slice(0, 5);
    type GateCard = {
      weekId?: string | null;
      startDate?: string;
      userWeekStatus?: string;
      experienceGrowth?: { checkGate?: unknown } | null;
    };
    const gateView = (cards: unknown[]) =>
      (cards as GateCard[])
        .filter((c) => c.startDate && c.startDate < CLUSTER4_SLOT_POLICY_EFFECTIVE_FROM)
        .map((c) => ({
          startDate: c.startDate,
          userWeekStatus: c.userWeekStatus,
          checkGate: c.experienceGrowth?.checkGate ?? null,
        }));
    // snapshot JSONB 왕복은 객체 키 순서를 보존하지 않는다 — 키 정렬 canonical 직렬화로 비교.
    const canon = (v: unknown): string =>
      JSON.stringify(v, (_k, val) =>
        val && typeof val === "object" && !Array.isArray(val)
          ? Object.fromEntries(Object.entries(val as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : 1)))
          : val,
      );
    let httpOk = true;
    let demoOk = true;
    const diffs: string[] = [];
    for (const uid of sampleUsers) {
      const direct = await getCluster4WeeklyCardsForProfileUser(uid);
      const viaHttp = await httpCards(`userId=${encodeURIComponent(uid)}`);
      const a = canon(gateView(direct as unknown[]));
      const b = canon(gateView(viaHttp));
      if (a !== b) {
        httpOk = false;
        diffs.push(`direct≠HTTP user=${uid}`);
      }
      const viaDemo = await httpCards(`demoUserId=${encodeURIComponent(uid)}`);
      if (canon(viaHttp) !== canon(viaDemo)) {
        demoOk = false;
        diffs.push(`HTTP≠demo user=${uid}`);
      }
    }
    check(
      "[5] direct == HTTP(snapshot) checkGate 동일 (oranke org 한정 — encre/phalanx 는 stale 예상)",
      httpOk,
      diffs.join("; ") || `orankeUsers=${sampleUsers.length}`,
    );
    check("[6] demoUserId == internal-key cards 완전 동일", demoOk, diffs.join("; ") || `users=${sampleUsers.length}`);
    // 정보성: encre/phalanx 테스터 snapshot stale 여부 (의도된 미재계산 상태 확인용)
    const nonOranke = [...orgCache.entries()]
      .filter(([, o]) => o === "encre" || o === "phalanx")
      .map(([u]) => u)
      .slice(0, 2);
    for (const uid of nonOranke) {
      const direct = await getCluster4WeeklyCardsForProfileUser(uid);
      const viaHttp = await httpCards(`userId=${encodeURIComponent(uid)}`);
      const same = canon(gateView(direct as unknown[])) === canon(gateView(viaHttp));
      console.log(
        `INFO [5b] ${orgCache.get(uid)} 테스터 ${uid.slice(0, 8)}… direct==HTTP: ${same} (false = snapshot 구값 stale — 재계산 미실시 의도 상태)`,
      );
    }
  } else {
    console.log("(--http 미지정 — [5][6] HTTP/demo 동일성은 dev 서버에서 별도 실행)");
  }

  finish();
}

function finish(): never {
  const summary = { pass, fail, results };
  writeFileSync(OUT, JSON.stringify(summary, null, 2));
  console.log(`\n결과: PASS ${pass} / FAIL ${fail} → ${OUT}`);
  process.exit(fail > 0 ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
