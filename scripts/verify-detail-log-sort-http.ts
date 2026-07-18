/**
 * 주차 상세 표 정렬 — 실제 HTTP 검증(어드민 라이브 서버 + 크루 projection 엔드포인트).
 *   선행: npm run dev (:3000)
 *   npx tsx --env-file=.env.local scripts/verify-detail-log-sort-http.ts
 *
 * 검증(요구 §9·§10·§12):
 *   1) 액트 기본 정렬 = 발생 시점 ASC → stableKey ASC, null 최하단(공통 comparator 재적용해 불변식 확인)
 *   2) 라인 기본 정렬 = 공식 허브 순서 ASC(허브 랭크 비감소)
 *   3) 정렬은 행 순서만 바꾼다 — 행 집합(멀티셋)·summary 값 불변(정렬 전후·모드 무관)
 *   4) 파리티: operating == mode=test == demoUserId 요약 동일(동일 per-user 빌더)
 *   5) 크로스앱: 어드민 clubOpen 라인 기본순서 == 크루 projection 기본순서((허브랭크, 라인명) 시퀀스)
 */
import { createClient } from "@supabase/supabase-js";
import { createServerClient } from "@supabase/ssr";
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { readWeeklyCardsSnapshot } from "@/lib/cluster4WeeklyCardsSnapshot";
import {
  hubRank,
  sortActRows,
  sortLineRows,
  type ActSortRow,
  type LineSortRow,
} from "@/shared/detailLogSort";
import type { CrewWeekActDetailDto, CrewWeekActRow } from "@/lib/adminCrewWeekActDetail";
import type { CrewWeekLineDetailRow, CrewWeekLineSummaryDto } from "@/lib/adminCrewWeekLineSummary";
import type { Cluster4WeeklyCardDto } from "@/shared/cluster4.contracts";

const BASE = process.env.ADMIN_API_BASE_URL?.replace(/\/$/, "") || "http://localhost:3000";
const u = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const a = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;
const s = process.env.SUPABASE_SERVICE_ROLE_KEY!;
const INTERNAL_KEY = process.env.INTERNAL_API_KEY!;

let passed = 0;
let failed = 0;
function check(n: string, ok: boolean, d?: unknown) {
  if (ok) passed++;
  else failed++;
  console.log(`${ok ? "✅" : "❌"} ${n}${!ok && d !== undefined ? " :: " + JSON.stringify(d) : ""}`);
}

// 컴포넌트의 toActSortRow / toLineSortRow 와 동일 매핑(정렬 기준을 그대로 재현).
function toActSortRow(row: CrewWeekActRow): ActSortRow {
  return {
    stableKey: row.awardId,
    result: row.cancelled ? "취소됨" : row.resultLabel,
    name: row.actName,
    occurredAt: row.occurredAt,
    hubToken: row.hubName,
    line: row.lineName ?? "",
    duration: row.durationMinutes,
    pointA: row.pointA,
    pointB: row.pointB,
    pointC: row.pointC,
    source: row.actKindLabel,
    kind: row.requirementLabel,
  };
}
function toLineSortRow(row: CrewWeekLineDetailRow): LineSortRow {
  return {
    stableKey: row.lineId ?? `${row.partType}:${row.lineName}:${row.lineTargetId ?? ""}`,
    result: row.enhancementLabel,
    name: row.lineName,
    hubToken: row.partType,
    kind: row.type ?? "",
    duration: row.estimatedDurationMinutes,
    rating: row.rating,
    pointA: row.earnedA,
    pointB: row.earnedB,
    pointC: row.earnedC,
    growthRequirement: "",
    clubOpen: row.clubOpen,
  };
}

async function adminCookie(): Promise<string> {
  const { data: adm } = await supabaseAdmin
    .from("admin_users")
    .select("email")
    .eq("is_active", true)
    .not("email", "is", null)
    .limit(1);
  const email = (adm?.[0] as { email: string } | undefined)?.email;
  if (!email) throw new Error("활성 관리자 없음");
  const A = createClient(u, s);
  const N = createClient(u, a);
  const { data: l } = await A.auth.admin.generateLink({ type: "magiclink", email });
  const { data: v } = await N.auth.verifyOtp({
    email,
    token: (l as { properties: { email_otp: string } }).properties.email_otp,
    type: "magiclink",
  });
  const cap: { name: string; value: string }[] = [];
  const sv = createServerClient(u, a, {
    cookies: { getAll: () => [], setAll: (items: { name: string; value: string }[]) => cap.push(...items) },
  });
  const sess = (v as { session: { access_token: string; refresh_token: string } }).session;
  await sv.auth.setSession({ access_token: sess.access_token, refresh_token: sess.refresh_token });
  return cap.map((c) => `${c.name}=${c.value}`).join("; ");
}

// 발생시점 epoch(없으면 null).
function epoch(v: string | null): number | null {
  if (!v) return null;
  const t = Date.parse(v);
  return Number.isNaN(t) ? null : t;
}
// 다중집합 동일(정렬이 순서만 바꿨는지 — 키 집합 불변).
function sameSet(x: string[], y: string[]): boolean {
  return JSON.stringify([...x].sort()) === JSON.stringify([...y].sort());
}

async function getJson<T>(path: string, cookie: string): Promise<{ status: number; data?: T }> {
  const res = await fetch(`${BASE}${path}`, { headers: { cookie }, cache: "no-store" });
  const json = (await res.json().catch(() => ({}))) as { success?: boolean; data?: T };
  return { status: res.status, data: json?.data };
}

async function main() {
  try {
    const h = await fetch(`${BASE}/api/health`);
    if (!h.ok) throw new Error("no health");
  } catch {
    console.log(`❌ dev server 미기동(${BASE}). npm run dev 후 재실행.`);
    process.exit(2);
  }
  const cookie = await adminCookie();

  const { data: aw } = await supabaseAdmin
    .from("process_point_awards")
    .select("user_id")
    .in("source", ["regular", "irregular"]);
  const counts = new Map<string, number>();
  for (const r of (aw ?? []) as { user_id: string }[]) counts.set(r.user_id, (counts.get(r.user_id) ?? 0) + 1);
  const busiest = [...counts.entries()].sort((x, y) => y[1] - x[1]).map(([id]) => id).slice(0, 12);
  const { data: markers } = await supabaseAdmin.from("test_user_markers").select("user_id");
  const testIds = new Set(((markers ?? []) as { user_id: string | null }[]).map((r) => r.user_id).filter(Boolean));

  let actChecked = 0;
  let lineChecked = 0;

  for (const uid of busiest) {
    const snap = await readWeeklyCardsSnapshot(uid);
    if (snap.status !== "hit" && snap.status !== "stale") continue;
    const cards = (snap.cards as Cluster4WeeklyCardDto[]).filter((c) => c.weekId && (c.actLogs?.length ?? 0) > 1);
    if (cards.length === 0) continue;

    for (const card of cards.slice(0, 2)) {
      const weekId = card.weekId!;
      const tag = `${uid.slice(0, 8)}/${card.weekLabel ?? card.startDate}`;

      // ── 액트: 기본 정렬 불변식 + 파리티 ──
      const op = await getJson<CrewWeekActDetailDto>(`/api/admin/members/${uid}/weeks/${weekId}/acts`, cookie);
      if (op.status !== 200 || !op.data) {
        check(`${tag} acts 200`, false, { status: op.status });
        continue;
      }
      const acts = op.data.acts;
      if (acts.length > 1) {
        actChecked++;
        const sorted = sortActRows(acts, null, toActSortRow);
        // (1) 발생시점 비감소(null 최하단) + 동시점 stableKey ASC
        let ok = true;
        for (let i = 1; i < sorted.length; i++) {
          const pe = epoch(sorted[i - 1].occurredAt);
          const ce = epoch(sorted[i].occurredAt);
          if (pe == null && ce != null) ok = false; // null 이 유효값보다 앞 → 위반
          else if (pe != null && ce != null && pe > ce) ok = false;
          else if (pe === ce && sorted[i - 1].awardId.localeCompare(sorted[i].awardId, "ko-KR", { numeric: true }) > 0) ok = false;
        }
        check(`${tag} 액트 기본=발생시점 ASC·null 최하단·stableKey tie`, ok, sorted.map((r) => ({ o: r.occurredAt, k: r.awardId })).slice(0, 6));
        // (3) 정렬은 순서만 — 키 집합 불변
        check(`${tag} 액트 정렬 reorder-only(키 집합 불변)`, sameSet(acts.map((r) => r.awardId), sorted.map((r) => r.awardId)));
        // asc/desc 사용자 정렬도 집합 불변
        const byNameAsc = sortActRows(acts, { key: "name", dir: "asc" }, toActSortRow);
        const byNameDesc = sortActRows(acts, { key: "name", dir: "desc" }, toActSortRow);
        check(`${tag} 액트 컬럼정렬 집합 불변(asc/desc)`, sameSet(byNameAsc.map((r) => r.awardId), byNameDesc.map((r) => r.awardId)) && sameSet(byNameAsc.map((r) => r.awardId), acts.map((r) => r.awardId)));
      }

      // (4) 모드 파리티 — summary 동일(정렬은 표시 전용이라 애초에 응답 불변)
      const test = await getJson<CrewWeekActDetailDto>(`/api/admin/members/${uid}/weeks/${weekId}/acts?mode=test`, cookie);
      if (test.status === 200 && test.data) {
        check(`${tag} acts operating==mode=test summary`, JSON.stringify(op.data.summary) === JSON.stringify(test.data.summary));
        check(`${tag} acts operating==mode=test 행 집합`, sameSet(op.data.acts.map((r) => r.awardId), test.data.acts.map((r) => r.awardId)));
      }
      if (testIds.has(uid)) {
        const demo = await getJson<CrewWeekActDetailDto>(`/api/admin/members/${uid}/weeks/${weekId}/acts?demoUserId=${uid}`, cookie);
        if (demo.status === 200 && demo.data) {
          check(`${tag} acts operating==demoUserId summary`, JSON.stringify(op.data.summary) === JSON.stringify(demo.data.summary));
        }
        const actAs = await getJson<CrewWeekActDetailDto>(`/api/admin/members/${uid}/weeks/${weekId}/acts?actAsTestUserId=${uid}`, cookie);
        if (actAs.status === 200 && actAs.data) {
          check(`${tag} acts operating==actAsTestUserId summary`, JSON.stringify(op.data.summary) === JSON.stringify(actAs.data.summary));
        }
      }

      // ── 라인: 기본=허브 공식순서 + 크로스앱 파리티 ──
      const lines = await getJson<CrewWeekLineSummaryDto>(`/api/admin/members/${uid}/weeks/${weekId}/lines`, cookie);
      if (lines.status === 200 && lines.data && lines.data.lineDetails.length > 1) {
        lineChecked++;
        const details = lines.data.lineDetails;
        const sorted = sortLineRows(details, { key: "hub", dir: "asc" }, toLineSortRow);
        let hubOk = true;
        for (let i = 1; i < sorted.length; i++) {
          if (hubRank(sorted[i - 1].partType) > hubRank(sorted[i].partType)) hubOk = false;
        }
        check(`${tag} 라인 허브정렬=공식순서(랭크 비감소)`, hubOk);
        check(`${tag} 라인 정렬 reorder-only`, sameSet(details.map(toLineSortRow).map((r) => r.stableKey), sorted.map(toLineSortRow).map((r) => r.stableKey)));

        // (5) 크로스앱: 어드민 clubOpen 라인 기본순서 == 크루 projection 기본순서((허브랭크,라인명))
        const crew = await fetch(`${BASE}/api/cluster4/weekly-line-enhancement?userId=${uid}&weekId=${weekId}`, {
          headers: { "x-internal-api-key": INTERNAL_KEY },
          cache: "no-store",
        });
        if (crew.ok) {
          const cj = (await crew.json()) as { data?: { rows: { hub: string; lineName: string; stableKey: string }[] } };
          const crewRows = cj.data?.rows ?? [];
          // 어드민 표시 기본 = 서버 순서(허브 그룹으로 이미 정보→경험→역량→경력 정렬됨, 그룹 내부는 서버 순서).
          //   ⚠ 컴포넌트는 기본(sort=null)에서 comparator 를 적용하지 않는다 — 여기서도 재정렬하지 않는다.
          const adminOpen = details.filter((r) => r.clubOpen);
          const adminDefault = adminOpen.map((r) => `${hubRank(r.partType)}|${r.lineName}`);
          // sortLineRows 는 **원본 crew 행**을 정렬해 돌려준다 — 원본 필드명(hub/lineName)으로 읽는다.
          const crewDefault = sortLineRows(crewRows, null, (r) => ({
            stableKey: r.stableKey, result: "", name: r.lineName, hubToken: r.hub, kind: "",
            duration: null, rating: null, pointA: 0, pointB: 0, pointC: 0, growthRequirement: "", clubOpen: true,
          })).map((r) => `${hubRank(r.hub)}|${r.lineName}`);
          check(`${tag} 크로스앱 라인 기본순서((허브랭크,라인명)) 동일`, JSON.stringify(adminDefault) === JSON.stringify(crewDefault), { admin: adminDefault.slice(0, 8), crew: crewDefault.slice(0, 8) });
        }
      }
    }
    if (actChecked >= 4 && lineChecked >= 4) break;
  }

  check(`검증 대상 확보(액트 ${actChecked} · 라인 ${lineChecked})`, actChecked > 0 && lineChecked > 0);
  console.log(`\n═══ 결과: PASS ${passed} · FAIL ${failed} ═══`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
