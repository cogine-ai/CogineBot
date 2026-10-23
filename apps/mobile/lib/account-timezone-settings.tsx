import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { Text, View } from "react-native";
import { MenuPicker } from "../components/menu-picker";
import { SettingsGroup } from "../components/settings-group";
import { deviceTimezone, timezoneOptions, validTimezone } from "./account-timezone";
import type { MobileMe } from "./api";
import { captureApiRequestContext, rpc } from "./api";
import { useI18n } from "./i18n";
import { captureMobileScope, isMobileScopeCurrent } from "./mobile-scope";
import { useMobileTokens } from "./native";
import { errorText } from "./user-error";

/** Account preference only: the response must never replace Space-scoped Me fields. */
export function AccountTimezone({
  me,
  onChange,
}: {
  me: MobileMe | null;
  onChange: (timezone: string | null) => void;
}) {
  const { t } = useI18n();
  const tokens = useMobileTokens();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const busy = useRef(false);
  const lifetime = useRef(true);
  const userId = useRef(me?.userId);
  useLayoutEffect(() => {
    userId.current = me?.userId;
  }, [me?.userId]);
  useEffect(() => {
    lifetime.current = true;
    return () => {
      lifetime.current = false;
    };
  }, []);
  if (!me || me.timezone === undefined) return null;
  const timezone = me.timezone ?? deviceTimezone() ?? "UTC";

  async function choose(nextTimezone: string) {
    if (!me || busy.current || !validTimezone(nextTimezone)) return;
    busy.current = true;
    setPending(true);
    setError(null);
    const owner = captureMobileScope();
    const ownerId = me.userId;
    const current = () =>
      lifetime.current && userId.current === ownerId && isMobileScopeCurrent(owner);
    try {
      const requestContext = await captureApiRequestContext(null);
      if (!current()) return;
      const next = await rpc<MobileMe>(
        "preferences/update",
        { timezone: nextTimezone },
        { requestContext },
      );
      if (!current() || next.userId !== ownerId) return;
      if (next.timezone === null || validTimezone(next.timezone)) onChange(next.timezone);
    } catch (cause) {
      if (current()) setError(errorText(cause, t("Could not save timezone")));
    } finally {
      busy.current = false;
      if (current()) setPending(false);
    }
  }

  return (
    <SettingsGroup>
      <View pointerEvents={pending ? "none" : "auto"} accessibilityState={{ busy: pending }}>
        <MenuPicker
          label={t("Timezone")}
          choices={timezoneOptions(timezone).map((zone) => ({
            key: zone,
            label: zone.replaceAll("_", " "),
          }))}
          value={timezone}
          onChange={(zone) => void choose(zone)}
        />
      </View>
      {error ? <Text style={{ color: tokens.destructive, padding: 16 }}>{error}</Text> : null}
    </SettingsGroup>
  );
}
