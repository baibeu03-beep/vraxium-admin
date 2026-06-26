/**
 * apply-summer-season-rest — 2026 여름 시즌 전체 휴식 확정 명단 → user_season_statuses(rest) 생성.
 *
 *   npx tsx --env-file=.env.local scripts/apply-summer-season-rest.ts            # PREVIEW (쓰기 0)
 *   npx tsx --env-file=.env.local scripts/apply-summer-season-rest.ts --apply    # 실제 적용
 *   npx tsx --env-file=.env.local scripts/apply-summer-season-rest.ts --rollback <runlog.json>
 *
 * 사용자 확정(2026-06-26):
 *   - 생성 대상은 "사람 데이터"가 아니라 user_season_statuses 의 (season_key='2026-summer', status='rest') 행뿐.
 *   - user_profiles 신규 생성 금지. 기존 DB에서 (organization_slug, display_name) 단일매칭만 적용.
 *   - 동명이인(>1) / 미존재(0) 는 절대 임의 선택하지 말고 보류(HOLD).
 *   - growth_status 등 전인(whole-person) 필드 무수정. 과거 시즌(봄 등) uws/uwp/라인/포인트 무접촉.
 *   - additive only — 멱등(이미 2026-summer 행 있으면 skip).
 *   - snapshot 무접촉(이 스크립트는 season_status 만 insert). 영향/재계산 필요 여부는 verify 단계에서 판정.
 *
 * rollback: run log 의 insertedIds 만 삭제(다른 시즌/행 무접촉).
 */
import { readFileSync, writeFileSync } from "fs";
import { createClient } from "@supabase/supabase-js";

const SUMMER_KEY = "2026-summer";
const NOTE = "2026 여름 시즌 전체 휴식 (확정 명단 2026-06-26)";

const EXPECTED: Record<string, string[]> = {
  encre: [
    "현유빈","추가현","최인영","제서영","이혜인","이재은","송은서","손지희","손정민","류신형",
    "김혜령","강지원","김가희","김나연","김다연","김다정","김도연","김민아","황수민","박가은",
    "오재우","김성현","이예령","박기연","임지윤","윤정환","김수민","김유나","우태경","황예원",
    "김준우","김지민","김지우","김채연",
  ],
  oranke: ["이수현","박소윤","공지민","김동욱","김민결","전현성","정은지","이윤재"],
  phalanx: ["성채윤","정혜빈","김다빈","강은비","최종원","공준혁","양설아","신유이"],
};

const APPLY = process.argv.includes("--apply");
const rbIdx = process.argv.indexOf("--rollback");
const ROLLBACK = rbIdx >= 0 ? process.argv[rbIdx + 1] : null;
const MODE = ROLLBACK ? "rollback" : APPLY ? "apply" : "preview";
const STAMP = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
const OUT = `claudedocs/apply-summer-season-rest-${MODE}-${STAMP}.json`;

const rawEnv = readFileSync(".env.local", "utf8");
const envGet = (k: string) => rawEnv.match(new RegExp(`^${k}=(.+)$`, "m"))?.[1]?.trim();
const sb = createClient(envGet("NEXT_PUBLIC_SUPABASE_URL")!, envGet("SUPABASE_SERVICE_ROLE_KEY")!);
const line = (s = "") => console.log(s);

async function rollback(file: string) {
  const log = JSON.parse(readFileSync(file, "utf8"));
  const ids: string[] = log.insertedIds ?? [];
  let deleted = 0;
  for (let i = 0; i < ids.length; i += 100) {
    const chunk = ids.slice(i, i + 100);
    // 안전: 2026-summer rest 행만 삭제(가드)
    const { data, error } = await sb.from("user_season_statuses")
      .delete().in("id", chunk).eq("season_key", SUMMER_KEY).eq("status", "rest").select("id");
    if (error) throw new Error(`rollback delete: ${error.message}`);
    deleted += (data ?? []).length;
  }
  line(`rollback 완료 — ${deleted}/${ids.length}행 삭제(2026-summer rest 가드)`);
  writeFileSync(OUT, JSON.stringify({ mode: "rollback", source: file, requested: ids.length, deleted }, null, 1));
}

async function main() {
  if (ROLLBACK) return rollback(ROLLBACK);

  // 사전: 2026-summer season_definition 존재 확인(FK)
  const { data: sd } = await sb.from("season_definitions").select("season_key").eq("season_key", SUMMER_KEY).maybeSingle();
  if (!sd) throw new Error(`season_definitions 에 ${SUMMER_KEY} 부재 — FK 위반`);

  type Resolved = { org: string; name: string; userId: string };
  type Held = { org: string; name: string; reason: string; candidates: string[] };
  const resolved: Resolved[] = [];
  const held: Held[] = [];

  for (const org of ["encre", "oranke", "phalanx"]) {
    for (const name of EXPECTED[org]) {
      const { data, error } = await sb.from("user_profiles")
        .select("user_id,growth_status,status").eq("organization_slug", org).eq("display_name", name);
      if (error) throw new Error(`resolve ${org}/${name}: ${error.message}`);
      const rows = (data ?? []) as any[];
      if (rows.length === 1) {
        resolved.push({ org, name, userId: rows[0].user_id });
      } else if (rows.length === 0) {
        held.push({ org, name, reason: "user_profiles 매칭 0 (미존재/미이관/오타)", candidates: [] });
      } else {
        held.push({ org, name, reason: `동명이인 ${rows.length} — user_id 확정 필요(임의선택 금지)`, candidates: rows.map((r) => r.user_id) });
      }
    }
  }

  // 멱등: 이미 2026-summer 행 보유자 조회
  const ids = resolved.map((r) => r.userId);
  const existing = new Set<string>();
  for (let i = 0; i < ids.length; i += 500) {
    const { data } = await sb.from("user_season_statuses")
      .select("user_id,status").eq("season_key", SUMMER_KEY).in("user_id", ids.slice(i, i + 500));
    for (const r of (data ?? []) as any[]) existing.add(r.user_id);
  }
  const toInsert = resolved.filter((r) => !existing.has(r.userId));
  const alreadyHas = resolved.filter((r) => existing.has(r.userId));

  const perOrg = (arr: { org: string }[]) => ({
    encre: arr.filter((x) => x.org === "encre").length,
    oranke: arr.filter((x) => x.org === "oranke").length,
    phalanx: arr.filter((x) => x.org === "phalanx").length,
  });

  line("═".repeat(72));
  line(`MODE=${MODE}  대상시즌=${SUMMER_KEY}`);
  line("═".repeat(72));
  line(`기대 50명 = {"encre":34,"oranke":8,"phalanx":8}`);
  line(`단일매칭(적용대상): ${resolved.length}  ${JSON.stringify(perOrg(resolved))}`);
  line(`  - 신규 insert: ${toInsert.length}  ${JSON.stringify(perOrg(toInsert))}`);
  line(`  - 이미 보유(skip): ${alreadyHas.length}  ${alreadyHas.map((x) => `${x.org}/${x.name}`).join(", ") || "없음"}`);
  line(`보류(HOLD): ${held.length}`);
  for (const h of held) line(`  · [${h.org}] ${h.name} — ${h.reason}${h.candidates.length ? ` 후보=[${h.candidates.join(", ")}]` : ""}`);

  const report: any = {
    generatedAt: `${STAMP}`, mode: MODE, seasonKey: SUMMER_KEY,
    expected: { encre: 34, oranke: 8, phalanx: 8, total: 50 },
    resolvedCount: resolved.length, resolvedPerOrg: perOrg(resolved),
    toInsertCount: toInsert.length, toInsertPerOrg: perOrg(toInsert),
    alreadyHas: alreadyHas.map((x) => ({ org: x.org, name: x.name, userId: x.userId })),
    held, resolved,
  };

  if (!APPLY) {
    writeFileSync(OUT, JSON.stringify(report, null, 1));
    line(`\n→ ${OUT}`);
    line("PREVIEW — 쓰기 0. 적용하려면 --apply.");
    return;
  }

  // ═══ APPLY ═══
  const insertedIds: string[] = [];
  for (const r of toInsert) {
    const { data, error } = await sb.from("user_season_statuses")
      .insert({ user_id: r.userId, season_key: SUMMER_KEY, status: "rest", note: NOTE })
      .select("id").single();
    if (error) {
      report.insertedIds = insertedIds;
      report.failedAt = { org: r.org, name: r.name, userId: r.userId, error: error.message };
      writeFileSync(OUT, JSON.stringify(report, null, 1));
      line(`✖ ${r.org}/${r.name} insert 실패: ${error.message} — 중단. rollback: --rollback ${OUT}`);
      process.exit(1);
    }
    insertedIds.push((data as any).id);
    line(`✔ ${r.org}/${r.name} (${r.userId.slice(0, 8)}) rest 생성`);
  }
  report.insertedIds = insertedIds;
  report.insertedCount = insertedIds.length;
  writeFileSync(OUT, JSON.stringify(report, null, 1));
  line(`\napply 완료 — ${insertedIds.length}행 생성, ${alreadyHas.length} skip, ${held.length} 보류`);
  line(`rollback: npx tsx --env-file=.env.local scripts/apply-summer-season-rest.ts --rollback ${OUT}`);
  line(`→ ${OUT}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
