import { I18nProvider } from "@lingui/react";
import { BotAvatar } from "@rakazo/ui-web";
import { useState } from "react";
import { createRoot } from "react-dom/client";
import { bootstrapI18n, i18n } from "../../src/lib/i18n";
import { AvatarStudioPopover } from "../../src/pages/shell/avatar-studio-popover";
import "../../src/styles.css";

const working = new URLSearchParams(location.search).get("working") === "1";

function EditorFixture() {
  const [identity, setIdentity] = useState("companion-alpha");
  const [avatars, setAvatars] = useState<Record<string, string>>({
    "companion-alpha": "#F5A15D::shape_0",
    "companion-beta": "#62A8EC::shape_7",
  });
  const [changes, setChanges] = useState(0);
  const value = avatars[identity]!;
  return (
    <main className="min-h-screen bg-background p-6 text-foreground">
      <button
        type="button"
        data-testid="switch-companion"
        onClick={() =>
          setIdentity((previous) =>
            previous === "companion-alpha" ? "companion-beta" : "companion-alpha",
          )
        }
      >
        Switch companion
      </button>
      <aside className="ms-auto w-80 border-s border-border p-6">
        <div className="flex justify-center py-4">
          <AvatarStudioPopover
            value={value}
            identity={identity}
            size={76}
            status={working ? "running" : undefined}
            onChange={(next) => {
              setAvatars((previous) => ({ ...previous, [identity]: next }));
              setChanges((previous) => previous + 1);
            }}
          />
        </div>
        <p className="text-center">Companion</p>
      </aside>
      <div data-testid="avatar-value" data-identity={identity} data-value={value} />
      <div data-testid="change-count">{changes}</div>
      <div data-testid="synced-avatar" className="mt-8 flex items-center gap-4">
        <BotAvatar
          color={value}
          identity={identity}
          size={38}
          status={working ? "running" : undefined}
        />
        <BotAvatar
          color={value}
          identity={identity}
          size={26}
          status={working ? "running" : undefined}
        />
        <BotAvatar
          color={value}
          identity={identity}
          size={16}
          status={working ? "running" : undefined}
        />
      </div>
    </main>
  );
}

void bootstrapI18n("en").then(() => {
  createRoot(document.getElementById("root")!).render(
    <I18nProvider i18n={i18n}>
      <EditorFixture />
    </I18nProvider>,
  );
});
