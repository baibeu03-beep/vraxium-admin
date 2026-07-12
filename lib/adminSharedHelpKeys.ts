// 어드민 공통(semantic) Help Key 중앙 레지스트리.
//   · 의미·업무역할·저장대상·사용자에게 설명할 내용이 "동일한" 요소들이 하나의 도움말 레코드를 공유한다.
//   · SoT 는 여전히 admin_page_help_contents(page_path=키, content) — 여기선 "키 문자열"만 중앙화한다.
//   · 각 사용부는 문자열 리터럴을 직접 쓰지 말고 이 상수를 참조한다(오타·drift 방지, 공유 관계 가시화).
//
// 불변 조건(공통 키에 절대 포함하지 않는다 — org/mode 무관):
//   mode · test · actAsTestUserId · org · encre · oranke · phalanx.
//   일반 모드와 mode=test 는 같은 컴포넌트·같은 Help Key·같은 조회/저장 DTO 를 쓴다.
//   org 별로 키/레코드를 복제하지 않는다 — 의미가 같으면 모든 org 가 같은 공통 키를 쓴다.
//
// 키 형식: /^admin(\.[a-zA-Z0-9]+)+$/  (lib/adminPageHelpData.isValidHelpPath).
//
// 분류 원칙:
//   · "admin.shared.*"        — 이번에 신설한 순수 공통 키(이전엔 페이지마다 개별 키였음).
//   · "admin.lineOpening.*"   — line-opening 에서 이미 다중 페이지가 공유 중인 정본 키(재키잉 금지, 그대로 참조).
//   · 애매하거나 의미가 갈리는 항목(로그인/연락 이메일, 개설/대상 주차, 상태 등)은 여기 넣지 않고
//     각 페이지 전용 키를 유지한다(감사표 B/C 그룹, claudedocs/admin-help-keys-audit.json 참조).

export const ADMIN_SHARED_HELP_KEYS = {
  // 크루(회원) 그 자체를 가리키는 항목 — 어느 페이지에서 보든 같은 대상/같은 설명.
  crew: {
    /** 크루(회원)의 표시 이름(사람 이름). 목록 표 "이름" 컬럼 등. 휴식기간명·주차명 등 "사람 아님"은 제외. */
    name: "admin.shared.crew.name",
    /** 크루 코드(13자리 식별자). 카페/크루 편집/검수 목록의 "크루 코드" 컬럼. */
    code: "admin.shared.crew.code",
    /** 크루가 "소속된" 클럽(organization). "클럽 범위"(윈도우 scope)·"적용 클럽"(라인 대상)과는 다름 → 제외. */
    organization: "admin.shared.crew.organization",
    /** 로그인 계정 이메일(인증 식별자). "연락 이메일"(contact_email)과는 다름 → 제외. */
    loginEmail: "admin.shared.crew.loginEmail",
  },
  // ── 이미 line-opening 개설 폼에서 다중 페이지가 공유 중인 정본 키(신설 아님, 참조용) ──
  //    info 개설폼 · career 개설폼 · experience 개설폼이 같은 키를 공유한다.
  lineOpening: {
    /** 개설 라인 메인 타이틀(고객 앱 노출). */
    mainTitle: "admin.lineOpening.field.mainTitle",
    /** 개설 라인 아웃풋(산출물) 그 자체. */
    output: "admin.lineOpening.field.output",
    /** 첫 번째 아웃풋 링크 URL. */
    outputLink: "admin.lineOpening.field.outputLink",
    /** 첫 번째 아웃풋 링크 설명. */
    outputLinkDescription: "admin.lineOpening.field.outputLinkDescription",
  },
} as const;

export type AdminSharedHelpKey =
  | (typeof ADMIN_SHARED_HELP_KEYS.crew)[keyof typeof ADMIN_SHARED_HELP_KEYS.crew]
  | (typeof ADMIN_SHARED_HELP_KEYS.lineOpening)[keyof typeof ADMIN_SHARED_HELP_KEYS.lineOpening];
