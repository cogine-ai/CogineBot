import type {
  CapabilityInstall,
  OpenApiImportConfirmation,
  OpenApiImportConfirmInput,
  OpenApiImportInput,
  OpenApiImportPreview,
} from "@rakazo/contracts";
import { OpenApiImportConfirmationSchema, OpenApiImportPreviewSchema } from "@rakazo/contracts";

export type OpenApiImportReviewState = {
  phase: "previewing" | "review" | "confirming" | "pending" | "unknown" | "terminal";
  preview: OpenApiImportPreview | null;
  confirmation: OpenApiImportConfirmation | null;
  error: unknown;
};

/** Keeps an explicit confirmation and its receipt checks on the reviewed input. */
export function createOpenApiImportReview(options: {
  preview(input: OpenApiImportInput): Promise<OpenApiImportPreview>;
  confirm(input: OpenApiImportConfirmInput): Promise<OpenApiImportConfirmation>;
  receipt(input: { reviewToken: string }): Promise<OpenApiImportConfirmation>;
  isCurrent(): boolean;
  changed(state: OpenApiImportReviewState): void;
  installed(install: CapabilityInstall): void;
}) {
  let state: OpenApiImportReviewState = {
    phase: "previewing",
    preview: null,
    confirmation: null,
    error: null,
  };
  let submitted: OpenApiImportConfirmInput | null = null;
  let busy = false;
  function publish(patch: Partial<OpenApiImportReviewState>) {
    state = { ...state, ...patch };
    if (options.isCurrent()) options.changed(state);
  }
  async function confirm(receiptOnly: boolean) {
    if (busy || !submitted || !options.isCurrent()) return;
    busy = true;
    publish({ phase: "confirming", error: null });
    try {
      const result = OpenApiImportConfirmationSchema.parse(
        await (receiptOnly
          ? options.receipt({ reviewToken: submitted.reviewToken })
          : options.confirm(submitted)),
      );
      if (!options.isCurrent()) return;
      publish({
        phase: result.status === "pending" ? "pending" : "terminal",
        confirmation: result,
      });
      if (result.status === "installed") options.installed(result.install);
    } catch (error) {
      publish({ phase: "unknown", error });
    } finally {
      busy = false;
    }
  }
  return {
    async preview(input: OpenApiImportInput) {
      if (busy || !options.isCurrent()) return;
      busy = true;
      const snapshot = Object.freeze({
        ...input,
        config: Object.freeze(
          JSON.parse(JSON.stringify(input.config)) as OpenApiImportInput["config"],
        ),
      });
      publish({ phase: "previewing" });
      try {
        const result = OpenApiImportPreviewSchema.parse(await options.preview(snapshot));
        if (!options.isCurrent()) return;
        if (result.status === "ready")
          submitted = Object.freeze({ ...snapshot, reviewToken: result.reviewToken });
        publish({ phase: "review", preview: result });
      } catch (error) {
        publish({ phase: "review", error });
      } finally {
        busy = false;
      }
    },
    confirm: () => confirm(false),
    check: () => confirm(true),
  };
}
