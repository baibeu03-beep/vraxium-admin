// 운영 모드 read-only / dry-run — 실사용자 데이터 write 0 으로 "동일 DTO 경로" 검증.
//   run: npx tsx --env-file=.env.local scripts/verify-operating-dryrun-dto-path.ts
//
// 목적:
//   · 운영 사용자 1명을 샘플로, 고객 DTO 빌더(getCluster4WeeklyCardsForProfileUser)와
//     운영 조회 경로(readWeeklyCardsSnapshot)를 direct 호출(read-only).
//   · 운영 snapshot 저장본 == 동일 빌더의 live 계산 결과(=snapshot 은 빌더 출력의 캐시일 뿐)
//     임을 구조 지문(weekId→lineId 집합)으로 대조 → test/operating 동일 매퍼 입증.
//   · cluster4_lines→DTO 매핑 필드(partType/outputLinks/canEdit/submissionStatus/enhancementStatus)
//     가 운영 사용자에게도 동일하게 산출됨을 확인(라인 개설 가정 시 매핑 경로 동일).
//   · 호출 전/후 cluster4_line_targets·snapshot.computed_at·user_weekly_points 불변 = DB write 0.
// 금지: 운영 실사용자 target/submission/snapshot 강제재계산/uwp 변경 — 본 스크립트는 일절 쓰기 없음.
import { createClient } from "@supabase/supabase-js";
import { getCluster4WeeklyCardsForProfileUser } from "@/lib/cluster4WeeklyCardsData";
import { readWeeklyCardsSnapshot } from "@/lib/cluster4WeeklyCardsSnapshot";
import { TEST_SUMMER_SIM_EFFECTIVE_FROM } from "@/lib/lineAvailability";

const URL = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const SERVICE = process.env.SUPABASE_SERVICE_ROLE_KEY!;
const sb = createClient(URL, SERVICE, { auth: { persistSession: false } });
const J = (o: unknown) => JSON.stringify(o);
let pass = 0, fail = 0;
const ck = (l: string, ok: boolean, d = "") => { console.log(`  ${ok ? "✓" : "✗"} ${l}${d ? ` — ${d}` : ""}`); ok ? pass++ : fail++; };

// 라인 매핑 필드 지문(같은 카드의 lines 를 lineId→partType 로 환원).
function lineFingerprint(cards: any[]): Record<string, string[]> {
  const fp: Record<string, string[]> = {};
  for (const c of cards) {
    const wk = c.weekId ?? `wn${c.weekNumber}`;
    fp[wk] = (c.lines ?? []).map((l: any) => l.lineId).filter(Boolean).sort();
  }
  return fp;
}

async function main() {
  // 운영 사용자 1명: oranke · test_user_markers 아님 · snapshot 보유(card_count>0=활동 유저).
  const markers = new Set(((await sb.from("test_user_markers").select("user_id")).data ?? []).map((x: any) => x.user_id));
  // 활동 카드가 있는 snapshot 우선(빌더가 라인을 산출하는 표본). 신선(is_stale=false) 우선.
  const snapRows = (((await sb.from("cluster4_weekly_card_snapshots")
    .select("user_id,card_count,is_stale").gt("card_count", 0)).data ?? []) as any[]);
  const snapByUser = new Map(snapRows.map((s) => [s.user_id, s]));
  const oranke = ((await sb.from("user_profiles").select("user_id").eq("organization_slug", "oranke")).data ?? []) as any[];
  const candidates = oranke.filter((u) => !markers.has(u.user_id) && snapByUser.has(u.user_id));
  const opUser = (candidates.find((u) => snapByUser.get(u.user_id)?.is_stale === false) ?? candidates[0])?.user_id;
  ck("[전제] 운영(비테스트·활동) 사용자(snapshot card_count>0) 확보", !!opUser, `user=${opUser ?? "none"} card_count=${snapByUser.get(opUser ?? "")?.card_count}`);
  if (!opUser) { console.log("⚠ 운영 사용자 없음 — 중단"); process.exit(2); }
  ck("[전제] 샘플 사용자는 test_user_markers 아님(실사용자)", !markers.has(opUser));

  // ── 호출 전 상태 스냅샷(쓰기 0 확인용) ──
  const before = {
    targets: (await sb.from("cluster4_line_targets").select("id", { count: "exact", head: true }).eq("target_user_id", opUser)).count ?? 0,
    snap: (await sb.from("cluster4_weekly_card_snapshots").select("computed_at,is_stale,card_count").eq("user_id", opUser).maybeSingle()).data as any,
    uwpCount: (await sb.from("user_weekly_points").select("id", { count: "exact", head: true }).eq("user_id", opUser)).count ?? 0,
  };
  const uwpSumBefore = (((await sb.from("user_weekly_points").select("points").eq("user_id", opUser)).data ?? []) as any[])
    .reduce((s, r) => s + (Number(r.points) || 0), 0);

  // ── A. 운영 조회 경로: readWeeklyCardsSnapshot (단일 SELECT, 쓰기 0) ──
  const snapRead = await readWeeklyCardsSnapshot(opUser);
  const snapCards = (snapRead as any).cards ?? [];
  ck("[A·운영 read] readWeeklyCardsSnapshot 정상(hit/stale, cards 배열)",
    (snapRead.status === "hit" || snapRead.status === "stale") && Array.isArray(snapCards) && snapCards.length > 0,
    `status=${snapRead.status} cards=${snapCards.length}`);

  // ── B. 동일 빌더 live 계산(운영, override 없음) — recompute 가 저장하는 그 함수 ──
  const liveCards = await getCluster4WeeklyCardsForProfileUser(opUser);
  ck("[B·동일 빌더] getCluster4WeeklyCardsForProfileUser(operating) 정상", Array.isArray(liveCards) && liveCards.length > 0, `cards=${liveCards.length}`);

  // ── C. snapshot 저장본 == live 빌더 출력 (구조 지문 동일) ⇒ snapshot=빌더 캐시 ──
  const fpSnap = lineFingerprint(snapCards);
  const fpLive = lineFingerprint(liveCards as any[]);
  const sameWeeks = J(Object.keys(fpSnap).sort()) === J(Object.keys(fpLive).sort());
  const sameLines = J(fpSnap) === J(fpLive);
  // 엄격 대조는 snapshot 이 "현재버전 + fresh" 일 때(status=hit)만 의미 — stale/version_mismatch 면
  //   저장본은 옛 빌더 출력의 캐시라 현 live 와 다를 수 있다(캐시 신선도 문제, 매퍼 동일성과 무관).
  if (snapRead.status === "hit") {
    ck("[C·동일 경로] 운영 snapshot(hit) weekId 집합 == live 빌더 출력", sameWeeks, `weeks snap=${Object.keys(fpSnap).length} live=${Object.keys(fpLive).length}`);
    ck("[C·동일 경로] 운영 snapshot(hit) 라인 구성 == live 빌더 출력 (snapshot=빌더 캐시)", sameLines, sameLines ? "identical" : "diff");
  } else {
    console.log(`  · [C·정보] snapshot status=${(snapRead as any).reason ?? snapRead.status}(현재버전 아님/old cache) → 엄격대조 생략. snapWeeks=${Object.keys(fpSnap).length} liveWeeks=${Object.keys(fpLive).length} (live 가 최신 빌더 출력)`);
  }

  // ── D. test-sim override 도 동일 함수 — 분기 없이 effectiveFrom 만 다름(read-only) ──
  const liveSim = await getCluster4WeeklyCardsForProfileUser(opUser, { effectiveFromOverride: TEST_SUMMER_SIM_EFFECTIVE_FROM });
  ck("[D·동일 함수] 동일 빌더에 effectiveFromOverride 만 달리해도 동일 DTO 계약(운영/테스트 단일 매퍼)",
    Array.isArray(liveSim) && liveSim.length > 0 && (liveSim as any[]).every((c) => "weekId" in c && Array.isArray(c.lines)),
    `cards=${(liveSim as any[]).length}`);

  // ── E. cluster4_lines→DTO 매핑 필드가 운영 사용자에게도 동일 산출(라인 개설 가정 시 동일 경로) ──
  const sampleLine = (liveCards as any[]).flatMap((c) => c.lines ?? []).find((l: any) => !!l.lineId);
  if (sampleLine) {
    ck("[E·매핑] 운영 라인 DTO 가 partType/outputLinks/canEdit/submissionStatus/enhancementStatus 동일 구조 보유",
      typeof sampleLine.partType === "string" && "outputLinks" in sampleLine && typeof sampleLine.canEdit === "boolean" &&
      typeof sampleLine.submissionStatus === "string" && typeof sampleLine.enhancementStatus === "string",
      J({ partType: sampleLine.partType, canEdit: sampleLine.canEdit, sub: sampleLine.submissionStatus, enh: sampleLine.enhancementStatus }));
  } else {
    ck("[E·매핑] 운영 사용자 라인 표본 존재", false, "이 사용자는 라인 없음 — 다른 표본 필요");
  }

  // ── F. 쓰기 0 확인: 호출 전/후 불변 ──
  const after = {
    targets: (await sb.from("cluster4_line_targets").select("id", { count: "exact", head: true }).eq("target_user_id", opUser)).count ?? 0,
    snap: (await sb.from("cluster4_weekly_card_snapshots").select("computed_at,is_stale,card_count").eq("user_id", opUser).maybeSingle()).data as any,
    uwpCount: (await sb.from("user_weekly_points").select("id", { count: "exact", head: true }).eq("user_id", opUser)).count ?? 0,
  };
  const uwpSumAfter = (((await sb.from("user_weekly_points").select("points").eq("user_id", opUser)).data ?? []) as any[])
    .reduce((s, r) => s + (Number(r.points) || 0), 0);

  ck("[F·write0] cluster4_line_targets 수 불변", before.targets === after.targets, `before=${before.targets} after=${after.targets}`);
  ck("[F·write0] snapshot.computed_at 불변(강제 재계산 안 함)", before.snap?.computed_at === after.snap?.computed_at, `before=${before.snap?.computed_at} after=${after.snap?.computed_at}`);
  ck("[F·write0] snapshot.is_stale 불변", before.snap?.is_stale === after.snap?.is_stale, `${before.snap?.is_stale}→${after.snap?.is_stale}`);
  ck("[F·write0] user_weekly_points 행수 불변", before.uwpCount === after.uwpCount, `before=${before.uwpCount} after=${after.uwpCount}`);
  ck("[F·write0] user_weekly_points 합계 불변", uwpSumBefore === uwpSumAfter, `before=${uwpSumBefore} after=${uwpSumAfter}`);

  console.log(`\n결과: ${pass} pass / ${fail} fail (운영 실사용자 write 0)`);
  process.exit(fail ? 1 : 0);
}

main().catch((e) => { console.error("FATAL:", e?.stack ?? e); process.exit(1); });
