import { createDingtalkActions } from "./dingtalk.js";
import { createFeishuActions } from "./feishu.js";
import { createWeComActions } from "./wecom.js";

export type {
  EnterpriseCallbackConfig,
  EnterpriseCallbackInput,
  EnterpriseCallbackResult,
} from "./callbacks.js";
export { verifyEnterpriseCallback } from "./callbacks.js";
export {
  ENTERPRISE_APP_METADATA,
  ENTERPRISE_EVENTS,
  enterpriseBase,
  isEnterpriseApp,
} from "./metadata.js";
export const enterpriseApps = [
  { slug: "feishu-lark", name: "Feishu / Lark", actions: createFeishuActions() },
  { slug: "dingtalk", name: "DingTalk", actions: createDingtalkActions() },
  { slug: "wecom", name: "WeCom", actions: createWeComActions() },
] as const;

export { EnterpriseAuthorities } from "./auth.js";
export type {
  EnterpriseEventObservation,
  EnterpriseEventSpec,
  EnterpriseReadApi,
  EnterpriseReadContext,
} from "./readers.js";
export { readEnterpriseEvent } from "./readers.js";
