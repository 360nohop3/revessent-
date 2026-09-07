import type { ReactNode } from "react";
import type { NavItem } from "./nav-items";

const PATHS: Record<NavItem["icon"], ReactNode> = {
  overview: <><rect x="3.5" y="3.5" width="7" height="7" rx="2" /><rect x="13.5" y="3.5" width="7" height="7" rx="2" /><rect x="3.5" y="13.5" width="7" height="7" rx="2" /><rect x="13.5" y="13.5" width="7" height="7" rx="2" /></>,
  recovery: <><path d="M21 12a9 9 0 1 1-2.64-6.36" /><path d="M21 3v6h-6" /></>,
  expansion: <><path d="M3 17l6-6 4 4 8-8" /><path d="M15 7h6v6" /></>,
  customers: <><circle cx="9" cy="8" r="3.4" /><path d="M3.5 20c.7-3.3 2.9-5 5.5-5s4.8 1.7 5.5 5" /><circle cx="17" cy="9" r="2.6" /><path d="M16.5 15.2c2.2.3 3.6 1.7 4.2 4.3" /></>,
  settings: <><path d="M4 7h10M18 7h2M4 12h4M12 12h8M4 17h12" /><circle cx="16" cy="7" r="2" /><circle cx="10" cy="12" r="2" /><circle cx="18" cy="17" r="2" /></>
};

export function NavIcon({ icon }: { icon: NavItem["icon"] }) {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      {PATHS[icon]}
    </svg>
  );
}
