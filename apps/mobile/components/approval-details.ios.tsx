import { DisclosureGroup, Host, Text } from "@expo/ui/swift-ui";
import { font, padding, textSelection } from "@expo/ui/swift-ui/modifiers";
import { useState } from "react";
import { useI18n } from "../lib/i18n";
import { useResolvedAppearance } from "../lib/native";

export function ApprovalDetails({ detail }: { detail: string }) {
  const { t } = useI18n();
  const scheme = useResolvedAppearance();
  const [expanded, setExpanded] = useState(false);

  return (
    <Host colorScheme={scheme} ignoreSafeArea="container" matchContents={{ vertical: true }}>
      <DisclosureGroup
        label={t("Details")}
        isExpanded={expanded}
        onIsExpandedChange={setExpanded}
        modifiers={[padding({ top: 8 })]}
      >
        {expanded ? (
          <Text
            modifiers={[font({ textStyle: "footnote", design: "monospaced" }), textSelection(true)]}
          >
            {detail}
          </Text>
        ) : null}
      </DisclosureGroup>
    </Host>
  );
}
