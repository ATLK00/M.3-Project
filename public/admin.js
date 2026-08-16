/**
 * admin.js — dev-only page for managing the instrument list.
 * Talks to the same GET/POST/PUT/DELETE /api/instruments endpoints that
 * server.js exposes. Write calls send the passcode as an `x-admin-key`
 * header; GET (listing) is public since instrument names aren't sensitive.
 */

const KEY_STORAGE = "mmg_adminKey";
let instruments = [];
let categories = {};
let editingId = null;
let pendingImageDataUrl = null;

function toast(msg) {
  const t = document.getElementById("toast");
  t.textContent = msg;
  t.classList.add("show");
  clearTimeout(toast._t);
  toast._t = setTimeout(() => t.classList.remove("show"), 2400);
}

function adminKey() {
  return sessionStorage.getItem(KEY_STORAGE) || "";
}

async function apiCall(method, url, body) {
  const res = await fetch(url, {
    method,
    headers: { "Content-Type": "application/json", "x-admin-key": adminKey() },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({ ok: false, error: "การตอบกลับไม่ถูกต้อง" }));
  if (!res.ok) throw new Error(data.error || `ผิดพลาด (${res.status})`);
  return data;
}

// ---------------- Passcode gate ----------------
document.getElementById("btn-unlock").addEventListener("click", unlock);
document.getElementById("input-key").addEventListener("keydown", (e) => {
  if (e.key === "Enter") unlock();
});

async function unlock() {
  const key = document.getElementById("input-key").value.trim();
  const errEl = document.getElementById("gate-error");
  errEl.textContent = "";
  if (!key) {
    errEl.textContent = "กรุณาใส่รหัสผ่าน";
    return;
  }
  sessionStorage.setItem(KEY_STORAGE, key);
  try {
    await apiCall("GET", "/api/admin/check");
    document.getElementById("screen-gate").classList.add("hidden");
    document.getElementById("screen-admin").classList.remove("hidden");
    await loadInstruments();
  } catch (err) {
    sessionStorage.removeItem(KEY_STORAGE);
    errEl.textContent = "รหัสผ่านไม่ถูกต้อง";
  }
}

document.getElementById("btn-lock").addEventListener("click", () => {
  sessionStorage.removeItem(KEY_STORAGE);
  document.getElementById("screen-admin").classList.add("hidden");
  document.getElementById("screen-gate").classList.remove("hidden");
});

// Skip the gate automatically if we already have a working key this tab.
(async function tryAutoUnlock() {
  if (!adminKey()) return;
  try {
    await apiCall("GET", "/api/admin/check");
    document.getElementById("screen-gate").classList.add("hidden");
    document.getElementById("screen-admin").classList.remove("hidden");
    await loadInstruments();
  } catch (err) {
    sessionStorage.removeItem(KEY_STORAGE);
  }
})();

// ---------------- Category dropdown ----------------
function renderCategoryOptions() {
  const sel = document.getElementById("input-category");
  sel.innerHTML = Object.entries(categories)
    .map(([id, label]) => `<option value="${id}">${label}</option>`)
    .join("");
}

// ---------------- Load + render list ----------------
async function loadInstruments() {
  const data = await apiCall("GET", "/api/instruments");
  instruments = data.instruments;
  categories = data.categories;
  renderCategoryOptions();
  renderTable();
}

function thumbHtml(inst) {
  if (inst.image) return `<img src="${inst.image}" alt="" />`;
  return categoryIconHtml(inst.category, "#c4b5fd");
}

function renderTable() {
  document.getElementById("inst-count").textContent = instruments.length;
  const wrap = document.getElementById("inst-table");
  wrap.innerHTML = instruments
    .map(
      (inst) => `
      <div class="inst-row">
        <div class="inst-thumb">${thumbHtml(inst)}</div>
        <div class="inst-info">
          <b>${escapeHtml(inst.th)}</b>
          <span>${categories[inst.category] || inst.category}</span>
        </div>
        <div class="inst-actions">
          <button class="btn-edit" data-id="${inst.id}">แก้ไข</button>
          <button class="btn-del" data-id="${inst.id}">ลบ</button>
        </div>
      </div>`
    )
    .join("");

  wrap.querySelectorAll(".btn-edit").forEach((btn) => btn.addEventListener("click", () => startEdit(btn.dataset.id)));
  wrap.querySelectorAll(".btn-del").forEach((btn) => btn.addEventListener("click", () => removeInstrument(btn.dataset.id)));
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

// ---------------- Add / Edit form ----------------
function startEdit(id) {
  const inst = instruments.find((i) => i.id === id);
  if (!inst) return;
  editingId = id;
  pendingImageDataUrl = undefined; // undefined = "leave image unchanged" for edits
  document.getElementById("form-title").textContent = `แก้ไข: ${inst.th}`;
  document.getElementById("input-th").value = inst.th;
  document.getElementById("input-category").value = inst.category;
  document.getElementById("input-image").value = "";
  const preview = document.getElementById("img-preview");
  if (inst.image) {
    preview.src = inst.image;
    preview.classList.add("show");
  } else {
    preview.classList.remove("show");
  }
  document.getElementById("btn-cancel-edit").classList.remove("hidden");
  document.getElementById("btn-save").textContent = "บันทึกการแก้ไข";
  window.scrollTo({ top: 0, behavior: "smooth" });
}

function resetForm() {
  editingId = null;
  pendingImageDataUrl = null;
  document.getElementById("form-title").textContent = "เพิ่มเครื่องดนตรีใหม่";
  document.getElementById("input-th").value = "";
  document.getElementById("input-image").value = "";
  document.getElementById("img-preview").classList.remove("show");
  document.getElementById("btn-cancel-edit").classList.add("hidden");
  document.getElementById("btn-save").textContent = "บันทึก";
  document.getElementById("form-error").textContent = "";
}
document.getElementById("btn-cancel-edit").addEventListener("click", resetForm);

document.getElementById("input-image").addEventListener("change", (e) => {
  const file = e.target.files && e.target.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = () => {
    pendingImageDataUrl = reader.result;
    const preview = document.getElementById("img-preview");
    preview.src = pendingImageDataUrl;
    preview.classList.add("show");
  };
  reader.readAsDataURL(file);
});

document.getElementById("btn-save").addEventListener("click", saveInstrument);

async function saveInstrument() {
  const errEl = document.getElementById("form-error");
  errEl.textContent = "";
  const th = document.getElementById("input-th").value.trim();
  const category = document.getElementById("input-category").value;
  if (!th) {
    errEl.textContent = "กรุณาใส่ชื่อเครื่องดนตรี";
    return;
  }
  const btn = document.getElementById("btn-save");
  btn.disabled = true;
  try {
    if (editingId) {
      const body = { th, category };
      if (pendingImageDataUrl) body.image = pendingImageDataUrl;
      await apiCall("PUT", `/api/instruments/${editingId}`, body);
      toast("แก้ไขแล้ว");
    } else {
      await apiCall("POST", "/api/instruments", { th, category, image: pendingImageDataUrl || null });
      toast("เพิ่มเครื่องดนตรีแล้ว");
    }
    resetForm();
    await loadInstruments();
  } catch (err) {
    errEl.textContent = err.message || "บันทึกไม่สำเร็จ";
  } finally {
    btn.disabled = false;
  }
}

async function removeInstrument(id) {
  const inst = instruments.find((i) => i.id === id);
  if (!inst) return;
  if (!confirm(`ลบ "${inst.th}" ออกจากรายการเครื่องดนตรี?`)) return;
  try {
    await apiCall("DELETE", `/api/instruments/${id}`);
    toast("ลบแล้ว");
    if (editingId === id) resetForm();
    await loadInstruments();
  } catch (err) {
    toast(err.message || "ลบไม่สำเร็จ");
  }
}
