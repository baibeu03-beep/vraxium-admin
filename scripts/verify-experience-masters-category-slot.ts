/**
 * 실 DB 검증 (2026-05-30): cluster4_experience_line_masters category/slot 백필 + DTO 노출.
 *
 *   npx tsx --env-file=.env.local scripts/verify-experience-masters-category-slot.ts
 *
 * 검증 항목:
 *   1) experience_category 컬럼 존재
 *   2) experience_slot_order 컬럼 존재
 *   3) active row 중 experience_category IS NULL 수 (기대 0)
 *   4) active row 중 experience_slot_order IS NULL 수 (기대 0)
 *   5) 슬롯별 분포 (slot/category × count)
 *   6) 3클럽 공통 라인(EXBS-EL*) org_count=3 여부
 *   7) weekly-cards DTO 의 experienceCategory/experienceSlotOrder 가 실제 값으로 내려오는지
 */
import { config } from "dotenv";
config({ path: ".env.local" });

import { createClient } from "@supabase/supabase-js";

const sb = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
);

let failed = false;
function check(label: string, ok: boolean, detail: string) {
  console.log(`  ${ok ? "✅" : "❌"} ${label} — ${detail}`);
  if (!ok) failed = true;
}

type MasterRow = {
  id: string;
  organization_slug: string | null;
  line_code: string | null;
  line_name: string | null;
  is_active: boolean;
  experience_category: string | null;
  experience_slot_order: number | null;
};

const CAT_BY_SLOT: Record<number, string> = {
  1: "derivation",
  2: "analysis",
  3: "evaluation",
  4: "extension",
  5: "management",
};

async function main() {
  console.log("════════ 1) & 2) 컬럼 존재 여부 ════════");
  // 컬럼이 없으면 select 자체가 에러난다.
  const probe = await sb
    .from("cluster4_experience_line_masters")
    .select("experience_category,experience_slot_order")
    .limit(1);
  if (probe.error) {
    check("experience_category / experience_slot_order 컬럼", false, probe.error.message);
    console.log("\n컬럼이 없어 이후 검증 불가. 마이그레이션 적용 여부 확인 필요.");
    process.exit(1);
  }
  check("experience_category 컬럼 존재", true, "select 성공");
  check("experience_slot_order 컬럼 존재", true, "select 성공");

  // 전체 master row 적재
  const { data, error } = await sb
    .from("cluster4_experience_line_masters")
    .select(
      "id,organization_slug,line_code,line_name,is_active,experience_category,experience_slot_order",
    );
  if (error) throw new Error(error.message);
  const rows = (data ?? []) as MasterRow[];
  const active = rows.filter((r) => r.is_active === true);
  console.log(`\n  (전체 ${rows.length} row, active ${active.length} row)`);

  console.log("\n════════ 3) active 中 experience_category IS NULL ════════");
  const catNull = active.filter((r) => r.experience_category == null);
  check("category NULL = 0", catNull.length === 0, `NULL ${catNull.length} 건`);
  if (catNull.length > 0) {
    for (const r of catNull) {
      console.log(`     · ${r.organization_slug ?? "-"} / ${r.line_code} / ${r.line_name}`);
    }
  }

  console.log("\n════════ 4) active 中 experience_slot_order IS NULL ════════");
  const slotNull = active.filter((r) => r.experience_slot_order == null);
  check("slot_order NULL = 0", slotNull.length === 0, `NULL ${slotNull.length} 건`);
  if (slotNull.length > 0) {
    for (const r of slotNull) {
      console.log(`     · ${r.organization_slug ?? "-"} / ${r.line_code} / ${r.line_name}`);
    }
  }

  console.log("\n════════ 5) 슬롯별 분포 (전체 row) ════════");
  const dist = new Map<string, number>();
  for (const r of rows) {
    const key = `${r.experience_slot_order ?? "∅"} / ${r.experience_category ?? "∅"}`;
    dist.set(key, (dist.get(key) ?? 0) + 1);
  }
  console.log("  slot / category | count");
  let pairOk = true;
  for (const key of [...dist.keys()].sort()) {
    console.log(`  ${key} | ${dist.get(key)}`);
  }
  // category↔slot 1:1 정합성 확인
  for (const r of rows) {
    if (r.experience_slot_order != null) {
      if (CAT_BY_SLOT[r.experience_slot_order] !== r.experience_category) pairOk = false;
    }
  }
  check("category↔slot 1:1 정합성", pairOk, "도출1·분석2·평가3·확장4·관리5");

  console.log("\n════════ 6) 3클럽 공통 EXBS-EL* org_count ════════");
  const exbs = rows.filter((r) => (r.line_code ?? "").startsWith("EXBS-EL"));
  // line_code × category × slot 그룹의 org(distinct organization_slug) 수
  const groups = new Map<string, Set<string>>();
  for (const r of exbs) {
    const key = `${r.line_code} | ${r.experience_category} | ${r.experience_slot_order}`;
    if (!groups.has(key)) groups.set(key, new Set());
    groups.get(key)!.add(r.organization_slug ?? "∅");
  }
  console.log("  line_code | category | slot | org_count | orgs");
  let allThree = exbs.length > 0;
  for (const key of [...groups.keys()].sort()) {
    const orgs = groups.get(key)!;
    const ok = orgs.size === 3;
    if (!ok) allThree = false;
    console.log(`  ${key} | ${orgs.size} | {${[...orgs].sort().join(",")}}`);
  }
  check("EXBS-EL* 각 line_code org_count=3", allThree, `${groups.size} 그룹`);

  console.log("\n════════ 7) weekly-cards/detail DTO 노출 (조인 재현) ════════");
  // DTO 조인: cluster4_lines.experience_line_master_id → masters(id).category/slot
  // (cluster4WeeklyCardsData.fetchExperienceMasterMetaByIds / cluster4LinesData.getExperienceMasterMeta 와 동일)
  const { data: expLines } = await sb
    .from("cluster4_lines")
    .select("id,line_code,experience_line_master_id")
    .eq("part_type", "experience")
    .eq("is_active", true);
  const lines = (expLines ?? []) as {
    id: string;
    line_code: string | null;
    experience_line_master_id: string | null;
  }[];
  const masterIds = lines.map((l) => l.experience_line_master_id).filter(Boolean) as string[];
  console.log(`  active experience 라인 ${lines.length}개, master 연결 ${masterIds.length}개`);

  if (lines.length === 0) {
    console.log("  ⚠️ active experience 라인 없음 — DTO 케이스 생략");
  } else {
    const metaById = new Map<string, MasterRow>();
    if (masterIds.length > 0) {
      const { data: m } = await sb
        .from("cluster4_experience_line_masters")
        .select(
          "id,organization_slug,line_code,line_name,is_active,experience_category,experience_slot_order",
        )
        .in("id", masterIds);
      for (const row of (m ?? []) as MasterRow[]) metaById.set(row.id, row);
    }
    let real = 0;
    for (const l of lines) {
      const meta = l.experience_line_master_id ? metaById.get(l.experience_line_master_id) : null;
      // DTO 가 내려보내는 값 (experience part, masterId 있을 때)
      const experienceCategory = meta?.experience_category ?? null;
      const experienceSlotOrder = meta?.experience_slot_order ?? null;
      if (experienceCategory !== null && experienceSlotOrder !== null) real++;
      console.log(
        `     · line=${l.line_code ?? "-"} masterId=${l.experience_line_master_id ? "Y" : "∅"} → experienceCategory=${experienceCategory ?? "null"} experienceSlotOrder=${experienceSlotOrder ?? "null"}`,
      );
    }
    const withMaster = masterIds.length;
    check(
      "master 연결 experience 라인 = 실제 category/slot 값(null 아님)",
      withMaster > 0 && real === withMaster,
      `${real}/${withMaster}`,
    );
  }

  console.log(`\n════════ 검증 ${failed ? "실패 ❌" : "전체 통과 ✅"} ════════`);
  if (failed) process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
