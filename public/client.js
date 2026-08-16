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
const ITEM_LABELS = { swap: "สลับตำแหน่งไพ่", freeze: "แช่แข็ง 3 วิ", peek: "ส่องไพ่ 3 วิ" };

// ---------------- Instrument data (single source of truth from the server) ----------------
// The client used to keep its own hand-copied instrument list, which could
// silently drift out of sync with the server's and show a blank/unknown
// card face. Now both sides read the same data/instruments.json (served
// via GET /api/instruments), and we make sure this has actually finished
// loading BEFORE we ever try to render a board — see `instrumentsReady`.
let INSTRUMENTS_BY_ID = {};
let CATEGORY_LABEL_FROM_SERVER = null;
const instrumentsReady = fetch("/api/instruments")
  .then((r) => r.json())
  .then((data) => {
    (data.instruments || []).forEach((inst) => (INSTRUMENTS_BY_ID[inst.id] = inst));
    CATEGORY_LABEL_FROM_SERVER = data.categories || null;
    return true;
  })
  .catch((err) => {
    console.error("Failed to load /api/instruments — falling back to a minimal built-in set.", err);
    // Minimal emergency fallback so the game can still start even if the
    // instrument endpoint is briefly unreachable.
    [
      { id: "drum_kit", th: "กลองชุด", category: "percussion" },
      { id: "guitar", th: "กีตาร์", category: "strings" },
      { id: "trumpet", th: "ทรัมเป็ต", category: "brass" },
      { id: "flute", th: "ขลุ่ย", category: "woodwind" },
      { id: "piano", th: "เปียโน", category: "keyboard" },
    ].forEach((inst) => (INSTRUMENTS_BY_ID[inst.id] = inst));
    return false;
  });

let instrumentsLoaded = false;
instrumentsReady.then(() => (instrumentsLoaded = true));

/** Ensures instrument data has actually finished loading before we ever
 *  try to draw a board — shows a brief loading screen if it hasn't
 *  (normally already resolved long before this is called, since the
 *  fetch kicks off the instant the page loads). */
async function showGameWhenReady(setupFn) {
  if (!instrumentsLoaded) {
    showScreen("screen-loading");
    await instrumentsReady;
  }
  setupFn();
}

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
  lastLobby: null,
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
  "screen-loading",
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
        renderMyDesk();
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
      showGameWhenReady(() => {
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
      });
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

// ---------------- 3. Team (choose a desk in the classroom) ----------------
function renderTeamGrid() {
  const grid = document.getElementById("team-grid");
  grid.innerHTML = "";
  state.teams.forEach((t) => {
    const full = t.count >= t.maxPerTeam;
    const btn = document.createElement("button");
    btn.className = "desk-tile";
    btn.disabled = full;
    btn.style.setProperty("--desk-color", t.color);
    btn.innerHTML = `
      <div class="desk-diamond-wrap">
        <div class="desk-diamond"></div>
        <div class="desk-avatar">${initials(t.name)}</div>
      </div>
      <div class="desk-label"><b>${t.name}</b><span>${t.count}/${t.maxPerTeam} คน${full ? " · เต็ม" : ""}</span></div>
    `;
    btn.addEventListener("click", () => chooseTeam(t.id));
    grid.appendChild(btn);
  });
}

function initials(name) {
  const clean = String(name || "").trim();
  return clean.slice(0, 2).toUpperCase() || "?";
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
      renderMyDesk();
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
      renderMyDesk();
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

// ---------------- Waiting screen: your desk + teammate tokens ----------------
socket.on("lobby:update", (lobby) => {
  state.lastLobby = lobby;
  if (!document.getElementById("screen-waiting").classList.contains("hidden")) {
    renderMyDesk();
  }
});

function renderMyDesk() {
  const nameEl = document.getElementById("waiting-team-name");
  const diamondEl = document.getElementById("my-desk-diamond");
  const tokensEl = document.getElementById("teammate-tokens");
  if (!nameEl || !diamondEl || !tokensEl) return;

  nameEl.textContent = state.teamName || "ทีมของคุณ";
  diamondEl.style.setProperty("--desk-color", state.teamColor || "#8b5cf6");
  tokensEl.innerHTML = "";

  const team = state.lastLobby && state.lastLobby.teams.find((t) => t.id === state.teamId);
  const players = team ? team.players : [];
  if (players.length === 0) return;

  const rx = 40;
  const ry = 40;
  players.forEach((p, i) => {
    const angle = (2 * Math.PI * i) / players.length - Math.PI / 2;
    const xPct = 50 + rx * Math.cos(angle);
    const yPct = 50 + ry * Math.sin(angle);
    const isMe = p.id === socket.id;
    const token = document.createElement("div");
    token.className = "teammate-token" + (isMe ? " me" : "");
    token.style.left = xPct + "%";
    token.style.top = yPct + "%";
    token.style.background = state.teamColor || "#8b5cf6";
    token.innerHTML = `${initials(p.name)}<span class="teammate-role-tag">${p.role ? roleLabel(p.role) : "..."}</span>`;
    tokensEl.appendChild(token);
  });
}

// ---------------- 6. Game start ----------------
socket.on("game:started", ({ endsAt, teams }) => {
  state.teams = teams;
  const myTeam = teams.find((t) => t.id === state.teamId);
  if (!myTeam) return;
  state.pairCount = myTeam.pairCount;
  state.board = myTeam.board;
  state.tokens = myTeam.tokens || 0;

  showGameWhenReady(() => {
    document.getElementById("hud-team-dot").style.background = myTeam.color;
    document.getElementById("hud-team-name").textContent = myTeam.name;
    document.getElementById("role-label").textContent = roleLabel(state.role);
    const canUseItem = state.role === "item" || state.role === "solo";
    document.getElementById("item-panel").classList.toggle("hidden", !canUseItem);
    setupItemButtons();
    if (canUseItem) renderTargetChips();

    renderBoard(true);
    updateProgress();
    updateTokenUI();
    showScreen("screen-game");
  });
});

// ---------------- Board rendering ----------------
function cardContent(card) {
  const inst = INSTRUMENTS_BY_ID[card.instrumentId];
  if (!inst) {
    // Defensive fallback: should never happen now that both sides share
    // the same /api/instruments data, but if a card ever arrives with an
    // unrecognized/missing instrumentId, show a visible marker instead of
    // a blank face so it's obvious something needs a refresh.
    return { text: "ไม่ทราบ", sub: "-", color: "#999", icon: iconHtml("card", "#999"), image: null };
  }
  const meta = CATEGORY_META[inst.category] || { label: inst.category, color: "#999" };
  if (card.kind === "category") {
    return { text: meta.label, sub: "ประเภท", color: meta.color, icon: categoryIconHtml(inst.category), image: null };
  }
  // Only the "name" card shows the instrument's picture (if the dev page
  // has one uploaded) — the category card always stays icon+text so it
  // reads as "a family", not "a specific thing".
  return {
    text: inst.th,
    sub: "ชื่อเครื่องดนตรี",
    color: meta.color,
    icon: categoryIconHtml(inst.category),
    image: inst.image || null,
  };
}

function buildCardFace(card) {
  let frontHtml = "";
  if (card.state !== "hidden") {
    const c = cardContent(card);
    const visual = c.image
      ? `<img class="card-img" src="${c.image}" alt="" />`
      : `<div class="icon-wrap" style="color:${c.color}">${c.icon}</div>`;
    frontHtml = `${visual}<div class="card-text">${c.text}</div><div class="label">${c.sub}</div>`;
  }
  return frontHtml;
}

function buildCardEl(card, idx, canOpen, locked, dealIn) {
  const el = document.createElement("div");
  el.className = "card" + (card.state === "matched" ? " flipped matched" : card.state === "revealed" ? " flipped" : "");
  if (!canOpen || locked) el.classList.add("disabled-click");
  if (locked) el.classList.add("locked");
  if (dealIn) {
    el.classList.add("deal-in");
    el.style.setProperty("--deal-i", idx);
  }
  el.dataset.idx = idx;
  el.innerHTML = `
    <div class="card-inner">
      <div class="card-face card-back"><div class="back-mark">?</div></div>
      <div class="card-face card-front">${buildCardFace(card)}</div>
    </div>
  `;
  el.addEventListener("click", () => onCardClick(idx));
  return el;
}

function buildFallbackCardEl(idx) {
  // Should never be needed — belt-and-suspenders so one bad card's data
  // can never leave the whole board blank if something unexpected slips
  // through (e.g. a stray render exception).
  const el = document.createElement("div");
  el.className = "card disabled-click";
  el.dataset.idx = idx;
  el.innerHTML = `
    <div class="card-inner">
      <div class="card-face card-back"><div class="back-mark">?</div></div>
      <div class="card-face card-front"><div class="card-text">-</div></div>
    </div>
  `;
  return el;
}

function renderBoard(dealIn) {
  const board = document.getElementById("board");
  const canOpen = state.role === "opener" || state.role === "solo";
  const locked = isBoardLocked();
  // Build everything in an off-DOM fragment first, so the visible board
  // is only ever replaced once, as a complete unit — never left half
  // torn-down. Each card also renders inside its own try/catch, so a
  // single bad card can't blank out the rest of the board.
  const frag = document.createDocumentFragment();
  state.board.forEach((card, idx) => {
    let el;
    try {
      el = buildCardEl(card, idx, canOpen, locked, dealIn);
    } catch (err) {
      console.error("Card render failed — showing fallback for this card only.", err, card);
      el = buildFallbackCardEl(idx);
    }
    frag.appendChild(el);
  });
  board.innerHTML = "";
  board.appendChild(frag);
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

socket.on("game:cardsResolved", ({ teamId, matched, confirmed, board, matchedPairs, tokens, wrongLockUntil }) => {
  if (teamId !== state.teamId) return;
  state.board = board;
  if (typeof tokens === "number") {
    state.tokens = tokens;
    updateTokenUI();
  }
  matched ? SFX.match() : SFX.wrong();
  document.getElementById("hud-progress").textContent = `คู่ที่จับได้ ${matchedPairs}/${state.pairCount}`;
  closeVoteOverlay();

  // Penalty only applies to a genuine wrong guess (confirmed "yes" but the
  // pair didn't actually match) — clicking "ยกเลิก" to catch a bad flip
  // before committing costs nothing.
  if (!matched && confirmed) {
    state.wrongLockUntil = wrongLockUntil || Date.now();
    const remain = state.wrongLockUntil - Date.now();
    if (remain > 0) {
      toast(`เปิดไพ่ผิด! รอ ${Math.ceil(remain / 1000)} วิ`);
      renderBoard();
      setTimeout(renderBoard, remain + 60);
      return;
    }
  } else if (!matched && !confirmed) {
    toast("ยกเลิกแล้ว ไม่มีบทลงโทษ");
  }
  renderBoard();
});

socket.on("game:cardsSwapped", ({ teamId, board, fromTeam }) => {
  if (teamId !== state.teamId) return;
  if (board) {
    state.board = board;
    renderBoard();
  }
  const fromT = state.teams.find((t) => t.id === fromTeam);
  toast(`${fromT ? fromT.name : "ทีมอื่น"} สลับตำแหน่งไพ่ของทีมคุณ!`);
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

function visualHtml(info) {
  return info.image
    ? `<img class="card-img mini" src="${info.image}" alt="" />`
    : `<div class="icon-wrap" style="color:${info.color}">${info.icon}</div>`;
}

socket.on("game:voteRequest", ({ teamId, cards }) => {
  if (teamId !== state.teamId || (state.role !== "confirmer" && state.role !== "solo")) return;
  const pairEl = document.getElementById("vote-pair");
  pairEl.innerHTML = cards
    .map((c) => {
      const info = cardContent({ instrumentId: c.instrumentId, kind: c.kind, state: "revealed" });
      return `<div class="mini-card" style="color:${info.color}"><div class="mini-icon">${visualHtml(info)}</div><div class="mini-text">${info.text}</div></div>`;
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

function useItem(itemType) {
  if (itemType !== "peek" && !selectedTarget) {
    toast("เลือกทีมเป้าหมายก่อน");
    return;
  }
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
document.getElementById("btn-item-swap").addEventListener("click", () => useItem("swap"));
document.getElementById("btn-item-freeze").addEventListener("click", () => useItem("freeze"));
document.getElementById("btn-item-peek").addEventListener("click", () => useItem("peek"));

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
  if (fromTeam === state.teamId) return; // you already got feedback locally when you clicked
  const fromT = state.teams.find((t) => t.id === fromTeam);
  const fromName = fromT ? fromT.name : "ทีมอื่น";
  const label = ITEM_LABELS[itemType] || itemType;

  if (targetTeamId === state.teamId) {
    // The target team gets a more specific, urgent toast from the
    // game:cardsSwapped / game:teamFrozen handlers below — skip the
    // generic one here so they don't overwrite each other.
    return;
  }
  if (itemType === "peek") {
    // Self-only item — announce it to everyone else for visibility even
    // though nobody else is affected.
    toast(`${fromName} ใช้ไอเทม "${label}"`);
  } else {
    const targetT = state.teams.find((t) => t.id === targetTeamId);
    toast(`${fromName} ใช้ไอเทม "${label}" ใส่ ${targetT ? targetT.name : "ทีมอื่น"}`);
  }
});

// ---------------- Peek (self item — reveals exactly ONE hidden card) ----------------
socket.on("game:peek", ({ teamId, cardIndex, instrumentId, kind, durationMs }) => {
  if (teamId !== state.teamId) return;
  toast("ส่องไพ่! จำตำแหน่งไว้ให้ดี");
  SFX.item();
  const board = document.getElementById("board");
  const el = board.children[cardIndex];
  const realCard = state.board[cardIndex];
  if (!el || !realCard || realCard.state !== "hidden") return;
  el.classList.add("flipped", "peek");
  const c = cardContent({ instrumentId, kind });
  el.querySelector(".card-front").innerHTML = `<div class="icon-wrap" style="color:${c.color}">${c.icon}</div><div class="card-text">${c.text}</div><div class="label">${c.sub}</div>`;
  setTimeout(renderBoard, durationMs);
});

// ---------------- Freeze effect ----------------
socket.on("game:teamFrozen", ({ teamId, until, durationMs, fromTeam }) => {
  if (teamId !== state.teamId) return;
  state.frozenUntil = until;
  SFX.freeze();
  const fromT = state.teams.find((t) => t.id === fromTeam);
  playFreezeEffect(durationMs, `ถูกแช่แข็งโดย ${fromT ? fromT.name : "ทีมอื่น"}! รอสักครู่...`);
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
