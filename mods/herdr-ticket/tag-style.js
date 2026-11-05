import { div } from "gpui-kit";

// Frozen native tag palette: colors belong to catalog entries, never ticket positions.
const PALETTE = Object.freeze({
  blue: ["#DDEBF1", "#234F6B"], green: ["#DDEAD9", "#2B593F"],
  yellow: ["#F3E9BC", "#6A5314"], purple: ["#E8DEF0", "#603E78"],
  pink: ["#F0DFE8", "#793E60"], red: ["#F2DDD9", "#823C35"],
  orange: ["#F2E0CF", "#80512B"], cyan: ["#D9ECEB", "#285E60"],
  brown: ["#E8DFD6", "#654C3B"], gray: ["#E5E5E3", "#50504D"],
});

export function tagPill(theme, name, color) {
  const pair = PALETTE[color];
  return div().min_w(0).max_w(240).px(5).py(2).rounded(4).text_size(10)
    .bg(pair?.[0] ?? theme.raised).text_color(pair?.[1] ?? theme.foreground)
    .truncate().tooltip(name).child(name);
}
