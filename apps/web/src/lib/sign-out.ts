import { t } from "@lingui/core/macro";
import { useRef, useState } from "react";
import { authClient } from "./auth";

export async function signOut(): Promise<boolean> {
  try {
    const result = await authClient.signOut();
    if (result.error) return false;
    const check = await authClient.getSession({ query: { disableCookieCache: true } });
    if (check.error || check.data) return false;
    await authClient.$store.atoms.session
      ?.get()
      .refetch({ query: { disableCookieCache: true } })
      .catch(() => undefined);
    return true;
  } catch {
    return false;
  }
}

export function useSignOut(
  onSuccess: () => void,
  onError: (message: string) => void,
  isCurrent: () => boolean,
) {
  const busy = useRef(false);
  const [signingOut, setSigningOut] = useState(false);
  async function logOut() {
    if (busy.current || !isCurrent()) return;
    busy.current = true;
    setSigningOut(true);
    try {
      const signedOut = await signOut();
      if (!isCurrent()) return;
      if (signedOut) onSuccess();
      else onError(t`Could not log out. Try again.`);
    } finally {
      busy.current = false;
      if (isCurrent()) setSigningOut(false);
    }
  }
  return { signingOut, logOut };
}
