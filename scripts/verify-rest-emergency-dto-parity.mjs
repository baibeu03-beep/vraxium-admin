// HTTP 검증 — 긴급 휴식 context DTO 가 일반/mode=test 에서 동일 키·구조인지, 그리고 라벨 원천이
//   DTO 가 아니라 클라이언트 resolver(getProcessPointLabels)임을 확인.
//   Usage: node scripts/verify-rest-emergency-dto-parity.mjs
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const adminRoot = resolve(__dirname, "..");
const rq = createRequire(resolve(adminRoot, "package.json"));
const { createClient } = rq("@supabase/supabase-js");
const { createServerClient } = rq("@supabase/ssr");
const env = readFileSync(resolve(adminRoot, ".env.local"), "utf8");
const get = (k) => env.match(new RegExp(`^${k}=(.+)$`, "m"))?.[1]?.trim();
const BASE = "http://localhost:3000";
const URL_ = get("NEXT_PUBLIC_SUPABASE_URL"), ANON = get("NEXT_PUBLIC_SUPABASE_ANON_KEY"), SERVICE = get("SUPABASE_SERVICE_ROLE_KEY");
const sb = createClient(URL_, SERVICE), brow = createClient(URL_, ANON);
const EMAIL = "vanuatu.golden@gmail.com";

const { data: link } = await sb.auth.admin.generateLink({ type: "magiclink", email: EMAIL });
const { data: v } = await brow.auth.verifyOtp({ email: EMAIL, token: link.properties.email_otp, type: "magiclink" });
const cap = [];
const srv = createServerClient(URL_, ANON, { cookies: { getAll: () => [], setAll: (i) => cap.push(...i) } });
await srv.auth.setSession({ access_token: v.session.access_token, refresh_token: v.session.refresh_token });
const cookie = cap.map((i) => `${i.name}=${i.value}`).join("; ");

let fail = 0;
const ck = (l, ok, d = "") => { console.log(`  ${ok ? "✓" : "✗"} ${l}${d ? ` — ${d}` : ""}`); if (!ok) fail++; };

async function ctx(org, test) {
  const qs = new URLSearchParams({ organization: org });
  if (test) qs.set("mode", "test");
  const r = await fetch(`${BASE}/api/admin/rest-management/emergency/context?${qs}`, { headers: { cookie }, cache: "no-store" });
  const j = await r.json().catch(() => ({}));
  return { status: r.status, json: j };
}

for (const org of ["encre", "oranke", "phalanx"]) {
  const a = await ctx(org, false);
  const b = await ctx(org, true);
  const ka = a.json?.context ? Object.keys(a.json.context).sort().join(",") : `(no context; ${a.status})`;
  const kb = b.json?.context ? Object.keys(b.json.context).sort().join(",") : `(no context; ${b.status})`;
  ck(`${org}: context DTO 키 동일(일반==test)`, ka === kb, `일반=[${ka}] test=[${kb}]`);
  // poC 필드는 숫자(고정 지급량)이지 라벨이 아님 — DTO 는 라벨을 담지 않는다.
  const poCa = a.json?.context?.poC, poCb = b.json?.context?.poC;
  ck(`${org}: poC 는 숫자값(라벨 아님)·동일`, poCa === poCb && typeof poCa === "number", `일반=${JSON.stringify(poCa)} test=${JSON.stringify(poCb)}`);
}

console.log(`\n${fail === 0 ? "ALL PASS" : `${fail} FAIL`}`);
process.exit(fail === 0 ? 0 : 1);
