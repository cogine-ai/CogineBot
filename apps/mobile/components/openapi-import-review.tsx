import type { OpenApiImportReviewState } from "@rakazo/core";
import { StyleSheet, Text, View } from "react-native";
import { useI18n } from "../lib/i18n";
import { native } from "../lib/native";
import { openApiDiagnosticText } from "../lib/openapi-diagnostic";
import { NativeActionButton } from "./native-action-button";

export function OpenApiImportReview({
  state,
  onConfirm,
  onCheck,
  onPreview,
}: {
  state: OpenApiImportReviewState;
  onConfirm(): void;
  onCheck(): void;
  onPreview(): void;
}) {
  const { t } = useI18n();
  const preview = state.preview;
  const result = state.confirmation;
  const diagnostics =
    result && result.status !== "installed" ? result.diagnostics : (preview?.diagnostics ?? []);
  const busy = state.phase === "confirming" || state.phase === "previewing";
  return (
    <View testID="openapi-import-review" style={styles.review}>
      {preview?.target ? (
        <Text selectable style={styles.text}>
          {preview.target}
        </Text>
      ) : null}
      {preview?.status === "ready" ? (
        <>
          <Text style={styles.heading}>
            {t("Ready")} · {preview.counts.accepted}
          </Text>
          {preview.operations.map((operation) => (
            <View key={operation.id}>
              <Text selectable style={styles.text}>
                {operation.id}
              </Text>
              <Text selectable style={styles.secondary}>
                {operation.method} {operation.path}
              </Text>
            </View>
          ))}
        </>
      ) : null}
      {preview && preview.counts.rejected > 0 ? (
        <Text style={styles.heading}>
          {t("Not imported")} · {preview.counts.rejected}
        </Text>
      ) : null}
      {diagnostics.map((diagnostic, index) => (
        <View key={`${diagnostic.code}:${index}`}>
          {diagnostic.operationId ? (
            <Text selectable style={styles.text}>
              {diagnostic.operationId}
            </Text>
          ) : null}
          {diagnostic.path ? (
            <Text selectable style={styles.secondary}>
              {diagnostic.method} {diagnostic.path}
            </Text>
          ) : null}
          <Text style={styles.secondary}>{openApiDiagnosticText(diagnostic.code)}</Text>
          {diagnostic.pointer ? (
            <Text selectable style={styles.secondary}>
              {diagnostic.pointer}
            </Text>
          ) : null}
        </View>
      ))}
      {preview && preview.counts.omittedDiagnostics > 0 ? (
        <Text style={styles.secondary}>
          {t("Additional diagnostics omitted: {count}", {
            count: preview.counts.omittedDiagnostics,
          })}
        </Text>
      ) : null}
      {state.phase === "unknown" ? (
        <Text style={styles.text}>{t("Could not confirm installation.")}</Text>
      ) : null}
      {state.phase === "pending" ? (
        <Text style={styles.text}>{t("Installation pending.")}</Text>
      ) : null}
      {state.phase === "review" && state.error ? (
        <Text style={styles.text}>{t("Could not preview OpenAPI.")}</Text>
      ) : null}
      {state.phase === "terminal" && result?.status !== "installed" ? (
        <Text style={styles.text}>
          {result?.status === "removed"
            ? t("This installation was removed.")
            : t("Preview again before adding.")}
        </Text>
      ) : null}
      {busy ? (
        <NativeActionButton
          label={state.phase === "previewing" ? t("Previewing…") : t("Adding…")}
          busy
          onPress={onConfirm}
        />
      ) : null}
      {state.phase === "review" && preview?.status === "ready" ? (
        <NativeActionButton label={t("Add")} onPress={onConfirm} />
      ) : null}
      {state.phase === "unknown" || state.phase === "pending" ? (
        <View style={styles.actions}>
          <NativeActionButton label={t("Check status")} onPress={onCheck} prominence="secondary" />
          <NativeActionButton label={t("Retry")} onPress={onConfirm} prominence="secondary" />
        </View>
      ) : null}
      {(state.phase === "review" && preview?.status !== "ready") ||
      (state.phase === "terminal" && result?.status !== "installed") ? (
        <NativeActionButton label={t("Preview again")} onPress={onPreview} prominence="secondary" />
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  review: { gap: 12 },
  heading: { color: native.label, fontSize: 15, fontWeight: "600" },
  text: { color: native.label, fontSize: 14 },
  secondary: { color: native.secondaryLabel, fontSize: 13 },
  actions: { flexDirection: "row", flexWrap: "wrap", gap: 8 },
});
