export type BotTemplateId = "research-v1" | "documents-v1" | "email-draft-v1";
export type BotTemplateSelection = Readonly<{ templateId: BotTemplateId; version: 1 }>;
export type BotCreationDraft = {
  name: string;
  title: string;
  description: string;
  instructions: string;
  notifyOnFinish: boolean;
  computerMode: "team" | "dedicated";
};
export type BotTemplate = Readonly<{
  templateId: BotTemplateId;
  version: 1;
  name: string;
  title: string;
  description: string;
  instructions: string;
  examplePrompt: string;
  requiredApps: readonly Readonly<{
    anyOf: readonly ("gmail" | "outlook-mail")[];
    optional: true;
  }>[];
}>;

export const BOT_TEMPLATE_CONTENT_LOCALE = "zh-CN";
export const BOT_TEMPLATES: readonly BotTemplate[] = Object.freeze([
  Object.freeze({
    templateId: "research-v1",
    version: 1,
    name: "资料研究",
    title: "查证资料并给出来源",
    description: "围绕问题检索资料、核对关键事实，整理有出处的结论。",
    instructions:
      "先明确研究问题和时间范围。优先一手资料，区分事实、推断和未知；关键结论附来源与日期。需要账号或付费资源时沿产品确认流程，不自行发布。",
    examplePrompt: "比较这三个方案的功能与限制，给出来源和需要验证的问题。",
    requiredApps: Object.freeze([]),
  }),
  Object.freeze({
    templateId: "documents-v1",
    version: 1,
    name: "文档整理",
    title: "把材料整理成可交付文档",
    description: "整理用户提供的材料，保留原意、出处和待确认项。",
    instructions:
      "先盘点已提供材料与预期读者。保留关键事实和来源，缺失内容明确标注；先形成结构清楚的草稿。未经用户要求不覆盖原文件或对外分享。",
    examplePrompt: "把这些材料整理成一份项目说明，列出决策、待办和缺失信息。",
    requiredApps: Object.freeze([]),
  }),
  Object.freeze({
    templateId: "email-draft-v1",
    version: 1,
    name: "邮件草稿",
    title: "整理邮件并准备回复",
    description: "归纳邮件上下文，起草供用户审阅的回复。",
    instructions:
      "核对收件人、上下文和附件，给出简短、可编辑的邮件草稿。没有连接邮箱时请用户提供内容；不要声称已读取。发送、删除和批量修改仍走产品现有授权流程。",
    examplePrompt: "根据这封邮件起草回复，先给我审阅，不要发送。",
    requiredApps: Object.freeze([
      Object.freeze({
        anyOf: Object.freeze(["gmail", "outlook-mail"] as const),
        optional: true as const,
      }),
    ]),
  }),
]);

export function getBotTemplate(templateId: string, version: number): BotTemplate | undefined {
  return BOT_TEMPLATES.find(
    (template) => template.templateId === templateId && template.version === version,
  );
}

export function botTemplateDraft(template: BotTemplate | null): BotCreationDraft {
  return {
    name: template?.name ?? "",
    title: template?.title ?? "",
    description: template?.description ?? "",
    instructions: template?.instructions ?? "",
    notifyOnFinish: true,
    computerMode: "team",
  };
}

export const BOT_CREATION_SPAWN_KEY_PREFIX = "bot-create:";

export function isBotCreationSpawnKey(value: string | null | undefined): boolean {
  return (
    typeof value === "string" &&
    value.length <= 120 &&
    value.startsWith(BOT_CREATION_SPAWN_KEY_PREFIX) &&
    value.slice(BOT_CREATION_SPAWN_KEY_PREFIX.length).trim().length > 0
  );
}
