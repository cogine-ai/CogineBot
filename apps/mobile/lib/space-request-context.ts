import type { ApiRequestContext } from "./api";
import { captureApiRequestContext, rpc } from "./api";
import { t } from "./i18n";
import type { MobileScope } from "./mobile-scope";

/** Bind requests to a verified Space even before the first global selection. */
export async function spaceRequestContext(
  scope: MobileScope,
  isCurrent: () => boolean,
  verifiedSpaceId?: string,
): Promise<ApiRequestContext> {
  if (!isCurrent()) throw new Error(t("Something went wrong. Try again."));
  const context = await captureApiRequestContext();
  const assertCurrent = () => {
    if (
      !isCurrent() ||
      context.apiBase !== scope.apiBase ||
      context.sessionGeneration !== scope.sessionGeneration
    ) {
      throw new Error(t("Something went wrong. Try again."));
    }
  };
  assertCurrent();
  if (scope.spaceId && verifiedSpaceId && scope.spaceId !== verifiedSpaceId) {
    throw new Error(t("Something went wrong. Try again."));
  }
  let spaceId = scope.spaceId ?? verifiedSpaceId;
  if (!spaceId) {
    const me = await rpc<{ spaceId: string }>("me", {}, { requestContext: context });
    assertCurrent();
    spaceId = me.spaceId;
    if (!spaceId) throw new Error(t("Could not load bot"));
  }
  return { ...context, headers: { ...context.headers, "x-rakazo-space-id": spaceId } };
}
