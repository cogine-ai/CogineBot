import { t } from "@lingui/core/macro";
import { accountSecuritySchema, legacyAccountSecurity } from "@rakazo/contracts";
import { readBoundedJsonResponse } from "@rakazo/core";
import { authErrorText } from "./user-error";

export async function fetchAccountSecurity() {
  const response = await fetch("/api/auth/account-security", {
    signal: AbortSignal.timeout(8_000),
  });
  // Electron ships this client independently of the connected API version.
  if (response.status === 404) return legacyAccountSecurity;
  if (!response.ok) throw new Error(t`Could not load sign-in options`);
  try {
    return accountSecuritySchema.parse(await readBoundedJsonResponse<unknown>(response, 64 * 1024));
  } catch {
    throw new Error(t`Could not load sign-in options`);
  }
}

async function postAuth(path: string, proof?: { password: string } | { code: string }) {
  const response = await fetch(`/api/auth/${path}`, {
    method: "POST",
    ...(proof && { headers: { "content-type": "application/json" }, body: JSON.stringify(proof) }),
    signal: AbortSignal.timeout(8_000),
  });
  if (!response.ok) {
    let body: unknown;
    try {
      body = await readBoundedJsonResponse<unknown>(response, 64 * 1024);
    } catch {
      // Gateways may return HTML or an empty body.
    }
    throw new Error(authErrorText(body, t`Could not continue`));
  }
}

export const requestAccountDeletionCode = () => postAuth("request-account-deletion");
export const requestIdentityCode = () => postAuth("request-identity-code");
export const confirmIdentity = (proof: { password: string } | { code: string }) =>
  postAuth("confirm-identity", proof);
