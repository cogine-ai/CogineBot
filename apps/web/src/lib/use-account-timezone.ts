import { useCallback, useEffect, useLayoutEffect, useMemo, useRef } from "react";
import { detectedTimezone } from "./local-timezone";
import { rpc } from "./rpc";

/** Account preferences outlive Space selection, but never their authentication owner. */
export function useAccountTimezone({
  ownerKey,
  userId,
  timezone,
  onTimezoneChanged,
}: {
  ownerKey: string | null;
  userId: string | null;
  timezone: string | null | undefined;
  onTimezoneChanged: (timezone: string | null | undefined) => void;
}): (timezone: string) => Promise<void> {
  const apiOrigin = typeof window === "undefined" ? "" : window.location.origin;
  const owner = useMemo(() => ({ ownerKey, userId, apiOrigin }), [ownerKey, userId, apiOrigin]);
  const committedOwner = useRef<typeof owner | null>(null);
  const onChanged = useRef(onTimezoneChanged);
  const revision = useRef(0);
  const adoptedOwner = useRef<typeof owner | null>(null);
  useLayoutEffect(() => {
    committedOwner.current = owner;
    return () => {
      if (committedOwner.current === owner) committedOwner.current = null;
      revision.current++;
      if (adoptedOwner.current === owner) adoptedOwner.current = null;
    };
  }, [owner]);
  useLayoutEffect(() => {
    onChanged.current = onTimezoneChanged;
  }, [onTimezoneChanged]);
  const isCurrent = useCallback(
    () => committedOwner.current === owner && window.location.origin === owner.apiOrigin,
    [owner],
  );

  useEffect(() => {
    // Missing means an older server; null is the explicit, adoptable unset value.
    if (!ownerKey || !userId || timezone !== null || adoptedOwner.current === owner) return;
    const zone = detectedTimezone();
    if (!zone) return;
    adoptedOwner.current = owner;
    const requestRevision = revision.current;
    void rpc.preferences
      .adoptTimezone({ timezone: zone }, { context: { spaceId: null, isCurrent } })
      .then((nextMe) => {
        if (isCurrent() && revision.current === requestRevision && nextMe.userId === userId)
          onChanged.current(nextMe.timezone);
      })
      .catch(() => undefined);
  }, [owner, ownerKey, userId, timezone, isCurrent]);

  return useCallback(
    async (next: string) => {
      if (!ownerKey || !userId || !isCurrent()) return;
      const requestRevision = ++revision.current;
      const nextMe = await rpc.preferences.update(
        { timezone: next },
        { context: { spaceId: null, isCurrent } },
      );
      if (isCurrent() && revision.current === requestRevision && nextMe.userId === userId)
        onChanged.current(nextMe.timezone);
    },
    [ownerKey, userId, isCurrent],
  );
}
