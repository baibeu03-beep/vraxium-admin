// NODE_OPTIONS=--require 용 전역 Date 패치 — FAKE_NOW 시각으로 오프셋 이동(시계는 계속 흐름).
// 시간여행 검증 전용. 운영/일반 dev 에서는 FAKE_NOW 미설정 → no-op.
const RealDate = Date;
const fake = process.env.FAKE_NOW;
if (fake) {
  const offset = new RealDate(fake).getTime() - RealDate.now();
  class FakeDate extends RealDate {
    constructor(...args) {
      if (args.length === 0) super(RealDate.now() + offset);
      else super(...args);
    }
    static now() {
      return RealDate.now() + offset;
    }
  }
  // 일부 번들러 런타임(Turbopack)에서 class static 상속이 끊기는 경우 대비 — 명시 복사.
  FakeDate.parse = RealDate.parse.bind(RealDate);
  FakeDate.UTC = RealDate.UTC.bind(RealDate);
  global.Date = FakeDate;
  // stdout 금지: npm/도구가 stdout 을 파싱하는 경우가 있어 stderr 로만 알린다.
  process.stderr.write(`[faketime] Date patched → now=${new FakeDate().toISOString()}\n`);
}
