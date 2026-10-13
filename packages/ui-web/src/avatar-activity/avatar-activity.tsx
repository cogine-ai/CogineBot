import type { CSSProperties, ReactNode } from "react";
import { useEffect, useId, useRef, useState, useSyncExternalStore } from "react";
import { motionEnvironmentEnabled, subscribeMotionEnvironment } from "./motion-environment.js";
import type { ActivityFrame } from "./official-source.js";
import { createOfficialSource } from "./official-source.js";
import { ActivitySourcePool } from "./source-pool.js";
import "./avatar-activity.css";

const activitySources = new ActivitySourcePool(createOfficialSource);
const serverMotionEnabled = () => false;

function rewriteReference(value: string, prefix: string): string {
  return value.replace(/url\(#([^)]*)\)/g, `url(#${prefix}-$1)`);
}

/** Copy only generated SVG nodes, preserving each view's unique clip-path IDs. */
function syncSvg(source: Element, target: Element, prefix: string) {
  for (const attribute of Array.from(target.attributes)) {
    if (!source.hasAttribute(attribute.name)) target.removeAttribute(attribute.name);
  }
  for (const attribute of Array.from(source.attributes)) {
    // Upstream trails and burst particles carry their own palette. Keep their
    // geometry and opacity, but bind their paint to this companion's identity.
    const identityPaint =
      attribute.name === "stop-color" ||
      ((attribute.name === "fill" || attribute.name === "stroke") &&
        /^(?:#|rgb\(|rgba\(|hsl\(|hsla\()/i.test(attribute.value));
    const value =
      attribute.name === "id"
        ? `${prefix}-${attribute.value}`
        : identityPaint
          ? "var(--avatar-activity-color)"
          : rewriteReference(attribute.value, prefix);
    if (target.getAttribute(attribute.name) !== value) target.setAttribute(attribute.name, value);
  }
  const children = Array.from(source.children);
  for (let index = 0; index < children.length; index++) {
    const child = children[index]!;
    let peer = target.children[index];
    if (!peer || peer.tagName !== child.tagName) {
      const replacement = document.createElementNS("http://www.w3.org/2000/svg", child.tagName);
      if (peer) target.replaceChild(replacement, peer);
      else target.append(replacement);
      peer = replacement;
    }
    syncSvg(child, peer, prefix);
  }
  while (target.children.length > children.length) target.lastElementChild?.remove();
}

interface AvatarActivityProps {
  identity: string;
  color: string;
  size: number;
  children: ReactNode;
}

/** Mounted only for real working avatars; its child supplies the idle/static fallback. */
export function AvatarActivity({ identity, color, size, children }: AvatarActivityProps) {
  const container = useRef<HTMLSpanElement>(null);
  const staticBody = useRef<HTMLSpanElement>(null);
  const motionBody = useRef<HTMLSpanElement>(null);
  const [visible, setVisible] = useState(false);
  const [ready, setReady] = useState(false);
  const prefix = useId().replace(/[^a-zA-Z0-9_-]/g, "");
  const environmentEnabled = useSyncExternalStore(
    subscribeMotionEnvironment,
    motionEnvironmentEnabled,
    serverMotionEnabled,
  );
  const tiny = size < 24;
  const enabled = visible && environmentEnabled;

  useEffect(() => {
    const element = container.current;
    if (!element) return;
    if (typeof IntersectionObserver === "undefined") {
      setVisible(true);
      return;
    }
    const observer = new IntersectionObserver(([entry]) => {
      setVisible(entry?.isIntersecting ?? false);
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    if (!enabled) return;
    const staticElement = staticBody.current;
    const motionElement = motionBody.current;
    if (!staticElement || !motionElement) return;
    const unsubscribe = activitySources.subscribe(identity, (frame: ActivityFrame | null) => {
      if (!frame) {
        setReady(false);
        return;
      }
      if (tiny) {
        staticElement.style.transform = frame.tinyTransform;
      } else {
        let svg = motionElement.firstElementChild;
        if (!svg) {
          svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
          motionElement.append(svg);
        }
        syncSvg(frame.svg, svg, prefix);
        motionElement.dataset.visual = frame.visual;
      }
      setReady(true);
    });
    return () => {
      unsubscribe();
      staticElement.style.removeProperty("transform");
      motionElement.replaceChildren();
      setReady(false);
    };
  }, [enabled, identity, prefix, tiny]);

  const style = {
    width: size,
    height: size,
    "--avatar-activity-color": color,
  } as CSSProperties;
  return (
    <span
      ref={container}
      className="avatar-activity"
      style={style}
      data-motion={enabled && ready ? "active" : "static"}
      aria-hidden="true"
    >
      <span
        ref={staticBody}
        className="avatar-activity-static"
        style={{ visibility: enabled && ready && !tiny ? "hidden" : "visible" }}
      >
        {children}
      </span>
      <span
        ref={motionBody}
        className="avatar-activity-motion"
        style={{
          transform: `scale(${size / 100})`,
          display: enabled && ready && !tiny ? "block" : "none",
        }}
      />
    </span>
  );
}
