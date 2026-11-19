// Supabase 연결 정보. anon(publishable) 키는 브라우저에 공개되도록 만들어진 키라서 여기에 두어도 됩니다.
// 실제 데이터는 데이터베이스 접근 규칙(RLS)이 지킵니다. service_role 키는 절대 여기에 넣지 마세요.
window.NK_CONFIG = {
  SUPABASE_URL: "__SUPABASE_URL__",
  SUPABASE_ANON_KEY: "__SUPABASE_ANON_KEY__",
};
