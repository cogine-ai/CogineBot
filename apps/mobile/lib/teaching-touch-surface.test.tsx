import { renderToStaticMarkup } from "react-dom/server";
import { expect, it, vi } from "vitest";
import { TeachingTouchSurface } from "../components/teaching-touch-surface";

const surface = vi.hoisted(() => ({ props: {} as Record<string, (event: unknown) => void> }));
vi.mock("react-native", () => ({
  StyleSheet: { absoluteFill: {} },
  View: (props: typeof surface.props) => {
    surface.props = props;
    return null;
  },
}));
it("maps taps and drags through the letterboxed provider dimensions into server input", () => {
  const input = vi.fn();
  renderToStaticMarkup(<TeachingTouchSurface width={1280} height={800} onInput={input} />);
  surface.props.onLayout!({ nativeEvent: { layout: { x: 0, y: 0, width: 800, height: 400 } } });
  surface.props.onResponderGrant!({ nativeEvent: { locationX: 180, locationY: 50 } });
  surface.props.onResponderRelease!({ nativeEvent: { locationX: 280, locationY: 100 } });
  expect(input.mock.calls.map(([value]) => value)).toEqual([
    { kind: "pointer", payload: { x: 200, y: 100, button: "left", type: "down" } },
    { kind: "pointer", payload: { x: 400, y: 200, button: "left", type: "move" } },
    { kind: "pointer", payload: { x: 400, y: 200, button: "left", type: "up" } },
  ]);
});
