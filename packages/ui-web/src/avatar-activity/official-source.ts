import { avatarIdentitySeed } from "@rakazo/core";
import type { ActivitySource } from "./source-pool.js";
import type { OfficialAvatarState } from "./vendor/official-avatar-runtime.js";

export interface ActivityFrame {
  svg: SVGSVGElement;
  tinyTransform: string;
  visual: OfficialAvatarState;
}

const VISUALS: readonly OfficialAvatarState[] = ["working", "thinking", "spawning"];

export async function createOfficialSource(
  identity: string,
  publish: (frame: ActivityFrame) => void,
): Promise<ActivitySource<ActivityFrame>> {
  // Static history avatars never fetch or start the procedural animation engine.
  const { createAvatar } = await import("./vendor/official-avatar-runtime.js");
  const seed = avatarIdentitySeed(identity);
  const host = document.createElement("span");
  let visual: OfficialAvatarState = "working";
  const controller = createAvatar(host, {
    state: visual,
    color: "var(--avatar-activity-color)",
    background: "var(--avatar-activity-eye, var(--foreground))",
    size: 100,
    shape: "blob",
    seed,
  });
  let lastPublished = -Infinity;
  let destroyed = false;
  const getFrame = (): ActivityFrame => {
    const phase = performance.now() * 0.003 + (seed % 1000) / 100;
    // Tiny group members keep a readable body rather than shrinking into particles.
    const tilt = Math.sin(phase) * 22;
    const squash = Math.sin(phase * 1.3) * 0.1;
    return {
      // A late-mounted view receives the same geometry as existing views, even
      // if the canonical engine has advanced since the most recent fanout.
      svg: controller.element.cloneNode(true) as SVGSVGElement,
      visual,
      tinyTransform: `rotate(${tilt}deg) scale(${1 + squash}, ${1 - squash})`,
    };
  };
  const observer = new MutationObserver(() => {
    if (destroyed) return;
    const now = performance.now();
    if (now - lastPublished < 1000 / 30) return;
    lastPublished = now;
    const next = VISUALS[Math.floor((now + (seed % 18000)) / 6000) % VISUALS.length]!;
    if (next !== visual) {
      visual = next;
      controller.setState(visual);
    }
    publish(getFrame());
  });
  observer.observe(controller.element, { attributes: true, childList: true, subtree: true });
  return {
    getFrame,
    destroy() {
      if (destroyed) return;
      destroyed = true;
      observer.disconnect();
      // The official inactive flag does not cancel RAF; teardown must destroy it.
      controller.destroy();
    },
  };
}
