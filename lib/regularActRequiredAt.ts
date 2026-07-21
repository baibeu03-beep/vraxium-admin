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

// 정규 액트의 "발생 예정 시각"(occur) 을 관리 주차 월요일 + occur 요일/시각으로 투영한 절대 ms.
//   [오픈 확인] 재실행 시점 경계 판정의 단일 SoT — 액트가 그 주 언제 발생하도록 예정됐는가.
//   occur_week/occur_dow/occur_time 은 check_* 과 동일한 요일수학(resolveRegularActRequiredDate,
//   "N1"=다음 주 +7일)을 쓰되 시각은 occur_time 을 붙인다. occur_time 부재 시 그 날 00:00 KST.
//   weekStart/occurDow 부재(예외 액트 등)면 null → 호출부는 최신 config 폴백(오늘 동작·안전).
export function resolveRegularActOccurredAtMs(input: {
  weekStart: string | null;
  occurWeek: string | null;
  occurDow: number | null;
  occurTime: string | null;
}): number | null {
  const iso = resolveRegularActRequiredAt({
    weekStart: input.weekStart,
    checkWeek: input.occurWeek,
    checkDow: input.occurDow,
    checkTime: input.occurTime,
  });
  if (!iso) return null;
  // 시각 없음(날짜만) → 그 날 00:00 KST 로 앵커.
  const ms = Date.parse(iso.length <= 10 ? `${iso}T00:00:00+09:00` : iso);
  return Number.isNaN(ms) ? null : ms;
}
