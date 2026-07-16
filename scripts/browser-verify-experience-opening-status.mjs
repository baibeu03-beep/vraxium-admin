// 브라우저 검증 — 실무 경험 [라인 개설] 개설 신청 상태 UI(상단 pill + 파트 드롭다운 완료 체크).
//   SoT = team-overall 서버 응답(parts[].submitted / status==="opened"). 추가 API/DB 없음.
//   비파괴(신청/완료/취소 mutation 없음) — 표시·파생·반응성·비모순만 검증. org × mode 전수.
//   검증 항목:
//     · 상단 상태 pill 렌더(role=status) + 선택 유형별 문구(파트=개설 신청 필요/완료, 팀총괄=개설 필요/개설 완료)
//     · 색상만 의존 금지 — 완료 옵션은 배경 강조 + 체크 아이콘 동시(라벨 옆, 선택 인디케이터와 분리)
//     · 비모순 — 트리거 완료 체크 ⇔ pill "완료"
//     · 반응성 — 파트 변경 시 pill 즉시 재파생(로컬 mutation 없이 openingStatus 맵에서)
//     · 교차 SoT — 팀 총괄 선택 시 상단 pill 과 보드 StatusBadge(동일 status 필드 독립 read) 일치
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const adminRoot = resolve(__dirname, "..");
const frontRoot = resolve(adminRoot, "..", "vraxium");
const { chromium } = createRequire(resolve(frontRoot, "package.json"))("playwright");
const rq = createRequire(resolve(adminRoot, "package.json"));
const { createClient } = rq("@supabase/supabase-js");
const { createServerClient } = rq("@supabase/ssr");
const env = readFileSync(resolve(adminRoot, ".env.local"), "utf8");
const get = (k) => env.match(new RegExp(`^${k}=(.+)$`, "m"))?.[1]?.trim();
const BASE = "http://localhost:3000";
const URL_ = get("NEXT_PUBLIC_SUPABASE_URL"),
  ANON = get("NEXT_PUBLIC_SUPABASE_ANON_KEY"),
  SERVICE = get("SUPABASE_SERVICE_ROLE_KEY");
const sb = createClient(URL_, SERVICE),
  brow = createClient(URL_, ANON);
const EMAIL = "vanuatu.golden@gmail.com";
const ORGS = ["encre", "oranke", "phalanx"];
// 운영(mode 미부착) + 테스트(mode=test) — DTO 키·상태 판정 동일해야 함(항목 12).
const MODES = [
  { key: "operating", qs: "" },
  { key: "test", qs: "&mode=test" },
];

let pass = 0, fail = 0;
const ck = (l, ok, d = "") => {
  console.log(`  ${ok ? "✓" : "✗"} ${l}${d ? ` — ${d}` : ""}`);
  ok ? pass++ : fail++;
};

const PART_WORDS = ["개설 신청 필요", "개설 신청 완료"];
const OVERALL_WORDS = ["개설 필요", "개설 완료"];

const { data: link } = await sb.auth.admin.generateLink({ type: "magiclink", email: EMAIL });
const { data: v } = await brow.auth.verifyOtp({ email: EMAIL, token: link.properties.email_otp, type: "magiclink" });
const cap = [];
const srv = createServerClient(URL_, ANON, { cookies: { getAll: () => [], setAll: (i) => cap.push(...i) } });
await srv.auth.setSession({ access_token: v.session.access_token, refresh_token: v.session.refresh_token });
const cookies = cap.map((i) => ({ name: i.name, value: i.value, domain: "localhost", path: "/", httpOnly: false, secure: false, sameSite: "Lax" }));

const browser = await chromium.launch({ channel: "chromium", headless: true });
const context = await browser.newContext({ viewport: { width: 1500, height: 1200 } });
await context.addCookies(cookies);
const page = await context.newPage();

// 상단 상태 pill 텍스트 — 전역 로딩(role=status)과 구분되도록 data-slot 으로 특정.
const readPill = () =>
  page.evaluate(() => {
    const el = document.querySelector('[data-slot="experience-opening-status"]');
    return el ? (el.textContent || "").trim() : null;
  });

// 네비게이션 후 파트 Select 트리거(카드 부트 완료 신호)가 나올 때까지 — 미등장 시 새로고침 재시도.
//   dev 서버 부하로 부트 fetch 가 간헐 실패하면 카드가 비어 트리거가 안 뜬다 → reload 로 복구.
const gotoAndReady = async (url) => {
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      await page.goto(url, { waitUntil: "domcontentloaded" });
    } catch {
      await page.waitForTimeout(900);
      continue;
    }
    // 파트 Select 트리거는 부트 완료 후 항상 렌더된다(파트 유무 무관). pill 은 part 확정 후 렌더.
    const ready = await page
      .waitForSelector('[data-slot="select-trigger"].w-56', { timeout: 15000 })
      .then(() => true)
      .catch(() => false);
    if (ready) {
      await page.waitForSelector('[data-slot="experience-opening-status"]', { timeout: 8000 }).catch(() => {});
      await page.waitForTimeout(800);
      return;
    }
    await page.waitForTimeout(900); // 부트 실패 → 재시도(reload)
  }
  throw new Error("part Select 트리거 미등장(부트 실패)");
};

// 파트 트리거: 선택 라벨 + 완료 체크(select-value 내부 svg) 여부.
const readTrigger = () =>
  page.evaluate(() => {
    const val = document.querySelector('[data-slot="select-trigger"].w-56 [data-slot="select-value"]');
    return {
      text: val ? (val.textContent || "").trim() : "",
      hasCheck: !!(val && val.querySelector("svg")),
    };
  });

// 드롭다운 옵션: 텍스트 / 완료 배경 / 라벨 옆 체크(우측 선택 인디케이터 제외).
const readOptions = () =>
  page.evaluate(() =>
    Array.from(document.querySelectorAll('[data-slot="select-item"]')).map((el) => {
      const leadingCheck = Array.from(el.querySelectorAll("svg")).some((s) => {
        const sp = s.closest("span");
        return sp && !sp.className.includes("absolute"); // 선택 인디케이터(absolute right-2) 제외
      });
      return {
        text: (el.textContent || "").trim(),
        completedBg: el.className.includes("emerald"),
        leadingCheck,
      };
    }),
  );

const openSelect = async () => {
  await page.locator('[data-slot="select-trigger"].w-56').first().click({ timeout: 10000 });
  await page.waitForTimeout(400);
};
const pickOption = async (text) => {
  await page.locator('[data-slot="select-item"]', { hasText: text }).first().click({ timeout: 10000 });
  await page.waitForTimeout(1500);
};

for (const org of ORGS) {
  for (const m of MODES) {
    const tag = `${org}/${m.key}`;
    try {
      await gotoAndReady(`${BASE}/admin/line-opening/practical-experience?org=${org}&tab=open${m.qs}`);

      // ① 상단 상태 pill 렌더 + 유형별 문구.
      const pill0 = await readPill();
      const trig0 = await readTrigger();
      const isOverall0 = trig0.text.includes("팀 총괄");
      const wordSet0 = isOverall0 ? OVERALL_WORDS : PART_WORDS;
      ck(`[${tag}] 상단 상태 pill 렌더 + 문구`, !!pill0 && wordSet0.includes(pill0), `pill="${pill0}" trigger="${trig0.text}"`);

      // ①-b 개설주차·파트 트리거 텍스트가 세로로 잘리지 않고 중앙 정렬(공통 h-9 규칙).
      //     value 박스가 트리거 박스 안에 완전 포함(위/아래 잘림 0) + 상하 여백 대칭(중앙).
      const clip = await page.evaluate(() => {
        const measure = (sel) => {
          const trig = document.querySelector(sel);
          if (!trig) return null;
          const val = trig.querySelector('[data-slot="select-value"]');
          if (!val) return null;
          const t = trig.getBoundingClientRect();
          const v = val.getBoundingClientRect();
          return {
            fits: v.top >= t.top - 1 && v.bottom <= t.bottom + 1,
            overflow: val.scrollHeight > val.clientHeight + 1,
            gapTop: Math.round(v.top - t.top),
            gapBot: Math.round(t.bottom - v.bottom),
            th: Math.round(t.height),
          };
        };
        return {
          week: measure('[data-slot="select-trigger"][class*="min-w-[16rem]"]'),
          part: measure('[data-slot="select-trigger"].w-56'),
        };
      });
      const okClip = ["week", "part"].every((k) => {
        const m = clip[k];
        return m && m.fits && !m.overflow && Math.abs(m.gapTop - m.gapBot) <= 2 && m.th >= 34 && m.th <= 40;
      });
      ck(`[${tag}] 주차/파트 트리거 텍스트 비잘림+세로중앙`, okClip, `week=${JSON.stringify(clip.week)} part=${JSON.stringify(clip.part)}`);

      // ② 비모순 — 트리거 완료 체크 ⇔ pill "완료".
      const pillDone0 = !!pill0 && pill0.endsWith("완료");
      ck(`[${tag}] 트리거 체크 ⇔ pill 완료 비모순`, trig0.hasCheck === pillDone0, `triggerCheck=${trig0.hasCheck} pillDone=${pillDone0}`);

      // ③ 드롭다운 옵션 — 팀 총괄 존재 + 완료 옵션은 배경+체크 동시(색상 무의존).
      await openSelect();
      const opts = await readOptions();
      await page.keyboard.press("Escape");
      await page.waitForTimeout(200);
      const hasOverallOpt = opts.some((o) => o.text.includes("팀 총괄"));
      const badCompleted = opts.filter((o) => o.completedBg && !o.leadingCheck);
      const iconOnlyNoBg = opts.filter((o) => o.leadingCheck && !o.completedBg);
      ck(`[${tag}] 드롭다운 팀 총괄 옵션 존재`, hasOverallOpt, `opts=${opts.length}`);
      ck(
        `[${tag}] 완료 옵션 = 배경+체크 동시(색상 무의존)`,
        badCompleted.length === 0 && iconOnlyNoBg.length === 0,
        `bgNoIcon=${badCompleted.length} iconNoBg=${iconOnlyNoBg.length} completed=${opts.filter((o) => o.completedBg).length}/${opts.length}`,
      );

      // ④ 반응성 + 교차 SoT — 팀 총괄 선택 → pill 문구 전환 + 보드 StatusBadge 와 일치.
      if (hasOverallOpt) {
        await openSelect();
        await pickOption("팀 총괄");
        const pillO = await readPill();
        ck(`[${tag}] 팀 총괄 선택 시 pill 문구(개설 필요/완료)`, !!pillO && OVERALL_WORDS.includes(pillO), `pill="${pillO}"`);
        // 보드(팀 총괄) StatusBadge 렌더 대기 — 보드는 자체 fetch 후 배지 노출.
        await page
          .waitForSelector('span.rounded-full:has-text("개설 완료"), span.rounded-full:has-text("개설 검수"), span.rounded-full:has-text("미진행")', { timeout: 8000 })
          .catch(() => {});
        const badge = await page.evaluate(() => {
          const el = Array.from(document.querySelectorAll("span")).find(
            (s) =>
              s.className.includes("rounded-full") &&
              /개설 완료|개설 검수|미진행/.test((s.textContent || "").trim()),
          );
          return el ? (el.textContent || "").trim() : null;
        });
        if (badge) {
          const pillOpened = pillO === "개설 완료";
          const badgeOpened = badge === "개설 완료";
          ck(`[${tag}] 상단 pill ⇔ 보드 StatusBadge(동일 status)`, pillOpened === badgeOpened, `pill="${pillO}" badge="${badge}"`);
        } else {
          ck(`[${tag}] 보드 StatusBadge 탐지`, false, "badge 미탐지(타이밍?)");
        }
        // #2 삭제 문구 부재 — 팀 총괄 보드에서 "개설 검수 (임시저장)"·"확장 비활성" 이 화면에 없어야 함.
        //   (비확장 주간이므로 이전 코드라면 "확장 비활성" 이 노출됐을 조건 — 실제 회귀 검증.)
        const removed = await page.evaluate(() => {
          const t = document.body.innerText;
          return { tempSave: t.includes("개설 검수 (임시저장)"), extInactive: t.includes("확장 비활성") };
        });
        ck(`[${tag}] 삭제 문구 부재(임시저장/확장비활성)`, !removed.tempSave && !removed.extInactive, `tempSave=${removed.tempSave} extInactive=${removed.extInactive}`);

        // 컬럼명 변경 확인 — 팀 총괄 헤더에 "클래스" 존재 + "크루 상태" 부재.
        const hdr = await page.evaluate(() => {
          const heads = Array.from(document.querySelectorAll('[data-slot="table-head"]')).map((h) => (h.textContent || "").trim());
          return { hasClass: heads.some((h) => h.includes("클래스")), hasOld: heads.some((h) => h.includes("크루 상태")) };
        });
        ck(`[${tag}] 헤더 '크루 상태'→'클래스'`, hdr.hasClass && !hdr.hasOld, `hasClass=${hdr.hasClass} hasOld=${hdr.hasOld}`);
        // '일반'→'정규' 표시 치환 — 보드 클래스 셀에 "일반" 표기 부재(정규/에이전트/파트장만).
        const noIlban = await page.evaluate(() => {
          const cells = Array.from(document.querySelectorAll('[data-slot="table-cell"]')).map((c) => (c.textContent || "").trim());
          return !cells.some((c) => c === "일반");
        });
        ck(`[${tag}] 클래스값 '일반' 미표기(정규 치환)`, noIlban, `noIlban=${noIlban}`);
        // 보드 그리드(라인명 드롭다운 열) 스크린샷 — 표를 뷰포트로 스크롤 후 촬영(컬럼 폭 육안 확인).
        await page.evaluate(() => {
          const tbl = document.querySelector('[data-slot="table"]') || document.querySelector("table");
          if (tbl) tbl.scrollIntoView({ block: "center" });
        }).catch(() => {});
        await page.waitForTimeout(500);
        await page.screenshot({ path: resolve(adminRoot, "claudedocs", `exp-board-${org}-${m.key}.png`), fullPage: false }).catch(() => {});
      }

      // ⑤ 반응성 — 실제 파트 선택 시 pill 이 그 파트 상태로 재파생(옵션 체크와 일치).
      const partOpt = opts.find((o) => !o.text.includes("팀 총괄"));
      if (partOpt) {
        await openSelect();
        await pickOption(partOpt.text);
        const pillP = await readPill();
        const trigP = await readTrigger();
        const okWord = !!pillP && PART_WORDS.includes(pillP);
        const okAgree = trigP.hasCheck === (!!pillP && pillP.endsWith("완료")) && trigP.hasCheck === partOpt.leadingCheck;
        ck(`[${tag}] 파트 선택 시 pill 재파생 + 옵션/트리거 일치`, okWord && okAgree, `part="${partOpt.text}" pill="${pillP}" optCheck=${partOpt.leadingCheck} trigCheck=${trigP.hasCheck}`);
      }

      await page.screenshot({ path: resolve(adminRoot, "claudedocs", `exp-opening-status-${org}-${m.key}.png`), fullPage: false });
    } catch (e) {
      ck(`[${tag}] 반복 실행 오류`, false, e?.message ?? String(e));
      try { await page.screenshot({ path: resolve(adminRoot, "claudedocs", `exp-opening-status-${org}-${m.key}-error.png`), fullPage: true }); } catch {}
    }
  }
}

await browser.close();
console.log(`\n결과: ${pass} pass / ${fail} fail`);
process.exit(fail > 0 ? 1 : 0);
