/**
 * 어드민 내비게이션 링크 전수 생존 검증 — 사이드바(통합/개별) + breadcrumb override 의 모든 href 가
 * 실제 라우트로 200 응답하는지 확인한다(구형 경로 404 회귀 방지).
 *
 *   대상: MENU_INTEGRATED / MENU_ORG 의 branch.children[].href (disabled 제외) ·
 *         BREADCRUMB_OVERRIDES 의 parts[].href · resolveAdminBreadcrumb 이 만드는 groupHref.
 *   제외: [weekId] 등 동적 세그먼트 템플릿(실 ID 없이는 조회 불가).
 *
 *   npx tsx --env-file=.env.local scripts/verify-admin-nav-hrefs-alive.ts
 */
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createClient } from "@supabase/supabase-js";
import { createServerClient } from "@supabase/ssr";
import { MENU_INTEGRATED, MENU_ORG, resolveAdminBreadcrumb } from "@/lib/adminMenuTree";

const __dirname = dirname(fileURLToPath(import.meta.url));
const env = readFileSync(resolve(__dirname, "..", ".env.local"), "utf8");
const g = (k: string) => env.match(new RegExp(`^${k}=(.+)$`, "m"))?.[1]?.trim();
const adminEmail = process.env.SMOKE_ADMIN_EMAIL ?? "vanuatu.golden@gmail.com";
const BASE = process.env.SMOKE_BASE_URL ?? "http://localhost:3000";
const SUPABASE_URL = g("NEXT_PUBLIC_SUPABASE_URL")!;
const ANON = g("NEXT_PUBLIC_SUPABASE_ANON_KEY")!;
const admin = createClient(SUPABASE_URL, g("SUPABASE_SERVICE_ROLE_KEY")!);

let pass = 0;
let fail = 0;
const ck = (l: string, ok: boolean, d = "") => {
  console.log(`  ${ok ? "✓" : "✗"} ${l}${d ? ` — ${d}` : ""}`);
  ok ? pass++ : fail++;
};

async function cookieHeader(): Promise<string> {
  const anon = createClient(SUPABASE_URL, ANON);
  const { data: link } = await admin.auth.admin.generateLink({ type: "magiclink", email: adminEmail });
  const { data: v } = await anon.auth.verifyOtp({
    email: adminEmail,
    token: (link as any).properties.email_otp,
    type: "magiclink",
  });
  const cap: any[] = [];
  const srv = createServerClient(SUPABASE_URL, ANON, {
    cookies: { getAll: () => [], setAll: (i: any[]) => cap.push(...i) },
  });
  await srv.auth.setSession({
    access_token: (v as any).session.access_token,
    refresh_token: (v as any).session.refresh_token,
  });
  return cap.map((c) => `${c.name}=${c.value}`).join("; ");
}

// 동적 세그먼트 템플릿([weekId] 등)은 실 ID 없이 조회 불가 → 생존 검증 제외.
const isTemplate = (href: string) => /\[[^\]]+\]/.test(href);

function collectHrefs(): Map<string, string[]> {
  const out = new Map<string, string[]>(); // href → 출처 라벨들
  const add = (href: string | undefined, src: string) => {
    if (!href || isTemplate(href)) return;
    const list = out.get(href) ?? [];
    list.push(src);
    out.set(href, list);
  };
  for (const [treeName, tree] of [
    ["MENU_INTEGRATED", MENU_INTEGRATED],
    ["MENU_ORG", MENU_ORG],
  ] as const) {
    for (const item of tree) {
      if (item.kind === "leaf") {
        add(item.href, `${treeName} leaf:${item.label}`);
        continue;
      }
      // 그룹(부모) href — resolveAdminBreadcrumb 의 groupHref 규칙과 동일.
      const groupHref = item.children.find((c) => !c.disabled)?.href ?? item.basePath;
      add(groupHref, `${treeName} group:${item.label}`);
      for (const child of item.children) {
        if (child.disabled) continue; // 준비 중 = span(링크 아님)
        add(child.href, `${treeName} child:${item.label}>${child.label}`);
      }
    }
  }
  return out;
}

// 실제 화면 pathname 들 — resolveAdminBreadcrumb 결과의 href 도 함께 검증(override 함수형 포함).
const REAL_PATHS = [
  "/admin/lines/register",
  "/admin/lines/info",
  "/admin/line-opening/practical-info",
  "/admin/line-opening/practical-experience",
  "/admin/line-opening/practical-competency",
  "/admin/line-opening/practical-career",
  "/admin/integrated/line-opening/practical-info",
  "/admin/integrated/line-opening/practical-experience",
  "/admin/integrated/line-opening/practical-competency",
  "/admin/processes/check/info",
  "/admin/processes/check/club",
  "/admin/processes/check/experience",
  "/admin/processes/check/competency",
  "/admin/processes/check/irregular",
  "/admin/integrated/processes/check/info",
  "/admin/integrated/processes/check/club",
  "/admin/integrated/processes/check/experience",
  "/admin/integrated/processes/check/competency",
  "/admin/integrated/processes/check/irregular",
  "/admin/processes/register",
  // breadcrumb override 계열(동적 parts 포함) — 실 pathname 으로 resolve 해 href 를 뽑는다.
  "/admin/",
  "/admin/members/00000000-0000-4000-8000-000000000000",
  "/admin/members/00000000-0000-4000-8000-000000000000/weekly-status",
  "/admin/crews",
  "/admin/crews/encre",
  "/admin/crews/encre/00000000-0000-4000-8000-000000000000",
  "/admin/team-parts/info",
  "/admin/team-parts/info/weeks",
  "/admin/team-parts/info/crew-week-results",
  "/admin/team-parts/info/crew-week-results/encre",
  "/admin/team-parts/info/encre",
  "/admin/users/applicants",
  "/admin/periods/register",
  "/admin/rest-management",
  "/admin/settings/accounts",
];

async function main() {
  const cookie = await cookieHeader();
  const hrefs = collectHrefs();
  for (const p of REAL_PATHS) {
    for (const item of resolveAdminBreadcrumb(p)) {
      if (!item.href || isTemplate(item.href)) continue;
      const list = hrefs.get(item.href) ?? [];
      list.push(`breadcrumb(${p})`);
      hrefs.set(item.href, list);
    }
  }

  console.log(`\n[내비게이션 href 생존 검증] 대상 ${hrefs.size}건`);
  const dead: string[] = [];
  for (const [href, sources] of [...hrefs.entries()].sort()) {
    const res = await fetch(`${BASE}${href}`, {
      headers: { cookie },
      redirect: "manual",
      cache: "no-store",
    });
    const ok = res.status < 400;
    if (!ok) dead.push(`${href} → ${res.status}  [${[...new Set(sources)].join(" · ")}]`);
    console.log(`    ${ok ? "·" : "✗"} ${String(res.status).padEnd(3)} ${href}`);
  }
  ck(
    "사이드바·breadcrumb 의 모든 링크가 살아있는 라우트를 가리킨다(구형 404 없음)",
    dead.length === 0,
    dead.length ? `\n      ${dead.join("\n      ")}` : "",
  );

  console.log(`\n결과: ${pass} pass / ${fail} fail`);
  process.exit(fail > 0 ? 1 : 0);
}
main().catch((e) => {
  console.error(e);
  process.exit(1);
});
