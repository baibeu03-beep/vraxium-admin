function addDaysIso(iso: string, days: number): string {
  const date = new Date(`${iso}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

function hhmm(time: string | null): string | null {
  return time && /^\d{2}:\d{2}/.test(time) ? time.slice(0, 5) : null;
}

// 관리 주차의 월요일 + 액트 체크 요일(일=0…토=6, N1=다음 주) → 필요 날짜.
export function resolveRegularActRequiredDate(input: {
  weekStart: string | null;
  checkWeek: string | null;
  checkDow: number | null;
}): string | null {
  if (!input.weekStart || input.checkDow == null) return null;
  const offsetFromMonday = (input.checkDow + 6) % 7;
  return addDaysIso(input.weekStart, offsetFromMonday + (input.checkWeek === "N1" ? 7 : 0));
}

// 정규 액트의 필요 시점은 신청 당시의 검수 예약 시각이 아니라 액트 정의를 관리 주차에 투영한다.
export function resolveRegularActRequiredAt(input: {
  weekStart: string | null;
  checkWeek: string | null;
  checkDow: number | null;
  checkTime: string | null;
}): string | null {
  const date = resolveRegularActRequiredDate(input);
  if (!date) return null;
  const time = hhmm(input.checkTime);
  return time ? `${date}T${time}:00+09:00` : date;
}
