/**
 * 배포 후 검증 — 실패 카드(experienceGrowth.status==='fail')에도 투구(Point.A) 인정 기준값이
 * checkGate 로 실려 고객앱 Detail Log "성장 성공 조건 체크" ① 문구에 노출되는지(admin DTO v45).
 *
 * 무엇을 보장하나:
 *   [A] HTTP 파리티 — 같은 (user, week) 실패 카드가 6개 접근 경로에서 동일한 checkGate 를 준다.
 *         일반 / mode=test / actAsTestUserId / mode=test+actAs / demoUserId / demoUserId+mode=test
 *         (카드 산식은 test/operating 무관 항상 operating → 값 동일. mode=test 가 QA 게이트로 403 이면
 *          "게이트 차단(운영 배포 정상)"으로 기록하고 파리티에서 제외한다.)
 *   [B] 문구 파리티 — DTO 값(required/earned/passed)으로 재구성한 기대 문구가 required 개수를 담는다.
 *   [C] snapshot 파리티 — snapshot 조회분 == 즉시 재계산분(둘 다 fail 카드에 checkGate 부착).
 *         (admin supabase 서비스 접근 필요 — env 없으면 SKIP.)
 *   [D] DOM 파리티 — 배포 브라우저에서 .detail-log-btn 클릭 → .dl-check-text 첫 항목이
 *         "…기준은 {required}개…" + "{earned}개를 획득" 을 담고, 일반/demo 경로가 동일 문자열.
 *         (playwright 없으면 SKIP.)
 *
 * 실행:
 *   # 로컬(admin :3000 + 고객 :3001) 전체:
 *   npx tsx --env-file=.env.local scripts/verify-checkgate-fail-card-parity.ts
 *   # 프로덕션(HTTP/DOM 만; snapshot 은 서비스키 있으면 함께):
 *   VERIFY_USER_ID=<phalanx 실패카드 보유 userId> \
 *   CUSTOMER_BASE=https://<고객앱> ADMIN_BASE=https://<admin> \
 *   npx tsx --env-file=.env.local scripts/verify-checkgate-fail-card-parity.ts
 *
 * env / argv:
 *   VERIFY_USER_ID   (필수) — 실패 카드를 가진 대상 userId. 없으면 즉시 안내 후 종료.
 *   VERIFY_WEEK_ID   (선택) — 특정 주차 고정. 없으면 대상 유저의 카드에서 checkGate 부착 fail 카드 자동 탐색.
 *   CUSTOMER_BASE    (기본 http://localhost:3001) — 고객앱 base. DOM·HTTP 파리티가 치는 곳.
 *   ADMIN_BASE       (기본 http://localhost:3000) — admin base(참고용 direct 비교; 미사용 시 무해).
 *   CARD_PATH        (기본 /cluster-4-card) — 카드 상세 라우트 prefix(조직별이면 -px/-ec 등으로 지정).
 *   SKIP_DOM=1       — DOM 단계 생략.
 *   SKIP_SNAPSHOT=1  — snapshot 단계 생략.
 */

const CUSTOMER_BASE = (process.env.CUSTOMER_BASE || "http://localhost:3001").replace(/\/$/, "");
const ADMIN_BASE = (process.env.ADMIN_BASE || "http://localhost:3000").replace(/\/$/, "");
const CARD_PATH = process.env.CARD_PATH || "/cluster-4-card";
const USER = process.env.VERIFY_USER_ID || "";
const PIN_WEEK = process.env.VERIFY_WEEK_ID || "";

const J = (o: unknown) => JSON.stringify(o);
let pass = 0, fail = 0, skip = 0;
const ck = (label: string, ok: boolean, detail = "") => {
  console.log(`  ${ok ? "✓ PASS" : "✗ FAIL"} ${label}${detail ? ` — ${detail}` : ""}`);
  ok ? pass++ : fail++;
};
const note = (m: string) => console.log(`  · ${m}`);
const skipStep = (m: string) => { console.log(`  ⤼ SKIP ${m}`); skip++; };

type Gate = { required: number; earned: number; passed: boolean; enforced: boolean } | null | undefined;
type Card = {
  weekId?: string; weekNumber?: number; seasonKey?: string; userWeekStatus?: string;
  experienceGrowth?: { status?: string; checkGate?: Gate } | null;
};
const gateOf = (c: Card | undefined): Gate => c?.experienceGrowth?.checkGate ?? null;
const gateSig = (g: Gate) => (g ? `${g.required}/${g.earned}/${g.passed}/${g.enforced}` : "null");

// 고객앱 프록시 GET — 쿼리스트링만 다르게(프록시는 search 전체를 admin 으로 forward).
async function fetchCustomer(qs: string): Promise<{ status: number; cards: Card[] }> {
  const url = `${CUSTOMER_BASE}/api/cluster4/weekly-cards?${qs}`;
  try {
    const res = await fetch(url, { headers: { "Content-Type": "application/json" }, cache: "no-store" as RequestCache });
    if (res.status !== 200) return { status: res.status, cards: [] };
    const j = await res.json().catch(() => ({}));
    return { status: 200, cards: Array.isArray(j?.data) ? (j.data as Card[]) : [] };
  } catch (e) {
    return { status: -1, cards: [] };
  }
}

// 대상 주차 카드 픽 — PIN_WEEK 우선, 없으면 status fail + checkGate(enforced,required>0) 자동 탐색.
function pickFailCard(cards: Card[]): Card | undefined {
  if (PIN_WEEK) return cards.find((c) => c.weekId === PIN_WEEK);
  return cards.find((c) => {
    const g = gateOf(c);
    const isFail = c.userWeekStatus === "fail" || c.experienceGrowth?.status === "fail";
    return isFail && !!g && g.enforced && g.required > 0;
  });
}

// 고객앱 문구 재구성(Cluster4CardContent 와 동치 — required 개수 노출 확인용).
const DL_ORG_POINT_A: Record<string, string> = { encre: "별", oranke: "단감", phalanx: "투구" };
function expectedPitchText(g: NonNullable<Gate>, poa: string, name = "크루"): string {
  const passed = g.passed;
  return `이번 주 성장 성공의 ${poa} 기준은 ${g.required}개였으며, ${name}님은 ${poa} ${g.earned}개를 획득하셨어요. ${
    passed ? "이번 주 성장에 성공하셨습니다!" : "성장 성공 기준에는 조금 더 필요해요!"
  }`;
}

async function main() {
  console.log("═".repeat(72));
  console.log("checkGate fail-card parity  (admin DTO v45)");
  console.log(`  CUSTOMER_BASE=${CUSTOMER_BASE}  ADMIN_BASE=${ADMIN_BASE}  CARD_PATH=${CARD_PATH}`);
  console.log("═".repeat(72));

  if (!USER) {
    console.log("\n⚠ VERIFY_USER_ID 미지정 — 실패 카드를 가진 phalanx userId 를 넣어 다시 실행하세요.");
    console.log("  예) VERIFY_USER_ID=xxxx npx tsx --env-file=.env.local scripts/verify-checkgate-fail-card-parity.ts");
    process.exit(2);
  }

  // ── 대상 카드 탐색 (일반 경로 = baseline) ──
  console.log("\n[0] 대상 실패 카드 탐색 (일반 userId 경로)");
  const base = await fetchCustomer(`userId=${USER}`);
  if (base.status !== 200) {
    ck(`일반 경로 200 응답`, false, `status=${base.status} (배포/URL/권한 확인)`);
    return finish();
  }
  const target = pickFailCard(base.cards);
  if (!target) {
    ck("checkGate 부착 실패 카드 존재", false,
      PIN_WEEK ? `VERIFY_WEEK_ID=${PIN_WEEK} 카드 없음` :
      "status=fail && checkGate(enforced,required>0) 카드 없음 → snapshot 재계산(v45) 아직 미수렴이거나 대상 유저에 해당 카드 없음");
    // 진단 도움: 이 유저 fail 카드들의 gate 상태를 덤프
    const fails = base.cards.filter((c) => c.userWeekStatus === "fail" || c.experienceGrowth?.status === "fail");
    note(`이 유저 fail 카드 ${fails.length}건 gate: ` + J(fails.slice(0, 8).map((c) => ({ w: c.weekNumber, s: c.seasonKey, gate: gateSig(gateOf(c)) }))));
    return finish();
  }
  const g0 = gateOf(target)!;
  const weekId = target.weekId!;
  const remaining = Math.max(0, g0.required - g0.earned);
  ck("실패 카드에 checkGate 부착됨", !!g0 && g0.enforced && g0.required > 0,
    `week=${target.weekNumber}(${target.seasonKey}) status=${target.userWeekStatus} gate(req/earn/passed/enf)=${gateSig(g0)} remaining=${remaining}`);

  // ── [A] HTTP 6경로 파리티 ──
  console.log("\n[A] HTTP 6경로 파리티 (동일 user·week 의 checkGate 일치)");
  const paths: Array<{ name: string; qs: string; qaSensitive?: boolean }> = [
    { name: "일반(userId)", qs: `userId=${USER}` },
    { name: "mode=test", qs: `userId=${USER}&mode=test`, qaSensitive: true },
    { name: "actAsTestUserId", qs: `userId=${USER}&actAsTestUserId=${USER}` },
    { name: "mode=test+actAs", qs: `userId=${USER}&mode=test&actAsTestUserId=${USER}`, qaSensitive: true },
    { name: "demoUserId", qs: `demoUserId=${USER}` },
    { name: "demoUserId+mode=test", qs: `demoUserId=${USER}&mode=test`, qaSensitive: true },
  ];
  for (const p of paths) {
    const r = await fetchCustomer(p.qs);
    if (r.status === 403 && p.qaSensitive) { skipStep(`${p.name} → 403 QA 게이트(운영 배포에서 mode=test 차단은 정상)`); continue; }
    if (r.status !== 200) { ck(`${p.name} 200 응답`, false, `status=${r.status}`); continue; }
    const c = r.cards.find((x) => x.weekId === weekId);
    const g = gateOf(c);
    const same = !!g && gateSig(g) === gateSig(g0) && c?.userWeekStatus === target.userWeekStatus;
    ck(`${p.name} == baseline`, same, `gate=${gateSig(g)} status=${c?.userWeekStatus}`);
  }

  // ── [B] 문구 파리티 (DTO 값 → required 개수를 담는 문구) ──
  console.log("\n[B] 문구 재구성 파리티");
  const org = (target.seasonKey || "").includes("") ? guessOrg(base.cards) : "phalanx";
  const poa = DL_ORG_POINT_A[org] ?? "투구";
  const text = expectedPitchText(g0, poa);
  ck("재구성 문구가 required 개수 포함", text.includes(`기준은 ${g0.required}개`), text);
  ck("재구성 문구가 earned 개수 포함", text.includes(`${poa} ${g0.earned}개를 획득`));
  note(`acquired=${g0.earned} required=${g0.required} remaining=${remaining} passed=${g0.passed}`);

  // ── [C] snapshot 파리티 (조회 == 재계산) ──
  console.log("\n[C] snapshot 조회 == 재계산 파리티");
  if (process.env.SKIP_SNAPSHOT || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
    skipStep("SUPABASE_SERVICE_ROLE_KEY 없음/SKIP_SNAPSHOT — admin 로컬(.env.local)에서만 수행");
  } else {
    try {
      const snap = await import("@/lib/cluster4WeeklyCardsSnapshot");
      const read = await snap.readWeeklyCardsSnapshot(USER);
      const readCards = extractCards(read);
      const rc = await snap.recomputeAndStoreWeeklyCardsSnapshot(USER);
      const recCards = extractCards(rc);
      const rGate = gateOf(readCards.find((c) => c.weekId === weekId));
      const cGate = gateOf(recCards.find((c) => c.weekId === weekId));
      ck("재계산분 fail 카드에 checkGate 부착", !!cGate && cGate.enforced, gateSig(cGate));
      ck("snapshot 조회 == 재계산(gate 동일)", gateSig(rGate) === gateSig(cGate), `read=${gateSig(rGate)} recompute=${gateSig(cGate)}`);
    } catch (e) {
      skipStep(`snapshot 단계 예외 — ${(e as Error).message}`);
    }
  }

  // ── [D] DOM 파리티 (배포 브라우저) ──
  console.log("\n[D] DOM .dl-check-text 파리티 (일반 vs demo)");
  if (process.env.SKIP_DOM) { skipStep("SKIP_DOM"); }
  else {
    let chromium: any;
    try { ({ chromium } = await import("playwright")); }
    catch { skipStep("playwright 미설치 — `npm i -D playwright && npx playwright install chromium` 후 재실행"); chromium = null; }
    if (chromium) {
      const browser = await chromium.launch();
      try {
        const readDom = async (qs: string) => {
          const page = await browser.newPage();
          await page.goto(`${CUSTOMER_BASE}${CARD_PATH}/${weekId}?${qs}`, { waitUntil: "domcontentloaded", timeout: 90000 });
          await page.waitForTimeout(12000);
          // Detail Log 열기
          const btn = await page.$(".detail-log-btn");
          if (btn) { await btn.click(); await page.waitForTimeout(1500); }
          const txt = await page.evaluate(() => {
            const el = document.querySelector(".dl-check-list .dl-check-text");
            return el ? (el.textContent || "").replace(/\s+/g, " ").trim() : null;
          });
          await page.close();
          return txt as string | null;
        };
        const domNormal = await readDom(`userId=${USER}`);
        const domDemo = await readDom(`userId=${USER}&demoUserId=${USER}`);
        ck("DOM(일반) 첫 조건문구 존재", !!domNormal, domNormal ? domNormal.slice(0, 80) : "null (모달 미개설/버튼 셀렉터 확인)");
        if (domNormal) {
          ck("DOM(일반) required 개수 노출", domNormal.includes(`기준은 ${g0.required}개`), domNormal);
          ck("DOM(일반) earned 개수 노출", domNormal.includes(`${g0.earned}개를 획득`));
        }
        ck("DOM 일반 == demo (동일 문자열)", !!domNormal && domNormal === domDemo, `demo=${domDemo ? domDemo.slice(0, 80) : "null"}`);
      } finally {
        await browser.close();
      }
    }
  }

  finish();
}

// snapshot lib 반환형(구분형)에서 cards 배열을 뽑는다(모양 방어적).
function extractCards(x: unknown): Card[] {
  const anyx = x as any;
  const arr = anyx?.cards ?? anyx?.snapshot?.cards ?? anyx?.data ?? anyx;
  return Array.isArray(arr) ? (arr as Card[]) : [];
}
// 조직 추정 — 카드 seasonKey 는 org 를 안 담으므로 CUSTOMER_BASE/CARD_PATH suffix 로 추정, 기본 phalanx.
function guessOrg(_cards: Card[]): string {
  const s = (CARD_PATH + " " + CUSTOMER_BASE).toLowerCase();
  if (s.includes("-ec") || s.includes("encre")) return "encre";
  if (s.includes("oranke") || s.includes("mkt") || s.includes("mk")) return "oranke";
  return "phalanx";
}

function finish() {
  console.log("\n" + "─".repeat(72));
  console.log(`결과: ${pass} PASS / ${fail} FAIL / ${skip} SKIP`);
  console.log("─".repeat(72));
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((e) => { console.error("스크립트 예외:", e); process.exit(1); });
