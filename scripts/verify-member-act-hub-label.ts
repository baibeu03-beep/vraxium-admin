// 회원 상세 "액트 체크 내역" 소속 허브 한글 표시 검증.
//   실행: npx tsx --env-file=.env.local scripts/verify-member-act-hub-label.ts
//
// 원칙 확인:
//   · 표시는 공통 SoT PROCESS_HUB_LABEL 재사용(formatProcessHubLabel) — 신규 매핑 없음.
//   · 화면 표시만 한글화, DTO/저장값(enum)은 무변경.
//   · 실제 DB(process_acts.hub) 전 값이 한글로 매핑되어 영문 노출 0 인지.

import { supabaseAdmin } from "@/lib/supabaseAdmin";
import {
  PROCESS_HUBS,
  PROCESS_HUB_LABEL,
  formatProcessHubLabel,
} from "@/lib/adminProcessesTypes";

let failures = 0;
function check(name: string, ok: boolean, detail?: string) {
  if (!ok) failures++;
  console.log(`  ${ok ? "✓" : "✗"} ${name}${detail ? ` — ${detail}` : ""}`);
}

const HANGUL = /[가-힣]/;

async function main() {
  console.log("\n[1] formatProcessHubLabel — 공통 SoT 재사용 (무DB)");
  for (const hub of PROCESS_HUBS) {
    check(
      `${hub} → ${PROCESS_HUB_LABEL[hub]}`,
      formatProcessHubLabel(hub) === PROCESS_HUB_LABEL[hub] && HANGUL.test(formatProcessHubLabel(hub)),
    );
  }
  check('null → "-"', formatProcessHubLabel(null) === "-");
  check('undefined → "-"', formatProcessHubLabel(undefined) === "-");
  // 예시로 든 'information'(실 enum 아님) 같은 미지값은 방어적으로 원문 보존(영문 노출 없이 매핑되는 실값만 노출됨).
  check("미지값은 원문 보존(방어)", formatProcessHubLabel("information") === "information");

  console.log("\n[2] 실제 process_acts.hub 전 값이 한글 매핑 (DB)");
  const { data, error } = await supabaseAdmin.from("process_acts").select("hub");
  if (error) {
    check("process_acts 조회", false, error.message);
  } else {
    const distinct = Array.from(
      new Set((data ?? []).map((r: { hub: string | null }) => r.hub)),
    );
    let englishLeak = 0;
    for (const h of distinct) {
      const label = formatProcessHubLabel(h);
      const ok = h == null || HANGUL.test(label);
      if (!ok) englishLeak++;
      console.log(`      ${h ?? "null"} → ${label}${ok ? "" : "  ⚠ 영문 노출"}`);
    }
    check(
      "실 hub 값 영문 노출 0",
      englishLeak === 0,
      `distinct=${distinct.length}, 영문=${englishLeak}`,
    );
  }

  console.log(
    failures === 0 ? "\n✅ 전체 통과" : `\n❌ 실패 ${failures}건`,
  );
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error("verify 오류:", e);
  process.exit(1);
});
