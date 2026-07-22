/**
 * admin ↔ front proxy 필드 단위 비교 — 크루 페이지가 실제로 만드는 URL 형태 그대로.
 *
 * 크루 카드 컴포넌트(vraxium/components/cluster-4-card/Cluster4CardContent.tsx:2299)는
 *   `/api/cluster4/weekly-cards?userId=${targetUserId}${demoQS}${modeQS}`
 * 로 호출한다. demoQS/modeQS 유무 조합마다 admin(:3000) 직접 호출과 front(:3001) proxy 호출을
 * 각각 실행해, 그 주차 카드의 teamName/partName/roleLabel/crewClassPositionCode 를 비교한다.
 *
 * 판정:
 *   · admin 이 이미 멤버십 값 → admin 레포 문제
 *   · admin 은 override 값인데 front 가 다름 → front 레포(proxy/enrich) 문제
 *   · 둘 다 override 값 → API 는 정상, 원인은 렌더링/캐시 계층
 *
 *   READ-ONLY. Usage: node scripts/diff-weekly-cards-admin-vs-front.mjs
 */
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
const ADMIN = "http://localhost:3000";
const FRONT = "http://localhost:3001";
const URL_ = get("NEXT_PUBLIC_SUPABASE_URL");
const ANON = get("NEXT_PUBLIC_SUPABASE_ANON_KEY");
const sb = createClient(URL_, get("SUPABASE_SERVICE_ROLE_KEY"));
const brow = createClient(URL_, ANON);

const FIELDS = ["teamName", "partName", "roleLabel", "crewClassPositionCode", "membershipStatusLabel"];
let fail = 0;
const ck = (l, ok, d = "") => { console.log(`    ${ok ? "✓" : "✗"} ${l}${d ? ` — ${d}` : ""}`); if (!ok) fail++; };

async function cookieHeader() {
  const { data: admins } = await sb.from("admin_users").select("email").eq("is_active", true).not("email", "is", null).limit(1);
  const email = admins?.[0]?.email;
  const { data: link } = await sb.auth.admin.generateLink({ type: "magiclink", email });
  const { data: v } = await brow.auth.verifyOtp({ email, token: link.properties.email_otp, type: "magiclink" });
  const cap = [];
  const srv = createServerClient(URL_, ANON, { cookies: { getAll: () => [], setAll: (i) => cap.push(...i) } });
  await srv.auth.setSession({ access_token: v.session.access_token, refresh_token: v.session.refresh_token });
  console.log(`admin 세션: ${email}\n`);
  return cap.map((i) => `${i.name}=${i.value}`).join("; ");
}

async function main() {
  const cookie = await cookieHeader();
  const call = (base, path) =>
    fetch(`${base}${path}`, { headers: { cookie, "content-type": "application/json" }, cache: "no-store" })
      .then(async (r) => ({ status: r.status, j: await r.json().catch(() => null) }))
      .catch((e) => ({ status: 0, j: null, err: String(e) }));

  const { data: ovr } = await sb.from("cluster4_team_week_position_overrides")
    .select("user_id,organization,raw_team,raw_part,position_code,week_start_date")
    .order("updated_at", { ascending: false }).limit(4);
  if (!ovr?.length) { console.log("override 없음 — abort"); process.exit(1); }

  // 관측 유효: override 클래스가 현재 멤버십 유도값과 다른 사람.
  let target = null;
  for (const o of ovr) {
    const { data: p } = await sb.from("user_profiles").select("display_name,role,current_part_name").eq("user_id", o.user_id).maybeSingle();
    const { data: m } = await sb.from("user_memberships").select("membership_level,part_name").eq("user_id", o.user_id).eq("is_current", true).maybeSingle();
    const derivedAdv = p?.role === "part_leader" || (m?.membership_level ?? "").startsWith("심화");
    const ovrAdv = o.position_code !== "regular";
    if (derivedAdv !== ovrAdv) { target = { ...o, name: p?.display_name, memPart: m?.part_name, memLevel: m?.membership_level, role: p?.role }; break; }
  }
  if (!target) { console.log("override==멤버십 인 행뿐 — 관측 불가. abort"); process.exit(1); }

  const WEEK = String(target.week_start_date).slice(0, 10);
  const expect = {
    partName: target.raw_part,
    teamName: target.raw_team,
    crewClassPositionCode: target.position_code,
  };
  console.log(`대상: ${target.name} (${target.user_id})`);
  console.log(`  override      : team=${target.raw_team} part=${target.raw_part} class=${target.position_code}`);
  console.log(`  현재 멤버십    : part=${target.memPart} level=${target.memLevel} role=${target.role}`);
  console.log(`  주차          : ${WEEK}\n`);

  const U = target.user_id;
  // 크루 카드 컴포넌트가 만드는 형태(demoQS/modeQS 유무 조합).
  const VARIANTS = [
    { label: "userId 만", qs: `?userId=${U}` },
    { label: "userId + demoUserId", qs: `?userId=${U}&demoUserId=${U}` },
    { label: "userId + demoUserId + mode=test", qs: `?userId=${U}&demoUserId=${U}&mode=test` },
    { label: "userId + mode=test", qs: `?userId=${U}&mode=test` },
    { label: "demoUserId 만", qs: `?demoUserId=${U}` },
  ];

  const pick = (j) => {
    const cards = Array.isArray(j?.data) ? j.data : [];
    const c = cards.find((x) => String(x.startDate ?? "").slice(0, 10) === WEEK) ?? null;
    if (!c) return { _missing: true, cardCount: cards.length };
    return Object.fromEntries(FIELDS.map((f) => [f, c[f] ?? null]));
  };

  for (const v of VARIANTS) {
    console.log(`──────── ${v.label}`);
    console.log(`  GET ${v.qs}`);
    const [a, f] = await Promise.all([call(ADMIN, `/api/cluster4/weekly-cards${v.qs}`), call(FRONT, `/api/cluster4/weekly-cards${v.qs}`)]);
    const av = pick(a.j), fv = pick(f.j);
    console.log(`  admin(:3000) ${a.status} → ${JSON.stringify(av)}`);
    console.log(`  front(:3001) ${f.status} → ${JSON.stringify(fv)}`);

    if (av._missing) { ck("admin 응답에 해당 주차 카드 존재", false, `cards=${av.cardCount}`); }
    else {
      ck("admin partName == override", av.partName === expect.partName, `${av.partName} vs ${expect.partName}`);
      ck("admin teamName == override", av.teamName === expect.teamName, `${av.teamName} vs ${expect.teamName}`);
      ck("admin class == override", av.crewClassPositionCode === expect.crewClassPositionCode, `${av.crewClassPositionCode}`);
    }
    if (f.status !== 200) { ck("front 200", false, `status=${f.status} ${JSON.stringify(f.j).slice(0, 120)}`); }
    else if (fv._missing) { ck("front 응답에 해당 주차 카드 존재", false, `cards=${fv.cardCount}`); }
    else {
      // front 는 proxy 라 admin 과 **필드 단위로 동일**해야 한다(enrich 는 빈 값만 채움).
      const diffs = FIELDS.filter((k) => (av[k] ?? null) !== (fv[k] ?? null));
      ck("front == admin (필드 단위)", diffs.length === 0,
        diffs.length ? diffs.map((k) => `${k}: admin=${av[k]} front=${fv[k]}`).join(" | ") : "");
    }
    console.log("");
  }

  console.log(`=== RESULT: ${fail === 0 ? "ALL PASS" : fail + " FAIL"} ===`);
  process.exit(fail === 0 ? 0 : 1);
}
main().catch((e) => { console.error(e); process.exit(1); });
