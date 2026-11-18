import type { DesktopScheme } from "./desktop-environment.js";

export function isConsoleLink(value: string, scheme: DesktopScheme): boolean {
  return value.toLowerCase() === `${scheme}://bot/`;
}

export function consoleLinkArgument(args: readonly string[]): string | undefined {
  return args.find((value) => /^coginebot(?:-dev)?:/i.test(value));
}

/** Early OS events join startup; opening the Console never supplies a navigation target. */
export function createDesktopLinkHandler(input: {
  scheme: DesktopScheme;
  open: () => void;
  invalid: () => void;
}) {
  let ready = false;
  let pendingOpen = false;
  let pendingInvalid = false;

  function open() {
    if (ready) input.open();
    else pendingOpen = true;
  }

  return {
    open,
    receive(value: string) {
      if (isConsoleLink(value, input.scheme)) open();
      else if (ready) input.invalid();
      else pendingInvalid = true;
    },
    ready() {
      ready = true;
      const invalid = pendingInvalid;
      const requested = pendingOpen;
      pendingInvalid = pendingOpen = false;
      if (invalid) input.invalid();
      if (requested) input.open();
    },
  };
}
