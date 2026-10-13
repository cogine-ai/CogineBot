import { BotAvatar, Button, GroupAvatar } from "@rakazo/ui-web";
import { useState } from "react";
import { createRoot } from "react-dom/client";
import "../../src/styles.css";

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
    </main>
  );
}

createRoot(document.getElementById("root")!).render(<MotionFixture />);
