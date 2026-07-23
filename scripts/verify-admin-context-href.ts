// 어드민 컨텍스트 유지 유틸 회귀 검증(순수 함수 — DB 불요).
//   buildAdminContextHref / resolveAdminOrgFocus 가 "출발 화면의 통합/개별·테스트 컨텍스트를
//   목적지 링크로 그대로 전달"하는지, 그리고 목록 전용 파라미터(page/sort/...)를 무단 복사하지
//   않는지 확인한다. 목적지 주소로 통합/개별을 재판정하지 않는 것이 핵심 불변식.
// 사용법: npm run verify:admin-context-href
import {
  buildAdminContextHref,
  resolveAdminOrgFocus,
  ADMIN_CONTEXT_PARAMS,
} from "../lib/adminOrgContext";

const checks: Array<{ name: string; pass: boolean; detail: string }> = [];
const check = (name: string, pass: boolean, detail = "") =>
  checks.push({ name, pass, detail });

// href 를 정규화해 비교(쿼리 파라미터 순서 무관 — path?정렬된 kv).
function norm(href: string): string {
  const [path, query] = href.split("?");
  if (!query) return path;
  const entries = [...new URLSearchParams(query).entries()].sort(([a], [b]) =>
    a < b ? -1 : a > b ? 1 : 0,
  );
  return `${path}?${entries.map(([k, v]) => `${k}=${v}`).join("&")}`;
}
const sp = (q: string) => new URLSearchParams(q);
const build = (targetPath: string, pathname: string, query: string) =>
  norm(buildAdminContextHref({ targetPath, pathname, searchParams: sp(query) }));

// ── resolveAdminOrgFocus — 통합/개별 판정 SoT ────────────────────────────────
check(
  "orgFocus: 통합(/admin/members, 쿼리 없음) → null",
  resolveAdminOrgFocus("/admin/members", sp("")) === null,
);
check(
  "orgFocus: path /admin/crews/{org} → 개별(path 우선)",
  resolveAdminOrgFocus("/admin/crews/phalanx", sp("mode=test")) === "phalanx",
);
check(
  "orgFocus: ?org=phalanx → 개별",
  resolveAdminOrgFocus("/admin/members/u1", sp("org=phalanx")) === "phalanx",
);
check(
  "orgFocus: path org 가 ?org 보다 우선",
  resolveAdminOrgFocus("/admin/crews/encre", sp("org=phalanx")) === "encre",
);
check(
  "orgFocus: 무효 org 값 → null(임의 조직 폴백 금지)",
  resolveAdminOrgFocus("/admin/members", sp("org=nope")) === null,
);

// ── buildAdminContextHref — 통합 컨텍스트 ────────────────────────────────────
check(
  "통합에서는 org 를 추가하지 않는다",
  build("/admin/members/u1", "/admin/members", "") === "/admin/members/u1",
);
check(
  "통합 + mode=test 유지",
  build("/admin/members/u1", "/admin/members", "mode=test") ===
    norm("/admin/members/u1?mode=test"),
);

// ── buildAdminContextHref — 개별 컨텍스트 ────────────────────────────────────
check(
  "개별(path org)에서는 현재 org 를 ?org 로 승격해 유지한다",
  build("/admin/members/u1", "/admin/crews/phalanx", "mode=test") ===
    norm("/admin/members/u1?org=phalanx&mode=test"),
);
check(
  "개별 + 일반 모드 → org 만 유지(mode 미부착)",
  build("/admin/members/u1", "/admin/crews/phalanx", "") ===
    norm("/admin/members/u1?org=phalanx"),
);
check(
  "개별(?org)에서 목적지로 org 유지",
  build("/admin/members/u1", "/admin/members", "org=encre") ===
    norm("/admin/members/u1?org=encre"),
);
check(
  "actAsTestUserId 를 유지한다",
  build("/admin/members/u1", "/admin/crews/phalanx", "mode=test&actAsTestUserId=T9") ===
    norm("/admin/members/u1?org=phalanx&mode=test&actAsTestUserId=T9"),
);
check(
  "demoUserId 를 유지한다",
  build("/admin/members/u1", "/admin/members", "org=phalanx&demoUserId=D3") ===
    norm("/admin/members/u1?org=phalanx&demoUserId=D3"),
);

// ── 병합/우선순위 규칙 ───────────────────────────────────────────────────────
check(
  "목적지의 기존 query 와 충돌 없이 병합한다",
  build("/admin/members/u1?tab=info", "/admin/crews/phalanx", "mode=test") ===
    norm("/admin/members/u1?tab=info&org=phalanx&mode=test"),
);
check(
  "목적지가 명시한 컨텍스트 값은 덮어쓰지 않는다(목적지 우선)",
  build("/admin/members/u1?org=encre", "/admin/crews/phalanx", "mode=test") ===
    norm("/admin/members/u1?org=encre&mode=test"),
);
check(
  "목적지 path 가 이미 /admin/crews/{org} 면 ?org 를 중복 부착하지 않는다",
  build("/admin/crews/phalanx", "/admin/crews/phalanx", "mode=test") ===
    norm("/admin/crews/phalanx?mode=test"),
);
check(
  "operating(기본) 은 mode 파라미터를 부착하지 않는다",
  build("/admin/members/u1", "/admin/members", "mode=operating") ===
    "/admin/members/u1",
);

// ── 목록 전용 파라미터는 무단 복사하지 않는다 ────────────────────────────────
check(
  "page/sort/search/tab 등 목록 전용 파라미터는 복사하지 않는다",
  build(
    "/admin/members/u1",
    "/admin/crews/phalanx",
    "mode=test&page=3&sort=name:asc&search=김&tab=info",
  ) === norm("/admin/members/u1?org=phalanx&mode=test"),
);
// 화이트리스트 고정 — page/sort/search/tab 등 목록 전용 파라미터가 새로 섞이면 실패한다.
//   club 은 2026-07-xx(3b1ff7b)에 의도적으로 추가됐다(team-parts/info 계열은 조직 탭이 ?club).
check(
  "ADMIN_CONTEXT_PARAMS 는 mode/org/club/actAsTestUserId/demoUserId 만 포함한다",
  JSON.stringify([...ADMIN_CONTEXT_PARAMS]) ===
    JSON.stringify(["mode", "org", "club", "actAsTestUserId", "demoUserId"]),
);

// ── CrewDetail 뒤로가기 시나리오(상세 → 목록 왕복) ───────────────────────────
//   개별 상세(/admin/members/{id}?org=phalanx&mode=test) → 뒤로가기는 그 조직 크루 목록으로.
check(
  "상세 → 뒤로가기: 개별이면 /admin/crews/{org} 로 컨텍스트 유지",
  build("/admin/crews/phalanx", "/admin/members/u1", "org=phalanx&mode=test") ===
    norm("/admin/crews/phalanx?mode=test"),
);
check(
  "상세 → 뒤로가기: 통합이면 /admin/members(컨텍스트 없음)",
  build("/admin/members", "/admin/members/u1", "") === "/admin/members",
);

// ── 결과 ─────────────────────────────────────────────────────────────────────
let failed = 0;
for (const c of checks) {
  const tag = c.pass ? "PASS" : "FAIL";
  if (!c.pass) failed++;
  console.log(`[${tag}] ${c.name}${c.detail ? ` — ${c.detail}` : ""}`);
}
console.log(`\n${checks.length - failed}/${checks.length} passed`);
if (failed > 0) {
  console.error(`\n${failed} check(s) FAILED`);
  process.exit(1);
}
