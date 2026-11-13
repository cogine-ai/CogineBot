import { DisclosureGroup, Host, RNHostView } from "@expo/ui/swift-ui";
import { View } from "react-native";
import { useResolvedAppearance } from "../lib/native";
import type { NativeDisclosureProps } from "./native-disclosure";

export function NativeDisclosure({
  label,
  expanded,
  onExpandedChange,
  children,
}: NativeDisclosureProps) {
  const scheme = useResolvedAppearance();
  return (
    <Host colorScheme={scheme} ignoreSafeArea="container" matchContents={{ vertical: true }}>
      <DisclosureGroup label={label} isExpanded={expanded} onIsExpandedChange={onExpandedChange}>
        {expanded ? (
          <RNHostView matchContents={{ vertical: true }}>
            <View style={{ gap: 12 }}>{children}</View>
          </RNHostView>
        ) : null}
      </DisclosureGroup>
    </Host>
  );
}
