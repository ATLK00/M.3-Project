# จับคู่เครื่องดนตรี — Music Card Matching Game

> **อัปเดตล่าสุด (รอบใหม่):** ธีมมืด/ม่วงสไตล์แอปเกมการ์ด, ระบบเครื่องดนตรีย้ายไปเป็นไฟล์ `data/instruments.json` ที่แก้ผ่านหน้า `/admin.html` ได้เลย (เพิ่ม/แก้/ลบ/ใส่รูปได้), ทั้งฝั่งเกมและแอดมินอ่านข้อมูลจากที่เดียวกันแล้ว (แก้บั๊ก "การ์ดขึ้นว่าง" ที่ต้นตอ), มีหน้าโหลดข้อมูลก่อนเข้าเกมเสมอ, รองรับ PWA เพิ่มไอคอนหน้าจอโฮมได้ทั้ง iOS/Android, และมีปุ่ม "สร้างห้องใหม่" เล็กๆ ใต้ช่อง PIN หน้าแรกแล้ว — รายละเอียดในหัวข้อ 9-11 ด้านล่าง.
>
> **อัปเดตก่อนหน้า:** (1) ทีมที่มีผู้เล่นคนเดียวจะได้ทุกบทบาทอัตโนมัติ (เปิดไพ่ + ยืนยันเอง + ใช้ไอเทมได้เอง)
> (2) การ์ดเปลี่ยนจาก "รูปเหมือนกัน 2 ใบ" เป็น "ชื่อเครื่องดนตรี ↔ ประเภทเครื่องดนตรี" (เช่น กลองชุด ↔ เครื่องกระทบ)
> (3) ไม่มีอิโมจิในหน้าเว็บเลย ใช้ไอคอนเส้น (`public/icons.js`) แทนทั้งหมด
> (4) หน้าหัวห้องมีการเฉลยผลแบบระทึกใจ (เผยจากอันดับสุดท้ายไล่ขึ้นมา) + คอนเฟตตี้ตอนประกาศทีมชนะ + สถิติพลาด/ใช้ไอเทม
> (5) มีปุ่มย้อนกลับ/ออกจากห้องอยู่มุมซ้ายบนแทบทุกหน้า และปุ่ม "เล่นใหม่" ในหน้าสรุปผล

Real-time, mobile-first, Kahoot-style multiplayer memory game for teaching
music instruments to ม.3 students. Built with **Node.js + Express + Socket.io**.
No database is used — a classroom session lives entirely in server memory
while it's running.

## 1. Setup

```bash
npm install
npm start
```

The server starts on `http://localhost:3000` (or `PORT` env var).

- Teacher device → open `http://<server-ip>:3000/host.html`
- Student devices → open `http://<server-ip>:3000/index.html` and enter the PIN shown on the host screen

Everyone must be able to reach the host machine's IP (same Wi-Fi/LAN, or deploy
the whole `music-match-game/` folder to any Node host — Render, Railway, a school VPS, etc.).

## 2. File structure

```
music-match-game/
├─ server.js              # Express + Socket.io backend, all game logic
├─ package.json
└─ public/
   ├─ index.html           # Student (client) page — join → name → team → role → play
   ├─ host.html             # Teacher (host) page — create room → lobby → dashboard
   ├─ style.css              # Shared glassmorphism design system
   ├─ client.js               # Student page logic + socket events
   ├─ host.js                  # Host page logic + socket events
   ├─ faces.js                  # DVD-bounce background + freeze-item vision block
   ├─ sound.js                   # Web Audio SFX (flip/match/vote/item/freeze)
   └─ assets/faces/*.png          # 11 placeholder friend-face avatars (see below)
```

## 3. Replacing the placeholder photos

The brief calls for 11 named face images (`xthichat.png`, `prom.png`,
`kittipob.png`, `witsnu.png`, …) floating around the screen and rocketing up
during the freeze effect. Since this build has no access to real class
photos, `public/assets/faces/` ships with 11 generated placeholder avatars
using those exact filenames. **Drop in real photos with the same filenames**
(square images work best, they're rendered as circles) and both effects pick
them up automatically — nothing else needs to change. The full list lives at
the top of `public/faces.js` (`FACE_FILES`) if you want to rename or add more.

## 4. Socket event map

| Event | Direction | Purpose |
|---|---|---|
| `host:createRoom` | client→server | Teacher submits settings, gets back a 6-digit PIN |
| `host:startGame` | client→server | Locks the room and starts the shared countdown |
| `client:joinRoom` | client→server | Student validates a PIN |
| `client:setName` / `client:chooseTeam` / `client:chooseRole` | client→server | Onboarding steps |
| `lobby:update` | server→room | Live roster, grouped by team, pushed on every join/role change |
| `client:flipCard` | client→server | Only the **opener** may call this |
| `game:boardUpdate` | server→room | New card revealed (still pending vote) |
| `game:voteRequest` / `game:voteProgress` | server→room | Sent to the team's **confirmer(s)** |
| `client:vote` | client→server | A confirmer's yes/no |
| `game:cardsResolved` | server→room | Final outcome of the pending pair |
| `client:useItem` | client→server | Only the **item** role may call this |
| `game:cardsSwapped` / `game:teamFrozen` / `game:itemUsed` | server→room | Sabotage effects broadcast to everyone (so the affected team's UI reacts) |
| `game:timerTick` / `game:teamFinished` / `game:over` | server→room | Countdown + final results |

## 5. Voting logic (Role 2 — คนกดยืนยัน) in detail

Each team keeps its board **entirely on the server** (`team.board`, an array
of `{ instrumentId, state }`). Card identities are stripped out of every
broadcast while `state === 'hidden'`, so a student can't peek at another
card's identity by inspecting network traffic.

1. The **opener** taps a hidden card → `client:flipCard`. The server checks
   the card is hidden, the sender really holds the `opener` role on that
   team, and the team isn't currently frozen. It flips that one card to
   `revealed` and pushes `game:boardUpdate` to the whole room (clients
   ignore updates for teams that aren't theirs).
2. When the opener has two `revealed` cards pending (`team.pendingFlip`
   reaches length 2), the server resets `team.votes = {}` and emits
   `game:voteRequest` containing the two card identities. Every client
   receives it, but only players whose `role === 'confirmer'` show the
   pop-up (`client.js` checks the role before rendering it).
3. Each confirmer sends `client:vote` with `true`/`false`. The server
   records it in `team.votes[socket.id]` — a map keyed by socket, so
   duplicate votes from the same person simply overwrite, they don't
   double-count. After every vote it emits `game:voteProgress` so the room
   can show "โหวตแล้ว 2/3 คน".
4. Once the number of votes cast equals the number of confirmers on that
   team, the server tallies: **majority rule** — `yesVotes > confirmers.length / 2`.
   A tie (e.g. 1-1 out of 2 confirmers) resolves to **not confirmed**, since
   it isn't a strict majority.
   - If confirmed **and** the two `instrumentId`s match → both cards become
     `matched`, `team.matchedPairs++`.
   - Otherwise (rejected, or confirmed but not a real match) → both cards
     flip back to `hidden`.
   - Edge case: a team with **zero** confirmers (e.g. exactly 3 players who
     are opener + item + nothing else yet) auto-resolves the pair instantly
     so the round is never soft-locked waiting on a vote that can't happen.
5. `game:cardsResolved` is broadcast with the new board state and the
   updated `matchedPairs`, closing the vote pop-up on every device and
   re-rendering the board with the 3D flip animation (`transform: rotateY`)
   plus a match/miss sound.

## 6. Item logic — swap & cross-team freeze (Role 3 — คนใช้ไอเทม)

Only the player with `role === 'item'` on a team may call `client:useItem`.
The server enforces a **15-second cooldown per team** (`team.itemCooldownUntil`)
so the button is locked client-side too (a countdown bar) but the source of
truth is always the server timestamp check.

- **สลับตำแหน่งไพ่ทีมอื่น (swap):** the server picks two random *currently
  hidden* card indexes on the **target team's own board** and swaps their
  `instrumentId`. Matched or already-revealed cards are never touched. The
  target team gets `game:cardsSwapped` and simply re-renders — since hidden
  cards show no face anyway, the "damage" is that any pairs the team had
  already memorized are now wrong.
- **แช่แข็งเป้าหมาย 3 วินาที (freeze):** the server sets
  `targetTeam.frozenUntil = now + 3000` and broadcasts `game:teamFrozen`
  with that timestamp. Every client checks `teamId === myTeamId`; if it
  matches, `client.js`:
  1. Sets a local `state.frozen = true` flag (the **opener's** `flipCard`
     clicks are ignored client-side *and* rejected server-side via the same
     `Date.now() < team.frozenUntil` check — so a fast clicker can't beat
     network latency).
  2. Calls `playFreezeEffect()` from `faces.js`, which spawns all 11 face
     images at randomized horizontal positions along the bottom edge and
     animates them flying upward off-screen (`@keyframes freeze-fly`) with
     randomized delay/duration so they don't move in unison — fully
     blocking the board for the 3-second duration.
  3. After the duration elapses, the lock and blur filter are removed and
     the board re-renders normally.

Because the effect is *driven by a server timestamp* rather than a purely
client-side timer, a student who refreshes mid-freeze still comes back
frozen until the real deadline (the next `game:boardUpdate`/state sync
respects `frozenUntil`).

## 7. Scoring & end of game

The host sets a shared countdown (`endsAt`, in minutes). The game also ends
early the instant **every** team has matched all of its pairs. Final ranking
sorts by `matchedPairs` (desc), then by completion time (asc) for teams that
finished — shown on both the student results screen and the host's
dashboard, with colored rank badges (gold/silver/bronze) for the top three.

## 8. Notes & suggested extensions

- All state is in-memory; restarting `server.js` clears any in-progress game.
  For a multi-classroom deployment behind a load balancer you'd want to move
  `rooms` into Redis and swap `setInterval` timers for a shared clock.
- Sound effects are synthesized with the Web Audio API so the game runs with
  zero extra asset files — swap in real `<audio>` clips in `sound.js` if you
  have licensed sound effects you'd like to use instead.

## 9. Managing instruments from `/admin.html` (no code editing needed)

Instruments now live in `data/instruments.json` — the server, the student
page, and the host page all read from the **same** file (via
`GET /api/instruments`), instead of each having their own hand-copied list.
That was the actual root cause of the old "sometimes a card shows up blank"
bug: the client's copy could drift out of sync with the server's. Now there's
exactly one source of truth.

**To add/edit/delete an instrument (with a photo, optionally):**

1. Open `https://<your-domain>/admin.html`
2. Enter the admin passcode (see "Setting the admin passcode" below)
3. Fill in the name + family (ตระกูล), optionally attach a photo, save
4. It's live immediately — no restart needed, no deploy needed

Deleting requires at least 4 instruments to remain (so the hardest 12-pair
mode still has enough content — 12-14+ instruments is a comfortable amount).

**Setting the admin passcode:** set an `ADMIN_KEY` environment variable
before starting the server (Render → your service → **Environment** → add
`ADMIN_KEY` = something only you know). If unset, it falls back to
`changeme` — fine for local testing, **not** fine for a public deploy.
Reading the instrument list (`GET /api/instruments`) is intentionally public
(the game itself needs it); only add/edit/delete/image-upload require the
passcode.

Uploaded photos are saved to `public/assets/instruments/<id>.<ext>` as plain
files — back that folder up (or the whole `data/` + `public/assets/instruments/`
pair) if you want to keep your custom set across a redeploy that wipes the
filesystem (e.g. Render's free tier resets on redeploy since it has no
persistent disk on the free plan).

## 10. Loading order (fixing the "blank card" class of bug at the root)

Both `client.js` and `host.js` used to hardcode their own copy of the
instrument list. Two problems came from that:

- If the two copies ever drifted (a typo, a missed edit), a card could
  render with no matching data → blank face.
- The `swap` item used to be able to trade identities between a "name" card
  and a "category" card, which could also produce duplicate-looking cards.

Both are fixed now: the client fetches `/api/instruments` **once, the
moment the page loads** (`instrumentsReady` promise in `client.js`), and the
game screen will not render a board until that fetch has actually resolved
— see `showGameWhenReady()`. In the extremely unlikely case the fetch is
still pending when `game:started` arrives, the player briefly sees a
"กำลังโหลดข้อมูลเกม…" loading screen instead of a half-built board. The
`swap` item was also fixed to only swap cards of the same kind (name↔name or
category↔category), so it can no longer create a mismatched pair.

## 11. PWA / "Add to Home Screen"

Both `index.html` (student) and `host.html` (host) are installable:

- **iOS Safari:** open the page → Share button → **Add to Home Screen**.
  Each page has its own `apple-mobile-web-app-title`, so the two icons on
  the home screen are labeled distinctly ("จับคู่ดนตรี" vs "หัวห้อง-ดนตรี").
- **Android Chrome:** you'll typically get an automatic "Install app" /
  "Add to Home screen" prompt, or find it in the browser's ⋮ menu.

Implementation notes if you touch this later:
- `public/manifest.json` (student) and `public/manifest-host.json` (host)
  are separate manifests with different `start_url`s, so installing from
  either page always reopens the right one.
- `public/icons/` has the generated app icons (192/512/apple-touch/favicon).
  Regenerate them with your own art if you want to rebrand — same
  filenames, same sizes, and everything else keeps working.
- `public/sw.js` is a **network-first** service worker on purpose — since
  this is a live multiplayer game, it always prefers a fresh network
  response and only serves a cached copy if the request fails outright
  (e.g. a brief connection drop). It never intercepts `/socket.io/*` or
  `/api/*` requests, so it can't ever serve stale game data.

## 12. Theme

The color system lives entirely in CSS custom properties at the top of
`public/style.css` (`:root { ... }`) — dark indigo background, violet
primary accent, white "playing card" faces for contrast. To reskin, edit
those variables; component styles below reference them rather than hardcoding
colors, with the exception of a few surfaces that are deliberately always
white regardless of theme (the flipped card face, the vote pop-up, the
winner banner) — those use `--ink-dark` / `--ink-dark-soft` for their text
specifically so it stays readable no matter what the page-level `--ink` is
set to.

