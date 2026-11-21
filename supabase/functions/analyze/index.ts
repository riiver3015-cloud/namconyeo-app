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
- 쇼핑 지역(area)은 여의도와 잠실 중 한 곳만 고릅니다(거주지·동선 기준). 다른 지역은 쓰지 않고, 이유를 한 줄 붙인 뒤 "최종 결정은 대표님"이라고 덧붙입니다.
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
    ["컨설팅 일정", [s.consult_date, s.consult_time].filter(Boolean).join(" ")], ["서비스", s.service],
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

    await supabase.from("plans").update({
      status: "done", plan, model: response.model, error: null,
      usage: response.usage as unknown as Record<string, unknown>, updated_at: new Date().toISOString(),
    }).eq("survey_id", surveyId);
  } catch (e) {
    const msg = e instanceof Anthropic.APIError ? `Claude API 오류 ${e.status}: ${e.message}` : (e as Error).message;
    await supabase.from("plans").update({ status: "error", error: msg, updated_at: new Date().toISOString() }).eq("survey_id", surveyId);
  }
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  try {
    const { survey_id } = await req.json();
    if (typeof survey_id !== "string" || !/^[0-9a-f-]{36}$/i.test(survey_id)) {
      return new Response(JSON.stringify({ error: "survey_id 필요" }), { status: 400, headers: { ...cors, "Content-Type": "application/json" } });
    }
    // 오래 걸리는 분석은 응답을 먼저 돌려준 뒤 백그라운드에서 진행
    // @ts-ignore EdgeRuntime 은 Supabase 런타임 전역
    EdgeRuntime.waitUntil(analyze(survey_id));
    return new Response(JSON.stringify({ accepted: true }), { status: 202, headers: { ...cors, "Content-Type": "application/json" } });
  } catch (e) {
    return new Response(JSON.stringify({ error: (e as Error).message }), { status: 400, headers: { ...cors, "Content-Type": "application/json" } });
  }
});
