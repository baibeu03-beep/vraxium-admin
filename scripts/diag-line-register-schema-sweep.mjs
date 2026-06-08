// 라인 등록 저장처 결정용 read-only 스키마 전수 조사.
// PostgREST OpenAPI(/rest/v1/) 스펙에서 라이브 테이블/컬럼 전체를 덤프한다. DB 변경 없음.
// 실행: node --env-file=.env.local scripts/diag-line-register-schema-sweep.mjs
const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;

const res = await fetch(`${url}/rest/v1/`, {
  headers: { apikey: key, Authorization: `Bearer ${key}` },
});
if (!res.ok) {
  console.error("openapi fetch failed", res.status);
  process.exit(1);
}
const spec = await res.json();
const defs = spec.definitions ?? {};
const tables = Object.keys(defs).sort();

console.log(`== 전체 테이블 ${tables.length}개 ==`);
console.log(tables.join("\n"));

// line/hub/project/output/unit 관련 테이블 상세 컬럼
const PATTERN = /line|hub|project|output|unit|master|registr/i;
console.log("\n== 관련 테이블 상세 ==");
for (const t of tables) {
  if (!PATTERN.test(t)) continue;
  const props = defs[t]?.properties ?? {};
  const required = new Set(defs[t]?.required ?? []);
  const cols = Object.entries(props).map(([name, p]) => {
    const fmt = p.format ?? p.type;
    const req = required.has(name) ? "!" : "";
    const fk = (p.description ?? "").includes("Foreign Key")
      ? ` FK→${(p.description.match(/<fk table='([^']+)'/) ?? [])[1] ?? "?"}`
      : "";
    return `  ${name}: ${fmt}${req}${fk}`;
  });
  console.log(`\n[${t}]`);
  console.log(cols.join("\n"));
}
