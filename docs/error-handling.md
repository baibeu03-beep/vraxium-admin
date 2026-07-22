# 오류 처리 규칙 (어드민)

API 오류를 사용자 문구로 바꾸는 판단은 **`lib/apiError.ts` 한 곳**에서만 한다.
새 helper 를 만들지 말고 아래 진입점을 쓴다.

## 1. 서버 (route handler / data layer)

### 4xx = 사용자가 고칠 수 있는 오류 → **사용자 문장**으로 쓴다

```ts
// ✗ 내부 필드명·영문 validator — 파서가 차단해서 사용자에게 아예 안 보인다
return Response.json({ success: false, error: "line_code is required" }, { status: 400 });

// ✓ 화면 라벨 + 무엇을 하면 되는지
return Response.json(
  { success: false, error: "라인 코드는 영문, 숫자, 하이픈(-)만 사용할 수 있습니다. 예: IFBS-NN0007" },
  { status: 400 },
);
```

필드명을 문구에 넣어야 하면 `lib/apiFieldLabels` 를 쓴다 — 직접 쓴 내부 이름은 노출되지 않는다.

```ts
import { fieldLabel, withJosa } from "@/lib/apiFieldLabels";

const label = fieldLabel(field);                       // "line_code" → "라인 코드"
error: label ? `${withJosa(label, "을/를")} 입력해주세요.` : "필수 입력값이 비어 있습니다.";
```

### 5xx = 내부 오류 → 원문 금지, 로그로만

```ts
} catch (error) {
  const status = error instanceof LineRegistrationError ? error.status : 500;
  console.error("[lines/registrations POST]", error);   // ← 원문은 여기에만
  return Response.json(
    { success: false, error: publicErrorMessage(error, status, "라인 등록에 실패했습니다") },
    { status },
  );
}
```

`publicErrorMessage(error, status, fallback)` 는 4xx 면 도메인 문구를 통과시키고,
5xx·401·429 면 무조건 fallback 을 돌려준다. **status 를 계산해 뒀다면 반드시 그 status 를 넘긴다**
(500 고정으로 넘기면 4xx 업무 문구까지 버려진다).

Postgres/Supabase 결과를 그대로 던지지 않는다.

```ts
// ✗ if (error) throw new XError(500, error.message);
// ✓
if (error) {
  console.error("[accounts] list query failed", error);
  throw new XError(500, "계정 목록을 불러오지 못했습니다.");
}
```

unique 위반(23505)처럼 사용자가 고칠 수 있는 DB 오류는 **4xx 로 승격**하고 업무 문구를 준다.

```ts
if (error?.code === "23505") {
  console.error("[createLineRegistration] unique violation", error);
  throw new LineRegistrationError(409, `이미 등록된 라인 코드입니다 (${input.lineCode}).`);
}
```

## 2. 클라이언트

### 일반 CRUD (토스트)

```ts
const json = await res.json().catch(() => ({}));
if (!res.ok || !json.success) {
  throw apiErrorFrom(res, json, "저장하지 못했습니다.");
}
...
} catch (err) {
  console.error("[화면] save failed", err);   // 개발자 상세(stack·payload)
  t.apiError("update", err, "저장하지 못했습니다.");
}
```

### 인라인 배너 / 폼 오류

```ts
} catch (err) {
  console.error("[화면] load failed", err);
  setError(getApiErrorMessage(err, "불러오지 못했습니다."));
}
```

### 낙관적 UI(rollback)

원복을 **먼저**, 안내를 **나중에**. 순서를 바꾸지 않는다.

```ts
} catch (err) {
  applyAccount({ ...account, adminRole: prevRole });   // ① 원복
  console.error("[accounts] role update failed", err);
  t.apiError("update", err, "권한 등급을 변경하지 못했습니다.");   // ② 안내
}
```

### 부분 성공

전체 실패로 뭉개지 말고 **성공한 부분과 남은 작업**을 나눠 안내한다.

```ts
throw apiErrorFrom(
  metaRes,
  metaJson,
  "라인 정보는 저장됐지만 기업/감독자 정보는 저장되지 않았습니다. 기업/감독자 항목만 다시 저장해주세요.",
);
```

### 무음 fallback (P2)

의도적 무음은 그대로 두되 **왜 무음인지 주석으로 남기고** 회귀 검사 허용목록에 등록한다.

```ts
// [P2 무음 유지] 입력 중 300ms 디바운스로 반복 요청되는 보조 계산. 실패해도 저장에 영향 없고
//   토스트를 띄우면 입력 중 반복 노출로 방해만 된다. 기존 표시 유지.
if (!res.ok || !json.success) return;
```

## 3. 금지

| 금지 | 이유 | 대신 |
|---|---|---|
| `setError(err.message)` | 5xx Postgres 원문이 그대로 노출 | `getApiErrorMessage(err, fb)` |
| `t.error("create")` (bare) | 서버가 준 원인이 사라짐 | `t.apiError("create", err, fb)` |
| `t.error(a, { message: json.error })` | override 경로라 **안전 필터를 우회** | `t.apiError(a, err, fb)` |
| route 에서 `error.message` 를 500 응답에 | 테이블·컬럼·제약명 유출 | `publicErrorMessage(error, status, fb)` |
| 사용자 문구에 `line_code` 등 내부 필드명 | 사용자가 이해 못함 + 파서가 폐기 | `fieldLabel()` / 사용자 문장 |
| 모드별(`mode=test`) 오류 문구 분기 | 일반/테스트 동등성 위반 | 같은 DTO·같은 파서 |

## 4. 검사

```bash
npx tsx scripts/verify-error-handling-regressions.ts   # E1~E3 = 실패, E4 = 경고
npx tsx scripts/audit-client-error-handling.ts         # catch 를 OK/RAW/LOST/SILENT 로 분류
npx tsx scripts/audit-api-error-copy.ts --list-dropped # 서버 문구 노출/번역/폐기 분류
npx tsx scripts/test-api-error.ts                      # 파서 단위 테스트
npx tsx scripts/verify-api-error-batch{1,2,3}.ts       # 실 HTTP (status·DTO·문구·모드 동등성)
```

`[폐기]` 목록은 "서버가 준 문구가 개발 용어라서 사용자에게 안 보이는 것"이다 —
다음 문구 개선 대상 목록으로 쓴다.
