import type { OpenApiImportInput, OpenApiImportPreview } from "@rakazo/contracts";
import { expect, it, vi } from "vitest";
import { createOpenApiImportReview } from "./openapi-import-review.js";

const preview: OpenApiImportPreview = {
  status: "ready",
  target: "https://api.example.test",
  operations: [{ id: "list", method: "GET", path: "/items", readOnly: true }],
  diagnostics: [],
  counts: { discovered: 1, accepted: 1, rejected: 0, omittedDiagnostics: 0 },
  reviewToken: "stable-review",
  expiresAt: "2099-01-01T00:00:00Z",
};
function setup() {
  let current = true;
  const options = {
    preview: vi.fn().mockResolvedValue(preview),
    confirm: vi.fn().mockResolvedValue({ status: "pending", diagnostics: [] }),
    receipt: vi.fn().mockResolvedValue({ status: "pending", diagnostics: [] }),
    installed: vi.fn(),
    changed: vi.fn(),
    isCurrent: () => current,
  };
  return {
    options,
    review: createOpenApiImportReview(options),
    close: () => {
      current = false;
    },
  };
}
const draft = (): OpenApiImportInput => ({
  name: "Example",
  source: "https://example.test/spec.yaml",
  credential: "private-token",
  config: { auth: { type: "bearer" } },
});

it("uses the reviewed snapshot after the caller edits its original input", async () => {
  const s = setup();
  const input = draft();
  await s.review.preview(input);
  input.name = "New draft";
  input.credential = "new-token";
  (input.config.auth as { type: string }).type = "none";
  await s.review.confirm();
  expect(s.options.confirm).toHaveBeenCalledWith({ ...draft(), reviewToken: "stable-review" });
});

it("serializes explicit confirms while the same intent is already in flight", async () => {
  const s = setup();
  let resolve!: (result: unknown) => void;
  s.options.confirm.mockReturnValue(
    new Promise((done) => {
      resolve = done;
    }),
  );
  await s.review.preview(draft());
  const first = s.review.confirm();
  await s.review.confirm();
  await s.review.check();
  expect(s.options.confirm).toHaveBeenCalledTimes(1);
  expect(s.options.receipt).not.toHaveBeenCalled();
  resolve({ status: "pending", diagnostics: [] });
  await first;
});

it("does not dispatch or publish after its captured editor closes", async () => {
  const s = setup();
  await s.review.preview(draft());
  const count = s.options.changed.mock.calls.length;
  s.close();
  await s.review.confirm();
  await s.review.check();
  expect(s.options.confirm).not.toHaveBeenCalled();
  expect(s.options.receipt).not.toHaveBeenCalled();
  expect(s.options.changed).toHaveBeenCalledTimes(count);
});

it("treats an invalid success receipt as unknown and checks it with only the token", async () => {
  const s = setup();
  s.options.confirm.mockResolvedValue({ status: "installed", install: {}, replayed: true });
  await s.review.preview(draft());
  await s.review.confirm();
  expect(s.options.changed).toHaveBeenLastCalledWith(expect.objectContaining({ phase: "unknown" }));
  expect(s.options.installed).not.toHaveBeenCalled();
  await s.review.check();
  expect(s.options.receipt).toHaveBeenCalledWith({ reviewToken: "stable-review" });
  expect(s.options.preview).toHaveBeenCalledTimes(1);
});
