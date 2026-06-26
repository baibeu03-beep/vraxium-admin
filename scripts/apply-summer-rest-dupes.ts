/**
 * apply-summer-rest-dupes — 동명이인 5명 기준-매칭 user_id 확정 → user_season_statuses(2026-summer, rest) 추가.
 *   npx tsx --env-file=.env.local scripts/apply-summer-rest-dupes.ts            # PREVIEW
 *   npx tsx --env-file=.env.local scripts/apply-summer-rest-dupes.ts --apply
 *   npx tsx --env-file=.env.local scripts/apply-summer-rest-dupes.ts --rollback <runlog.json>
 *
 * 사용자 확정 기준(2026-06-26) — 후보 중 아래 모든 조건을 만족하는 단일 user_id 만 선택(fail-closed):
 *   - 이혜인: 광운대 / 프로듀싱·이야기 / 전화끝 8301
 *   - 김도연: 조선대 / 갤러리·코믹스
 *   - 김민아: 한국외대 / 팬마케팅
 *   - 박가은: 청운대 / 시즌전체휴식
 *   - 정은지: 시즌전체휴식 / 예능
 * season_status(2026-summer, rest) 만 추가. growth_status·과거 시즌 무수정. 신규 profile 생성 없음.
 */
import { readFileSync, writeFileSync } from "fs";
import { createClient } from "@supabase/supabase-js";

const SUMMER_KEY = "2026-summer";
const NOTE = "2026 여름 시즌 전체 휴식 (확정 명단 2026-06-26, 동명이인 기준확정)";

type Crit = { org: string; name: string; school?: string; teamOrPart?: string[]; phoneLast4?: string };
const TARGETS: Crit[] = [
  { org: "encre", name: "이혜인", school: "광운대", teamOrPart: ["프로듀싱", "이야기"], phoneLast4: "8301" },
  { org: "encre", name: "김도연", school: "조선대", teamOrPart: ["갤러리", "코믹스"] },
  { org: "encre", name: "김민아", school: "한국외대", teamOrPart: ["팬마케팅"] },
  { org: "encre", name: "박가은", school: "청운대", teamOrPart: ["시즌전체휴식"] },
  { org: "oranke", name: "정은지", teamOrPart: ["시즌전체휴식", "예능"] },
];

const APPLY = process.argv.includes("--apply");
const rbIdx = process.argv.indexOf("--rollback");
const ROLLBACK = rbIdx >= 0 ? process.argv[rbIdx + 1] : null;
const MODE = ROLLBACK ? "rollback" : APPLY ? "apply" : "preview";
const STAMP = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
const OUT = `claudedocs/apply-summer-rest-dupes-${MODE}-${STAMP}.json`;

const rawEnv = readFileSync(".env.local", "utf8");
const envGet = (k: string) => rawEnv.match(new RegExp(`^${k}=(.+)$`, "m"))?.[1]?.trim();
const sb = createClient(envGet("NEXT_PUBLIC_SUPABASE_URL")!, envGet("SUPABASE_SERVICE_ROLE_KEY")!);
const line = (s = "") => console.log(s);
const norm = (s: unknown) => String(s ?? "").replace(/\s+/g, "");

async function rollback(file: string) {
  const log = JSON.parse(readFileSync(file, "utf8"));
  const ids: string[] = log.insertedIds ?? [];
  let deleted = 0;
  for (const id of ids) {
    const { data, error } = await sb.from("user_season_statuses").delete()
      .eq("id", id).eq("season_key", SUMMER_KEY).eq("status", "rest").select("id");
    if (error) throw new Error(error.message);
    deleted += (data ?? []).length;
  }
  line(`rollback — ${deleted}/${ids.length}행 삭제`);
  writeFileSync(OUT, JSON.stringify({ mode: "rollback", deleted }, null, 1));
}

async function enrich(user_id: string) {
  const { data: edu } = await sb.from("user_educations").select("school_name").eq("user_id", user_id).limit(1).maybeSingle();
  const { data: mem } = await sb.from("user_memberships").select("team_name,part_name").eq("user_id", user_id).eq("is_current", true).limit(1).maybeSingle();
  const { data: prof } = await sb.from("user_profiles").select("contact_phone,current_team_name,current_part_name").eq("user_id", user_id).maybeSingle();
  const phone = (prof as any)?.contact_phone ? String((prof as any).contact_phone).replace(/\D/g, "").slice(-4) : "";
  const school = (edu as any)?.school_name ?? "";
  const team = (mem as any)?.team_name ?? (prof as any)?.current_team_name ?? "";
  const part = (mem as any)?.part_name ?? (prof as any)?.current_part_name ?? "";
  return { school, team, part, phone };
}

function matches(c: Crit, e: { school: string; team: string; part: string; phone: string }): boolean {
  if (c.school && !norm(e.school).includes(norm(c.school))) return false;
  if (c.phoneLast4 && e.phone !== c.phoneLast4) return false;
  if (c.teamOrPart) {
    const hay = norm(e.team) + "|" + norm(e.part);
    if (!c.teamOrPart.every((t) => hay.includes(norm(t)))) return false;
  }
  return true;
}

async function main() {
  if (ROLLBACK) return rollback(ROLLBACK);

  const chosen: Array<{ org: string; name: string; userId: string; ev: any }> = [];
  const failedResolve: Array<{ name: string; reason: string }> = [];

  for (const c of TARGETS) {
    const { data } = await sb.from("user_profiles").select("user_id").eq("organization_slug", c.org).eq("display_name", c.name);
    const rows = (data ?? []) as any[];
    const enriched = await Promise.all(rows.map(async (r) => ({ user_id: r.user_id, ev: await enrich(r.user_id) })));
    const hits = enriched.filter((x) => matches(c, x.ev));
    line(`\n[${c.org}] ${c.name} — 후보 ${rows.length}, 기준매칭 ${hits.length}`);
    for (const x of enriched) {
      const ok = matches(c, x.ev);
      line(`   ${ok ? "★" : " "} ${x.user_id} 학교=${x.ev.school || "-"} 팀=${x.ev.team || "-"} 파트=${x.ev.part || "-"} 폰끝4=${x.ev.phone || "-"}`);
    }
    if (hits.length === 1) chosen.push({ org: c.org, name: c.name, userId: hits[0].user_id, ev: hits[0].ev });
    else failedResolve.push({ name: c.name, reason: `기준매칭 ${hits.length} (1이어야 함)` });
  }

  line("\n" + "═".repeat(60));
  line(`확정 ${chosen.length}/5 · 실패 ${failedResolve.length}`);
  for (const f of failedResolve) line(`  ✖ ${f.name}: ${f.reason}`);

  // 멱등: 이미 여름 행 있는지
  const ids = chosen.map((c) => c.userId);
  const existing = new Set<string>();
  if (ids.length) {
    const { data } = await sb.from("user_season_statuses").select("user_id").eq("season_key", SUMMER_KEY).in("user_id", ids);
    for (const r of (data ?? []) as any[]) existing.add(r.user_id);
  }
  const toInsert = chosen.filter((c) => !existing.has(c.userId));
  line(`신규 insert 대상: ${toInsert.length} (이미보유 skip ${chosen.length - toInsert.length})`);

  const report: any = { mode: MODE, seasonKey: SUMMER_KEY, chosen, failedResolve, toInsert: toInsert.map((c) => ({ name: c.name, userId: c.userId })) };

  if (!APPLY) {
    writeFileSync(OUT, JSON.stringify(report, null, 1));
    line(`\n→ ${OUT}\nPREVIEW — 쓰기 0. (실패>0 이면 --apply 해도 그 항목은 제외)`);
    return;
  }
  if (failedResolve.length) { line("⛔ 기준매칭 실패 항목 존재 — 전원 확정 전 apply 중단(fail-closed)"); process.exit(1); }

  const insertedIds: string[] = [];
  for (const c of toInsert) {
    const { data, error } = await sb.from("user_season_statuses")
      .insert({ user_id: c.userId, season_key: SUMMER_KEY, status: "rest", note: NOTE }).select("id").single();
    if (error) { report.insertedIds = insertedIds; report.failedAt = { name: c.name, error: error.message }; writeFileSync(OUT, JSON.stringify(report, null, 1)); line(`✖ ${c.name} 실패: ${error.message}`); process.exit(1); }
    insertedIds.push((data as any).id);
    line(`✔ ${c.org}/${c.name} (${c.userId.slice(0, 8)}) rest 생성`);
  }
  report.insertedIds = insertedIds;
  writeFileSync(OUT, JSON.stringify(report, null, 1));
  line(`\napply 완료 — ${insertedIds.length}행 생성. rollback: --rollback ${OUT}`);
}
main().catch((e) => { console.error(e); process.exit(1); });
