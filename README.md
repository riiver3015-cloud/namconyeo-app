# 남코녀 사전설문 · 컨설팅 준비판

- `docs/index.html` — 고객용 사전설문 폼 (사진 업로드, 동의 포함)
- `docs/admin.html` — 대표용 준비판 (이메일 링크 로그인, AI 계획서, 사진, 현장 기록)
- `docs/config.js` — Supabase 주소와 공개(anon) 키
- `supabase/schema.sql` — 표, 접근 규칙(RLS), 사진 저장소, 설문 → AI 자동 호출 트리거
- `supabase/functions/analyze/index.ts` — 설문이 들어오면 Claude(claude-opus-5-5)로 계획서 초안을 만드는 함수

흐름: 고객이 폼 제출 → 사진은 비공개 저장소, 답변은 `surveys` 표 → 트리거가 `analyze` 함수 호출 → Claude가 남코녀 분석 기준(`settings` 표의 criteria)으로 계획서 작성 → `plans` 표 저장 → 준비판에 실시간 표시.

분석 기준은 공개 저장소에 두지 않고 Supabase `settings` 표에만 저장합니다.
