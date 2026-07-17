/**
 * [실무 역량] 헤더 "라인명 변경(repoint)" 실데이터 저장 왕복 검증.
 *   dry-run(기본, 읽기 전용):  npx tsx --env-file=.env.local scripts/verify-competency-line-repoint.ts
 *   실왕복(A→B→A, 복원):       npx tsx --env-file=.env.local scripts/verify-competency-line-repoint.ts --apply
 *
 * 시나리오(실제 저장 경로 saveCrewWeekLineDetail 사용):
 *   1) 테스트 유저(test_user_markers)의 실무 역량 "강화 성공" 라인 1건 발견(open+target+master).
 *   2) 옵션 로더(listCompetencyMasterOptionsForWeek, excludeLineId)로 다른 유효 마스터(B) 선택.
 *   3) competencyMasterId=B 로 저장 → 같은 lineId/target 유지, 라인명/코드/유형=B, 제출/평점/이미지/포인트 보존 확인.
 *   4) competencyMasterId=A(원복)로 저장 → 원상 복구 확인.
 *   변경은 라인 인스턴스의 마스터만 교체(다른 크루/데이터 무접촉). finally 에서 항상 A 로 복원 시도.
 */
import { config } from "dotenv";
config({ path: ".env.local" });
import { createClient } from "@supabase/supabase-js";
import { resolveCrewWeekCard } from "../lib/adminCrewWeekDetail";
import { getCrewWeekLineDetail } from "../lib/adminCrewWeekLineDetail";
import { saveCrewWeekLineDetail, type SaveLineDetailInput } from "../lib/adminCrewWeekLineSave";
import { listCompetencyMasterOptionsForWeek } from "../lib/adminCompetencyLineSelect";

const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);
const APPLY = process.argv.includes("--apply");
const s8 = (x: string | null | undefined) => (x ? x.slice(0, 8) : "null");

// updated_by/created_by 는 uuid FK — 스크립트도 실제 관리자 UUID 를 써야 한다(개설 시 created_by 재사용).
async function resolveAdminId(lineId: string): Promise<string> {
  const { data } = await sb.from("cluster4_lines").select("created_by,updated_by").eq("id", lineId).maybeSingle();
  const row = data as { created_by: string | null; updated_by: string | null } | null;
  const id = row?.created_by ?? row?.updated_by;
  if (id) return id;
  const { data: fb } = await sb.from("cluster4_lines").select("created_by").not("created_by", "is", null).limit(1);
  const fbId = ((fb ?? []) as Array<{ created_by: string }>)[0]?.created_by;
  if (!fbId) throw new Error("관리자 UUID 를 확인할 수 없습니다");
  return fbId;
}

type Candidate = {
  userId: string;
  weekId: string;
  lineId: string;
  masterId: string;
};

// 테스트 유저의 실무 역량 강화 성공 라인(open+target+master) 후보를 찾는다.
async function findCandidate(): Promise<Candidate | null> {
  const { data: tm } = await sb.from("test_user_markers").select("user_id");
  const testIds = new Set(((tm ?? []) as Array<{ user_id: string }>).map((x) => x.user_id));
  if (testIds.size === 0) return null;

  // 활성 competency 라인(마스터 보유) → 그 라인의 user 타깃(테스트 유저) 조인.
  const { data: lines } = await sb
    .from("cluster4_lines")
    .select("id,competency_line_master_id")
    .eq("part_type", "competency")
    .eq("is_active", true)
    .not("competency_line_master_id", "is", null)
    .limit(2000);
  const lineIds = ((lines ?? []) as Array<{ id: string; competency_line_master_id: string }>).map((l) => l.id);
  if (lineIds.length === 0) return null;
  const masterByLine = new Map(
    ((lines ?? []) as Array<{ id: string; competency_line_master_id: string }>).map((l) => [l.id, l.competency_line_master_id]),
  );

  // 청크로 타깃 조회(.in URL 절벽 회피).
  for (let i = 0; i < lineIds.length; i += 150) {
    const chunk = lineIds.slice(i, i + 150);
    const { data: tgts } = await sb
      .from("cluster4_line_targets")
      .select("line_id,week_id,target_user_id")
      .eq("target_mode", "user")
      .in("line_id", chunk);
    for (const tg of (tgts ?? []) as Array<{ line_id: string; week_id: string; target_user_id: string }>) {
      if (!testIds.has(tg.target_user_id)) continue;
      // 카드에서 이 라인이 "강화 성공" + 편집 가능(확정 주차)인지 확인.
      const resolved = await resolveCrewWeekCard(tg.target_user_id, tg.week_id);
      if (!resolved.ok) continue;
      if (!(resolved.card.userWeekStatus === "success" || resolved.card.userWeekStatus === "fail")) continue; // 확정만
      const line = resolved.card.lines.find((l) => l.lineId === tg.line_id);
      if (!line || line.partType !== "competency" || line.enhancementStatus !== "success") continue;
      // 다른 마스터(B) 후보가 있어야 왕복 가능.
      const opt = await listCompetencyMasterOptionsForWeek(tg.target_user_id, tg.week_id, { excludeLineId: tg.line_id });
      if (!opt.ok) continue;
      const other = opt.options.find((o) => o.masterId !== masterByLine.get(tg.line_id));
      if (!other) continue;
      return { userId: tg.target_user_id, weekId: tg.week_id, lineId: tg.line_id, masterId: masterByLine.get(tg.line_id)! };
    }
  }
  return null;
}

// 현재 상태 스냅샷(비교용).
async function snapshot(userId: string, weekId: string, lineId: string) {
  const detail = await getCrewWeekLineDetail(userId, weekId, lineId);
  if (!detail.ok) throw new Error(`getCrewWeekLineDetail 실패: ${detail.reason}`);
  const d = detail.data;
  const { data: awards } = await sb
    .from("process_point_awards")
    .select("point_type,amount,cancelled_at")
    .eq("source", "line")
    .eq("ref_id", lineId)
    .eq("user_id", userId);
  const awardSum = ((awards ?? []) as Array<{ amount: number; cancelled_at: string | null }>)
    .filter((a) => !a.cancelled_at)
    .reduce((s, a) => s + (a.amount ?? 0), 0);
  const { data: tgt } = await sb
    .from("cluster4_line_targets")
    .select("id")
    .eq("line_id", lineId)
    .eq("target_user_id", userId)
    .eq("target_mode", "user")
    .maybeSingle();
  return {
    masterId: d.identity.competencyLineMasterId,
    lineName: d.identity.lineName,
    lineCode: d.identity.lineCode,
    type: d.identity.type,
    mainTitle: d.identity.mainTitle,
    status: d.currentStatus,
    subTitle: d.submission.subTitle,
    growthPoint: d.submission.growthPoint,
    links: d.submission.outputLinks,
    images: d.submission.outputImages,
    targetId: (tgt as { id: string } | null)?.id ?? null,
    awardSum,
  };
}

// 현재 제출값을 그대로 보내는 저장 입력(제출 변경 없음 → 보존). competencyMasterId 만 바꾼다.
function saveInputFrom(snap: Awaited<ReturnType<typeof snapshot>>, masterId: string): SaveLineDetailInput {
  return {
    enhancementStatus: "success",
    competencyMasterId: masterId,
    statusData: {
      subTitle: snap.subTitle,
      growthPoint: snap.growthPoint,
      outputLinks: snap.links.map((l) => ({ url: l.url, label: l.label ?? null })),
      images: snap.images.map((url) => ({ url, caption: null })),
      rating: null,
      grade: null,
    },
  };
}

async function main() {
  console.log(`=== 실무 역량 라인명 변경(repoint) 검증 — ${APPLY ? "APPLY(실왕복)" : "DRY-RUN(읽기 전용)"} ===\n`);
  const cand = await findCandidate();
  if (!cand) {
    console.log("적합한 테스트 역량 성공 라인 후보를 찾지 못했습니다(테스트 유저·확정 주차·성공·대체 마스터 필요).");
    console.log("=> 검증 스킵(SKIP). --apply 여부와 무관하게 후보 부재.");
    return;
  }
  const ADMIN = await resolveAdminId(cand.lineId);
  const before = await snapshot(cand.userId, cand.weekId, cand.lineId);
  const opt = await listCompetencyMasterOptionsForWeek(cand.userId, cand.weekId, { excludeLineId: cand.lineId });
  if (!opt.ok) throw new Error("옵션 로더 실패");
  const target = opt.options.find((o) => o.masterId !== before.masterId)!;
  console.log(`후보: user=${s8(cand.userId)} week=${s8(cand.weekId)} line=${s8(cand.lineId)}`);
  console.log(`현재(A): master=${s8(before.masterId)} "${before.lineName}" [${before.lineCode ?? "-"}] 유형=${before.type ?? "-"}`);
  console.log(`대상(B): master=${s8(target.masterId)} "${target.lineName}" [${target.lineCode ?? "-"}]`);
  console.log(`옵션에 현재 마스터 포함=${opt.options.some((o) => o.masterId === before.masterId)} · 총 옵션=${opt.options.length}`);
  console.log(`보존 대상 스냅샷: target=${s8(before.targetId)} 포인트합=${before.awardSum} subTitle=${before.subTitle ? "有" : "無"} 링크=${before.links.length} 이미지=${before.images.length}`);

  if (!APPLY) {
    console.log("\n(DRY-RUN) 실제 저장을 수행하지 않았습니다. 위 후보/옵션이 정상이면 --apply 로 왕복 검증 가능.");
    return;
  }

  let restored = false;
  try {
    // ── A → B ──
    const r1 = await saveCrewWeekLineDetail(cand.userId, cand.weekId, cand.lineId, saveInputFrom(before, target.masterId), ADMIN, true);
    if (!r1.ok) throw new Error(`A→B 저장 실패: ${r1.code} ${r1.error}`);
    const afterB = await snapshot(cand.userId, cand.weekId, cand.lineId);
    const bChecks = {
      "라인 유지(lineId·target 불변)": afterB.targetId != null && r1.data?.identity.lineId === cand.lineId,
      "마스터=B": afterB.masterId === target.masterId,
      "라인명=B": afterB.lineName === target.lineName,
      "코드=B": (afterB.lineCode ?? null) === (target.lineCode ?? null),
      "강화 성공 유지": afterB.status === "success",
      "제출 subTitle 보존": afterB.subTitle === before.subTitle,
      "제출 growthPoint 보존": afterB.growthPoint === before.growthPoint,
      "링크 개수 보존": afterB.links.length === before.links.length,
      "이미지 개수 보존": afterB.images.length === before.images.length,
      "포인트 보존(합 동일)": afterB.awardSum === before.awardSum,
    };
    console.log("\n[A→B]");
    for (const [k, v] of Object.entries(bChecks)) console.log(`  ${v ? "✅" : "❌"} ${k}`);

    // ── B → A (복원) ──
    const r2 = await saveCrewWeekLineDetail(cand.userId, cand.weekId, cand.lineId, saveInputFrom(before, before.masterId!), ADMIN, true);
    if (!r2.ok) throw new Error(`B→A 복원 실패: ${r2.code} ${r2.error}`);
    restored = true;
    const afterA = await snapshot(cand.userId, cand.weekId, cand.lineId);
    const aChecks = {
      "마스터=A(원복)": afterA.masterId === before.masterId,
      "라인명=A(원복)": afterA.lineName === before.lineName,
      "코드=A(원복)": (afterA.lineCode ?? null) === (before.lineCode ?? null),
      "강화 성공 유지": afterA.status === "success",
      "제출 보존": afterA.subTitle === before.subTitle && afterA.growthPoint === before.growthPoint,
      "포인트 보존": afterA.awardSum === before.awardSum,
      "target 불변": afterA.targetId === before.targetId,
    };
    console.log("\n[B→A 복원]");
    for (const [k, v] of Object.entries(aChecks)) console.log(`  ${v ? "✅" : "❌"} ${k}`);

    const pass = Object.values(bChecks).every(Boolean) && Object.values(aChecks).every(Boolean);
    console.log(`\n=> 실데이터 왕복 검증: ${pass ? "PASS ✅" : "FAIL ❌"}`);
  } finally {
    if (APPLY && !restored) {
      console.warn("\n⚠ 예외 발생 — A 로 복원 시도(best-effort)");
      try {
        await saveCrewWeekLineDetail(cand.userId, cand.weekId, cand.lineId, saveInputFrom(before, before.masterId!), ADMIN, true);
        console.warn("복원 완료");
      } catch (e) {
        console.error("복원 실패 — 수동 확인 필요:", cand, e);
      }
    }
  }
}
main().catch((e) => {
  console.error("FATAL", e?.stack ?? e);
  process.exit(1);
});
