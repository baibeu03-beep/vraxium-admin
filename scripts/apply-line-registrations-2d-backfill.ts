/**
 * Phase 2D — 기존 마스터 → line_registrations 백필 (additive 이관).
 *   npx tsx --env-file=.env.local scripts/apply-line-registrations-2d-backfill.ts            # dry-run (쓰기 0건)
 *   npx tsx --env-file=.env.local scripts/apply-line-registrations-2d-backfill.ts --apply    # 실반영
 *
 * 원천 (기존 마스터는 전부 read-only — 절대 무수정):
 *   - cluster4_experience_line_masters (26)  → hub=experience, line_type=category EN→KO
 *   - cluster4_competency_line_masters (30)  → hub=competency, line_type=prefix 분류
 *       (2026-06-07 확정: Principle=원리 / Tool=기술 / Mindset=관점 / Resource=자원)
 *   - career_projects (1)                    → hub=career, line_type=일반
 *
 * 정책:
 *   - main_title_mode: 원천 타이틀 NULL → variable('-') / 값 존재 → fixed(그대로)
 *   - unit_link='-' (원천에 대응 개념 없음)
 *   - bridged_master_id = 원천 마스터 id, bridged_at = 백필 시각
 *     → 이관 행은 "이미 연결됨" 상태 (재브리지 시 already_bridged 멱등, 중복 마스터 생성 차단)
 *   - 멱등 키 = (hub, organization_slug, line_code) — partial unique 와 동일. 기존 행 있으면 skip.
 *   - career supervisor_profile_img(URL) → manager_profile_key 는 토큰 enum 이라 매핑 불가 → null
 *     (이미지 자산 확정 후 별도 — 2C 결정 4와 동일 정책)
 *   - created_by = 운영자 admin id
 * rollback: apply 시 삽입 id 전수를 claudedocs/2d-backfill-inserted-<ts>.json 에 기록.
 */
import { writeFileSync } from "fs";
import { createClient } from "@supabase/supabase-js";

const sb = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
  { auth: { persistSession: false } },
);
const APPLY = process.argv.includes("--apply");
// 2026-06-07 사용자 결정: career_projects 1건은 테스트성 데이터 — 이번 2D 범위에서 제외.
const SKIP_CAREER = process.argv.includes("--skip-career");
const adminEmail = process.env.SMOKE_ADMIN_EMAIL ?? "vanuatu.golden@gmail.com";

// 경험 category EN → 한글 line_type (등록 페이지 enum 과 동일)
const EXP_CATEGORY_KO: Record<string, string> = {
  derivation: "도출",
  analysis: "분석",
  evaluation: "평가",
  management: "관리",
  extension: "확장",
};

// 역량 line_name prefix → line_type (2026-06-07 사용자 확정 매핑)
function competencyType(lineName: string): string | null {
  if (lineName.includes("[실무 Principle.")) return "원리";
  if (lineName.includes("[실무 Tool.")) return "기술";
  if (lineName.includes("[실무 Mindset.")) return "관점";
  if (lineName.includes("[실무 Resource.")) return "자원";
  return null;
}

type Payload = {
  line_name: string;
  hub: "experience" | "competency" | "career";
  line_type: string;
  line_code: string;
  main_title_mode: "fixed" | "variable";
  main_title: string;
  unit_link: string;
  organization_slug: string;
  partner_company: string | null;
  company_logo_url: string | null;
  manager_name: string | null;
  manager_position: string | null;
  manager_job: string | null;
  manager_profile_key: string | null;
  bridged_master_id: string;
  bridged_at: string;
  created_by: string;
};

function titleFields(raw: string | null): { mode: "fixed" | "variable"; title: string } {
  const t = raw?.trim() ?? "";
  return t.length > 0 ? { mode: "fixed", title: t } : { mode: "variable", title: "-" };
}

async function main() {
  const now = new Date().toISOString();
  const { data: adminRow } = await sb
    .from("admin_users")
    .select("id")
    .eq("email", adminEmail)
    .maybeSingle();
  if (!adminRow) throw new Error("admin_users row not found");
  const actor = (adminRow as { id: string }).id;

  const payloads: Payload[] = [];
  const problems: string[] = [];

  // ── 경험 마스터 26 ──
  const { data: exps, error: expErr } = await sb
    .from("cluster4_experience_line_masters")
    .select("id,line_code,line_name,default_main_title,experience_category,organization_slug")
    .order("line_code");
  if (expErr) throw new Error(expErr.message);
  for (const m of exps ?? []) {
    const ko = m.experience_category ? EXP_CATEGORY_KO[m.experience_category] : null;
    if (!ko) {
      problems.push(`경험 ${m.line_code}(${m.organization_slug}): category=${m.experience_category} → line_type 매핑 불가`);
      continue;
    }
    const t = titleFields(m.default_main_title);
    payloads.push({
      line_name: m.line_name,
      hub: "experience",
      line_type: ko,
      line_code: m.line_code,
      main_title_mode: t.mode,
      main_title: t.title,
      unit_link: "-",
      organization_slug: m.organization_slug,
      partner_company: null, company_logo_url: null, manager_name: null,
      manager_position: null, manager_job: null, manager_profile_key: null,
      bridged_master_id: m.id,
      bridged_at: now,
      created_by: actor,
    });
  }

  // ── 역량 마스터 30 ──
  const { data: comps, error: compErr } = await sb
    .from("cluster4_competency_line_masters")
    .select("id,line_code,line_name,main_title,organization_slug")
    .order("line_code");
  if (compErr) throw new Error(compErr.message);
  for (const m of comps ?? []) {
    const ko = competencyType(m.line_name);
    if (!ko) {
      problems.push(`역량 ${m.line_code}: line_name='${m.line_name}' → 분류 불가`);
      continue;
    }
    const t = titleFields(m.main_title);
    payloads.push({
      line_name: m.line_name,
      hub: "competency",
      line_type: ko,
      line_code: m.line_code,
      main_title_mode: t.mode,
      main_title: t.title,
      unit_link: "-",
      organization_slug: m.organization_slug,
      partner_company: null, company_logo_url: null, manager_name: null,
      manager_position: null, manager_job: null, manager_profile_key: null,
      bridged_master_id: m.id,
      bridged_at: now,
      created_by: actor,
    });
  }

  // ── 경력 마스터(career_projects) — --skip-career 시 전체 제외 ──
  const { data: careers, error: carErr } = SKIP_CAREER
    ? { data: [], error: null }
    : await sb
    .from("career_projects")
    .select(
      "id,line_code,line_name,default_main_title,company_name,company_logo_url,supervisor_name,supervisor_position,supervisor_department,supervisor_profile_img,organization_slug",
    )
    .not("line_code", "is", null)
    .order("line_code");
  if (carErr) throw new Error(carErr.message);
  for (const m of careers ?? []) {
    if (!m.line_name?.trim()) {
      problems.push(`경력 ${m.line_code}: line_name 없음 → skip 후보`);
    }
    const t = titleFields(m.default_main_title);
    payloads.push({
      line_name: m.line_name?.trim() || `(이름 없음) ${m.line_code}`,
      hub: "career",
      line_type: "일반",
      line_code: m.line_code!,
      main_title_mode: t.mode,
      main_title: t.title,
      unit_link: "-",
      organization_slug: m.organization_slug,
      partner_company: m.company_name?.trim() || null,
      company_logo_url: m.company_logo_url?.trim() || null,
      manager_name: m.supervisor_name?.trim() || null,
      manager_position: m.supervisor_position?.trim() || null,
      manager_job: m.supervisor_department?.trim() || null,
      // supervisor_profile_img 는 URL — 토큰 enum 으로 변환 불가 → null (2C 결정 4 동일)
      manager_profile_key: null,
      bridged_master_id: m.id,
      bridged_at: now,
      created_by: actor,
    });
  }

  // ── 멱등: 기존 registrations (hub,org,code) 키와 충돌 검사 ──
  const { data: existing } = await sb
    .from("line_registrations")
    .select("hub,organization_slug,line_code");
  const existingKeys = new Set(
    (existing ?? []).map((r) => `${r.hub}|${r.organization_slug}|${r.line_code}`),
  );
  const toInsert = payloads.filter(
    (p) => !existingKeys.has(`${p.hub}|${p.organization_slug}|${p.line_code}`),
  );
  const skipped = payloads.length - toInsert.length;

  // ── 집계 출력 ──
  const byHubType = new Map<string, number>();
  for (const p of toInsert) {
    const k = `${p.hub}/${p.line_type}`;
    byHubType.set(k, (byHubType.get(k) ?? 0) + 1);
  }
  console.log(`=== 2D 백필 ${APPLY ? "APPLY" : "DRY-RUN"} ===`);
  console.log(`원천: 경험 ${exps?.length ?? 0} · 역량 ${comps?.length ?? 0} · 경력 ${careers?.length ?? 0}`);
  console.log(`삽입 대상 ${toInsert.length}건 (기존 키 중복 skip ${skipped}건)`);
  console.log("허브/종류 분포:", JSON.stringify(Object.fromEntries([...byHubType.entries()].sort())));
  if (problems.length > 0) {
    console.log("\n! 문제 항목:");
    for (const p of problems) console.log("  -", p);
  }
  console.log("\n== 샘플 (역량 4분류 각 1건 + 경험/경력) ==");
  const samples = ["원리", "기술", "관점", "자원"].map((t) =>
    toInsert.find((p) => p.hub === "competency" && p.line_type === t),
  );
  samples.push(toInsert.find((p) => p.hub === "experience"));
  samples.push(toInsert.find((p) => p.hub === "career"));
  for (const s of samples) {
    if (s)
      console.log(
        `  ${s.hub}/${s.line_type} | ${s.line_code} | ${s.line_name} | ${s.main_title_mode} | org=${s.organization_slug} | bridged→${s.bridged_master_id.slice(0, 8)}`,
      );
  }

  const ts = now.replace(/[:.]/g, "-");
  writeFileSync(
    `claudedocs/2d-backfill-${APPLY ? "apply" : "dryrun"}-${ts}.json`,
    JSON.stringify({ generatedAt: now, apply: APPLY, skipped, problems, rows: toInsert }, null, 2),
    "utf8",
  );
  console.log(`\n계획 저장: claudedocs/2d-backfill-${APPLY ? "apply" : "dryrun"}-${ts}.json`);

  if (!APPLY) {
    console.log("\n[dry-run] DB 쓰기 0건. 실반영: --apply");
    return;
  }

  // ── 실반영 ──
  const inserted: string[] = [];
  for (const p of toInsert) {
    const { data, error } = await sb
      .from("line_registrations")
      .insert(p)
      .select("id")
      .single();
    if (error) {
      console.error(`  ✗ ${p.hub}/${p.line_code}(${p.organization_slug}): ${error.message}`);
      continue;
    }
    inserted.push((data as { id: string }).id);
  }
  writeFileSync(
    `claudedocs/2d-backfill-inserted-${ts}.json`,
    JSON.stringify(inserted, null, 2),
    "utf8",
  );
  console.log(`\n삽입 완료 ${inserted.length}/${toInsert.length}건 — rollback id 목록 저장됨`);
  const { count } = await sb
    .from("line_registrations")
    .select("*", { count: "exact", head: true });
  console.log(`line_registrations 총 ${count}건`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
