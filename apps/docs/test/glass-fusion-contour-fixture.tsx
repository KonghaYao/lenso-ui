import { useState } from "react";
import { createRoot } from "react-dom/client";
import { Button, GlassButton, GlassContainer, ThemeScope } from "@lenso/ui";
import "../src/styles/global.css";

function Example({ theme, count }: { theme: "light" | "dark"; count: number }) {
  const [wide, setWide] = useState(false);
  return (
    <ThemeScope theme={theme}>
      <main
        style={{
          padding: 48,
          display: "grid",
          gap: 24,
          justifyItems: "start",
          background: theme === "light" ? "#eef1f4" : "#242428",
        }}
      >
        <Button data-case="resize" onClick={() => setWide((value) => !value)}>
          Resize group
        </Button>
        <GlassContainer spacing={20} data-case="fusion" style={{ display: "inline-flex", gap: 0 }}>
          {Array.from({ length: count }, (_, index) => (
            <GlassButton
              key={index}
              elastic={false}
              aria-label={`Member ${index + 1}`}
              style={{
                width: wide ? 120 : 88,
                height: 44,
                borderRadius: 22,
                transition: "width 160ms linear",
              }}
            >
              {index + 1}
            </GlassButton>
          ))}
        </GlassContainer>
      </main>
    </ThemeScope>
  );
}

export function mount(host: HTMLElement, theme: "light" | "dark", count: number) {
  const root = createRoot(host);
  root.render(<Example theme={theme} count={count} />);
  return () => root.unmount();
}
