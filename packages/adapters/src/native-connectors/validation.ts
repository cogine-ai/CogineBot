import type { ValidateFunction } from "ajv";
import { Ajv2020 } from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import { NativeActionError } from "./action.js";

const validators = new WeakMap<Record<string, unknown>, ValidateFunction>();
/** Frozen developer-owned schemas; no model-provided schema or coercion/defaults. */
export function validateNativeInput(schema: Record<string, unknown>, value: unknown): void {
  let validate = validators.get(schema);
  if (!validate) {
    const ajv = new Ajv2020({ strict: false, allErrors: false, validateFormats: true });
    addFormats.default(ajv);
    for (const [format, maximum] of [
      ["uint", Number.MAX_SAFE_INTEGER],
      ["uint16", 65_535],
      ["uint32", 4_294_967_295],
    ] as const)
      ajv.addFormat(format, {
        type: "number",
        validate: (number: number) =>
          Number.isSafeInteger(number) && number >= 0 && number <= maximum,
      });
    ajv.addFormat("int32", {
      type: "number",
      validate: (number: number) =>
        Number.isSafeInteger(number) && number >= -2_147_483_648 && number <= 2_147_483_647,
    });
    ajv.addFormat("int64", { type: "number", validate: Number.isSafeInteger });
    ajv.addFormat("binary", true);
    validate = ajv.compile(schema);
    validators.set(schema, validate);
  }
  if (!validate(value))
    throw new NativeActionError(
      "invalid_input",
      "These parameters do not match this action. Check its required fields and supported values.",
    );
}
