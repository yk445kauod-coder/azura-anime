import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "IGNIS — Microgravity Combustion & Spacecraft Fire Safety",
  description:
    "AI-powered research platform over NASA microgravity combustion and spacecraft fire-safety data: experiment explorer, agentic RAG research assistant, smart ranking, comparative analysis and evidence-backed fire-safety insights.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
