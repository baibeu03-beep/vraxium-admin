/**
 * Phase 2B 검증: 통합 라인 카탈로그 (direct vs HTTP · 건수 정합 · snapshot 무영향).
 *   npx tsx --env-file=.env.local scripts/verify-line-catalog-http.ts
 * READ-ONLY — DB 쓰기 0건.
 */
import { createClient } from "@supabase/supabase-js";
import { createServerClient } from "@supabase/ssr";
import { listLineCatalog } from "@/lib/adminLineCatalogData";

const baseUrl = process.env.SMOKE_BASE_URL ?? "http://localhost:3000";
const adminEmail = process.env.SMOKE_ADMIN_EMAIL ?? "vanuatu.golden@gmail.com";

function ensureEnv(name: string) {
  const v = process.env[name];
  if (!v) throw new Error(`Missing env: ${name}`);
  return v;
}

const supabaseUrl = ensureEnv("NEXT_PUBLIC_SUPABASE_URL");
const serviceKey = ensureEnv("SUPABASE_SERVICE_ROLE_KEY");
const anonKey = ensureEnv("NEXT_PUBLIC_SUPABASE_ANON_KEY");
const sb = createClient(supabaseUrl, serviceKey, { auth: { persistSession: false } });

let pass = 0;
let fail = 0;
function check(label: string, ok: boolean, detail?: string) {
  console.log(`  ${ok ? "✓" : "✗"} ${label}${detail ? " — " + detail : ""}`);
  if (ok) pass++;
  else fail++;
}

async function makeAdminCookieHeader() {
  const admin = createClient(supabaseUrl, serviceKey);
  const browser = createClient(supabaseUrl, anonKey);
  const { data: l, error: le } = await admin.auth.admin.generateLink({
    type: "magiclink",
    email: adminEmail,
  });
  if (le || !l?.properties?.email_otp) throw new Error(le?.message ?? "generateLink failed");
  const { data: v, error: ve } = await browser.auth.verifyOtp({
    email: adminEmail,
    token: l.properties.email_otp,
    type: "magiclink",
  });
  if (ve || !v.session) throw new Error(ve?.message ?? "verifyOtp failed");
  const captured: Array<{ name: string; value: string }> = [];
  const server = createServerClient(supabaseUrl, anonKey, {
    cookies: {
      getAll: () => [],
      setAll: (items) => captured.push(...items.map((i) => ({ name: i.name, value: i.value }))),
    },
  });
  await server.auth.setSession({
    access_token: v.session.access_token,
    refresh_token: v.session.refresh_token,
  });
  return captured.map((i) => `${i.name}=${i.value}`).join("; ");
}

async function count(table: string, filter?: (q: any) => any): Promise<number> {
  let q = sb.from(table).select("*", { count: "exact", head: true });
  if (filter) q = filter(q);
  const { count: c, error } = await q;
  if (error) throw new Error(`${table}: ${error.message}`);
  return c ?? 0;
}

async function fingerprint() {
  return {
    snapTotal: await count("cluster4_weekly_card_snapshots"),
    snapStale: await count("cluster4_weekly_card_snapshots", (q) => q.eq("is_stale", true)),
    lines: await count("cluster4_lines"),
    targets: await count("cluster4_line_targets"),
    expMasters: await count("cluster4_experience_line_masters"),
    compMasters: await count("cluster4_competency_line_masters"),
    careers: await count("career_projects"),
    registrations: await count("line_registrations"),
  };
}

async function main() {
  const before = await fingerprint();
  console.log("=== fingerprint (before) ===");
  console.log(" ", JSON.stringify(before));

  // ── 1) direct 함수 결과 ──
  console.log("\n=== 1) direct listLineCatalog() ===");
  const direct = await listLineCatalog({ sort: "latest" });
  console.log("  countsBySource:", JSON.stringify(direct.countsBySource));
  check("경험 마스터 건수 = 테이블 실건수", direct.countsBySource.experience_master === before.expMasters, `${direct.countsBySource.experience_master} vs ${before.expMasters}`);
  check("역량 마스터 건수 = 테이블 실건수", direct.countsBySource.competency_master === before.compMasters, `${direct.countsBySource.competency_master} vs ${before.compMasters}`);
  check("경력 마스터 건수 = 테이블 실건수", direct.countsBySource.career_master === before.careers, `${direct.countsBySource.career_master} vs ${before.careers}`);
  check("신규 등록 건수 = 테이블 실건수", direct.countsBySource.registration === before.registrations, `${direct.countsBySource.registration} vs ${before.registrations}`);
  const expectedTotal =
    before.expMasters + before.compMasters + before.careers + before.registrations;
  check("통합 total = 4원천 합", direct.total === expectedTotal, `${direct.total} vs ${expectedTotal}`);

  // ── 2) HTTP 응답 + 3) direct 와 동일 여부 ──
  console.log("\n=== 2~3) HTTP 응답 + direct 일치 ===");
  const cookie = await makeAdminCookieHeader();
  const res = await fetch(`${baseUrl}/api/admin/lines/catalog?sort=latest`, {
    headers: { Cookie: cookie },
  });
  const json = (await res.json()) as { success: boolean; data: typeof direct };
  check("HTTP 200", res.status === 200, `status=${res.status}`);
  check(
    "HTTP rows = direct rows (JSON 완전 일치)",
    JSON.stringify(json.data.rows) === JSON.stringify(direct.rows),
    `direct=${direct.rows.length} http=${json.data.rows.length}`,
  );
  check(
    "HTTP countsBySource = direct 일치",
    JSON.stringify(json.data.countsBySource) === JSON.stringify(direct.countsBySource),
  );

  // 필터 동작 (HTTP)
  const resHub = await fetch(`${baseUrl}/api/admin/lines/catalog?hub=experience`, {
    headers: { Cookie: cookie },
  });
  const jsonHub = (await resHub.json()) as { data: typeof direct };
  check(
    "hub=experience 필터 — 경험 행만",
    jsonHub.data.rows.every((r) => r.hub === "experience"),
    `rows=${jsonHub.data.rows.length}`,
  );
  const resSrc = await fetch(`${baseUrl}/api/admin/lines/catalog?source=registration`, {
    headers: { Cookie: cookie },
  });
  const jsonSrc = (await resSrc.json()) as { data: typeof direct };
  check(
    "source=registration 필터 — 등록 행만",
    jsonSrc.data.rows.every((r) => r.source === "registration") &&
      jsonSrc.data.rows.length === before.registrations,
    `rows=${jsonSrc.data.rows.length}`,
  );
  const resQ = await fetch(`${baseUrl}/api/admin/lines/catalog?q=EXBS`, {
    headers: { Cookie: cookie },
  });
  const jsonQ = (await resQ.json()) as { data: typeof direct };
  check(
    "q=EXBS 검색 — 코드 매칭 행만",
    jsonQ.data.rows.length > 0 &&
      jsonQ.data.rows.every((r) => (r.lineCode ?? "").includes("EXBS") || r.lineName.includes("EXBS")),
    `rows=${jsonQ.data.rows.length}`,
  );
  const resOld = await fetch(`${baseUrl}/api/admin/lines/catalog?sort=oldest`, {
    headers: { Cookie: cookie },
  });
  const jsonOld = (await resOld.json()) as { data: typeof direct };
  const oldFirst = jsonOld.data.rows[0]?.createdAt ?? "";
  const latestFirst = json.data.rows[0]?.createdAt ?? "";
  check("정렬 latest/oldest 역순 동작", oldFirst <= latestFirst, `oldest첫=${oldFirst} latest첫=${latestFirst}`);

  // ── 9) line-history 와 비교 (축 다름 — 정의 카탈로그 vs 개설 인스턴스) ──
  console.log("\n=== 9) line-history(개설 인스턴스)와 비교 ===");
  const resHist = await fetch(`${baseUrl}/api/admin/cluster4/lines/history?limit=5`, {
    headers: { Cookie: cookie },
  });
  const jsonHist = (await resHist.json()) as { data: { total: number } };
  console.log(
    `  카탈로그(정의 계층)=${direct.total}건 vs line-history(개설 인스턴스)=${jsonHist.data.total}건 — 서로 다른 축(정상)`,
  );
  check("line-history 응답 정상 (기존 API 무영향)", resHist.status === 200 && jsonHist.data.total > 0, `total=${jsonHist.data.total}`);
  // 카탈로그 행이 개설 인스턴스 id 와 충돌하지 않는지 (registration 행이 history 에 섞이지 않음은 Phase 2A 에서 확인)
  check(
    "카탈로그에 4개 원천 외 행 없음",
    direct.rows.every((r) =>
      ["experience_master", "competency_master", "career_master", "registration"].includes(r.source),
    ),
  );

  // ── 4~5) snapshot 무영향 / 재계산 불필요 ──
  console.log("\n=== 4~5) snapshot fingerprint (after) ===");
  const after = await fingerprint();
  console.log(" ", JSON.stringify(after));
  check("fingerprint 전후 동일 (snapshot 무영향·재계산 불필요)", JSON.stringify(before) === JSON.stringify(after));

  console.log(`\n결과: pass=${pass} fail=${fail}`);
  if (fail > 0) process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
