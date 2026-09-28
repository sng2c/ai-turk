// TypeSafe 스모크 테스트 — 최소 Noul 예제 (스킬 quickstart 기반)
// 키 없이 실행 → AuthenticationError 401이 기대값 (배관 검증)
// 키 설정 후: TYPESAFE_API_KEY=... node tests/typesafe-smoke.mjs
import { noul, TypeSafeClient } from "@typesafe-ai/sdk";

const client = new TypeSafeClient();

const state = {
	document: "Hi, I've been trying to connect my Stripe account for 3 days and it keeps failing. I'm losing sales. Please help ASAP.",
};

const response = await client.systemOne({
	state,
	questions: {
		urgency: noul("Does this message express urgency?"),
	},
});

const a = response.answers.urgency;
console.log("urgency probability:", a.probability);
console.log("answer:", JSON.stringify(a, null, 2).slice(0, 400));