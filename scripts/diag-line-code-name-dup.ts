// (read-only) line_code+line_name 동일 행 진단 — 페이지네이션 중복 검증 키 보정용.
// 실행: npx tsx --env-file=.env.local scripts/diag-line-code-name-dup.ts
import { createClient } from "@supabase/supabase-js";

const sb = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
  { auth: { persistSession: false } },
);

async function main() {
  const { data, error } = await sb
    .from("line_registrations")
    .select("id,line_name,line_code,hub,organization_slug")
    .range(0, 999);
  if (error) throw new Error(error.message);
  const byCodeName = new Map<string, Array<Record<string, unknown>>>();
  for (const r of data ?? []) {
    const k = `${r.line_code}|${r.line_name}`;
    byCodeName.set(k, [...(byCodeName.get(k) ?? []), r]);
  }
  for (const [k, v] of byCodeName) {
    if (v.length > 1) {
      console.log(
        k,
        JSON.stringify(v.map((r) => ({ hub: r.hub, org: r.organization_slug }))),
      );
    }
  }
  console.log("total", data?.length);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
