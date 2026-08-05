/**
 * client.js — Student ("Client") page logic.
 * See README.md for the full socket-flow write-up.
 *
 * New in this revision:
 *  - Reconnect-safe: a per-tab playerId is kept in sessionStorage, so a
 *    refresh (or brief dropped connection) restores your team/role/board
 *    instead of kicking you back to the PIN screen (client:rejoin).
 *  - Solo teams now still see the confirm pop-up for their own flips —
 *    they just don't need to wait on anyone else (see getVotingConfirmers
 *    on the server).
 *  - Wrong matches lock the opener out briefly (penalty), mirroring the
 *    freeze effect visually.
 *  - Items cost tokens earned from correct matches instead of a pure
 *    cooldown, plus a new self-only "peek" item.
 */

const socket = io();

const ITEM_COSTS = { swap: 1, freeze: 2, peek: 1 };
const ITEM_LABELS = { swap: "สลับตำแหน่งไพ่", freeze: "แช่แข็ง 3 วิ", peek: "ส่องทั้งกระดาน 3 วิ" };

function getOrCreatePlayerId() {
  let id = sessionStorage.getItem("mmg_playerId");
  if (!id) {
    id = window.crypto && crypto.randomUUID ? crypto.randomUUID() : "p-" + Math.random().toString(36).slice(2);
    sessionStorage.setItem("mmg_playerId", id);
  }
  return id;
}

const state = {
  playerId: getOrCreatePlayerId(),
  pin: null,
  teamId: null,
  teamName: null,
  teamColor: null,
  role: null,
  pairCount: 6,
  board: [],
  teams: [],
  tokens: 0,
  frozenUntil: 0,
  wrongLockUntil: 0,
};

function isBoardLocked() {
  return Date.now() < state.frozenUntil || Date.now() < state.wrongLockUntil;
}

// ---------------- Screen helpers ----------------
const screens = [
  "screen-join",
  "screen-name",
  "screen-team",
  "screen-role",
  "screen-waiting",
  "screen-game",
  "screen-results",
];
function showScreen(id) {
  screens.forEach((s) => document.getElementById(s).classList.toggle("hidden", s !== id));
}
function toast(msg) {
  const t = document.getElementById("toast");
  t.textContent = msg;
  t.classList.add("show");
  clearTimeout(toast._t);
  toast._t = setTimeout(() => t.classList.remove("show"), 2200);
}
function leaveSession() {
  sessionStorage.removeItem("mmg_pin");
}

document.addEventListener("DOMContentLoaded", () => {
  initDvdLayer();
  document.querySelectorAll(".back-btn").forEach((b) =>
    b.addEventListener("click", () => {
      leaveSession();
      window.location.reload();
    })
  );
  attemptRejoin();
});

// ---------------- Reconnect after refresh ----------------
function attemptRejoin() {
  const savedPin = sessionStorage.getItem("mmg_pin");
  if (!savedPin) return;
  socket.emit("client:rejoin", { pin: savedPin, playerId: state.playerId }, (res) => {
    if (!res || !res.ok) {
      leaveSession();
      return;
    }
    state.pin = savedPin;
    state.teamId = res.teamId;
    state.teamName = res.teamName;
    state.teamColor = res.teamColor;
    state.role = res.role;
    state.teams = res.teams || [];

    if (res.status === "lobby") {
      if (!state.role) {
        showScreen("screen-role");
      } else {
        document.getElementById("waiting-summary").textContent = `ทีม: ${state.teamName} · บทบาท: ${roleLabel(state.role)}`;
        showScreen("screen-waiting");
      }
    } else if (res.status === "playing") {
      const myTeam = state.teams.find((t) => t.id === state.teamId);
      if (myTeam) {
        state.pairCount = myTeam.pairCount;
        state.board = myTeam.board;
        state.tokens = myTeam.tokens || 0;
        state.frozenUntil = myTeam.frozenUntil || 0;
        state.wrongLockUntil = myTeam.wrongLockUntil || 0;
      }
      document.getElementById("hud-team-dot").style.background = state.teamColor;
      document.getElementById("hud-team-name").textContent = state.teamName;
      document.getElementById("role-label").textContent = roleLabel(state.role);
      const canUseItem = state.role === "item" || state.role === "solo";
      document.getElementById("item-panel").classList.toggle("hidden", !canUseItem);
      setupItemButtons();
      if (canUseItem) renderTargetChips();
      renderBoard();
      updateProgress();
      updateTokenUI();
      showScreen("screen-game");
      toast("เชื่อมต่อกลับเข้าเกมแล้ว");
    } else if (res.status === "ended") {
      renderResults(res.results || []);
      showScreen("screen-results");
    }
  });
}

// ---------------- 1. Join with PIN ----------------
const pinInput = document.getElementById("input-pin");
pinInput.addEventListener("input", () => {
  pinInput.value = pinInput.value.replace(/\D/g, "").slice(0, 6);
});
pinInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter") document.getElementById("btn-join").click();
});

document.getElementById("btn-join").addEventListener("click", () => {
  const pin = pinInput.value.trim();
  const errEl = document.getElementById("join-error");
  errEl.textContent = "";
  if (pin.length !== 6) {
    errEl.textContent = "กรุณาใส่รหัส PIN ให้ครบ 6 หลัก";
    return;
  }
  socket.emit("client:joinRoom", { pin, playerId: state.playerId }, (res) => {
    if (!res.ok) {
      errEl.textContent = res.error || "เข้าห้องไม่สำเร็จ";
      return;
    }
    state.pin = pin;
    state.teams = res.teams;
    sessionStorage.setItem("mmg_pin", pin);
    showScreen("screen-name");
  });
});

// ---------------- 2. Name ----------------
document.getElementById("btn-name").addEventListener("click", () => {
  const name = document.getElementById("input-name").value.trim();
  if (!name) {
    toast("กรุณาใส่ชื่อของคุณ");
    return;
  }
  socket.emit("client:setName", { name }, (res) => {
    if (!res.ok) {
      toast(res.error || "เกิดข้อผิดพลาด");
      return;
    }
    renderTeamGrid();
    showScreen("screen-team");
  });
});

// ---------------- 3. Team ----------------
function renderTeamGrid() {
  const grid = document.getElementById("team-grid");
  grid.innerHTML = "";
  state.teams.forEach((t) => {
    const full = t.count >= t.maxPerTeam;
    const btn = document.createElement("button");
    btn.className = "choice-card" + (full ? " disabled" : "");
    btn.disabled = full;
    btn.innerHTML = `
      <span class="team-dot" style="background:${t.color}"></span>
      <b>${t.name}</b>
      <span class="count">${t.count}/${t.maxPerTeam} คน${full ? " (เต็ม)" : ""}</span>
    `;
    btn.addEventListener("click", () => chooseTeam(t.id));
    grid.appendChild(btn);
  });
}

function chooseTeam(teamId) {
  socket.emit("client:chooseTeam", { teamId }, (res) => {
    if (!res.ok) {
      toast(res.error || "เลือกทีมไม่สำเร็จ");
      return;
    }
    state.teamId = teamId;
    state.teamName = res.teamName;
    state.teamColor = res.color;
    if (res.soloMode) {
      state.role = "solo";
      document.getElementById("waiting-summary").textContent =
        `ทีม: ${state.teamName} · คุณเล่นคนเดียว (ทำหน้าที่ครบทุกบทบาท)`;
      showScreen("screen-waiting");
    } else {
      showScreen("screen-role");
    }
  });
}

// ---------------- 4. Role ----------------
function setupRoleIcons() {
  document.querySelector('#screen-role .choice-card[data-role="opener"] .role-icon').innerHTML = iconHtml("card");
  document.querySelector('#screen-role .choice-card[data-role="item"] .role-icon').innerHTML = iconHtml("bolt");
  document.querySelector('#screen-role .choice-card[data-role="confirmer"] .role-icon').innerHTML = iconHtml("check");
}
setupRoleIcons();

document.querySelectorAll("#screen-role .choice-card").forEach((btn) => {
  btn.addEventListener("click", () => {
    const role = btn.dataset.role;
    socket.emit("client:chooseRole", { role }, (res) => {
      const errEl = document.getElementById("role-error");
      if (!res.ok) {
        errEl.textContent = res.error || "เลือกบทบาทไม่สำเร็จ";
        return;
      }
      errEl.textContent = "";
      state.role = res.role;
      document.querySelectorAll("#screen-role .choice-card").forEach((b) => b.classList.remove("selected"));
      const activeBtn = document.querySelector(`#screen-role .choice-card[data-role="${res.role}"]`);
      if (activeBtn) activeBtn.classList.add("selected");
      document.getElementById("waiting-summary").textContent =
        `ทีม: ${state.teamName} · บทบาท: ${roleLabel(res.role)}`;
      showScreen("screen-waiting");
    });
  });
});

socket.on("client:forceRoleSelect", () => {
  state.role = null;
  document.querySelectorAll("#screen-role .choice-card").forEach((b) => b.classList.remove("selected"));
  toast("มีเพื่อนเข้าทีมเพิ่ม กรุณาเลือกบทบาทของคุณอีกครั้ง");
  showScreen("screen-role");
});

function roleLabel(role) {
  return { opener: "คนเปิดไพ่", confirmer: "คนกดยืนยัน", item: "คนใช้ไอเทม", solo: "เล่นคนเดียว (ทุกบทบาท)" }[role] || role;
}

// ---------------- 6. Game start ----------------
socket.on("game:started", ({ endsAt, teams }) => {
  state.teams = teams;
  const myTeam = teams.find((t) => t.id === state.teamId);
  if (!myTeam) return;
  state.pairCount = myTeam.pairCount;
  state.board = myTeam.board;
  state.tokens = myTeam.tokens || 0;

  document.getElementById("hud-team-dot").style.background = myTeam.color;
  document.getElementById("hud-team-name").textContent = myTeam.name;
  document.getElementById("role-label").textContent = roleLabel(state.role);
  const canUseItem = state.role === "item" || state.role === "solo";
  document.getElementById("item-panel").classList.toggle("hidden", !canUseItem);
  setupItemButtons();
  if (canUseItem) renderTargetChips();

  renderBoard();
  updateProgress();
  updateTokenUI();
  showScreen("screen-game");
});

// ---------------- Board rendering ----------------
// The server now sends `th` (display name) and `category` directly on
// every revealed/matched card (see sanitizeBoard in server.js), so the
// client never has to look instrument info up in a second, separately
// maintained copy of the instrument list. That duplicate lookup used to
// be the cause of the intermittent "blank card" bug: whenever the two
// hand-kept lists drifted out of sync, whichever instrument was missing
// from the client's copy would render as an empty card the moment it was
// randomly drawn onto the board.
function cardContent(card) {
  const meta = CATEGORY_META[card.category];
  if (!meta) return { text: "", sub: "", color: "#999", icon: "" };
  if (card.kind === "category") {
    return { text: meta.label, sub: "ประเภท", color: meta.color, icon: categoryIconHtml(card.category) };
  }
  return { text: card.th || "", sub: "ชื่อเครื่องดนตรี", color: meta.color, icon: categoryIconHtml(card.category) };
}

function renderBoard() {
  const board = document.getElementById("board");
  board.innerHTML = "";
  const canOpen = state.role === "opener" || state.role === "solo";
  const locked = isBoardLocked();
  state.board.forEach((card, idx) => {
    const el = document.createElement("div");
    el.className = "card" + (card.state === "matched" ? " flipped matched" : card.state === "revealed" ? " flipped" : "");
    if (!canOpen || locked) el.classList.add("disabled-click");
    if (locked) el.classList.add("locked");
    el.dataset.idx = idx;

    let frontHtml = "";
    if (card.state !== "hidden") {
      const c = cardContent(card);
      frontHtml = `<div class="icon-wrap" style="color:${c.color}">${c.icon}</div><div class="card-text">${c.text}</div><div class="label">${c.sub}</div>`;
    }

    el.innerHTML = `
      <div class="card-inner">
        <div class="card-face card-back"><div class="back-mark">?</div></div>
        <div class="card-face card-front">${frontHtml}</div>
      </div>
    `;
    el.addEventListener("click", () => onCardClick(idx));
    board.appendChild(el);
  });
}

function onCardClick(idx) {
  const canOpen = state.role === "opener" || state.role === "solo";
  if (!canOpen || isBoardLocked()) return;
  const card = state.board[idx];
  if (!card || card.state !== "hidden") return;
  socket.emit("client:flipCard", { cardIndex: idx });
}

socket.on("game:boardUpdate", ({ teamId, board }) => {
  if (teamId !== state.teamId) return;
  state.board = board;
  SFX.flip();
  renderBoard();
});

socket.on("game:cardsResolved", ({ teamId, matched, board, matchedPairs, tokens, wrongLockUntil }) => {
  if (teamId !== state.teamId) return;
  state.board = board;
  if (typeof tokens === "number") {
    state.tokens = tokens;
    updateTokenUI();
  }
  matched ? SFX.match() : SFX.wrong();
  document.getElementById("hud-progress").textContent = `คู่ที่จับได้ ${matchedPairs}/${state.pairCount}`;
  closeVoteOverlay();

  if (!matched) {
    state.wrongLockUntil = wrongLockUntil || Date.now();
    const remain = state.wrongLockUntil - Date.now();
    if (remain > 0) {
      toast(`เปิดไพ่ผิด! รอ ${Math.ceil(remain / 1000)} วิ`);
      renderBoard();
      setTimeout(renderBoard, remain + 60);
      return;
    }
  }
  renderBoard();
});

socket.on("game:cardsSwapped", ({ teamId }) => {
  if (teamId !== state.teamId) return;
  toast("ทีมของคุณถูกสลับตำแหน่งไพ่!");
});

function updateProgress() {
  const myTeam = state.teams.find((t) => t.id === state.teamId);
  document.getElementById("hud-progress").textContent = `คู่ที่จับได้ ${myTeam ? myTeam.matchedPairs : 0}/${state.pairCount}`;
}

function updateTokenUI() {
  const el = document.getElementById("token-count");
  if (el) el.textContent = state.tokens;
  refreshItemButtonAvailability();
}

// ---------------- Voting (confirmer / solo) ----------------
function closeVoteOverlay() {
  document.getElementById("vote-overlay").classList.add("hidden");
}

socket.on("game:voteRequest", ({ teamId, cards }) => {
  if (teamId !== state.teamId || (state.role !== "confirmer" && state.role !== "solo")) return;
  const pairEl = document.getElementById("vote-pair");
  pairEl.innerHTML = cards
    .map((c) => {
      const info = cardContent(c);
      return `<div class="mini-card" style="color:${info.color}"><div class="mini-icon">${info.icon}</div><div class="mini-text">${info.text}</div></div>`;
    })
    .join("");
  document.getElementById("vote-progress").textContent = "";
  document.getElementById("vote-overlay").classList.remove("hidden");
  SFX.vote();
});

socket.on("game:voteProgress", ({ teamId, cast, total }) => {
  if (teamId !== state.teamId) return;
  document.getElementById("vote-progress").textContent = `โหวตแล้ว ${cast}/${total} คน`;
});

document.getElementById("btn-vote-yes").addEventListener("click", () => {
  socket.emit("client:vote", { vote: true });
  closeVoteOverlay();
});
document.getElementById("btn-vote-no").addEventListener("click", () => {
  socket.emit("client:vote", { vote: false });
  closeVoteOverlay();
});

// ---------------- Items ----------------
let selectedTarget = null;

function renderTargetChips() {
  const wrap = document.getElementById("target-select");
  wrap.innerHTML = "";
  state.teams
    .filter((t) => t.id !== state.teamId)
    .forEach((t) => {
      const chip = document.createElement("button");
      chip.className = "target-chip";
      chip.style.background = t.color;
      chip.textContent = t.name;
      chip.addEventListener("click", () => {
        selectedTarget = t.id;
        document.querySelectorAll(".target-chip").forEach((c) => c.classList.remove("selected"));
        chip.classList.add("selected");
      });
      wrap.appendChild(chip);
    });
}

function setupItemButtons() {
  document.getElementById("btn-item-swap").innerHTML =
    iconHtml("swap") + `<span>${ITEM_LABELS.swap}</span><span class="cost-tag">${ITEM_COSTS.swap} โทเค็น</span>`;
  document.getElementById("btn-item-freeze").innerHTML =
    iconHtml("freeze") + `<span>${ITEM_LABELS.freeze}</span><span class="cost-tag">${ITEM_COSTS.freeze} โทเค็น</span>`;
  document.getElementById("btn-item-peek").innerHTML =
    iconHtml("eye") + `<span>${ITEM_LABELS.peek}</span><span class="cost-tag">${ITEM_COSTS.peek} โทเค็น</span>`;
  refreshItemButtonAvailability();
}

function refreshItemButtonAvailability() {
  const cooling = document.getElementById("btn-item-swap").dataset.cooling === "1";
  ["swap", "freeze", "peek"].forEach((type) => {
    const btn = document.getElementById(`btn-item-${type}`);
    if (!btn) return;
    btn.disabled = cooling || state.tokens < ITEM_COSTS[type];
  });
}

// Using an item now always goes through a confirm step first. Tokens are
// only spent on the server when the player actually presses "ยืนยัน" —
// pressing "ยกเลิก" (or dismissing) never talks to the server at all, so
// no token is ever deducted for a cancelled use.
let pendingItemType = null;

function requestUseItem(itemType) {
  if (itemType !== "peek" && !selectedTarget) {
    toast("เลือกทีมเป้าหมายก่อน");
    return;
  }
  pendingItemType = itemType;
  const cost = ITEM_COSTS[itemType];
  const targetTeam = itemType !== "peek" ? state.teams.find((t) => t.id === selectedTarget) : null;

  document.getElementById("item-confirm-title").textContent = `ใช้ "${ITEM_LABELS[itemType]}" ใช่ไหม?`;
  document.getElementById("item-confirm-detail").textContent = targetTeam
    ? `ใช้ใส่ทีม "${targetTeam.name}" · หัก ${cost} โทเค็น`
    : `ใช้กับทีมของคุณเอง · หัก ${cost} โทเค็น`;
  document.getElementById("item-confirm-overlay").classList.remove("hidden");
}

function cancelUseItem() {
  pendingItemType = null;
  document.getElementById("item-confirm-overlay").classList.add("hidden");
}

function confirmUseItem() {
  const itemType = pendingItemType;
  document.getElementById("item-confirm-overlay").classList.add("hidden");
  if (!itemType) return;
  pendingItemType = null;

  socket.emit("client:useItem", { itemType, targetTeamId: selectedTarget }, (res) => {
    if (!res.ok) {
      toast(res.error || "ใช้ไอเทมไม่ได้");
      return;
    }
    SFX.item();
    if (typeof res.tokens === "number") {
      state.tokens = res.tokens;
      updateTokenUI();
    }
    startCooldownUI(res.cooldownUntil);
  });
}

document.getElementById("btn-item-swap").addEventListener("click", () => requestUseItem("swap"));
document.getElementById("btn-item-freeze").addEventListener("click", () => requestUseItem("freeze"));
document.getElementById("btn-item-peek").addEventListener("click", () => requestUseItem("peek"));
document.getElementById("btn-item-cancel").addEventListener("click", cancelUseItem);
document.getElementById("btn-item-confirm").addEventListener("click", confirmUseItem);

function startCooldownUI(until) {
  const fill = document.getElementById("cooldown-fill");
  const statusEl = document.getElementById("item-status");
  const total = until - Date.now();
  ["swap", "freeze", "peek"].forEach((t) => (document.getElementById(`btn-item-${t}`).dataset.cooling = "1"));
  refreshItemButtonAvailability();
  const tick = () => {
    const remaining = until - Date.now();
    if (remaining <= 0) {
      fill.style.width = "0%";
      statusEl.textContent = "พร้อมใช้งาน";
      ["swap", "freeze", "peek"].forEach((t) => (document.getElementById(`btn-item-${t}`).dataset.cooling = "0"));
      refreshItemButtonAvailability();
      return;
    }
    const pct = Math.max(0, Math.min(100, (remaining / total) * 100));
    fill.style.width = pct + "%";
    statusEl.textContent = `รอชาร์จ ${(remaining / 1000).toFixed(1)} วิ`;
    requestAnimationFrame(tick);
  };
  tick();
}

socket.on("game:itemUsed", ({ fromTeam, itemType, targetTeamId }) => {
  if (fromTeam === state.teamId) return;
  const fromT = state.teams.find((t) => t.id === fromTeam);
  const fromName = fromT ? fromT.name : "ทีมอื่น";
  const label = ITEM_LABELS[itemType] || itemType;
  if (targetTeamId === state.teamId) {
    // It was used directly on us — the more urgent, specific message.
    toast(`${fromName} ใช้ไอเทม "${label}" ใส่ทีมคุณ!`);
  } else {
    // Otherwise still let every team know an item was used, and by whom,
    // even if it doesn't affect them directly.
    toast(`${fromName} ใช้ไอเทม "${label}"`);
  }
});

// ---------------- Peek (self item — briefly reveals the WHOLE board) ----------------
socket.on("game:peek", ({ teamId, cards, durationMs }) => {
  if (teamId !== state.teamId) return;
  toast("ส่องไพ่ทั้งกระดาน! จำตำแหน่งไว้ให้ดี");
  SFX.item();
  const board = document.getElementById("board");
  (cards || []).forEach((c) => {
    const el = board.children[c.cardIndex];
    const realCard = state.board[c.cardIndex];
    if (!el || !realCard || realCard.state !== "hidden") return;
    el.classList.add("flipped", "peek");
    const info = cardContent(c);
    el.querySelector(".card-front").innerHTML = `<div class="icon-wrap" style="color:${info.color}">${info.icon}</div><div class="card-text">${info.text}</div><div class="label">${info.sub}</div>`;
  });
  setTimeout(renderBoard, durationMs);
});

// ---------------- Freeze effect ----------------
socket.on("game:teamFrozen", ({ teamId, until, durationMs }) => {
  if (teamId !== state.teamId) return;
  state.frozenUntil = until;
  SFX.freeze();
  playFreezeEffect(durationMs, "ถูกแช่แข็ง! รอสักครู่...");
  renderBoard();
  setTimeout(renderBoard, durationMs + 60);
});

// ---------------- Timer ----------------
socket.on("game:timerTick", ({ remainingMs }) => {
  const totalSec = Math.max(0, Math.round(remainingMs / 1000));
  const m = String(Math.floor(totalSec / 60)).padStart(2, "0");
  const s = String(totalSec % 60).padStart(2, "0");
  document.getElementById("hud-timer").textContent = `${m}:${s}`;
});

socket.on("game:teamFinished", ({ teamId }) => {
  if (teamId === state.teamId) {
    SFX.finish();
    toast("ทีมของคุณจับคู่ครบแล้ว!");
  }
});

// ---------------- Results ----------------
function renderResults(results) {
  const list = document.getElementById("result-list");
  list.innerHTML = results
    .map((r, i) => {
      const pct = Math.round((r.matchedPairs / r.pairCount) * 100);
      const timeStr = r.elapsedMs ? `${Math.round(r.elapsedMs / 1000)} วิ` : "ยังไม่ครบ";
      return `
        <div class="result-row">
          <div class="result-rank rank-${i + 1}">${i + 1}</div>
          <div style="flex:1;">
            <div class="row between"><b>${r.name}</b><span class="small-note">${r.matchedPairs}/${r.pairCount} คู่ · ${timeStr}</span></div>
            <div class="bar-wrap"><div class="bar" style="width:${pct}%; background:${r.color};"></div></div>
            <p class="small-note" style="margin:4px 0 0;">พลาด ${r.wrongAttempts} ครั้ง · ใช้ไอเทม ${r.itemsUsedCount} ครั้ง</p>
          </div>
        </div>`;
    })
    .join("");
}

socket.on("game:over", ({ results }) => {
  renderResults(results);
  showScreen("screen-results");
});

document.getElementById("btn-play-again").addEventListener("click", () => {
  leaveSession();
  window.location.reload();
});

socket.on("client:kicked", () => {
  leaveSession();
  toast("คุณถูกนำออกจากห้องโดยหัวห้อง");
  setTimeout(() => window.location.reload(), 1500);
});


// ---------------- Instrument lookup (mirrors server.js INSTRUMENTS) ----------------
const INSTRUMENTS_BY_ID = {
  drum_kit: { th: "กลองชุด", category: "percussion" },
  maracas: { th: "มาริมบา", category: "percussion" },
  snare: { th: "สแนร์", category: "percussion" },
  bassdrum: { th: "เบสดรัม", category: "percussion" },
  xylophone: { th: "ระนาดเอก", category: "percussion" },
  cymbal: { th: "ฉาบ", category: "percussion" },
  guitar: { th: "กีตาร์", category: "strings" },
  violin: { th: "ไวโอลิน", category: "strings" },
  harp: { th: "ฮาร์ป", category: "strings" },
  cello: { th: "เชลโล", category: "strings" },
  trumpet: { th: "ทรัมเป็ต", category: "brass" },
  frenchoen: { th: "เฟรนช์ฮอร์น", category: "brass" },
  trombone: { th: "ทรอมโบน", category: "brass" },
  saxophone: { th: "แซกโซโฟน", category: "woodwind" },
  clarinet: { th: "คลาริเน็ต", category: "woodwind" },
  flute: { th: "ฟลุต", category: "woodwind" },
  piano: { th: "เปียโน", category: "keyboard" },
  melodion: { th: "เมโลเดียน", category: "keyboard" },
  keyboard: { th: "คีย์บอร์ด", category: "keyboard" },
  organ: { th: "ออร์แกน", category: "keyboard" },
};
