export interface NavItem {
  href: string;
  label: string;
  icon: "overview" | "recovery" | "expansion" | "customers" | "settings";
}

export const NAV_ITEMS: NavItem[] = [
  { href: "overview", label: "Overview", icon: "overview" },
  { href: "recovery", label: "Recovery", icon: "recovery" },
  { href: "expansion", label: "Expansion", icon: "expansion" },
  { href: "customers", label: "Customers", icon: "customers" },
  { href: "settings", label: "Settings", icon: "settings" }
];

export function navHref(slug: string, item: string): string {
  return `/app/${slug}/${item}`;
}
