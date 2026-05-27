# Cluster4 Line Opening Spec

## Final Table Schema

### `public.cluster4_lines`

운영자가 생성하는 1차 입력 마스터다.

| Column | Type | Null | Notes |
| --- | --- | --- | --- |
| `id` | `uuid` | no | PK, `gen_random_uuid()` |
| `part_type` | `text` | no | `info \| experience \| competency \| career` |
| `main_title` | `text` | no | 운영자 1차 제목 |
| `output_link_1` | `text` | yes | 운영자 1차 링크 |
| `submission_opens_at` | `timestamptz` | no | 제출 시작 |
| `submission_closes_at` | `timestamptz` | no | 제출 종료 |
| `is_active` | `boolean` | no | soft-off switch |
| `created_by` | `uuid` | yes | `admin_users(id)` FK |
| `updated_by` | `uuid` | yes | `admin_users(id)` FK |
| `created_at` | `timestamptz` | no | default `now()` |
| `updated_at` | `timestamptz` | no | default `now()`, trigger 갱신 |

제약:
- `CHECK (part_type IN ('info','experience','competency','career'))`
- `CHECK (btrim(main_title) <> '')`
- `CHECK (submission_opens_at <= submission_closes_at)`

인덱스:
- `(part_type, is_active, submission_opens_at, submission_closes_at)`
- `(created_at DESC)`

### `public.cluster4_line_targets`

운영자가 어떤 주차/대상에 라인을 노출할지 정의한다.

| Column | Type | Null | Notes |
| --- | --- | --- | --- |
| `id` | `uuid` | no | PK |
| `line_id` | `uuid` | no | `cluster4_lines(id)` FK, cascade delete |
| `week_id` | `uuid` | no | `weeks(id)` FK |
| `target_mode` | `text` | no | `user \| rule` |
| `target_user_id` | `uuid` | yes | `user_profiles(user_id)` FK |
| `target_rule` | `jsonb` | no | rule 대상 정의 |
| `created_by` | `uuid` | yes | `admin_users(id)` FK |
| `updated_by` | `uuid` | yes | `admin_users(id)` FK |
| `created_at` | `timestamptz` | no | default `now()` |
| `updated_at` | `timestamptz` | no | default `now()`, trigger 갱신 |

제약:
- `CHECK (target_mode IN ('user','rule'))`
- `target_mode='user'` 이면 `target_user_id IS NOT NULL AND target_rule = '{}'::jsonb`
- `target_mode='rule'` 이면 `target_user_id IS NULL AND jsonb_typeof(target_rule) = 'object'`

유니크:
- user target: `(line_id, week_id, target_user_id)` partial unique
- rule target: `(line_id, week_id, md5(target_rule::text))` partial unique

인덱스:
- `(week_id, target_mode)`
- `(target_user_id, week_id)` partial on `target_mode='user'`

### `public.cluster4_line_submissions`

사용자의 2차 입력을 저장한다.

| Column | Type | Null | Notes |
| --- | --- | --- | --- |
| `id` | `uuid` | no | PK |
| `line_target_id` | `uuid` | no | `cluster4_line_targets(id)` FK, cascade delete |
| `user_id` | `uuid` | no | `user_profiles(user_id)` FK |
| `subtitle` | `text` | yes | 사용자 입력 |
| `output_link_2` | `text` | yes | 사용자 입력 |
| `output_link_3` | `text` | yes | 사용자 입력 |
| `output_link_4` | `text` | yes | 사용자 입력 |
| `output_link_5` | `text` | yes | 사용자 입력 |
| `submitted_at` | `timestamptz` | no | 최초 제출 시각 |
| `created_at` | `timestamptz` | no | default `now()` |
| `updated_at` | `timestamptz` | no | default `now()`, trigger 갱신 |

제약:
- `CHECK (subtitle IS NULL OR btrim(subtitle) <> '')`

유니크:
- `(line_target_id, user_id)`

인덱스:
- `(user_id, updated_at DESC)`

추가 DB trigger:
- user-mode target 에 대해 `submission.user_id = target_user_id` 강제
- rule-mode target 의 실제 매칭 검증은 API/service layer 책임

## SQL Migration Draft

초안 파일:
- [`db/migrations/2026-05-26_cluster4_line_opening_step1_tables.sql`](/C:/Users/ynlee/OneDrive/바탕 화면/vraxium-admin/db/migrations/2026-05-26_cluster4_line_opening_step1_tables.sql)

핵심 원칙:
- idempotent (`CREATE TABLE IF NOT EXISTS`, `CREATE INDEX IF NOT EXISTS`, `CREATE OR REPLACE FUNCTION`)
- 기존 `career_projects` 미변경
- 상태값 미저장
- `updated_at` 은 trigger 갱신

## API Spec

### Admin API

관리자 API는 `supabaseAdmin` 경유 서버 권한으로 동작하고, request body 의 `created_by`, `updated_by` 는 신뢰하지 않는다. 서버가 현재 admin session 으로 채운다.

#### `GET /api/admin/cluster4/lines`

Query:
- `partType?=info|experience|competency|career`
- `weekId?=<uuid>`
- `targetMode?=user|rule`
- `q?=<search text>`
- `limit?=<int>`
- `offset?=<int>`

Response `200`:

```json
{
  "success": true,
  "data": {
    "rows": [
      {
        "id": "9f6fdf94-aaaa-bbbb-cccc-111111111111",
        "partType": "career",
        "mainTitle": "이번 주 실무 경력 라인",
        "outputLink1": "https://example.com/admin-guide",
        "submissionOpensAt": "2026-05-26T00:00:00.000Z",
        "submissionClosesAt": "2026-06-01T14:59:59.000Z",
        "isActive": true,
        "targetCount": 12,
        "createdAt": "2026-05-26T01:00:00.000Z",
        "updatedAt": "2026-05-26T01:00:00.000Z"
      }
    ],
    "total": 1,
    "limit": 50,
    "offset": 0
  }
}
```

#### `POST /api/admin/cluster4/lines`

Request:

```json
{
  "part_type": "career",
  "main_title": "이번 주 실무 경력 라인",
  "output_link_1": "https://example.com/admin-guide",
  "submission_opens_at": "2026-05-26T00:00:00.000Z",
  "submission_closes_at": "2026-06-01T14:59:59.000Z",
  "is_active": true
}
```

Response `201`:

```json
{
  "success": true,
  "data": {
    "line": {
      "id": "9f6fdf94-aaaa-bbbb-cccc-111111111111",
      "partType": "career",
      "mainTitle": "이번 주 실무 경력 라인",
      "outputLink1": "https://example.com/admin-guide",
      "submissionOpensAt": "2026-05-26T00:00:00.000Z",
      "submissionClosesAt": "2026-06-01T14:59:59.000Z",
      "isActive": true,
      "createdAt": "2026-05-26T01:00:00.000Z",
      "updatedAt": "2026-05-26T01:00:00.000Z"
    }
  }
}
```

#### `GET /api/admin/cluster4/lines/[id]`

Response `200`:

```json
{
  "success": true,
  "data": {
    "line": {
      "id": "9f6fdf94-aaaa-bbbb-cccc-111111111111",
      "partType": "career",
      "mainTitle": "이번 주 실무 경력 라인",
      "outputLink1": "https://example.com/admin-guide",
      "submissionOpensAt": "2026-05-26T00:00:00.000Z",
      "submissionClosesAt": "2026-06-01T14:59:59.000Z",
      "isActive": true,
      "createdAt": "2026-05-26T01:00:00.000Z",
      "updatedAt": "2026-05-26T01:00:00.000Z"
    }
  }
}
```

#### `PATCH /api/admin/cluster4/lines/[id]`

Request:

```json
{
  "main_title": "수정된 실무 경력 라인",
  "output_link_1": "https://example.com/updated-guide",
  "submission_opens_at": "2026-05-26T00:00:00.000Z",
  "submission_closes_at": "2026-06-03T14:59:59.000Z",
  "is_active": true
}
```

Response `200`:

```json
{
  "success": true,
  "data": {
    "line": {
      "id": "9f6fdf94-aaaa-bbbb-cccc-111111111111",
      "updatedAt": "2026-05-26T02:00:00.000Z"
    }
  }
}
```

#### `DELETE /api/admin/cluster4/lines/[id]`

Response `200`:

```json
{
  "success": true
}
```

삭제 시 target/submission 은 FK cascade 로 함께 제거된다.

#### `GET /api/admin/cluster4/lines/[id]/targets`

Response `200`:

```json
{
  "success": true,
  "data": {
    "lineId": "9f6fdf94-aaaa-bbbb-cccc-111111111111",
    "rows": [
      {
        "id": "bb6fdf94-aaaa-bbbb-cccc-111111111111",
        "weekId": "7f6fdf94-aaaa-bbbb-cccc-111111111111",
        "targetMode": "user",
        "targetUserId": "6f6fdf94-aaaa-bbbb-cccc-111111111111",
        "targetRule": {},
        "createdAt": "2026-05-26T01:10:00.000Z",
        "updatedAt": "2026-05-26T01:10:00.000Z"
      }
    ]
  }
}
```

#### `POST /api/admin/cluster4/lines/[id]/targets`

User target request:

```json
{
  "week_id": "7f6fdf94-aaaa-bbbb-cccc-111111111111",
  "target_mode": "user",
  "target_user_id": "6f6fdf94-aaaa-bbbb-cccc-111111111111"
}
```

Rule target request:

```json
{
  "week_id": "7f6fdf94-aaaa-bbbb-cccc-111111111111",
  "target_mode": "rule",
  "target_rule": {
    "organizationSlug": "vrax",
    "membershipLevel": "crew"
  }
}
```

Response `201`:

```json
{
  "success": true,
  "data": {
    "target": {
      "id": "bb6fdf94-aaaa-bbbb-cccc-111111111111",
      "lineId": "9f6fdf94-aaaa-bbbb-cccc-111111111111",
      "weekId": "7f6fdf94-aaaa-bbbb-cccc-111111111111",
      "targetMode": "user",
      "targetUserId": "6f6fdf94-aaaa-bbbb-cccc-111111111111",
      "targetRule": {}
    }
  }
}
```

#### `PATCH /api/admin/cluster4/targets/[targetId]`

Request:

```json
{
  "week_id": "7f6fdf94-aaaa-bbbb-cccc-111111111111",
  "target_mode": "rule",
  "target_rule": {
    "organizationSlug": "vrax",
    "membershipLevel": "leader"
  }
}
```

Response `200`:

```json
{
  "success": true,
  "data": {
    "target": {
      "id": "bb6fdf94-aaaa-bbbb-cccc-111111111111",
      "updatedAt": "2026-05-26T03:00:00.000Z"
    }
  }
}
```

#### `DELETE /api/admin/cluster4/targets/[targetId]`

Response `200`:

```json
{
  "success": true
}
```

삭제 시 해당 target 에 연결된 submission 은 FK cascade 로 제거된다.

### User API

사용자 API는 auth user 기준으로만 동작한다.
- request body/query 에 `userId` 를 받지 않는다.
- 서버가 세션의 auth user id 를 읽어 사용한다.
- 다른 사용자의 데이터 조회/수정 시도는 허용하지 않는다.

#### `GET /api/cluster4/lines/detail?weekId=&partType=`

Query:
- `weekId=<uuid>`
- `partType=info|experience|competency|career`

Response `200`, `void`:

```json
{
  "success": true,
  "data": {
    "status": "void",
    "partType": "career",
    "line": null,
    "submission": null
  }
}
```

Response `200`, `pending`:

```json
{
  "success": true,
  "data": {
    "status": "pending",
    "partType": "career",
    "line": {
      "lineId": "9f6fdf94-aaaa-bbbb-cccc-111111111111",
      "lineTargetId": "bb6fdf94-aaaa-bbbb-cccc-111111111111",
      "mainTitle": "이번 주 실무 경력 라인",
      "outputLink1": "https://example.com/admin-guide",
      "submissionOpensAt": "2026-05-26T00:00:00.000Z",
      "submissionClosesAt": "2026-06-01T14:59:59.000Z"
    },
    "submission": null
  }
}
```

Response `200`, `success`:

```json
{
  "success": true,
  "data": {
    "status": "success",
    "partType": "career",
    "line": {
      "lineId": "9f6fdf94-aaaa-bbbb-cccc-111111111111",
      "lineTargetId": "bb6fdf94-aaaa-bbbb-cccc-111111111111",
      "mainTitle": "이번 주 실무 경력 라인",
      "outputLink1": "https://example.com/admin-guide",
      "submissionOpensAt": "2026-05-26T00:00:00.000Z",
      "submissionClosesAt": "2026-06-01T14:59:59.000Z"
    },
    "submission": {
      "id": "cc6fdf94-aaaa-bbbb-cccc-111111111111",
      "subtitle": "사용자 2차 입력",
      "outputLink2": "https://example.com/out2",
      "outputLink3": "https://example.com/out3",
      "outputLink4": null,
      "outputLink5": null,
      "submittedAt": "2026-05-27T09:00:00.000Z",
      "updatedAt": "2026-05-27T09:00:00.000Z"
    }
  }
}
```

Response `200`, `fail`:

```json
{
  "success": true,
  "data": {
    "status": "fail",
    "partType": "career",
    "line": {
      "lineId": "9f6fdf94-aaaa-bbbb-cccc-111111111111",
      "lineTargetId": "bb6fdf94-aaaa-bbbb-cccc-111111111111",
      "mainTitle": "이번 주 실무 경력 라인",
      "outputLink1": "https://example.com/admin-guide",
      "submissionOpensAt": "2026-05-26T00:00:00.000Z",
      "submissionClosesAt": "2026-06-01T14:59:59.000Z"
    },
    "submission": null
  }
}
```

#### `POST /api/cluster4/lines/[lineTargetId]/submission`

Request:

```json
{
  "subtitle": "사용자 2차 입력",
  "output_link_2": "https://example.com/out2",
  "output_link_3": "https://example.com/out3",
  "output_link_4": null,
  "output_link_5": null
}
```

Response `201`:

```json
{
  "success": true,
  "data": {
    "submission": {
      "id": "cc6fdf94-aaaa-bbbb-cccc-111111111111",
      "lineTargetId": "bb6fdf94-aaaa-bbbb-cccc-111111111111",
      "subtitle": "사용자 2차 입력",
      "outputLink2": "https://example.com/out2",
      "outputLink3": "https://example.com/out3",
      "outputLink4": null,
      "outputLink5": null,
      "submittedAt": "2026-05-27T09:00:00.000Z",
      "updatedAt": "2026-05-27T09:00:00.000Z"
    }
  }
}
```

Errors:
- `403`: auth user 가 해당 target 대상이 아님
- `409`: 이미 submission 이 존재함
- `410`: 제출 기간 종료

#### `PATCH /api/cluster4/lines/[lineTargetId]/submission`

Request:

```json
{
  "subtitle": "수정된 사용자 2차 입력",
  "output_link_2": "https://example.com/out2-updated",
  "output_link_3": "https://example.com/out3",
  "output_link_4": "https://example.com/out4",
  "output_link_5": null
}
```

Response `200`:

```json
{
  "success": true,
  "data": {
    "submission": {
      "id": "cc6fdf94-aaaa-bbbb-cccc-111111111111",
      "updatedAt": "2026-05-27T09:30:00.000Z"
    }
  }
}
```

Errors:
- `403`: auth user 가 해당 submission owner 가 아님
- `404`: submission 없음
- `410`: 제출 기간 종료

## Status Calculation

입력:
- auth user
- `weekId`
- `partType`

절차:
1. `cluster4_line_targets` 에서 해당 `weekId` + `partType` 에 맞는 line target 후보를 찾는다.
2. auth user 에 대해 `target_mode='user'` 이면 `target_user_id = authUserId` 로 매칭한다.
3. `target_mode='rule'` 이면 API/service layer 의 rule evaluator 로 auth user 를 판정한다.
4. 매칭된 target 이 없으면 `void`.
5. 매칭된 target 이 있으면 `cluster4_line_submissions` 를 `(line_target_id, authUserId)` 로 조회한다.
6. submission 이 있으면 `success`.
7. submission 이 없고 현재 시각이 `submission_closes_at` 이전 또는 같으면 `pending`.
8. submission 이 없고 현재 시각이 `submission_closes_at` 이후면 `fail`.

정리:
- target 없음 → `void`
- target 있음 + submission 없음 + 기간 안 → `pending`
- target 있음 + submission 있음 → `success`
- target 있음 + submission 없음 + 기간 종료 → `fail`

## Implementation Notes

- 사용자 API 는 절대 `userId` 를 query/body 로 받지 않는다.
- 사용자 API 는 auth session 의 user id 만 사용한다.
- `main_title`, `output_link_1`, 제출 기간, target 설정은 admin API 만 수정 가능하다.
- user API 는 `subtitle`, `output_link_2`~`output_link_5` 만 수정 가능하다.
- 제출 기간 종료 후 user create/update 모두 차단한다.
- `target_rule` 는 JSON object canonicalization 규칙을 정해야 한다.
  지금 초안은 `md5(target_rule::text)` unique 를 사용하므로, API 에서 key ordering 을 일관되게 normalize 하는 편이 안전하다.
- rule target 의 "누가 대상인가" 검증은 DB 가 아니라 API/service layer 가 책임진다.
- `submitted_at` 은 최초 생성 시각으로 유지하고, 수정 시에는 `updated_at` 만 변한다.
- 추후 read model 이 복잡해지면 `cluster4_line_status_view` 같은 조회용 view 를 추가하는 것이 좋다.
