/**
 * 기존 info line_registrations → point_activity_type_id 백필.  [Phase 3 · 후속]
 *
 *   목적: info 라인이 라인 강화 Point.A/B config(cluster4_line_point_configs, key=activity_types.id)를
 *         조회할 수 있도록 안정 연결 키(point_activity_type_id)를 채운다. 오픈확인 A/B/N 계산과
 *         동일 SoT·동일 key 를 목록이 그대로 보게 만드는 선행 작업.
 *
 *   연결 근거(사용자 지정 우선순위):
 *     1) 등록 payload/metadata  → line_registrations 에 없음(그래서 이 백필이 필요).
 *     2) line_code 규칙          → IFBS-NN0001..0009 = practical_info 활동유형 정본 순서(SoT 채택).
 *     3) 연결 activity/content   → activity_types(cluster_id='practical_info') 존재 확인으로 교차검증.
 *     4) 제목/유형 매핑          → line_name == activity_types.name 으로 재확인(불일치는 미적용·보고).
 *
 *   안전장치: null → 값 세팅만(이미 설정된 행 skip·덮어쓰기 없음). 확정 불가 행(QA 라인 등)은
 *            임의 추정하지 않고 unmappable 로 보고만 한다.
 *
 *   Usage: npx tsx --env-file=.env.local scripts/backfill-info-line-activity-types.ts [--apply]
 *          (기본 = dry-run. --apply 시에만 DB 쓰기.)
 */

import { supabaseAdmin } from "@/lib/supabaseAdmin";

// line_code → activity_types.id (practical_info 정본 순서). 기대 이름은 재확인용.
const CODE_TO_ACTIVITY: Record<string, { id: string; expectName: string }> = {
  "IFBS-NN0001": { id: "wisdom", expectName: "위즈덤" },
  "IFBS-NN0002": { id: "essay", expectName: "에세이" },
  "IFBS-NN0003": { id: "infodesk", expectName: "인포데스크" },
  "IFBS-NN0004": { id: "calendar", expectName: "캘린더" },
  "IFBS-NN0005": { id: "forum", expectName: "포럼" },
  "IFBS-NN0006": { id: "session", expectName: "세션" },
  "IFBS-NN0007": { id: "practical_lecture", expectName: "아카데미" },
  "IFBS-NN0008": { id: "community", expectName: "커뮤니티" },
  // NN0009: 라인명 "기타" ≈ 활동유형 "기타A"(etc_a). 코드 순서 규칙으로 확정, 이름은 근사.
  "IFBS-NN0009": { id: "etc_a", expectName: "기타A" },
};

async function main() {
  const apply = process.argv.includes("--apply");
  console.log(`mode: ${apply ? "APPLY (DB write)" : "DRY-RUN (no write)"}\n`);

  // 유효한 practical_info 활동유형 id 집합(교차검증용).
  const { data: at } = await supabaseAdmin
    .from("activity_types")
    .select("id, name")
    .eq("cluster_id", "practical_info");
  const activityName = new Map<string, string | null>();
  for (const r of (at ?? []) as Array<{ id: string; name: string | null }>) {
    activityName.set(r.id, r.name);
  }

  const { data: regs, error } = await supabaseAdmin
    .from("line_registrations")
    .select("id, line_name, line_code, organization_slug, point_activity_type_id")
    .eq("hub", "info")
    .order("line_code", { ascending: true });
  if (error) {
    console.error("info 라인 조회 실패:", error.message);
    if (/point_activity_type_id/.test(error.message) || error.code === "42703") {
      console.error("→ 마이그레이션 미적용. db/migrations/2026-07-12_line_registrations_point_activity_type.sql 을 SQL Editor 에서 먼저 적용하세요.");
    }
    process.exit(1);
  }

  const toUpdate: Array<{ id: string; code: string; activityId: string }> = [];
  const alreadySet: string[] = [];
  const unmappable: Array<{ code: string; org: string | null; name: string; reason: string }> = [];

  for (const r of (regs ?? []) as Array<{
    id: string; line_name: string; line_code: string; organization_slug: string | null; point_activity_type_id: string | null;
  }>) {
    const map = CODE_TO_ACTIVITY[r.line_code];
    if (!map) {
      unmappable.push({ code: r.line_code, org: r.organization_slug, name: r.line_name, reason: "확정 가능한 연결 근거 없음(코드 규칙/이름 매핑 불가)" });
      continue;
    }
    if (!activityName.has(map.id)) {
      unmappable.push({ code: r.line_code, org: r.organization_slug, name: r.line_name, reason: `activity_types 에 ${map.id} 부재` });
      continue;
    }
    if (r.point_activity_type_id) {
      alreadySet.push(`${r.line_code} (이미 ${r.point_activity_type_id})`);
      continue;
    }
    const nameOk = r.line_name === map.expectName || r.line_name === activityName.get(map.id);
    const nameNote = nameOk ? "" : ` [이름 근사: 라인 "${r.line_name}" vs 활동 "${activityName.get(map.id)}"]`;
    console.log(`  ${r.line_code} (org=${r.organization_slug}, "${r.line_name}") → ${map.id}${nameNote}`);
    toUpdate.push({ id: r.id, code: r.line_code, activityId: map.id });
  }

  console.log(`\n연결 예정: ${toUpdate.length} · 이미 설정: ${alreadySet.length} · 미연결(보고): ${unmappable.length}`);
  if (alreadySet.length) console.log("  이미 설정:", alreadySet.join(", "));
  if (unmappable.length) {
    console.log("\n⚠ 미연결(임의 추정 안 함 · 목록에서 Point.A/B = '-'):");
    for (const u of unmappable) console.log(`    - ${u.code} (org=${u.org}, "${u.name}"): ${u.reason}`);
  }

  if (!apply) {
    console.log("\n(dry-run — 쓰기 없음. 적용하려면 --apply)");
    return;
  }
  let ok = 0;
  for (const u of toUpdate) {
    const { error: uErr } = await supabaseAdmin
      .from("line_registrations")
      .update({ point_activity_type_id: u.activityId })
      .eq("id", u.id)
      .is("point_activity_type_id", null); // 경쟁 방어 — null 일 때만
    if (uErr) console.error(`  ✗ ${u.code}: ${uErr.message}`);
    else ok++;
  }
  console.log(`\n✅ 적용 완료: ${ok}/${toUpdate.length}`);
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
