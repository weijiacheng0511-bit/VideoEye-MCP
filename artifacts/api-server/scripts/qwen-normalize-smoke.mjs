import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import path from "node:path";
registerHooks({ resolve(specifier, context, nextResolve) {
  return nextResolve(specifier.startsWith(".") && !path.extname(specifier) && context.parentURL?.includes("/src/videoeye/") ? `${specifier}.ts` : specifier, context);
} });
const { normalizeQwenProviderResult } = await import("../src/videoeye/qwen-worker.ts");
const missing = normalizeQwenProviderResult({ answer: "一个人站在画面中" });
assert.equal(missing.result.objective_observation_summary, "一个人站在画面中");
assert.equal(missing.result.summary, missing.result.answer);
assert.deepEqual(missing.result.timeline, []);
assert(missing.warnings.includes("timeline_missing_or_empty_defaulted"));
const observer = normalizeQwenProviderResult({ analysis: {
  objective_observation_summary: "真人画面切换为动画。",
  people: [
    { person_id: "p1", identity: "某演员", identity_confidence: "high", appearance: "穿黑色上衣" },
    { person_id: "p2", identity: "李明", identity_confidence: "high", identity_evidence: ["00:02 字幕姓名标签：李明"] },
  ],
  timeline: [{ timestamp: "00:03", event: "切换为动画", evidence: "both", people: ["p1"],
    dialogue: [{ speaker: "p1", text: "有些东西是要靠命的", tone: "轻声", uncertain: false }],
    actions: ["人物转头"], visuals: ["真人画面切换为二维动画"],
    screen_text: ["有些东西是要靠命的"], audio_events: ["背景音乐持续"], entities: ["手机"] }],
  recognized_entities: [{ type: "product", name: "手机", confidence: "medium", evidence: ["画面中手持矩形屏幕设备"] }],
  uncertain_observations: ["背景音中的个别词句听不清"],
} });
assert.equal(observer.result.people[0].identity, "unknown");
assert.equal(observer.result.people[0].identity_confidence, "low");
assert.equal(observer.result.people[1].identity, "李明");
assert.deepEqual(observer.result.timeline, observer.result.important_events);
assert.equal(observer.result.timeline[0].dialogue[0].text, "有些东西是要靠命的");
assert.equal(observer.result.timeline[0].audio_events[0], "背景音乐持续");
assert.equal(observer.result.recognized_entities[0].confidence, "medium");
assert.equal(observer.result.uncertain_observations.length, 1);
assert.deepEqual(observer.warnings, []);
// The production provider returned scalar fields despite requesting arrays.
// Keep those observations instead of silently replacing them with empty arrays.
const scalarFields = normalizeQwenProviderResult({
  objective_observation_summary: "实拍画面转为动画。",
  timeline: [
    { timestamp: "00:00-00:04", event: "P1 说话", dialogue: "一个人到四十岁还不信命",
      actions: "看向前方", visuals: "身后为书架", screen_text: "一个人到40岁",
      audio_events: "钢琴背景音乐", people: "P1", entities: "书架" },
    { timestamp: "00:04", dialogue: { speaker: "P1", quote: "有些东西是要靠命的" } },
  ],
  screen_text: "一个人到40岁",
  recognized_entities: [{ type: "product", name: "手机", confidence: "medium", evidence: "00:01 手持矩形屏幕设备" }],
  people: [{ person_id: "P2", identity: "李明", identity_confidence: "high", identity_evidence: "00:02 名牌：李明" }],
  uncertain_observations: "片尾对白与音乐重叠",
});
assert.equal(scalarFields.result.timeline[0].dialogue[0].text, "一个人到四十岁还不信命");
assert.equal(scalarFields.result.timeline[1].dialogue[0].speaker, "P1");
for (const key of ["actions", "visuals", "screen_text", "audio_events", "people", "entities"]) {
  assert.equal(scalarFields.result.timeline[0][key].length, 1, `${key} must survive scalar normalization`);
}
assert.deepEqual(scalarFields.result.screen_text, ["一个人到40岁"]);
assert.equal(scalarFields.result.recognized_entities[0].evidence.length, 1);
assert.equal(scalarFields.result.people[0].identity, "李明");
assert.equal(scalarFields.result.uncertain_observations.length, 1);
const legacy = normalizeQwenProviderResult({ key_events: [{ time: "00:01", description: "人物走入画面" }] });
assert.equal(legacy.result.timeline[0].timestamp, "00:01");
assert.equal(legacy.result.important_events[0].event, "人物走入画面");
console.log(JSON.stringify({ ok: true, observer_fields_preserved: true, unsupported_identity_unknown: true, legacy_aliases_preserved: true }));
