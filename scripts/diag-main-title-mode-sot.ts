// 고정/변동 SoT 조사 (read-only) — line_registrations.main_title_mode 저장값이
// 허브 기준 정책(info/career=variable, experience/competency=fixed)과 일치하는지 전수 점검.
// 실행: npx tsx --env-file=.env.local scripts/diag-main-title-mode-sot.ts
import { createClient } from "@supabase/supabase-js";

const url = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY!;

// 허브 기준 정책 (2026-06-07 요청 사양)
const POLICY_MODE: Record<string, "fixed" | "variable"> = {
  info: "variable",
  career: "variable",
  experience: "fixed",
  competency: "fixed",
};

async function main() {
  const sb = createClient(url, serviceKey, { auth: { persistSession: false } });
  const { data, error, count } = await sb
    .from("line_registrations")
    .select("id,line_name,hub,line_code,main_title_mode,main_title,is_active,organization_slug", {
      count: "exact",
    })
    .order("created_at", { ascending: true })
    .range(0, 999);
  if (error) throw new Error(error.message);
  const rows = data ?? [];
  console.log(`total rows: ${count} (fetched ${rows.length})`);

  // hub × mode 분포
  const dist = new Map<string, number>();
  for (const r of rows) {
    const k = `${r.hub} / ${r.main_title_mode}`;
    dist.set(k, (dist.get(k) ?? 0) + 1);
  }
  console.log("\n== hub × main_title_mode 분포 ==");
  for (const [k, v] of [...dist.entries()].sort()) console.log(`  ${k}: ${v}`);

  // 정책 불일치 행
  const mismatches = rows.filter((r) => POLICY_MODE[r.hub] !== r.main_title_mode);
  console.log(`\n== 정책(허브 기준) 불일치: ${mismatches.length}건 ==`);
  for (const r of mismatches) {
    console.log(
      `  [${r.hub}] mode=${r.main_title_mode} title="${r.main_title}" — ${r.line_name} (${r.line_code}) org=${r.organization_slug} active=${r.is_active} id=${r.id}`,
    );
  }

  // 정책상 variable 인데 main_title 이 '-' 가 아닌 행 (표시 시 정보 손실 후보)
  const variableWithTitle = rows.filter(
    (r) => POLICY_MODE[r.hub] === "variable" && r.main_title !== "-",
  );
  console.log(`\n== 정책=variable 인데 main_title != '-': ${variableWithTitle.length}건 ==`);
  for (const r of variableWithTitle) {
    console.log(
      `  [${r.hub}] mode=${r.main_title_mode} title="${r.main_title}" — ${r.line_name} (${r.line_code})`,
    );
  }

  // 정책상 fixed 인데 main_title 이 '-'/공백인 행 (표시 공백 후보)
  const fixedNoTitle = rows.filter(
    (r) => POLICY_MODE[r.hub] === "fixed" && (!r.main_title || r.main_title.trim() === "" || r.main_title === "-"),
  );
  console.log(`\n== 정책=fixed 인데 main_title 비어있음/'-': ${fixedNoTitle.length}건 ==`);
  for (const r of fixedNoTitle) {
    console.log(
      `  [${r.hub}] mode=${r.main_title_mode} title="${r.main_title}" — ${r.line_name} (${r.line_code})`,
    );
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
