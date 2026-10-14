import { BotAvatar, Button, GroupAvatar } from "@rakazo/ui-web";
import { useState } from "react";
import { createRoot } from "react-dom/client";
import "../../src/styles.css";

const portrait = `data:image/svg+xml,${encodeURIComponent(
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 48 48"><rect width="48" height="48" fill="#a9d6e8"/><path d="M4 48c2-10 9-15 20-15s18 5 20 15" fill="#31465d"/><ellipse cx="24" cy="22" rx="11" ry="13" fill="#d7a17d"/><path d="M13 21c0-12 5-17 12-17s12 5 12 17c-4-4-7-7-12-7s-8 3-12 7" fill="#3c2d2a"/></svg>',
)}`;

function MotionFixture() {
  const [working, setWorking] = useState(true);
  const [late, setLate] = useState(false);
  const [color, setColor] = useState("#62A8EC");
  const [dark, setDark] = useState(false);
  const status = working ? "running" : "idle";
  const members = [
    { botId: "motion-a", name: "Research companion", color, status },
    { botId: "motion-b", name: "Planning companion", color: "#EF6E65", status },
    { botId: "motion-c", name: "Writing companion", color: "#A78BE4", status },
  ];
  return (
    <main
      data-theme={dark ? "dark" : "light"}
      className="min-h-screen bg-background p-6 text-foreground"
    >
      <h1 className="text-lg font-medium">Companion activity fixture</h1>
      <div className="my-5 flex flex-wrap gap-3">
        <Button variant="outline" onClick={() => setWorking(!working)}>
          Toggle activity
        </Button>
        <Button variant="outline" onClick={() => setLate(!late)}>
          Toggle late view
        </Button>
        <Button
          variant="outline"
          onClick={() => setColor(color === "#62A8EC" ? "#F5A15D" : "#62A8EC")}
        >
          Change color
        </Button>
        <Button variant="outline" onClick={() => setDark(!dark)}>
          Toggle theme
        </Button>
      </div>
      <div className="flex flex-wrap items-center gap-8">
        <div data-testid="sidebar-avatar">
          <BotAvatar color={color} identity="motion-a" size={38} status={status} />
        </div>
        <div data-testid="header-avatar">
          <BotAvatar color={color} identity="motion-a" size={26} status={status} />
        </div>
        <div data-testid="large-avatar">
          <BotAvatar color={color} identity="motion-a" size={120} status={status} />
        </div>
        <div data-testid="group-avatar">
          <GroupAvatar members={members} size={38} />
        </div>
        <div data-testid="tiny-group">
          <GroupAvatar members={members} size={26} />
        </div>
        {late ? (
          <div data-testid="late-avatar">
            <BotAvatar color={color} identity="motion-a" size={72} status={status} />
          </div>
        ) : null}
      </div>
      <div className="mt-8 flex flex-wrap items-center gap-5" data-testid="sizes">
        {[14, 17, 24, 26, 38, 72].map((size) => (
          <BotAvatar
            key={size}
            color={color}
            identity={`size-${size}`}
            size={size}
            status={status}
          />
        ))}
      </div>
      <div data-testid="history-avatar" className="mt-8 flex items-center gap-3">
        <BotAvatar color={color} identity="motion-a" size={24} />
        <span>A historical message keeps the companion still.</span>
      </div>
      <div className="mt-8 flex items-center gap-5">
        <div data-testid="working-photo">
          <BotAvatar color={portrait} identity="working-photo" size={38} status={status} />
        </div>
        <div data-testid="idle-photo">
          <BotAvatar color={portrait} identity="idle-photo" size={38} status="idle" />
        </div>
      </div>
    </main>
  );
}

createRoot(document.getElementById("root")!).render(<MotionFixture />);
