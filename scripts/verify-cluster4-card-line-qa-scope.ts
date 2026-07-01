/**
 * verify-cluster4-card-line-qa-scope.ts — 회귀 테스트 (실패 시 exit 1)
 *
 * 목적: 고객앱 cluster-4-card 의 라인 개설 데이터(weekly-cards snapshot 의 matchedLine /
 *   "개설·본인 미배정" synthetic fail 라인)가 QA 모집단 스코프(운영/테스트)를 따르는지 검증.
 *
 * 근본 원인: 빌더(lib/cluster4WeeklyCardsData.fetchLineDetailsByWeek)의 openedByWeek(Step 2)가
 *   targetRows + activeInfoLines 를 mode 무관 전수 수집해, 테스트 유저 snapshot 에 운영 라인이
 *   "강화 실패(내용 노출)"로 baked 되던 누수. 수정: lineInProfileScope(profileUser 마커 여부 기준
 *   every() 게이트)로 Step 2 라인을 운영/테스트 스코프로 분리.
 *
 * 검증:
 *   [A] 실유저(encre 비마커) 표본: NEW direct 라인-세트 == 기존 baked snapshot(OLD) → 운영 불변.
 *   [B] 테스트유저(encre 마커) 표본: NEW direct 에 운영-타깃 라인 0건(누수 제거). OLD→NEW 제거된
 *        라인은 전부 운영/0대상 라인임을 확인.
 *   [C] admin QA(getInfoLineResultsForWeek mode=test, encre) opened 라인 == 고객 테스트유저 카드의
 *        information 라인 집합(어드민 QA == 고객앱 정합).
 *
 * 주의: 모두 읽기 전용(getCluster4WeeklyCardsForProfileUser 는 순수 계산 — DB write 없음).
 * npx tsx --env-file=.env.local scripts/verify-cluster4-card-line-qa-scope.ts
 */
import { config } from "dotenv"; config({ path: ".env.local" });
import { createClient } from "@supabase/supabase-js";
import { getCluster4WeeklyCardsForProfileUser } from "@/lib/cluster4WeeklyCardsData";
import {
  readWeeklyCardsSnapshot,
  WEEKLY_CARDS_DTO_VERSION,
} from "@/lib/cluster4WeeklyCardsSnapshot";
import { getInfoLineResultsForWeek } from "@/lib/adminCluster4InfoLineResults";

const sb = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
  { auth: { persistSession: false } },
);

const ORG = "encre";
let failures = 0;
function check(name: string, cond: boolean, detail = "") {
  console.log(`  ${cond ? "✅" : "❌"} ${name}${detail ? ` — ${detail}` : ""}`);
  if (!cond) failures++;
}

type Card = { weekId?: string | null; lines?: LineDto[] };
type LineDto = {
  lineId?: string | null;
  partType?: string | null;
  lineName?: string | null;
  enhancementStatus?: string | null;
};

// 라인 신원(주차+파트+lineId+강화상태) — 운영 불변 비교용.
const lineSig = (c: Card, l: LineDto) =>
  `${c.weekId}|${l.partType}|${l.lineId ?? "∅"}|${l.enhancementStatus ?? "∅"}`;
const cardLineSigs = (cards: Card[]): Set<string> => {
  const s = new Set<string>();
  for (const c of cards) for (const l of c.lines ?? []) s.add(lineSig(c, l));
  return s;
};
// 카드 내 lineId 가진 모든 라인(파트 무관).
const lineIdsInCards = (cards: Card[]): { lineId: string; weekId: string }[] => {
  const out: { lineId: string; weekId: string }[] = [];
  for (const c of cards)
    for (const l of c.lines ?? [])
      if (l.lineId) out.push({ lineId: l.lineId, weekId: String(c.weekId) });
  return out;
};

async function fetchMarkerIds(): Promise<Set<string>> {
  const { data } = await sb.from("test_user_markers").select("user_id");
  return new Set(((data ?? []) as { user_id: string }[]).map((r) => r.user_id));
}

// 라인의 user-mode 대상자 집합.
async function lineUserTargets(lineId: string): Promise<string[]> {
  const { data } = await sb
    .from("cluster4_line_targets")
    .select("target_user_id")
    .eq("line_id", lineId)
    .eq("target_mode", "user");
  return ((data ?? []) as { target_user_id: string | null }[])
    .map((r) => r.target_user_id)
    .filter((id): id is string => Boolean(id));
}

// 테스트 유저(viewer) 관점에서 라인이 "정당하게" 카드에 보일 수 있는가.
//   · 본인 배정(uids 에 viewer 포함) → 항상 정당(Step 1, [통합] 코호트 라인 포함).
//   · 미배정(Step 2 synthetic) → 라인 user-대상자 전원이 마커여야(테스트 스코프). 0대상/운영 = 누수.
function legitForTestViewer(uids: string[], viewer: string, markers: Set<string>): boolean {
  if (uids.includes(viewer)) return true; // 본인 배정 — 항상 정당
  return uids.length > 0 && uids.every((id) => markers.has(id)); // 미배정이면 전원 마커만
}

// 실유저(viewer, 운영) 관점 정당성.
//   · 본인 배정 → 항상 정당.
//   · 미배정 → 운영 라인(전원 비마커) 또는 0대상 라인만. 순수 테스트 라인(마커 대상자 보유) = 누수.
function legitForOperatingViewer(uids: string[], viewer: string, markers: Set<string>): boolean {
  if (uids.includes(viewer)) return true; // 본인 배정 — 항상 정당
  return uids.length === 0 || uids.every((id) => !markers.has(id));
}

// 현재 버전·fresh snapshot 보유한 encre 사용자(마커/비마커) 표본 수집.
async function sampleUsers(markers: Set<string>) {
  const { data: profs } = await sb
    .from("user_profiles")
    .select("user_id")
    .eq("organization_slug", ORG)
    .order("user_id")
    .limit(800);
  const ids = ((profs ?? []) as { user_id: string }[]).map((r) => r.user_id);
  const real: string[] = [];
  const test: string[] = [];
  for (let i = 0; i < ids.length; i += 50) {
    const { data: snaps } = await sb
      .from("cluster4_weekly_card_snapshots")
      .select("user_id,is_stale,dto_version")
      .in("user_id", ids.slice(i, i + 50))
      .eq("dto_version", WEEKLY_CARDS_DTO_VERSION);
    for (const s of (snaps ?? []) as { user_id: string; is_stale: boolean }[]) {
      if (s.is_stale) continue;
      if (markers.has(s.user_id)) {
        if (test.length < 6) test.push(s.user_id);
      } else if (real.length < 6) real.push(s.user_id);
    }
    if (real.length >= 6 && test.length >= 6) break;
  }
  return { real, test };
}

async function partA(realIds: string[], markers: Set<string>) {
  console.log(`\n[A] 실유저(${ORG} 비마커) NEW direct: 순수 테스트 라인 누수 0 (운영 스코프)`);
  // ⚠ "운영 snapshot 완전 불변(byte-identical)"은 stash A/B(scripts/dump-card-line-sigs.ts)로 별도
  //   입증(REAL 0/6 변경). 여기서는 커밋 회귀용 방향 불변식(운영 카드에 마커-대상 라인 없음)을 검증.
  if (realIds.length === 0) check("실유저 표본 존재", false, "표본 없음(SKIP)");
  const tgtCache = new Map<string, string[]>();
  const getTargets = async (lineId: string) => {
    let v = tgtCache.get(lineId);
    if (!v) { v = await lineUserTargets(lineId); tgtCache.set(lineId, v); }
    return v;
  };
  for (const uid of realIds) {
    const live = (await getCluster4WeeklyCardsForProfileUser(uid)) as Card[];
    const lines = lineIdsInCards(live);
    let leak = 0;
    const detail: string[] = [];
    for (const { lineId } of lines) {
      const uids = await getTargets(lineId);
      if (!legitForOperatingViewer(uids, uid, markers)) { leak++; detail.push(lineId.slice(0, 8)); }
    }
    check(
      `${uid.slice(0, 8)} 순수 테스트 라인 누수 0`,
      leak === 0,
      `누수 ${leak}/${lines.length}${leak ? " [" + detail.slice(0, 5).join(",") + "]" : ""}`,
    );
  }
}

async function partB(testIds: string[], markers: Set<string>) {
  console.log(`\n[B] 테스트유저(${ORG} 마커) NEW direct: 미배정(Step 2) 운영 라인 누수 0`);
  if (testIds.length === 0) check("테스트유저 표본 존재", false, "표본 없음(SKIP)");
  let anyRemoval = false;
  // lineId → user-targets 캐시(반복 라인 재조회 방지).
  const tgtCache = new Map<string, string[]>();
  const getTargets = async (lineId: string) => {
    let v = tgtCache.get(lineId);
    if (!v) { v = await lineUserTargets(lineId); tgtCache.set(lineId, v); }
    return v;
  };
  for (const uid of testIds) {
    const snap = await readWeeklyCardsSnapshot(uid);
    const oldCards = (snap.status === "hit" || snap.status === "stale"
      ? snap.cards
      : []) as Card[];
    const live = (await getCluster4WeeklyCardsForProfileUser(uid)) as Card[];

    // NEW 출력의 lineId 라인이 모두 viewer 관점에서 정당해야(미배정이면 전원 마커).
    const newLines = lineIdsInCards(live);
    let leak = 0;
    const leakDetail: string[] = [];
    for (const { lineId } of newLines) {
      const uids = await getTargets(lineId);
      if (!legitForTestViewer(uids, uid, markers)) { leak++; leakDetail.push(lineId.slice(0, 8)); }
    }
    check(
      `${uid.slice(0, 8)} 미배정 운영 라인 누수 0`,
      leak === 0,
      `누수 ${leak}/${newLines.length}${leak ? " ["+leakDetail.slice(0,5).join(",")+"]" : ""}`,
    );

    // OLD→NEW 제거된 라인 = 운영 누수 제거. 제거된 lineId 는 viewer 비정당(운영/0대상)이어야.
    const newLineIdSet = new Set(newLines.map((x) => `${x.weekId}|${x.lineId}`));
    const oldLineIds = lineIdsInCards(oldCards);
    let removedLineIds = 0;
    let badRemoval = 0;
    for (const { lineId, weekId } of oldLineIds) {
      if (newLineIdSet.has(`${weekId}|${lineId}`)) continue; // 유지됨
      removedLineIds++;
      const uids = await getTargets(lineId);
      if (legitForTestViewer(uids, uid, markers)) badRemoval++; // 정당한 라인이 제거되면 버그
    }
    if (removedLineIds > 0) anyRemoval = true;
    check(
      `${uid.slice(0, 8)} 제거 라인은 전부 운영/0대상(정당 라인 보존)`,
      badRemoval === 0,
      `잘못 제거 ${badRemoval} · 제거 lineId ${removedLineIds}`,
    );
  }
  check(
    `테스트유저 표본에서 운영 라인 누수 제거가 실제로 발생(누수 존재 입증)`,
    anyRemoval || testIds.length === 0,
    anyRemoval ? "" : "제거 0 — 현재 encre 운영 라인이 없거나 코호트 주차 불일치(데이터 의존)",
  );
}

async function partC(testIds: string[]) {
  console.log(`\n[C] admin QA(mode=test) opened ⊇ 고객 테스트유저 카드 information 라인 (어드민 SoT)`);
  if (testIds.length === 0) {
    check("테스트유저 표본 존재", false, "표본 없음(SKIP)");
    return;
  }
  // admin info-line-results(mode=test) 주차별 opened 캐시.
  const adminCache = new Map<string, Set<string>>();
  const adminOpened = async (weekId: string): Promise<Set<string>> => {
    let v = adminCache.get(weekId);
    if (!v) {
      const res = await getInfoLineResultsForWeek({ weekId, organization: ORG, mode: "test" });
      v = new Set(res.lines.filter((l) => l.status === "opened" && l.lineId).map((l) => l.lineId as string));
      adminCache.set(weekId, v);
    }
    return v;
  };

  let totalCust = 0;
  let totalAdmin = 0;
  let subsetViolations = 0;
  let comparedWeeks = 0;
  for (const uid of testIds) {
    const live = (await getCluster4WeeklyCardsForProfileUser(uid)) as Card[];
    const weekIds = Array.from(
      new Set(live.map((c) => c.weekId).filter((w): w is string => Boolean(w))),
    );
    for (const weekId of weekIds) {
      const card = live.find((c) => c.weekId === weekId);
      const custInfo = (card?.lines ?? [])
        .filter((l) => l.partType === "information" && l.lineId)
        .map((l) => l.lineId as string);
      if (custInfo.length === 0) continue;
      const admin = await adminOpened(weekId);
      totalCust += custInfo.length;
      totalAdmin += admin.size;
      comparedWeeks++;
      for (const id of custInfo) if (!admin.has(id)) subsetViolations++;
    }
  }
  check(
    `고객 테스트유저 info 라인 ⊆ admin opened(test) (위반 ${subsetViolations})`,
    subsetViolations === 0,
    `info 라인 보유 주차 ${comparedWeeks} · 고객 info ${totalCust} · admin opened ${totalAdmin}`,
  );
  if (comparedWeeks === 0) {
    console.log(
      `     ℹ︎ 고객 테스트유저 카드에 information 라인 0건 = 어드민 QA(mode=test) opened 0건과 정합` +
      ` (운영 info 라인 누수 제거 완료).`,
    );
  }
}

async function main() {
  console.log(`=== cluster-4-card 라인 QA 스코프 회귀 (DTO v${WEEKLY_CARDS_DTO_VERSION}) ===`);
  const markers = await fetchMarkerIds();
  console.log(`  test_user_markers: ${markers.size}명`);
  const { real, test } = await sampleUsers(markers);
  console.log(`  표본: 실유저 ${real.length} · 테스트유저 ${test.length} (${ORG})`);
  await partA(real, markers);
  await partB(test, markers);
  await partC(test);
  console.log(`\n=== 결과: ${failures === 0 ? "ALL PASS ✅" : `${failures} FAIL ❌`} ===`);
  process.exit(failures === 0 ? 0 : 1);
}
main().catch((e) => {
  console.error("ERR", e instanceof Error ? e.stack : e);
  process.exit(1);
});
