import { renderToString } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { isMessageSendKey, MessageInput } from "./message-input.js";

describe("message input", () => {
  it("retains the original multiline code and allows wrapping from a one-row default", () => {
    const text = "const name = 'Robin';\nconsole.log(name);";
    const html = renderToString(
      <MessageInput
        value={text}
        onChange={() => {}}
        style={{ height: 100 }}
        rows={8}
        wrap="soft"
      />,
    );
    expect(html).toContain("const name = &#x27;Robin&#x27;;\nconsole.log(name);");
    expect(html).toContain('rows="1"');
    expect(html).toContain('wrap="soft"');
  });

  it("reserves plain Enter for send and leaves Shift Enter and IME confirmation as text input", () => {
    expect(isMessageSendKey({ key: "Enter", shiftKey: false })).toBe(true);
    expect(isMessageSendKey({ key: "Enter", shiftKey: true })).toBe(false);
    expect(isMessageSendKey({ key: "Enter", shiftKey: false, isComposing: true })).toBe(false);
    expect(isMessageSendKey({ key: "Enter", shiftKey: false, keyCode: 229 })).toBe(false);
    expect(isMessageSendKey({ key: "Escape", shiftKey: false })).toBe(false);
  });
});
