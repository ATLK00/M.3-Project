/**
 * table.js — shared helpers for the poker-table style layouts
 * (host lobby, host live dashboard, and the client's team-select screen).
 */

/** Position seat `i` of `total` around a rounded-rectangle ("squircle")
 *  perimeter instead of a plain ellipse — reads much closer to a real
 *  table shape than pure oval trig. Returns {xPct, yPct} (0-100, relative
 *  to the containing .game-table-wrap). */
function seatPosition(i, total, rx = 44, ry = 38, n = 4) {
  const angle = (2 * Math.PI * i) / Math.max(1, total) - Math.PI / 2;
  const c = Math.cos(angle);
  const s = Math.sin(angle);
  const x = Math.sign(c) * Math.pow(Math.abs(c), 2 / n) * rx;
  const y = Math.sign(s) * Math.pow(Math.abs(s), 2 / n) * ry;
  return { xPct: 50 + x, yPct: 50 + y };
}

/** Animate a small icon flying from one seat element to another
 *  (used when a team uses an item on a rival team). */
function flyItemAnimation(fromEl, toEl, iconName, color) {
  if (!fromEl || !toEl) return;
  const fromRect = fromEl.getBoundingClientRect();
  const toRect = toEl.getBoundingClientRect();
  const icon = document.createElement("div");
  icon.className = "item-fly";
  icon.style.color = color || "#fff";
  icon.innerHTML = iconHtml(iconName, color || "#fff");
  icon.style.left = fromRect.left + fromRect.width / 2 + "px";
  icon.style.top = fromRect.top + fromRect.height / 2 + "px";
  document.body.appendChild(icon);
  requestAnimationFrame(() => {
    icon.classList.add("flying");
    icon.style.left = toRect.left + toRect.width / 2 + "px";
    icon.style.top = toRect.top + toRect.height / 2 + "px";
  });
  setTimeout(() => icon.remove(), 950);
}
