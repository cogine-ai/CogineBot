export type OfficialAvatarState = "working" | "thinking" | "spawning";

export interface OfficialAvatarController {
  element: SVGSVGElement;
  setState(state: OfficialAvatarState): void;
  destroy(): void;
}

export function createAvatar(
  host: Element,
  options: {
    state: OfficialAvatarState;
    color: string;
    background: string;
    size: number;
    shape: "blob";
    seed: number;
  },
): OfficialAvatarController;
