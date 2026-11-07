import type { ComponentType, ExoticComponent } from "react";

export type PageComponent = ComponentType | ExoticComponent;

const COMPONENT_WRAPPERS: ReadonlySet<unknown> = new Set([
  Symbol.for("react.memo"),
  Symbol.for("react.forward_ref"),
  Symbol.for("react.lazy"),
]);

/** Recognize functions and the supported non-callable React component wrappers. */
export function isPageComponent(value: unknown): value is PageComponent {
  return (
    typeof value === "function" ||
    (value !== null &&
      typeof value === "object" &&
      "$$typeof" in value &&
      COMPONENT_WRAPPERS.has(value.$$typeof))
  );
}
