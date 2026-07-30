변경 대상의 영향 범위를 조사하세요.

목표는 "수정 전에 어디까지 영향을 받는지"를 파악하는 것입니다.

절대 코드를 수정하지 마세요.
절대 리팩토링하지 마세요.
조사와 보고만 수행하세요.

다음 항목을 순서대로 조사하세요.

## 1. 직접 영향

- 수정 대상 파일
- 호출하는 함수
- 호출되는 함수
- import 관계
- export 관계

---

## 2. 데이터 흐름

다음 흐름을 끝까지 추적하세요.

DB
↓

Repository / Query
↓

Service

↓

API(Route)

↓

DTO

↓

React Query

↓

Hook

↓

Component

↓

화면

중간에 Snapshot, Cache, Mapper가 있으면 반드시 포함하세요.

---

## 3. 공통 모듈 영향

다음 공통 모듈 사용 여부를 조사하세요.

- util
- helper
- shared component
- common DTO
- validation
- formatter

---

## 4. 저장 영향

다음 저장소에 영향이 있는지 조사하세요.

- DB
- Snapshot
- Cache
- Local Storage
- Session
- IndexedDB

---

## 5. 읽는 곳

수정 대상 데이터를 읽는 곳을 모두 찾으세요.

- API
- Admin
- User
- Batch
- Cron
- 통계
- Dashboard

---

## 6. 쓰는 곳

수정 대상 데이터를 저장하는 곳을 모두 찾으세요.

- API
- Batch
- Scheduler
- Migration

---

## 7. 프로젝트 정책 영향

특히 다음을 확인하세요.

- 일반 사용자
- mode=test
- actAsTestUserId
- demoUserId
- Snapshot 생성
- Snapshot 조회
- DTO 일관성
- HTTP API 응답
- Cluster1
- Cluster2
- Cluster3
- Cluster4

---

## 8. 위험도

영향도를 다음 기준으로 평가하세요.

HIGH
- 공통 DTO
- Snapshot
- Point
- Ledger
- Cache

MEDIUM
- API
- Admin 화면
- Hook

LOW
- UI
- Style
- Badge
- Text

---

## 9. 마지막 보고

다음 형식으로만 정리하세요.

### 직접 영향

...

### 간접 영향

...

### 영향받는 화면

...

### 영향받는 API

...

### 영향받는 DTO

...

### Snapshot 영향

...

### Cache 영향

...

### 위험도

HIGH
...

MEDIUM
...

LOW
...

### 수정 시 반드시 함께 검증해야 하는 항목

□ 일반 사용자
□ mode=test
□ actAsTestUserId
□ demoUserId
□ Snapshot 생성
□ Snapshot 조회
□ DTO 동일
□ HTTP Response 동일