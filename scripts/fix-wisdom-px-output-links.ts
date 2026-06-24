// 26봄(2026-spring) phalanx(PX) 위즈덤(wisdom) info 라인 output_link 교체.
//
// 변경 범위: output_links jsonb 의 url 만 교체(label 보존) + 레거시 output_link_1 mirror.
//   line_code / target / main_title / week_id 는 절대 건드리지 않는다.
//   교체 후 영향 크루(org audience ∪ target) weekly-card snapshot 재계산.
//
// 안전장치: 각 라인은 (line_code === 기대값) AND (part_type='info') AND (week_id === 기대값)
//   일 때만 갱신. 하나라도 어긋나면 그 라인은 건너뛰고 전체 abort.
//
// 실행(실제):   npx tsx --env-file=.env.local scripts/fix-wisdom-px-output-links.ts --apply
// 실행(드라이): npx tsx --env-file=.env.local scripts/fix-wisdom-px-output-links.ts

import { createClient } from "@supabase/supabase-js";
import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  resolveOutputLinks,
  normalizeOutputLinks,
} from "../lib/cluster4OutputLinks";

const url = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY!;
const sb = createClient(url, serviceKey, { auth: { persistSession: false } });

const APPLY = process.argv.includes("--apply");

// 진단 스크립트(diag-wisdom-output-links.ts)로 확정한 line_id ↔ 새 URL 매핑.
// week = 2026-spring 시즌 주차, lineCode = 기대 line_code(가드용).
const MAPPING: Array<{
  week: number;
  lineId: string;
  lineCode: string;
  weekId: string;
  newUrl: string;
}> = [
  { week: 1, lineId: "9ded1835-6987-41cd-b588-6672bf65c0e4", lineCode: "info-PX-wisdom-2026w10", weekId: "d3aa89d8-35f6-42b3-bb12-a1d65b6b0e91", newUrl: "https://cafe.naver.com/phalanx/8440" },
  { week: 2, lineId: "c315b4a6-497e-498a-b6ed-f1d267cce6a2", lineCode: "info-PX-wisdom-2026w11", weekId: "31672f8c-e58c-4d92-9939-197237d7fbcf", newUrl: "https://cafe.naver.com/phalanx/8530" },
  { week: 3, lineId: "cd5c3e8c-7920-4c1e-8bfd-508043509889", lineCode: "info-PX-wisdom-2026w12", weekId: "c6800fe1-8200-4b10-9c97-7515b6a805ca", newUrl: "https://cafe.naver.com/phalanx/8615" },
  { week: 4, lineId: "61579d75-e7fa-4090-ac8f-0225acac518d", lineCode: "info-PX-wisdom-2026w13", weekId: "5eca4fe4-77ff-46bc-9e53-8772a078b651", newUrl: "https://cafe.naver.com/phalanx/8716" },
  { week: 5, lineId: "b1046d2c-3c1a-4730-ab23-547d925e04af", lineCode: "info-PX-wisdom-2026w14", weekId: "20a7ebcb-85ea-4a98-83fa-a920d010038a", newUrl: "https://cafe.naver.com/phalanx/8808" },
  { week: 9, lineId: "dc7ccffc-6d44-429b-8268-b4b601b6fb78", lineCode: "info-PX-wisdom-2026w18", weekId: "b531c234-e860-499a-992c-b74d2c1d5349", newUrl: "https://cafe.naver.com/phalanx/8941" },
  { week: 10, lineId: "fd7f9c1b-f8ef-4d8a-a3a6-b1b40e00b124", lineCode: "info-PX-wisdom-2026w19", weekId: "6cc59d70-3aa6-4823-8854-5b82691d1a84", newUrl: "https://cafe.naver.com/phalanx/9014" },
  { week: 11, lineId: "b1eb989e-b853-4c5d-87a4-80c01ae91171", lineCode: "info-PX-wisdom-2026w20", weekId: "67e07106-564e-4dab-b180-8f11c909973a", newUrl: "https://cafe.naver.com/phalanx/9106" },
  { week: 12, lineId: "967d5278-bb45-4f29-b1da-9c36812c6d0c", lineCode: "info-PX-wisdom-2026w21", weekId: "00000000-0000-0000-0000-202605210002", newUrl: "https://cafe.naver.com/phalanx/9208" },
  { week: 13, lineId: "a4e60985-6148-40a9-a2a5-e8f9af9bd537", lineCode: "info-PX-wisdom-2026w22", weekId: "a2112b50-64d2-42d6-a243-faf9fcdc6ffc", newUrl: "https://cafe.naver.com/phalanx/9288" },
];

type LineRow = {
  id: string;
  part_type: string;
  line_code: string | null;
  week_id: string | null;
  main_title: string | null;
  is_active: boolean;
  output_link_1: string | null;
  output_link_2: string | null;
  output_links: unknown;
};

async function main() {
  console.log(`=== fix-wisdom-px-output-links (${APPLY ? "APPLY" : "DRY-RUN"}) ===\n`);

  const ids = MAPPING.map((m) => m.lineId);
  const { data, error } = await sb
    .from("cluster4_lines")
    .select(
      "id,part_type,line_code,week_id,main_title,is_active,output_link_1,output_link_2,output_links",
    )
    .in("id", ids);
  if (error) throw error;
  const byId = new Map((data as LineRow[]).map((r) => [r.id, r]));

  // ── 가드 + 변경계획 산출 ──────────────────────────────────────────────
  const backup: Array<Record<string, unknown>> = [];
  const plan: Array<{
    week: number; lineId: string; newUrl: string;
    nextOutputLinks: Array<{ url: string; label: string | null }>;
  }> = [];

  for (const m of MAPPING) {
    const row = byId.get(m.lineId);
    if (!row) throw new Error(`[ABORT] line not found: ${m.lineId} (W${m.week})`);
    if (row.part_type !== "info") throw new Error(`[ABORT] not info: ${m.lineId}`);
    if (row.line_code !== m.lineCode) {
      throw new Error(`[ABORT] line_code mismatch ${m.lineId}: got=${row.line_code} expected=${m.lineCode}`);
    }
    if (row.week_id !== m.weekId) {
      throw new Error(`[ABORT] week_id mismatch ${m.lineId}: got=${row.week_id} expected=${m.weekId}`);
    }

    const current = resolveOutputLinks(row.output_links, [row.output_link_1, row.output_link_2]);
    // label 보존: 기존 첫 링크 label 유지(없으면 null). url 만 새 값으로 교체. 단일 링크 라인.
    const preservedLabel = current[0]?.label ?? null;
    const nextOutputLinks = [{ url: m.newUrl, label: preservedLabel }];

    backup.push({
      week: m.week,
      lineId: m.lineId,
      lineCode: row.line_code,
      mainTitle: row.main_title,
      before: {
        output_link_1: row.output_link_1,
        output_link_2: row.output_link_2,
        output_links: row.output_links,
      },
    });
    plan.push({ week: m.week, lineId: m.lineId, newUrl: m.newUrl, nextOutputLinks });

    console.log(
      `W${m.week}  ${m.lineId}\n` +
        `   BEFORE url=${JSON.stringify(current[0]?.url ?? null)} label=${JSON.stringify(preservedLabel)}\n` +
        `   AFTER  url=${JSON.stringify(m.newUrl)} label=${JSON.stringify(preservedLabel)}\n`,
    );
  }

  if (!APPLY) {
    console.log("DRY-RUN: no DB writes. Re-run with --apply to execute.");
    return;
  }

  // ── 롤백 백업 저장 ───────────────────────────────────────────────────
  const backupPath = resolve(
    process.cwd(),
    `claudedocs/rollback-wisdom-px-output-links-${new Date().toISOString().replace(/[:.]/g, "-")}.json`,
  );
  writeFileSync(backupPath, JSON.stringify(backup, null, 2), "utf8");
  console.log(`rollback backup → ${backupPath}\n`);

  // ── UPDATE (output_links jsonb + 레거시 output_link_1 mirror, output_link_2=null) ──
  for (const p of plan) {
    const mirror1 = p.nextOutputLinks[0]?.url ?? null;
    const { error: upErr } = await sb
      .from("cluster4_lines")
      .update({
        output_links: p.nextOutputLinks,
        output_link_1: mirror1,
        output_link_2: null,
      })
      .eq("id", p.lineId);
    if (upErr) throw new Error(`update failed ${p.lineId}: ${upErr.message}`);
    console.log(`updated W${p.week} ${p.lineId} → ${p.newUrl}`);
  }

  console.log("\n=== UPDATE complete. Snapshot 재계산은 별도 스크립트(recompute-wisdom-px-snapshots.ts)에서 ===");
  // sanity: normalizeOutputLinks 로 모든 행 재해석 확인
  const { data: after } = await sb
    .from("cluster4_lines")
    .select("id,output_links,output_link_1")
    .in("id", ids);
  let ok = 0;
  for (const r of (after ?? []) as Array<{ id: string; output_links: unknown; output_link_1: string | null }>) {
    const expected = MAPPING.find((m) => m.lineId === r.id)!.newUrl;
    const resolved = normalizeOutputLinks(r.output_links);
    if (resolved[0]?.url === expected && r.output_link_1 === expected) ok += 1;
  }
  console.log(`post-update consistency: ${ok}/${MAPPING.length} rows match new URL (jsonb + legacy mirror)`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
