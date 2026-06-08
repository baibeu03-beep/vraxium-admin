import { supabaseAdmin } from "@/lib/supabase/admin";
import { maskEmail } from "@/lib/maskEmail";

// 기존 회원 찾기(가입 전 "이미 회원인가?" 확인 플로우)의 단일 데이터 진입점.
// route 와 검증 스크립트가 동일하게 이 함수를 호출한다(direct == HTTP 보장).
//
// 매칭 규칙:
//   - 이름: user_profiles.display_name OR english_name(실명/영문명) 정확 일치
//   - 전화: contact_phone 을 숫자만 정규화하여 비교(하이픈/공백 표기차 흡수)
// 응답:
//   - { found:true, displayName, maskedEmail }  (실제 이메일은 절대 미반환)
//   - { found:false }
//
// 주의: snapshot 미사용 — user_profiles 실시간 직접 조회.

export type FindMemberResult =
  | { found: true; displayName: string; maskedEmail: string }
  | { found: false };

const NOT_FOUND: FindMemberResult = { found: false };

// 전화번호 정규화: 숫자 이외 문자 제거(010-1234-5678 → 01012345678)
function normalizePhone(raw: string | null | undefined): string {
  return (raw ?? "").replace(/\D/g, "");
}

// user_profiles 조회 컬럼(이메일은 마스킹 전용으로만 사용, 원본은 반환 경로 없음)
// 등록 이메일 우선순위 정책: auth_email → contact_email → email.
// 단, user_profiles 에 독립 `email` 컬럼은 존재하지 않으므로(등록 이메일 SoT 는
// contact_email) 3순위 email 은 스키마상 도달 불가 — 실효 우선순위는
// auth_email → contact_email 로 수렴한다. 비존재 컬럼을 select 하면 쿼리가
// 깨지므로 email 은 select 하지 않는다.
const SELECT_COLS = "display_name, contact_phone, auth_email, contact_email";

export async function findExistingMember(
  nameRaw: string,
  phoneRaw: string,
): Promise<FindMemberResult> {
  const name = (nameRaw ?? "").trim();
  const phoneDigits = normalizePhone(phoneRaw);
  if (!name || !phoneDigits) return NOT_FOUND;

  // display_name / english_name 각각 .eq() 로 조회(.or() 문자열 인젝션 회피).
  const [byDisplay, byEnglish] = await Promise.all([
    supabaseAdmin
      .from("user_profiles")
      .select(SELECT_COLS)
      .eq("display_name", name)
      .limit(100),
    supabaseAdmin
      .from("user_profiles")
      .select(SELECT_COLS)
      .eq("english_name", name)
      .limit(100),
  ]);

  if (byDisplay.error) throw byDisplay.error;
  if (byEnglish.error) throw byEnglish.error;

  const rows = [...(byDisplay.data ?? []), ...(byEnglish.data ?? [])];
  if (rows.length === 0) return NOT_FOUND;

  // 정규화 전화 일치 첫 행
  const match = rows.find(
    (row) => normalizePhone(row.contact_phone) === phoneDigits,
  );
  if (!match) return NOT_FOUND;

  // 등록 이메일 우선순위: auth_email → contact_email (→ email: 컬럼 부재로 도달 불가)
  const maskedEmail = maskEmail(match.auth_email ?? match.contact_email);
  if (!maskedEmail) return NOT_FOUND; // 가릴 이메일이 없으면 식별 불가로 취급

  return {
    found: true,
    displayName: match.display_name,
    maskedEmail,
  };
}
