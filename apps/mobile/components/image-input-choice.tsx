import type { ImageHandling, ImageInputStatus } from "@rakazo/contracts";
import { Text, View } from "react-native";
import { useI18n } from "../lib/i18n";
import { useMobileTokens } from "../lib/native";
import { NativeActionButton } from "./native-action-button";
import { NativeSegmentedControl } from "./native-segmented-control";

export function ImageInputChoice({
  value,
  status,
  onChange,
  onChooseModel,
}: {
  value: ImageHandling;
  status: ImageInputStatus;
  onChange: (value: ImageHandling) => void;
  onChooseModel: () => void;
}) {
  const { t } = useI18n();
  const tokens = useMobileTokens();
  return (
    <View style={{ gap: 8, marginTop: 8 }}>
      <NativeSegmentedControl
        accessibilityLabel={t("Image use")}
        value={value}
        onChange={onChange}
        options={[
          { value: "confirm", label: t("Let Bot see images") },
          { value: "file", label: t("As file") },
        ]}
      />
      {value === "confirm" ? (
        <>
          <Text
            accessibilityLiveRegion="polite"
            style={{ color: tokens.mutedForeground, fontSize: 13 }}
          >
            {status === "supported"
              ? t("Can see images")
              : status === "unsupported"
                ? t("This model cannot see images")
                : t("This model's image capability is unconfirmed")}
          </Text>
          {status !== "supported" ? (
            <NativeActionButton
              label={t("Choose model")}
              prominence="quiet"
              onPress={onChooseModel}
            />
          ) : null}
        </>
      ) : null}
    </View>
  );
}
