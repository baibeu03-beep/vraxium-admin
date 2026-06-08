// 이메일 마스킹 유틸. 외부로 실제 이메일을 절대 노출하지 않기 위한 단일 지점.
// 로컬부(local-part)는 앞 2글자만 남기고 나머지를 "***" 로 가린다. 도메인은 그대로 둔다.
//   aseunbi@gmail.com → as***@gmail.com
//   a@gmail.com       → a***@gmail.com
//   (형식 불명/빈 값) → ""  (호출 측에서 found:false 로 처리)
export function maskEmail(email: string | null | undefined): string {
  const trimmed = (email ?? "").trim();
  if (!trimmed) return "";

  const at = trimmed.lastIndexOf("@");
  if (at <= 0) return ""; // "@" 없음 또는 로컬부 비어있음 → 마스킹 불가

  const local = trimmed.slice(0, at);
  const domain = trimmed.slice(at + 1);
  if (!domain) return "";

  const visible = local.slice(0, Math.min(2, local.length));
  return `${visible}***@${domain}`;
}
