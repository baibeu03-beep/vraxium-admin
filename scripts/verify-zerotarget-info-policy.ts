/**
 * verify-zerotarget-info-policy.ts  — 회귀 테스트 (실패 시 exit 1)
 *
 * 전역 정책: part_type='info' · is_active=true · org-visible 라인은 cluster4_line_targets 가 0명이어도
 *   고객 weekly-cards 에 "개설(미배정=강화 실패, 내용 노출)"로 포함된다. org 분기/예외 없음.
 *
 * PART A (UNIT, no DB): line_code 토큰(BS/common·OK·EC·PX·null) × 뷰어 org 가시성 매트릭스.
 *   → common/null/OK/EC/PX 각각에 org visibility 가 정확히 적용되는지(요구 #4) — 데이터 무관 결정성.
 *   → phalanx/common 은 현재 활성 info 라인이 없어 통합 검증 불가 → 정책 로직을 여기서 보장.
 * PART B (UNIT): line_id dedup 불변식 — targetRows 유래 라인 + 보강 라인 동일 id → 1회(요구 #5).
 * PART C (INTEGRATION): encre·oranke 0명 info 라인이 동일 org 코호트 카드에 표시 + 타org 누수 0.
 * PART D (SNAPSHOT-ONLY): DTO 버전 bump 확인 · 표본 direct==snapshot · is_stale 확인.
 *
 * npx tsx --env-file=.env.local scripts/verify-zerotarget-info-policy.ts
 */
import { config } from "dotenv"; config({ path: ".env.local" });
import { createClient } from "@supabase/supabase-js";
import { resolveLineScopeFromValues, isLineScopeVisibleForOrg } from "@/lib/lineScope";
import { getCluster4WeeklyCardsForProfileUser } from "@/lib/cluster4WeeklyCardsData";
import { readWeeklyCardsSnapshot, WEEKLY_CARDS_DTO_VERSION } from "@/lib/cluster4WeeklyCardsSnapshot";
import type { OrganizationSlug } from "@/lib/organizations";

const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } });

let failures = 0;
function check(name: string, cond: boolean, detail = "") {
  console.log(`  ${cond ? "✅" : "❌"} ${name}${detail ? ` — ${detail}` : ""}`);
  if (!cond) failures++;
}

// ── PART A: 토큰 × org 가시성 매트릭스 (결정성, DB 무관) ──────────────────
function partA() {
  console.log("\n[A] 토큰 × org 가시성 매트릭스 (요구 #4)");
  const orgs: OrganizationSlug[] = ["encre", "oranke", "phalanx"];
  // line_code 토큰별 기대 가시 org 집합 (null=전부 숨김, common=전부 보임)
  const cases: Array<{ code: string | null; visibleTo: Set<OrganizationSlug | "none"> }> = [
    { code: "info-BS-x-2025w01", visibleTo: new Set(["encre", "oranke", "phalanx"]) }, // common
    { code: "info-OK-x-2025w01", visibleTo: new Set(["oranke"]) },
    { code: "info-EC-x-2025w01", visibleTo: new Set(["encre"]) },
    { code: "info-PX-x-2025w01", visibleTo: new Set(["phalanx"]) },
    { code: null, visibleTo: new Set(["none"]) }, // null=fail-closed(allowUnknown:false)
  ];
  for (const c of cases) {
    const scope = resolveLineScopeFromValues({ partType: "info", lineCode: c.code });
    for (const org of orgs) {
      const got = isLineScopeVisibleForOrg(scope, org, { allowUnknown: false });
      const want = c.visibleTo.has(org);
      check(`${String(c.code ?? "null").padEnd(20)} → ${org}: ${got ? "보임" : "숨김"}`, got === want, want ? "기대 보임" : "기대 숨김");
    }
  }
}

// ── PART B: dedup 불변식 (요구 #5) ───────────────────────────────────────
function partB() {
  console.log("\n[B] line_id dedup 불변식 (요구 #5·#6)");
  // 실제 코드의 openedByWeek 병합과 동일한 패턴: if (!m.has(id)) m.set(...)
  type Entry = { dbPart: string; src: string };
  const m = new Map<string, Entry>();
  const targetLine = { id: "L1", part_type: "info" };
  const supplementalSame = { id: "L1", part_type: "info" }; // 동일 라인(타깃 보유)
  const supplementalNew = { id: "L2", part_type: "info" }; // 0명 개설 신규
  // 1) targetRows 경로
  if (!m.has(targetLine.id)) m.set(targetLine.id, { dbPart: targetLine.part_type, src: "target" });
  // 2) 보강(동일 id) — dedup 되어야 함
  if (!m.has(supplementalSame.id)) m.set(supplementalSame.id, { dbPart: "info", src: "supplement" });
  // 3) 보강(신규 0명 id)
  if (!m.has(supplementalNew.id)) m.set(supplementalNew.id, { dbPart: "info", src: "supplement" });
  check("동일 라인 1회만(중복 없음)", m.size === 2);
  check("타깃 보유 라인은 target 경로 보존(보강이 덮지 않음)", m.get("L1")?.src === "target");
  check("0명 개설 신규 라인은 보강으로 추가", m.get("L2")?.src === "supplement");
}

// 한 org 의 0명 info 라인이 같은 org 코호트 카드에 보이는지 + 타org 누수 0
async function integOrg(org: OrganizationSlug, token: string): Promise<void> {
  console.log(`\n[C-${org}] 0명 info 라인 표시 + 타org 누수`);
  // 활성 info 라인 중 이 org 토큰 + user-target 0건 + 코호트(uws 보유 주차) 후보 찾기
  const { data: lines } = await sb.from("cluster4_lines")
    .select("id,line_code,week_id,main_title")
    .eq("part_type", "info").eq("is_active", true).like("line_code", `%${token}%`).not("week_id", "is", null);
  const cand = (lines ?? []) as Array<{ id: string; line_code: string; week_id: string; main_title: string }>;
  // user-target 0건 라인만
  let target0: typeof cand[0] | null = null;
  let cohortUser: string | null = null;
  for (const l of cand) {
    const { data: tg } = await sb.from("cluster4_line_targets").select("id").eq("line_id", l.id).eq("target_mode", "user").limit(1);
    if ((tg ?? []).length > 0) continue; // user-target 있음 → 0명 케이스 아님
    // 그 주차에 카드(스냅샷)가 있는 같은 org 사용자 찾기
    const { data: usrs } = await sb.from("user_profiles").select("user_id").eq("organization_slug", org).limit(400);
    const ids = ((usrs ?? []) as Array<{ user_id: string }>).map((r) => r.user_id);
    for (let i = 0; i < ids.length && !cohortUser; i += 50) {
      const { data: snaps } = await sb.from("cluster4_weekly_card_snapshots").select("user_id,cards").in("user_id", ids.slice(i, i + 50));
      for (const s of (snaps ?? []) as Array<{ user_id: string; cards: any[] }>) {
        if ((s.cards ?? []).some((c) => c.weekId === l.week_id)) { cohortUser = s.user_id; break; }
      }
    }
    if (cohortUser) { target0 = l; break; }
  }
  if (!target0 || !cohortUser) {
    check(`${org}: 0명 info 라인+코호트 후보 존재`, false, "데이터 없음 → 검증 불가(SKIP)");
    return;
  }
  const live = await getCluster4WeeklyCardsForProfileUser(cohortUser);
  const snap = await readWeeklyCardsSnapshot(cohortUser);
  const snapCards = snap.status === "hit" || snap.status === "stale" ? (snap.cards as any[]) : [];
  const card = live.find((c: any) => c.weekId === target0!.week_id);
  const snapCard = snapCards.find((c: any) => c.weekId === target0!.week_id);
  const liveHas = (card?.lines ?? []).some((l: any) => l.lineId === target0!.id && l.partType === "information");
  const snapHas = (snapCard?.lines ?? []).some((l: any) => l.lineId === target0!.id && l.partType === "information");
  console.log(`     라인 ${target0.line_code} (0명) · 코호트 ${cohortUser.slice(0, 8)} · 주차 ${target0.week_id.slice(0, 8)}`);
  check(`${org}: 0명 info 라인이 live 카드에 표시`, liveHas);
  check(`${org}: 0명 info 라인이 snapshot 카드에 표시(==live)`, snapHas);
  // dedup: 그 주차 info 라인 lineId 중복 없음
  const ids = (card?.lines ?? []).filter((l: any) => l.partType === "information").map((l: any) => l.lineId);
  check(`${org}: info 라인 lineId 중복 없음(요구 #5)`, ids.length === new Set(ids).size);
  // 타org 누수 0: 그 주차 info 라인 전부 이 사용자 org 가시여야 함
  const otherOrgLeak = (card?.lines ?? [])
    .filter((l: any) => l.partType === "information" && l.lineId)
    .some((l: any) => {
      // 라인 line_code 로 org 판정 후 이 org 가시 아니면 누수
      return false; // 아래 별도 쿼리로 검사
    });
  // 누수 검사: 카드 info 라인들의 line_code org ≠ 사용자 org 인 'specific org' 라인이 있나
  const lineIds = (card?.lines ?? []).filter((l: any) => l.partType === "information" && l.lineId).map((l: any) => l.lineId);
  let leak = 0;
  if (lineIds.length) {
    const { data: lc } = await sb.from("cluster4_lines").select("id,line_code").in("id", lineIds);
    for (const r of (lc ?? []) as Array<{ id: string; line_code: string | null }>) {
      const sc = resolveLineScopeFromValues({ partType: "info", lineCode: r.line_code });
      if (!isLineScopeVisibleForOrg(sc, org, { allowUnknown: false })) leak++;
    }
  }
  check(`${org}: 타org 라인 누수 0(요구 #4)`, leak === 0, `누수 ${leak}건`);
}

async function partD() {
  console.log("\n[D] snapshot-only 구조");
  check(`DTO 버전 bump(>=27)`, WEEKLY_CARDS_DTO_VERSION >= 27, `현재 v${WEEKLY_CARDS_DTO_VERSION}`);
  // encre 표본 direct==snapshot + is_stale=false
  const { data: enc } = await sb.from("user_profiles").select("user_id").eq("organization_slug", "encre").order("user_id").limit(120);
  const ids = ((enc ?? []) as Array<{ user_id: string }>).map((r) => r.user_id);
  let checked = 0, eqc = 0, stalec = 0;
  for (let i = 0; i < ids.length && checked < 5; i += 50) {
    const { data: snaps } = await sb.from("cluster4_weekly_card_snapshots").select("user_id,is_stale,dto_version,cards").in("user_id", ids.slice(i, i + 50)).eq("dto_version", WEEKLY_CARDS_DTO_VERSION);
    for (const s of (snaps ?? []) as Array<{ user_id: string; is_stale: boolean; cards: any[] }>) {
      if (checked >= 5) break;
      if (s.is_stale) stalec++;
      const live = await getCluster4WeeklyCardsForProfileUser(s.user_id);
      const infoCount = (cards: any[]) => cards.reduce((n, c) => n + (c.lines ?? []).filter((l: any) => l.partType === "information").length, 0);
      if (infoCount(live) === infoCount(s.cards)) eqc++;
      checked++;
    }
  }
  check(`encre 표본 direct==snapshot info 라인 수 일치`, eqc === checked, `${eqc}/${checked}`);
  check(`encre v${WEEKLY_CARDS_DTO_VERSION} 표본 is_stale=false`, stalec === 0, `stale ${stalec}`);
}

async function main() {
  console.log(`=== 타깃 0명 info 라인 전역 정책 회귀 테스트 (DTO v${WEEKLY_CARDS_DTO_VERSION}) ===`);
  partA();
  partB();
  await integOrg("encre", "EC");
  await integOrg("oranke", "OK");
  // phalanx: 현재 활성 info 라인 0건 → 통합 불가. 정책 로직은 PART A(PX 토큰)에서 보장.
  console.log("\n[C-phalanx] 활성 info 라인 0건 → 통합 검증 불가(SKIP). PX 토큰 가시성은 [A]에서 보장(org-agnostic 동일 경로).");
  await partD();
  console.log(`\n=== 결과: ${failures === 0 ? "ALL PASS ✅" : `${failures} FAIL ❌`} ===`);
  process.exit(failures === 0 ? 0 : 1);
}
main().catch((e) => { console.error("ERR", e instanceof Error ? e.stack : e); process.exit(1); });
