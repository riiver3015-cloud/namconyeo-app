// 남코녀 AI 계획서 함수 (Supabase Edge Function: analyze)
// - 설문이 저장되면 DB 트리거가 { survey_id } 로 호출합니다.
// - 준비판의 "다시 분석" 버튼도 같은 방식으로 호출합니다.
// - plans.status 가 'queued' 인 설문만 처리하므로, 주소를 아는 사람이 호출해도 중복 과금되지 않습니다.
// 필요한 비밀값(Supabase > Edge Functions > Secrets): ANTHROPIC_API_KEY
// (SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY 는 Supabase가 자동으로 넣어 줍니다.)

import Anthropic from "npm:@anthropic-ai/sdk";
import { createClient } from "npm:@supabase/supabase-js@2";

const MODEL = "claude-opus-5-5";
const BUCKET = "survey-photos";

// 관리자 키: 예전 이름(SUPABASE_SERVICE_ROLE_KEY)과 새 이름(SUPABASE_SECRET_KEY / SUPABASE_SECRET_KEYS) 모두 지원
function adminKey(): string {
  const direct = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || Deno.env.get("SUPABASE_SECRET_KEY");
  if (direct) return direct;
  const many = Deno.env.get("SUPABASE_SECRET_KEYS");
  if (many) {
    try { const v = JSON.parse(many); return (Array.isArray(v) ? v[0] : Object.values(v)[0]) as string; } catch { return many; }
  }
  throw new Error("Supabase 관리자 키 환경변수를 찾을 수 없음");
}
const supabase = createClient(Deno.env.get("SUPABASE_URL")!, adminKey());
const anthropic = new Anthropic({ apiKey: Deno.env.get("ANTHROPIC_API_KEY") });

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

// 준비판이 그대로 그리는 계획서 구조 (모든 칸 필수)
const str = { type: "string" };
const strs = { type: "array", items: str };
const obj = (props: Record<string, unknown>) => ({ type: "object", properties: props, required: Object.keys(props), additionalProperties: false });
const planSchema = (lookKeys: string[]) => obj({
  summary: str,
  analysis: { type: "array", items: obj({ item: str, judgment: str }) },
  hair: obj({ recommend: str, avoid: str, designer_note: str }),
  colors: { type: "array", items: obj({ candidate: str, reason: str, colors: str }) },
  styles: { type: "array", items: obj({ rank: str, direction: str, reason: str }) },
  principles: strs,
  shopping: { type: "array", items: obj({ priority: str, item: str, budget: str, brands: str, reason: str }) },
  outfits: strs,
  timeline: { type: "array", items: obj({ time: str, task: str }) },
  area: str,
  checklist: strs,
  one_liner: str,
  // 현장 기록 칸에 미리 골라 둘 값 (대표님이 현장에서 바꿀 수 있음)
  picks: obj({
    bone: { type: "string", enum: ["스트레이트", "웨이브", "내추럴"] },
    color_chroma: { type: "string", enum: ["저채도", "중채도", "고채도"] },
    color_value: { type: "string", enum: ["고명도", "중명도", "저명도"] },
    color_clarity: { type: "string", enum: ["청도", "탁도"] },
    color_temp: { type: "string", enum: ["웜", "쿨", "뉴트럴"] },
    style: { type: "string", enum: ["캐쥬얼", "댄디", "포멀", "스트리트", "아메카지"] },
    reason: str,
  }),
  // 남코녀 코디 사진 모음(lookbook)에서 고른 코디 3개
  lookbook: { type: "array", items: obj({ key: lookKeys.length ? { type: "string", enum: lookKeys } : str, reason: str }) },
});

const BASE_INSTRUCTIONS = `당신은 남성 스타일 컨설팅 브랜드 '남코녀'(남자 코디해주는 여자)의 컨설팅 준비 담당입니다.
고객의 사전설문과 사진을 보고, 대표 컨설턴트가 오프라인 컨설팅 전에 검수할 "컨설팅 계획서 초안"을 씁니다.

반드시 지킬 것
- 아래 "남코녀 분석 기준"을 가장 먼저 따릅니다. 기준에서 나온 판단 앞에는 📏, 사진으로 추정한 판단에는 🔶, 현장에서 꼭 확인할 것에는 ❓를 붙입니다.
- 기준에 비어 있는 내용(V·H·O형 코디, 얼굴 큰·목 짧은·다리 두꺼운·키 작은 체형 코디 등)은 지어내지 말고 "일반 원칙(대표님 기준 아님):"으로 시작해 적습니다.
- 체형은 A/I/O/H/V(판정 순서 O→A→I→V→H, BMI 계산 포함)와 골격(웨이브/내추럴/스트레이트, 혼합 비율 가능)을 둘 다 적습니다. 어깨·허리·골반 너비는 설문에 없으니 사진으로 추정하고 체크리스트에 실측을 넣습니다.
- 얼굴은 얼굴형, 광대, 무턱 여부(측면 사진 기준), 중안부·하안부 길이, 얼굴 크기를 analysis에 각각 따로 적습니다. 인상은 후보로 적습니다.
- 퍼스널컬러는 절대 확정하지 않고 colors에 후보 2개만 적습니다.
- 스타일은 체형 기준과 얼굴 인상 기준 매칭표에서 겹치는 스타일로 styles에 2~3안을 입혀볼 순서대로 적습니다.
- picks에는 현장 기록 칸에 미리 골라 둘 값을 하나씩 고릅니다: 골격(가장 가까운 것 하나), 퍼스널컬러 4축(채도·명도·청탁도·온도, colors의 1순위 후보와 맞게), 스타일(styles 1순위와 맞게). 사진 기반 임시 판단이며 대표님이 현장에서 바꿉니다. reason에 각 선택 이유를 한두 줄로 적습니다.
- 예산은 컨설팅비를 뺀 의류 구매 예산입니다. 보유 옷과 겹치지 않게 사고, 보유 옷을 완성 코디에 활용합니다.
- 서비스에 '헤메'가 있으면 hair.designer_note를 디자이너에게 그대로 전할 문장으로 씁니다. '촬영'이 있으면 checklist에 촬영 자세·각도 메모를 넣습니다.
- 쇼핑 지역(area)은 대표님이 정합니다. 사전설문의 "쇼핑 지역 (대표님 확정)" 값을 그대로 area에 적고, 절대 바꾸거나 다른 지역을 권하지 않습니다(거주지로 추측하지 않음). 값이 (미정)이면 area에는 "미정"만 적고, shopping은 아이템·예산만 쓰되 매장·층은 쓰지 않으며, timeline의 쇼핑 칸은 "❓ 지역 미정 — 대표님이 지역을 정하면 동선을 다시 짭니다" 한 줄만 둡니다.
- 쇼핑 지역이 잠실이면 기준의 "잠실 동선 매뉴얼", 여의도면 "여의도(영등포) 동선 매뉴얼"대로 shopping과 timeline을 짭니다. 매뉴얼에 ❓로 비어 있는 아이템·조건은 지어내지 말고 ❓로 남깁니다. 매뉴얼의 고객 구분 규칙(통통/날씬, 맑은 컬러, 예산)을 설문 숫자로 계산해 매장과 추천 제품을 고르고, 예산이 모자라면 매뉴얼의 빼는 순서를 따릅니다. 매장 순서는 매뉴얼 순서(층 동선)를 지키고, 각 매장 칸에 층과 살 것을 적습니다.
- timeline의 첫 칸은 "0~10분 분석 설명"으로 하고, task에 대표님이 현장에서 그대로 읽을 짧은 설명을 체형 → 이미지·이목구비(헤어 한 줄) → 오늘 동선·예산 순으로 한두 문장씩 적습니다. 나머지 시간은 쇼핑에 씁니다.
- lookbook에는 "남코녀 코디 사진 모음"에서 이 고객에게 입힐 코디를 정확히 3개 고릅니다. 체형·골격·퍼스널컬러 후보·스타일 순위·컨설팅 날짜의 계절·직업과 목적을 함께 보고, 서로 다른 느낌으로 고르며 1번이 가장 추천하는 코디입니다. reason에 왜 이 고객에게 맞는지 한두 줄로 적습니다.
- 사진에 고객이 아닌 사람이 섞여 있으면 누구인지 추정하지 말고 ❓로 적습니다.
- 모든 문장은 한국어, 쉬운 말로 씁니다. 고객 이름·연락처는 계획서에 쓰지 않습니다.`;

async function loadLookbook(): Promise<{ keys: string[]; text: string }> {
  const { data } = await supabase.from("lookbook").select("key,style,season,items,colors,bone").eq("active", true).order("key");
  const rows = data ?? [];
  return {
    keys: rows.map((r) => r.key),
    text: rows.map((r) => `${r.key} | ${r.style} | ${r.season} | ${r.items} | 색: ${r.colors} | 잘 맞는 골격: ${r.bone}`).join("\n"),
  };
}

async function loadCriteria(): Promise<string> {
  const { data } = await supabase.from("settings").select("value").eq("key", "criteria").maybeSingle();
  return data?.value ?? "(분석 기준이 아직 등록되지 않았습니다. 일반 원칙으로 작성하고 그렇게 표시하세요.)";
}

function surveyText(s: Record<string, unknown>): string {
  const lines: [string, unknown][] = [
    ["나이", s.age], ["직업·평소 복장", s.job], ["거주 지역", s.region], ["키 / 몸무게", s.height_weight],
    ["상의 / 하의 / 신발 사이즈", s.sizes], ["보완하고 싶은 신체 특징", (s.body_concerns as string[] | null)?.join(", ")],
    ["의류 예산", s.budget], ["패션 이해도", s.fashion_level], ["컨설팅 기대사항", s.expectation],
    ["받아본 서비스", (s.prior_services as string[] | null)?.join(", ")], ["이전 진단 결과", s.prior_result],
    ["보유 신발", s.shoes], ["보유 바지", s.pants],
    ["모질·숱·곱슬 (본인 선택)", [s.hair_thick, s.hair_amount, s.hair_curl].filter(Boolean).join(" / ")],
    ["머리 손질 시간", s.hair_care],
    ["컨설팅 일정", [s.consult_date, s.consult_time].filter(Boolean).join(" ")], ["서비스", s.service],
    ["쇼핑 지역 (대표님 확정)", s.shop_area || "(미정)"],
  ];
  return lines.map(([k, v]) => `- ${k}: ${v === undefined || v === null || v === "" ? "(공란)" : v}`).join("\n");
}

async function imageBlocks(photos: Record<string, string[]>): Promise<Anthropic.Beta.BetaContentBlockParam[]> {
  const blocks: Anthropic.Beta.BetaContentBlockParam[] = [];
  const groups: [string, string][] = [["body", "체형이 잘 드러나는 전신사진"], ["face", "셀카 (정면·측면)"], ["style", "평소 스타일 전신사진"]];
  for (const [key, label] of groups) {
    const paths = photos?.[key] ?? [];
    if (!paths.length) continue;
    const { data, error } = await supabase.storage.from(BUCKET).createSignedUrls(paths, 600);
    if (error) throw new Error(`사진 주소 생성 실패: ${error.message}`);
    blocks.push({ type: "text", text: `[${label} ${paths.length}장]` });
    for (const item of data ?? []) {
      if (item.signedUrl) blocks.push({ type: "image", source: { type: "url", url: item.signedUrl } });
    }
  }
  return blocks;
}

async function analyze(surveyId: string) {
  // queued → processing 으로 바꾼 경우에만 진행 (중복 실행 방지)
  const { data: claimed } = await supabase.from("plans")
    .update({ status: "processing", error: null, updated_at: new Date().toISOString() })
    .eq("survey_id", surveyId).eq("status", "queued").select("survey_id");
  if (!claimed?.length) return;

  try {
    const { data: s, error } = await supabase.from("surveys").select("*").eq("id", surveyId).single();
    if (error || !s) throw new Error(`설문을 찾을 수 없음: ${error?.message}`);
    const criteria = await loadCriteria();
    const images = await imageBlocks(s.photos);
    const look = await loadLookbook();

    const response = await anthropic.beta.messages.create({
      model: MODEL,
      max_tokens: 16000,
      betas: ["server-side-fallback-2026-07-01"],
      fallbacks: "default",
      output_config: { effort: "medium", format: { type: "json_schema", schema: planSchema(look.keys) } },
      system: [
        { type: "text", text: BASE_INSTRUCTIONS },
        { type: "text", text: `## 남코녀 분석 기준\n\n${criteria}\n\n## 남코녀 코디 사진 모음 (key | 스타일 | 계절 | 구성 | 색 | 잘 맞는 골격)\n${look.text || "(없음)"}`, cache_control: { type: "ephemeral" } },
      ],
      messages: [{
        role: "user",
        content: [
          { type: "text", text: `다음 고객의 컨설팅 계획서 초안을 작성하세요.\n\n## 사전설문\n${surveyText(s)}\n\n## 사진` },
          ...images,
        ],
      }],
    });

    if (response.stop_reason === "refusal") throw new Error(`AI가 작성을 거절함 (${response.stop_details?.category ?? "사유 미상"})`);
    if (response.stop_reason === "max_tokens") throw new Error("계획서가 너무 길어 중간에 끊김");
    const text = response.content.filter((b) => b.type === "text").map((b) => (b as { text: string }).text).join("");
    const plan = JSON.parse(text);
    plan.area = s.shop_area ? String(s.shop_area) : "미정"; // 지역은 AI가 고르지 않음 (대표님이 정한 값으로 고정)

    await supabase.from("plans").update({
      status: "done", plan, model: response.model, error: null,
      usage: response.usage as unknown as Record<string, unknown>, updated_at: new Date().toISOString(),
    }).eq("survey_id", surveyId);
    // 설명 모드용 사진 선·도형 좌표도 같이 만들어 둠 (실패해도 계획서는 그대로)
    // 설명 모드용 사진 선·도형 좌표는 따로 한 번 더 불러서 만듦 (같은 실행 안에서 하면 시간 제한에 걸려 끊김)
    try {
      await fetch(`${Deno.env.get("SUPABASE_URL")}/functions/v1/analyze`, { method: "POST", headers: { "Content-Type": "application/json", "x-nk-internal": adminKey(), apikey: Deno.env.get("SUPABASE_ANON_KEY") ?? "", Authorization: `Bearer ${Deno.env.get("SUPABASE_ANON_KEY") ?? ""}` }, body: JSON.stringify({ survey_id: surveyId, mode: "photo_marks_bg" }) });
    } catch (e) { console.error("marks trigger failed:", (e as Error).message); }
  } catch (e) {
    const msg = e instanceof Anthropic.APIError ? `Claude API 오류 ${e.status}: ${e.message}` : (e as Error).message;
    await supabase.from("plans").update({ status: "error", error: msg, updated_at: new Date().toISOString() }).eq("survey_id", surveyId);
  }
}

// ===== 현장 AI 초안 (관리자 화면 "AI 초안 채우기") =====
// 현장 기록 1~4단계(실측·체형·골격·얼굴 사진)까지 넣은 뒤 누르면 5~8단계 초안을 돌려줍니다. DB에는 쓰지 않고, 관리자 화면이 비어 있는 칸만 채웁니다.
const enumArr = (vals: string[]) => ({ type: "array", items: { type: "string", enum: vals } });
const RANK = { type: "string", enum: ["1st", "2nd", "3rd", "✕"] };
const draftSchema = obj({
  body_type: { type: "string", enum: ["A형", "I형", "O형", "H형", "V형"] },
  image: enumArr(["캐쥬얼", "댄디", "포멀", "스트리트", "아메카지"]),
  image_reason: str,
  glasses: obj({ none: RANK, horn: RANK, brow: RANK, silver: RANK }),
  glasses_reason: str,
  hair_forehead: { type: "string", enum: ["넓음", "중간", "좁음"] },
  hair_bangs: { type: "string", enum: ["올림 (이마 드러냄)", "눈썹 위", "눈썹 선", "눈썹~눈 사이", "눈 아래"] },
  hair_down: { type: "string", enum: ["필요", "필요 없음"] },
  hair_head: enumArr(["뒤통수 납작", "정수리 납작", "옆머리 뜸", "M자 헤어라인"]),
  hair_pick: enumArr(["댄디컷", "시스루 댄디컷", "덮은 머리 (긴 댄디)", "쉼표머리", "가르마펌", "사이드 가르마컷", "애즈펌", "리프컷", "아이비리그컷", "크롭컷", "텍스처드 펌", "볼륨펌", "히피펌", "울프컷"]),
  hair_why: strs, hair_diag: str, hair_side: str, hair_back: str, hair_perm: str, hair_home: str,
  hair_request: str, hair_reason: str,
  mk_diag: str, mk_skin: str, mk_brow: str, mk_shade: str, mk_point: str, mk_request: str, mk_home: str,
  top_neck: enumArr(["라운드넥", "브이넥", "헨리넥", "터틀넥", "카라넥"]),
  top_fit: enumArr(["슬림핏(머슬핏)", "레귤러 핏", "세미오버핏", "오버핏"]),
  top_fabric: enumArr(["니트", "데님", "면(코튼)", "린넨", "레이온"]),
  top_detail: enumArr(["무지", "프린팅", "로고", "절개선", "스트라이프"]),
  bottom_width: enumArr(["슬림", "레귤러", "세미와이드", "와이드", "엑스트라 와이드"]),
  bottom_shape: enumArr(["슬림 일자핏", "와이드 일자핏", "둥근핏(커브드)"]),
  outer_length: enumArr(["크롭", "기본", "하프", "롱"]),
  outer_shoulder: enumArr(["레귤러", "드롭숄더", "래글런", "구조적인 어깨", "어깨패드"]),
  outer_fabric: enumArr(["울·캐시미어", "데님", "가죽", "나일론", "코튼", "스웨이드", "무스탕"]),
  style_reason: str,
});
const DRAFT_INSTRUCTIONS = `당신은 남성 스타일 컨설팅 브랜드 '남코녀'의 현장 보조입니다. 대표 컨설턴트가 고객을 만나 실측·체형·골격·얼굴 사진까지 기록했습니다.
이 정보로 현장 기록 5~8단계 초안을 고릅니다. 대표님이 보고 틀린 것만 고칩니다.
- body_type(A/I/O/H/V 체형): 현장에서 확정한 체형이 있으면 그대로. 없으면 실측 너비가 있으면 그것으로, 없으면 전신사진과 키·몸무게(BMI)로 기준의 판정 순서(O → A → I → V → H)를 따라 고릅니다.
- 아래 "남코녀 분석 기준"을 먼저 따릅니다. 대표님이 현장에서 확정한 체형·골격·컬러가 있으면 사전 계획서보다 그것을 우선합니다.
- image(어울리는 이미지)는 1~2개. 기준의 '체형 기준 + 얼굴 인상 기준' 매칭에서 겹치는 것을 고릅니다.
- glasses는 안경 착용 X(none)·뿔테(horn)·하금테(brow)·실버테(silver) 각각에 1st/2nd/3rd/✕ 중 하나. 1st는 하나만. 안경 사진이 있으면 사진을 보고, 없으면 얼굴형 기준으로 판단하고 reason에 "사진 없음"이라고 적습니다.
- 헤어는 두 단계로 고릅니다. (1) 어울림: 기준의 얼굴형·이마·두상 규칙, 얼굴 비율(실측이 있으면 실측), 이목구비, 고른 이미지에 맞는 후보를 뽑습니다. (2) 구현 가능: 모질·숱·곱슬기(현장 확인값, 없으면 설문 본인 선택), 두상, 머리 손질 시간으로 걸러 매일 유지할 수 있는 것만 남깁니다. 얼굴에 어울려도 손질 시간이 5분 미만인 고객에게 매일 드라이가 필요한 스타일은 1순위로 두지 않습니다.
- hair_forehead는 정면 사진으로 판단. hair_head는 사진에서 분명히 보이는 것만 고릅니다(없으면 빈 배열). hair_pick은 추천 헤어스타일 3개를 1순위부터. hair_why는 hair_pick과 같은 순서로 3개, 각각 "왜 어울리는지 + 왜 관리할 수 있는지"를 고객에게 보여 줄 한 문장으로. hair_diag는 얼굴 비율·헤어라인·모질을 묶은 진단 한 문장(고객용).
- hair_bangs는 앞머리 기장 하나. hair_down은 옆머리가 뜨는 모질(반곱슬·악성곱슬·두꺼운 직모)이거나 사진에서 옆머리가 떠 보이면 "필요". hair_side·hair_back은 옆머리·뒷머리를 어떻게 자를지 짧게. hair_perm은 필요한 펌(없으면 "필요 없음").
- hair_request는 고객이 헤어샵에서 그대로 말할 문장(존댓말, 2~3문장): 1순위 헤어 이름, 앞머리 기장, 옆·뒷머리, 다운펌·펌 여부. hair_home은 집에서 손질하는 법 3줄(드라이 방향, 제품, 순서)을 "1. … 2. … 3. …" 형태로, 고객의 손질 시간 안에 끝나게. 모질·숱·곱슬기 자체는 고르지 않습니다.
- 메이크업(mk_*)은 서비스에 '헤메'가 있을 때만 씁니다. 없으면 모두 빈 문자열. 남성 그루밍 메이크업이라 티 나지 않게 "원래 피부가 좋은 사람"처럼 보이는 것이 기준입니다. 얼굴 사진에서 보이는 것만 근거로 씁니다(피부 톤·잡티·다크서클·눈썹 숱과 모양·얼굴 윤곽). 사진 조명 때문에 피부 톤은 확정하지 말고 "사진상"이라고 적습니다.
  mk_diag: 메이크업 진단 한 문장(고객용). mk_skin: 피부 표현(베이스 두께·커버할 곳). mk_brow: 눈썹 모양·색·정리할 곳. mk_shade: 음영·쉐딩 위치(얼굴형 보완). mk_point: 그 밖에(입술 보습, 다크서클 등, 없으면 "없음"). mk_request: 메이크업 선생님께 그대로 전할 요청 2~3문장(존댓말). mk_home: 고객이 혼자 할 때 순서 3줄 "1. … 2. … 3. …"(제품 종류 위주, 브랜드명 없이, 5분 안에).
- 스타일 방향성(top_*, bottom_*, outer_*)은 각 1~2개. 체형·골격·이미지·고객 고민(두꺼운 다리 등)·예산에 맞춥니다. 기준에 비어 있는 체형 규칙은 일반 원칙으로 판단합니다.
- *_reason은 대표님이 읽을 한두 문장, 쉬운 한국어. 고객 이름은 쓰지 않습니다.`;

async function signedImages(paths: [string, string][]): Promise<Anthropic.Beta.BetaContentBlockParam[]> {
  const list = paths.filter(([, p]) => p);
  if (!list.length) return [];
  const { data } = await supabase.storage.from(BUCKET).createSignedUrls(list.map(([, p]) => p), 600);
  const out: Anthropic.Beta.BetaContentBlockParam[] = [];
  list.forEach(([label], i) => { const u = data?.[i]?.signedUrl; if (u) out.push({ type: "text", text: `[${label}]` }, { type: "image", source: { type: "url", url: u } }); });
  return out;
}

async function onsiteDraft(req: Request, surveyId: string): Promise<Response> {
  const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status, headers: { ...cors, "Content-Type": "application/json" } });
  // 관리자만 (로그인 토큰 확인 → admins 표)
  const token = (req.headers.get("Authorization") || "").replace(/^Bearer\s+/i, "");
  const { data: u } = await supabase.auth.getUser(token);
  if (!u?.user) return json({ error: "관리자 로그인이 필요해요" }, 401);
  const { data: adm } = await supabase.from("admins").select("user_id").eq("user_id", u.user.id);
  if (!adm?.length) return json({ error: "관리자 권한이 없어요" }, 403);

  const [{ data: s }, { data: p }, { data: o }] = await Promise.all([
    supabase.from("surveys").select("*").eq("id", surveyId).single(),
    supabase.from("plans").select("plan").eq("survey_id", surveyId).maybeSingle(),
    supabase.from("onsite").select("*").eq("survey_id", surveyId).maybeSingle(),
  ]);
  if (!s) return json({ error: "설문을 찾을 수 없어요" }, 404);
  const rep = (o?.report ?? {}) as Record<string, any>;
  const plan = (p?.plan ?? {}) as Record<string, any>;
  const onsiteText = [
    `- 실측 어깨/허리/골반: ${[o?.shoulder, o?.waist, o?.hip].map((x) => x ?? "?").join(" / ")} cm`,
    `- 현장 확정 체형: ${o?.body_type ?? "(미정)"} / 골격: ${o?.bone ?? "(미정)"}`,
    `- 컬러(현장): ${o?.color || "(아직 천 대보기 전)"}`,
    `- 예외사항: ${o?.exception || "(없음)"}`,
    `- 모질/숱/곱슬 (현장 확인값, 없으면 설문 본인 선택): ${[rep.hair_thick || s.hair_thick, rep.hair_amount || s.hair_amount, rep.hair_curl || s.hair_curl].map((x) => x || "?").join(" / ")}`,
    `- 두상·헤어라인 (현장 체크): ${(rep.hair_head || []).join(", ") || "(없음)"}`,
    `- 얼굴 실측 비율 상:중:하안부 ${rep.face_ratio || "(없음)"} / 가로:세로 ${rep.face_wh || "(없음)"}`,
  ].join("\n");
  const planText = plan.summary ? `${plan.summary}\n${(plan.analysis || []).map((r: any) => `- ${r.item}: ${r.judgment}`).join("\n")}` : "(사전 계획서 없음)";
  const faces: [string, string][] = [["현장 얼굴 왼쪽", rep.face?.left], ["현장 얼굴 정면", rep.face?.front], ["현장 얼굴 오른쪽", rep.face?.right]];
  const glasses: [string, string][] = [["안경 착용 X", rep.glass_photos?.none], ["뿔테 안경", rep.glass_photos?.horn], ["하금테 안경", rep.glass_photos?.brow], ["실버테 안경", rep.glass_photos?.silver]];
  const surveyFaces: [string, string][] = faces.some(([, x]) => x) ? [] : ((s.photos?.face ?? []) as string[]).slice(0, 2).map((x, i) => [`사전 셀카 ${i + 1}`, x]);
  const body: [string, string][] = ((s.photos?.body ?? []) as string[]).slice(0, 2).map((x, i) => [`사전 전신사진 ${i + 1}`, x]);
  const images = await signedImages([...faces, ...surveyFaces, ...glasses, ...body]);
  const criteria = await loadCriteria();
  try {
    const response = await anthropic.beta.messages.create({
      model: MODEL,
      max_tokens: 6000,
      betas: ["server-side-fallback-2026-07-01"],
      fallbacks: "default",
      output_config: { effort: "low", format: { type: "json_schema", schema: draftSchema } },
      system: [
        { type: "text", text: DRAFT_INSTRUCTIONS },
        { type: "text", text: `## 남코녀 분석 기준\n\n${criteria}`, cache_control: { type: "ephemeral" } },
      ],
      messages: [{ role: "user", content: [
        { type: "text", text: `## 사전설문\n${surveyText(s)}\n\n## 현장 기록\n${onsiteText}\n\n## 사전 계획서 요약 (참고)\n${planText}\n\n## 사진` },
        ...images,
      ] }],
    });
    if (response.stop_reason === "refusal") return json({ error: "AI가 작성을 거절했어요" }, 502);
    const text = response.content.filter((b) => b.type === "text").map((b) => (b as { text: string }).text).join("");
    return json({ draft: JSON.parse(text), usage: response.usage });
  } catch (e) {
    const msg = e instanceof Anthropic.APIError ? `Claude API 오류 ${e.status}: ${e.message}` : (e as Error).message;
    return json({ error: msg }, 502);
  }
}

// ===== 택 사진 읽기 (관리자 화면 9단계 "택 읽기") =====
// 택 사진 + 택 없는 옷 메모를 읽어 구매 리스트 행을 돌려줍니다. 택에 제품명이 없으면 품번을 웹 검색해 찾습니다. DB에는 쓰지 않고, 관리자 화면이 리스트에 덧붙입니다.
const TAG_INSTRUCTIONS = `당신은 남성 스타일 컨설팅 브랜드 '남코녀'의 현장 보조입니다. 동행쇼핑에서 고객이 산 옷의 택(가격표) 사진과, 택이 없는 옷에 대한 대표님 메모를 읽어 구매 리스트를 만듭니다.
- 옷 한 벌 = 한 행. 같은 옷을 여러 각도로 찍은 사진은 한 행으로 합칩니다. 택 한 장에 여러 옷이 보이면 각각 나눕니다.
- brand: 브랜드 이름(한국어로 흔히 부르는 이름, 예: 유니클로, 무신사 스탠다드, 마시모두띠, 쿠에른). 택에 영문만 있으면 한국어 표기로 씁니다.
- item: 제품명을 짧게(예: 울 블렌드 라운드넥 니트). 품번·바코드 숫자는 쓰지 않습니다. color: 택에 적힌 색(한국어, 예: 네이비). size: 택의 사이즈 그대로(예: L, 32, 260).
- price: 원 단위 정수. 할인 가격이 따로 찍혀 있으면 할인 가격. 메모의 "29.8만"은 298000. 모르면 0.
- source: "택 사진 3" 또는 "메모"처럼 어디서 읽었는지.
- unsure: 잘 안 보여서 추정했거나 빠진 칸이 있으면 무엇인지 짧게(예: "가격이 흐려서 추정"). 확실하면 빈 문자열.
- "이미 있는 구매 리스트"에 있는 옷은 다시 넣지 않습니다.
- 택이 아닌 사진(코디 사진 등)이나 읽을 수 없는 사진은 건너뛰고 note에 적습니다. note는 대표님이 읽을 한두 문장, 쉬운 한국어.
- 추측으로 브랜드·가격을 지어내지 않습니다. 안 보이면 비우고(가격은 0) unsure에 적습니다.

## 택에 제품명이 없을 때: 웹 검색으로 찾기
- 택에 제품명이 안 적힌 브랜드(예: 마시모두띠, 자라)는 web_search로 "브랜드명 + 택의 품번 그대로"를 검색합니다.
  예) 마시모두띠 택 "Artículo 1468/222/507" → "마시모두띠 1468/222/507" 검색. 1468/222는 상품 번호, 507은 옵션(색상) 번호입니다.
  못 찾으면 검색어를 바꿔 봅니다: "Massimo Dutti 1468/222", "massimodutti l01468222"(공식몰 주소는 끝이 l0 + 상품번호 7자리). 공식몰·쇼핑몰 페이지 주소가 나오면 web_fetch로 열어 제품명과 색을 확인합니다.
  해외 공식몰(영문)에서만 찾았으면 영문 이름을 자연스러운 한국어로 옮겨 씁니다(예: 100% wool button knit polo sweater → 100% 울 버튼 니트 폴로 스웨터).
- 검색 결과의 한국어 제품명을 item에, 옵션 번호에 해당하는 색을 color에 씁니다(예: 다크 카키). 한국 공식몰(massimodutti.com/kr 등) 이름을 우선합니다.
- 가격은 검색 결과가 아니라 택에 찍힌 가격을 씁니다.
- 검색으로 확인한 제품이면 unsure에 "제품명은 품번 검색으로 확인"이라고 적어 대표님이 한 번 볼 수 있게 합니다. 검색해도 못 찾으면 item은 택에서 보이는 대로(또는 비움) 두고 unsure에 "품번 ○○○ 검색 결과 없음"을 적습니다.
- 택에 제품명이 이미 있으면(예: 인사일런스 "TYPE-2 트러커 자켓") 검색하지 않습니다. 검색은 꼭 필요한 옷만, 한 옷당 3번까지만.

## 답 형식
마지막 답은 다른 말 없이 아래 모양의 JSON 하나만 씁니다(코드블록 없이).
{"items":[{"brand":"","item":"","color":"","size":"","price":0,"source":"","unsure":""}],"note":""}`;

async function requireAdmin(req: Request): Promise<string | null> {
  if (req.headers.get("x-nk-internal") && req.headers.get("x-nk-internal") === adminKey()) return null; // 이 함수가 스스로 부른 경우
  const token = (req.headers.get("Authorization") || "").replace(/^Bearer\s+/i, "");
  const { data: u } = await supabase.auth.getUser(token);
  if (!u?.user) return "관리자 로그인이 필요해요";
  const { data: adm } = await supabase.from("admins").select("user_id").eq("user_id", u.user.id);
  return adm?.length ? null : "관리자 권한이 없어요";
}

async function readTags(req: Request, surveyId: string): Promise<Response> {
  const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status, headers: { ...cors, "Content-Type": "application/json" } });
  const denied = await requireAdmin(req);
  if (denied) return json({ error: denied }, 401);
  const { data: o } = await supabase.from("onsite").select("report").eq("survey_id", surveyId).maybeSingle();
  const rep = (o?.report ?? {}) as Record<string, any>;
  const photos = ((rep.tag_photos ?? []) as string[]).slice(0, 30);
  const memo = (rep.texts?.tag_memo ?? rep.tag_memo ?? "").toString().trim();
  if (!photos.length && !memo) return json({ error: "택 사진이나 메모가 아직 없어요" }, 400);
  const have = ((rep.purchases ?? []) as any[]).filter((r) => r.brand || r.item).map((r) => `- ${r.brand ?? ""} ${r.item ?? ""} ${r.size ?? ""} ${r.price ?? ""}`).join("\n") || "(없음)";
  const images = await signedImages(photos.map((p, i) => [`택 사진 ${i + 1}`, p] as [string, string]));
  // 택에 제품명이 없으면(마시모두띠 등) 웹 검색으로 품번을 찾아봅니다. 서버 도구라서 검색이 길어지면 pause_turn으로 멈췄다가 이어서 합니다.
  const messages: Anthropic.Beta.BetaMessageParam[] = [{ role: "user", content: [
    { type: "text", text: `## 이미 있는 구매 리스트
${have}

## 택 없는 옷 메모
${memo || "(없음)"}

## 택 사진 ${photos.length}장` },
    ...images,
  ] }];
  try {
    let response: Anthropic.Beta.BetaMessage | null = null;
    for (let turn = 0; turn < 4; turn++) {
      response = await anthropic.beta.messages.create({
        model: MODEL,
        max_tokens: 16000,
        betas: ["server-side-fallback-2026-07-01"],
        fallbacks: "default",
        output_config: { effort: "low" },
        system: [{ type: "text", text: TAG_INSTRUCTIONS }],
        tools: [
          { type: "web_search_20260209", name: "web_search", max_uses: 10, user_location: { type: "approximate", country: "KR", city: "Seoul", timezone: "Asia/Seoul" } },
          { type: "web_fetch_20260209", name: "web_fetch", max_uses: 6, max_content_tokens: 8000 },
        ],
        messages,
      });
      if (response.stop_reason !== "pause_turn") break;
      messages.push({ role: "assistant", content: response.content as Anthropic.Beta.BetaContentBlockParam[] });
    }
    if (!response) return json({ error: "AI 응답이 없어요" }, 502);
    if (response.stop_reason === "refusal") return json({ error: "AI가 작성을 거절했어요" }, 502);
    const text = response.content.filter((b) => b.type === "text").map((b) => (b as { text: string }).text).join("");
    // 검색 중간 설명이 앞에 붙을 수 있어서, 마지막 {"items" 부터 마지막 } 까지만 읽어요
    const start = text.search(/\{\s*"items"\s*:(?![\s\S]*\{\s*"items"\s*:)/), end = text.lastIndexOf("}");
    if (start < 0 || end < start) return json({ error: "AI 답을 읽지 못했어요. 한 번 더 눌러 주세요." }, 502);
    const tags = JSON.parse(text.slice(start, end + 1));
    const searches = response.usage?.server_tool_use?.web_search_requests ?? 0;
    return json({ tags, usage: response.usage, searches });
  } catch (e) {
    const msg = e instanceof Anthropic.APIError ? `Claude API 오류 ${e.status}: ${e.message}` : (e as Error).message;
    return json({ error: msg }, 502);
  }
}

// ===== 공식·TIP 쓰기 (관리자 화면 "AI로 공식·TIP 쓰기") =====
// 현장 기록(체형·이미지·스타일 방향성·컬러·구매 리스트)으로 리포트 마무리 공식 3줄과 아이템별 TIP을 돌려줍니다. DB에는 쓰지 않습니다.
const tipSchema = obj({
  formulas: { type: "array", items: str },
  tips: { type: "array", items: obj({ index: { type: "integer" }, tip: str }) },
});
const TIP_INSTRUCTIONS = `당신은 남성 스타일 컨설팅 브랜드 '남코녀'의 리포트 작성 보조입니다. 대표 컨설턴트가 현장에서 기록한 내용으로, 고객에게 전달하는 리포트의 마무리 문장을 씁니다. 고객이 직접 읽습니다.
- formulas: "나만의 스타일링 공식" 정확히 3줄. 1줄은 상의(넥라인·핏·소재·디테일), 2줄은 하의·아우터(너비·핏·기장·어깨선), 3줄은 컬러(현장 컬러 4축과 구매한 옷 색 조합). 현장에서 고른 값만 근거로 쓰고, 고르지 않은 항목은 지어내지 않습니다. 각 줄은 한 문장, 다음에 옷을 살 때 그대로 따라 할 수 있게 구체적으로. 예) "라운드넥·레귤러 핏 상의에 니트 소재를 활용해주세요."
- tips: 구매 리스트의 각 옷마다 하나(index는 목록 번호 그대로). 이번에 같이 산 다른 옷이나 고객이 이미 가진 옷(설문의 보유 신발·바지)과 어떻게 매치할지, 핏·기장·소매 등 입는 법을 1~2문장으로. 예) "구매하신 블랙 와이드 슬랙스와 매치하고, 소매는 한 번 걷어 입어주세요." 같은 말 반복은 피합니다.
- 고객에게 쓰는 다정한 존댓말(~해주세요, ~좋아요). 쉬운 한국어. 고객 이름·체형 약점을 직접 지적하는 표현(예: 다리가 짧아서)은 쓰지 않고 "비율이 좋아 보여요"처럼 긍정적으로 씁니다. 이모지는 쓰지 않습니다.`;

async function writeTips(req: Request, surveyId: string): Promise<Response> {
  const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status, headers: { ...cors, "Content-Type": "application/json" } });
  const denied = await requireAdmin(req);
  if (denied) return json({ error: denied }, 401);
  const [{ data: s }, { data: o }] = await Promise.all([
    supabase.from("surveys").select("*").eq("id", surveyId).single(),
    supabase.from("onsite").select("*").eq("survey_id", surveyId).maybeSingle(),
  ]);
  if (!s || !o) return json({ error: "현장 기록이 아직 없어요" }, 400);
  const rep = (o.report ?? {}) as Record<string, any>;
  const buys = ((rep.purchases ?? []) as any[]);
  const keys: [string, string][] = [["image", "어울리는 이미지"], ["top_neck", "상의 넥라인"], ["top_fit", "상의 핏"], ["top_fabric", "상의 소재"], ["top_detail", "상의 디테일"],
    ["bottom_width", "하의 너비"], ["bottom_shape", "하의 핏"], ["outer_length", "아우터 기장"], ["outer_shoulder", "아우터 어깨선"], ["outer_fabric", "아우터 소재"]];
  const pick = keys.map(([k, l]) => `- ${l}: ${[].concat(rep[k] ?? []).join(", ") || "(안 고름)"}`).join("\n");
  const onsiteText = [
    `- 체형: ${o.body_type ?? "(미정)"} / 골격: ${o.bone ?? "(미정)"} / 예외사항: ${o.exception || "(없음)"}`,
    pick,
    `- 컬러(현장): ${o.color || "(안 고름)"}`,
    `- 헤어: ${rep.hair_style || "(없음)"}`,
  ].join("\n");
  const buyText = buys.length ? buys.map((b, i) => `${i}. ${b.brand ?? ""} | ${b.item ?? ""} | ${b.size ?? ""} | ${b.price ?? ""}원`).join("\n") : "(구매 리스트 없음 → tips는 빈 배열)";
  try {
    const response = await anthropic.beta.messages.create({
      model: MODEL,
      max_tokens: 6000,
      betas: ["server-side-fallback-2026-07-01"],
      fallbacks: "default",
      output_config: { effort: "low", format: { type: "json_schema", schema: tipSchema } },
      system: [{ type: "text", text: TIP_INSTRUCTIONS }],
      messages: [{ role: "user", content: `## 사전설문\n${surveyText(s)}\n\n## 현장 기록\n${onsiteText}\n\n## 구매 리스트 (번호 | 브랜드 | 제품명·색 | 사이즈 | 가격)\n${buyText}` }],
    });
    if (response.stop_reason === "refusal") return json({ error: "AI가 작성을 거절했어요" }, 502);
    const text = response.content.filter((b) => b.type === "text").map((b) => (b as { text: string }).text).join("");
    return json({ result: JSON.parse(text), usage: response.usage });
  } catch (e) {
    const msg = e instanceof Anthropic.APIError ? `Claude API 오류 ${e.status}: ${e.message}` : (e as Error).message;
    return json({ error: msg }, 502);
  }
}

// ===== 예상 착장 사진 (관리자 화면 "입혀보기") =====
// 고객 전신사진 + 코디 설명 → OpenAI 이미지 편집으로 옷만 바꾼 사진을 만들어 survey-photos에 저장하고 plans.plan.tryon 에 기록합니다.
// 필요한 비밀값: OPENAI_API_KEY (선택: OPENAI_IMAGE_MODEL, 기본 gpt-image-2)
const TRYON_PREFIX = `첨부한 사진 속 남성의 얼굴, 헤어, 피부색, 키와 체형(어깨 너비, 팔·허벅지 두께), 자세는 절대 바꾸지 말고, 옷만 아래 코디로 바꿔 입힌 사진을 만들어줘.
- 얼굴이 더 잘생겨 보이게 보정하거나, 날씬하게 만들거나, 키를 늘리지 마.
- 실제 매장에서 산 옷처럼 자연스러운 주름과 핏, 사진 같은 질감으로.
- 배경은 밝은 회색 스튜디오 벽, 전신이 다 보이게 세로 사진.
- 사진에 다른 사람이 있으면 지우고 이 남성만 남겨.`;

async function tryOn(req: Request, surveyId: string, body: Record<string, unknown>): Promise<Response> {
  const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status, headers: { ...cors, "Content-Type": "application/json" } });
  const denied = await requireAdmin(req);
  if (denied) return json({ error: denied }, 401);
  const key = Deno.env.get("OPENAI_API_KEY");
  if (!key) return json({ error: "OpenAI API 키가 아직 등록되지 않았어요 (Supabase Secrets: OPENAI_API_KEY)" }, 400);
  const outfit = String(body.outfit ?? "").replace(/\s+/g, " ").trim().slice(0, 600);
  if (!outfit) return json({ error: "입힐 코디 설명이 필요해요" }, 400);
  const { data: s } = await supabase.from("surveys").select("photos").eq("id", surveyId).single();
  const bodies = ((s?.photos?.body ?? []) as string[]);
  const photo = typeof body.photo === "string" && body.photo.startsWith(surveyId + "/") ? body.photo : bodies[0];
  if (!photo) return json({ error: "고객 전신사진이 없어요" }, 400);
  const { data: file, error: dErr } = await supabase.storage.from(BUCKET).download(photo);
  if (dErr || !file) return json({ error: "사진을 불러오지 못했어요" }, 500);
  const model = Deno.env.get("OPENAI_IMAGE_MODEL") || "gpt-image-2";
  const form = new FormData();
  form.append("model", model);
  form.append("image[]", new File([file], "person." + (photo.split(".").pop() || "jpg"), { type: file.type || "image/jpeg" }));
  form.append("prompt", `${TRYON_PREFIX}\n\n코디: ${outfit}`);
  form.append("size", "1024x1536");
  form.append("quality", String(body.quality === "high" ? "high" : "medium"));
  form.append("output_format", "jpeg");
  form.append("n", "1");
  const r = await fetch("https://api.openai.com/v1/images/edits", { method: "POST", headers: { Authorization: `Bearer ${key}` }, body: form });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) return json({ error: `OpenAI 오류 ${r.status}: ${j?.error?.message ?? "알 수 없음"}` }, 502);
  const b64 = j?.data?.[0]?.b64_json;
  if (!b64) return json({ error: "이미지가 돌아오지 않았어요" }, 502);
  const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
  const path = `${surveyId}/tryon_${Date.now()}.jpg`;
  const { error: uErr } = await supabase.storage.from(BUCKET).upload(path, bytes, { contentType: "image/jpeg" });
  if (uErr) return json({ error: "저장 실패: " + uErr.message }, 500);
  // 계획서에 기록 (다른 칸은 그대로)
  const { data: p } = await supabase.from("plans").select("plan").eq("survey_id", surveyId).maybeSingle();
  if (p?.plan) {
    const plan = p.plan as Record<string, any>;
    plan.tryon = [...(plan.tryon ?? []), { path, outfit, base: photo, model, at: new Date().toISOString() }];
    await supabase.from("plans").update({ plan }).eq("survey_id", surveyId);
  }
  return json({ path, outfit, usage: j.usage ?? null });
}

// 사진 위에 선·도형을 그릴 좌표 찾기 (설명 모드용). 사람처럼 사진을 보고 판단해야 하는 위치를 Fable 5.2 가 짚음.
const MARK_MODEL = "claude-fable-5-2";
const pt = obj({ x: { type: "integer" }, y: { type: "integer" } });
const marksSchema = obj({
  body_front: obj({ found: { type: "boolean" }, head_top: pt, neck_base: pt, shoulder_left: pt, shoulder_right: pt, waist_left: pt, waist_right: pt, hip_left: pt, hip_right: pt, feet_bottom: pt, note: str }),
  body_side: obj({ found: { type: "boolean" }, head_top: pt, chest_front: pt, chest_back: pt, hip_front: pt, hip_back: pt, feet_bottom: pt, note: str }),
  face: obj({ found: { type: "boolean" }, hairline: pt, brow_line: pt, nose_base: pt, chin: pt, outline: { type: "array", items: pt }, shape: str, shape_note: str, note: str }),
});
const MARK_INSTRUCTIONS = `당신은 남성 스타일 컨설팅에서 고객 사진 위에 분석용 선을 긋기 위한 좌표를 찾습니다.
좌표는 각 사진의 왼쪽 위를 (0,0), 오른쪽 아래를 (1000,1000)으로 하는 정수입니다. left/right 는 사진에서 보이는 왼쪽/오른쪽입니다.
추측이 아니라 실제 보이는 윤곽 위의 점을 최대한 정확히 짚으세요. 해당 사진이 없으면 found 를 false 로 하고 좌표는 0 으로 둡니다.

정면 전신 (body_front)
- head_top: 머리카락 포함 머리 꼭대기. feet_bottom: 발바닥이 바닥에 닿는 높이의 몸 중심.
- neck_base: 목과 어깨가 만나는 높이의 목 가운데.
- shoulder_left / shoulder_right: 어깨 끝(어깨뼈 끝, 팔이 시작되는 바깥 윤곽). 두 점의 높이는 실제 어깨 높이대로.
- waist_left / waist_right: 몸통에서 가장 잘록한 허리 높이의 몸통 양쪽 윤곽. 팔은 제외하고 몸통만.
- hip_left / hip_right: 골반·엉덩이에서 가장 넓은 높이의 양쪽 윤곽. 팔·손은 제외.
- note: 어깨·허리·골반 너비를 비교한 한 문장 (고객에게 보여 줄 쉬운 말).

측면 전신 (body_side)
- chest_front / chest_back: 가슴 높이에서 몸통의 앞쪽·뒤쪽 윤곽. hip_front / hip_back: 엉덩이가 가장 나온 높이의 앞쪽·뒤쪽 윤곽.
- note: 상체 두께와 하체 두께를 비교한 한 문장.

얼굴 정면 (face)
- hairline: 이마와 머리카락 경계(헤어라인)의 가운데. 머리카락이 이마를 덮으면 머리카락 아래 실제 헤어라인을 추정.
- brow_line: 두 눈썹 사이(미간) 높이의 얼굴 중심. nose_base: 코끝 아래, 인중이 시작되는 점. chin: 턱 끝.
- outline: 얼굴 윤곽(이마 헤어라인~광대~턱선~턱끝)을 따라가는 점 16개. 헤어라인 가운데에서 시작해 시계 방향. 귀와 머리카락은 제외.
- shape: 윤곽(이마 너비·광대 너비·턱 너비·얼굴 길이)을 보고 가장 가까운 얼굴형 하나. 반드시 다음 중 하나를 글자 그대로: 타원형, 둥근형, 각진형, 긴형, 하트형, 역삼각형, 마름모형. shape_note: 왜 그 얼굴형인지 고객에게 보여 줄 한 문장(예: "광대와 턱 너비가 비슷하고 턱선이 둥글어 둥근형에 가까워요").
- note: 상안부·중안부·하안부 길이를 평균(1 : 1 : 1)과 비교한 결론 한 문장(예: "평균보다 중안부가 긴 편이고 하안부는 짧은 편이에요").`;

// 좌표를 찾아 돌려줌 (실패하면 오류를 던짐)
const MARK_FORMAT = `

답 형식: 설명 없이 아래 모양의 JSON 하나만 출력합니다. 모든 좌표는 {"x": 정수, "y": 정수}.
{"body_front": {"found": true, "head_top": {"x":0,"y":0}, "neck_base": {"x":0,"y":0}, "shoulder_left": {"x":0,"y":0}, "shoulder_right": {"x":0,"y":0}, "waist_left": {"x":0,"y":0}, "waist_right": {"x":0,"y":0}, "hip_left": {"x":0,"y":0}, "hip_right": {"x":0,"y":0}, "feet_bottom": {"x":0,"y":0}, "note": ""},
 "body_side": {"found": true, "head_top": {"x":0,"y":0}, "chest_front": {"x":0,"y":0}, "chest_back": {"x":0,"y":0}, "hip_front": {"x":0,"y":0}, "hip_back": {"x":0,"y":0}, "feet_bottom": {"x":0,"y":0}, "note": ""},
 "face": {"found": true, "hairline": {"x":0,"y":0}, "brow_line": {"x":0,"y":0}, "nose_base": {"x":0,"y":0}, "chin": {"x":0,"y":0}, "outline": [{"x":0,"y":0}], "shape": "", "shape_note": "", "note": ""}}`;

async function computeMarks(surveyId: string): Promise<Record<string, unknown>> {
  const [{ data: s }, { data: o }] = await Promise.all([
    supabase.from("surveys").select("photos").eq("id", surveyId).single(),
    supabase.from("onsite").select("report").eq("survey_id", surveyId).maybeSingle(),
  ]);
  const rep = (o?.report ?? {}) as Record<string, any>;
  const bodies = (s?.photos?.body ?? []) as string[], faces = (s?.photos?.face ?? []) as string[];
  const paths = { body_front: rep.body_photo?.front || bodies[0] || null, body_side: rep.body_photo?.side || bodies[1] || null, face: rep.face?.front || faces[0] || null };
  const list: [string, string][] = [["정면 전신 (body_front)", paths.body_front], ["측면 전신 (body_side)", paths.body_side], ["얼굴 정면 (face)", paths.face]];
  const missing = list.filter(([, p]) => !p).map(([l]) => l);
  const images = await signedImages(list.filter(([, p]) => p) as [string, string][]);
  if (!images.length) throw new Error("고객 사진이 없어요");
  const response = await anthropic.beta.messages.create({
    model: MARK_MODEL,
    max_tokens: 16000,
    betas: ["server-side-fallback-2026-07-01"],
    fallbacks: "default",
    output_config: { effort: "high" },
    system: MARK_INSTRUCTIONS + MARK_FORMAT,
    messages: [{ role: "user", content: [
      { type: "text", text: `아래 사진에서 좌표를 찾아 주세요.${missing.length ? ` 없는 사진: ${missing.join(", ")} (found=false)` : ""}` },
      ...images,
    ] }],
  });
  if (response.stop_reason === "refusal") throw new Error("AI가 작성을 거절했어요");
  if (response.stop_reason === "max_tokens") throw new Error("응답이 중간에 끊겼어요");
  const text = response.content.filter((b) => b.type === "text").map((b) => (b as { text: string }).text).join("");
  // 정해진 출력 형식(json_schema)은 좌표 칸이 많아 한도를 넘으므로, 일반 JSON으로 받아 직접 확인함
  const i0 = text.indexOf("{"), i1 = text.lastIndexOf("}");
  if (i0 < 0 || i1 <= i0) throw new Error("좌표 응답을 읽지 못했어요");
  const marks = JSON.parse(text.slice(i0, i1 + 1));
  const okPt = (q: any) => q && Number.isFinite(q.x) && Number.isFinite(q.y);
  const B = marks.body_front, S = marks.body_side, F = marks.face;
  if (!B || !S || !F) throw new Error("좌표 응답에 빠진 칸이 있어요");
  if (B.found && !["head_top", "neck_base", "shoulder_left", "shoulder_right", "waist_left", "waist_right", "hip_left", "hip_right", "feet_bottom"].every((k) => okPt(B[k]))) B.found = false;
  if (S.found && !["head_top", "chest_front", "chest_back", "hip_front", "hip_back", "feet_bottom"].every((k) => okPt(S[k]))) S.found = false;
  if (F.found && !(["hairline", "brow_line", "nose_base", "chin"].every((k) => okPt(F[k])) && Array.isArray(F.outline) && F.outline.length >= 8 && F.outline.every(okPt))) F.found = false;
  // 얼굴형은 정해진 7가지 중 하나만 받음 (출력 형식을 단순하게 유지하려고 여기서 확인)
  if (marks?.face && !["타원형", "둥근형", "각진형", "긴형", "하트형", "역삼각형", "마름모형"].includes(marks.face.shape)) { marks.face.shape = ""; marks.face.shape_note = ""; }
  return { marks, paths, model: response.model, usage: response.usage, at: new Date().toISOString() };
}

// 계획서(plan.marks)에 저장. 다른 칸은 그대로 둠
async function saveMarks(surveyId: string, m: Record<string, unknown>) {
  const { data: p } = await supabase.from("plans").select("plan").eq("survey_id", surveyId).maybeSingle();
  if (!p?.plan) return false;
  const plan = p.plan as Record<string, unknown>;
  plan.marks = m;
  await supabase.from("plans").update({ plan }).eq("survey_id", surveyId);
  return true;
}

async function photoMarks(req: Request, surveyId: string): Promise<Response> {
  const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status, headers: { ...cors, "Content-Type": "application/json" } });
  const denied = await requireAdmin(req);
  if (denied) return json({ error: denied }, 401);
  try {
    const m = await computeMarks(surveyId);
    const saved = await saveMarks(surveyId, m);
    return json({ ...m, saved });
  } catch (e) {
    return json({ error: (e as Error).message }, 502);
  }
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  try {
    const body = await req.json();
    const { survey_id, mode } = body;
    if (typeof survey_id !== "string" || !/^[0-9a-f-]{36}$/i.test(survey_id)) {
      return new Response(JSON.stringify({ error: "survey_id 필요" }), { status: 400, headers: { ...cors, "Content-Type": "application/json" } });
    }
    if (mode === "onsite_draft") return await onsiteDraft(req, survey_id);
    if (mode === "read_tags") return await readTags(req, survey_id);
    if (mode === "write_tips") return await writeTips(req, survey_id);
    if (mode === "tryon") return await tryOn(req, survey_id, body);
    if (mode === "photo_marks") return await photoMarks(req, survey_id);
    if (mode === "photo_marks_bg") {
      // 계획서를 다 만든 뒤 내부에서 부름: 응답은 바로 돌려주고 좌표는 뒤에서 만들어 저장
      if (req.headers.get("x-nk-internal") !== adminKey()) return new Response(JSON.stringify({ error: "권한 없음" }), { status: 401, headers: { ...cors, "Content-Type": "application/json" } });
      // @ts-ignore EdgeRuntime 은 Supabase 런타임 전역
      EdgeRuntime.waitUntil((async () => { try { await saveMarks(survey_id, await computeMarks(survey_id)); } catch (e) { console.error("marks failed:", (e as Error).message); } })());
      return new Response(JSON.stringify({ accepted: true }), { status: 202, headers: { ...cors, "Content-Type": "application/json" } });
    }
    // 오래 걸리는 분석은 응답을 먼저 돌려준 뒤 백그라운드에서 진행
    // @ts-ignore EdgeRuntime 은 Supabase 런타임 전역
    EdgeRuntime.waitUntil(analyze(survey_id));
    return new Response(JSON.stringify({ accepted: true }), { status: 202, headers: { ...cors, "Content-Type": "application/json" } });
  } catch (e) {
    return new Response(JSON.stringify({ error: (e as Error).message }), { status: 400, headers: { ...cors, "Content-Type": "application/json" } });
  }
});
