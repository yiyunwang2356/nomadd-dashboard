import { initializeApp } from "https://www.gstatic.com/firebasejs/10.11.0/firebase-app.js";
import {
  getAuth, GoogleAuthProvider, signInWithPopup, signOut, onAuthStateChanged
} from "https://www.gstatic.com/firebasejs/10.11.0/firebase-auth.js";
import {
  getFirestore, collection, addDoc, onSnapshot,
  doc, updateDoc, deleteDoc, serverTimestamp, query, orderBy, setDoc, getDoc
} from "https://www.gstatic.com/firebasejs/10.11.0/firebase-firestore.js";
import firebaseConfig from "./firebase-config.js";

const ALLOWED_DOMAIN = "nomaddhaus.com";
const ADMIN_EMAILS   = ["nomaddhaus@gmail.com"];

function isAllowed(email) {
  return email && (email.endsWith("@" + ALLOWED_DOMAIN) || ADMIN_EMAILS.includes(email));
}
function isAdmin(email) {
  return ADMIN_EMAILS.includes(email);
}

const app  = initializeApp(firebaseConfig);
const auth = getAuth(app);
const db   = getFirestore(app);

let currentUser   = null;
let currentDept   = "全部";
let currentMode   = "list";
let newTaskPinned = false;
let currentMonth  = new Date(new Date().getFullYear(), new Date().getMonth(), 1);
let allTasks      = [];

document.getElementById("google-login-btn").addEventListener("click", async () => {
  const provider = new GoogleAuthProvider();
  provider.setCustomParameters({ hd: ALLOWED_DOMAIN, prompt: "select_account" });
  try {
    await signInWithPopup(auth, provider);
  } catch (e) {
    alert("登入失敗：" + e.message);
  }
});

document.getElementById("logout-btn").addEventListener("click", () => signOut(auth));

onAuthStateChanged(auth, async user => {
  if (user) {
    if (!isAllowed(user.email)) {
      alert("此帳號沒有存取權限，請使用公司帳號登入。");
      await signOut(auth);
      return;
    }
    currentUser = user;
    document.getElementById("login-screen").style.display = "none";
    document.getElementById("main-app").style.display     = "block";
    document.getElementById("user-name").textContent      = user.displayName || user.email;

    const userRef = doc(db, "users", user.uid);
    const snap = await getDoc(userRef);
    if (!snap.exists()) {
      await setDoc(userRef, {
        name:      user.displayName || "",
        email:     user.email,
        role:      isAdmin(user.email) ? "admin" : "staff",
        createdAt: serverTimestamp()
      });
    }

    document.getElementById("add-task-form").style.display = isAdmin(user.email) ? "block" : "none";
    loadTasks();
    populateAssigneeFilter();
  } else {
    currentUser = null;
    document.getElementById("login-screen").style.display = "flex";
    document.getElementById("main-app").style.display     = "none";
  }
});

function loadTasks() {
  const q = query(collection(db, "tasks"), orderBy("createdAt", "desc"));
  onSnapshot(q, snapshot => {
    allTasks = snapshot.docs.map(d => ({ id: d.id, ...d.data() }));
    populateAssigneeFilter();
    renderAll();
  });
}

document.getElementById("add-task-btn").addEventListener("click", async () => {
  const title    = document.getElementById("task-title").value.trim();
  const dept     = document.getElementById("task-dept").value;
  const freq     = document.getElementById("task-freq").value;
  const assignee = document.getElementById("task-assignee").value.trim();
  const dueDate  = document.getElementById("task-date").value;
  if (!title) return alert("請輸入待辦事項名稱");
  await addDoc(collection(db, "tasks"), {
    title, dept, freq,
    assignee:  assignee || "未指定",
    dueDate:   dueDate  || "",
    pinned:    newTaskPinned,
    done:      false,
    createdBy: currentUser.uid,
    createdAt: serverTimestamp(),
    updatedAt: serverTimestamp()
  });
  document.getElementById("task-title").value    = "";
  document.getElementById("task-assignee").value = "";
  document.getElementById("task-date").value     = "";
  setPinBtn(false);
});

document.getElementById("new-pin-btn").addEventListener("click", () => setPinBtn(!newTaskPinned));
function setPinBtn(state) {
  newTaskPinned = state;
  const btn = document.getElementById("new-pin-btn");
  btn.textContent        = state ? "📌 已 Pin" : "📌 未 Pin";
  btn.style.background   = state ? "#FFF3E8"   : "white";
  btn.style.borderColor  = state ? "#f0cda3"   : "#E7DDD0";
  btn.style.color        = state ? "#C96F16"   : "#4B443D";
}

document.querySelectorAll(".tab-btn").forEach(btn => {
  btn.addEventListener("click", () => {
    document.querySelectorAll(".tab-btn").forEach(b => b.classList.remove("active"));
    btn.classList.add("active");
    currentDept = btn.dataset.dept;
    document.getElementById("dept-filter").value = currentDept;
    renderAll();
  });
});

document.getElementById("dept-filter").addEventListener("change", e => {
  currentDept = e.target.value;
  document.querySelectorAll(".tab-btn").forEach(b =>
    b.classList.toggle("active", b.dataset.dept === currentDept)
  );
  renderAll();
});

document.getElementById("assignee-filter").addEventListener("change", renderAll);
document.getElementById("pin-filter").addEventListener("change", renderAll);

window.switchMode = mode => {
  currentMode = mode;
  document.getElementById("list-view").style.display     = mode === "list" ? "block" : "none";
  document.getElementById("calendar-view").style.display = mode === "calendar" ? "block" : "none";
  document.getElementById("listModeBtn").classList.toggle("active",     mode === "list");
  document.getElementById("calendarModeBtn").classList.toggle("active", mode === "calendar");
  if (mode === "calendar") renderCalendar();
};

window.changeMonth = offset => {
  currentMonth = new Date(currentMonth.getFullYear(), currentMonth.getMonth() + offset, 1);
  renderCalendar();
};

function getFiltered() {
  const assignee  = document.getElementById("assignee-filter").value;
  const pinFilter = document.getElementById("pin-filter").value;
  let list = [...allTasks];
  if (currentDept !== "全部") list = list.filter(t => t.dept === currentDept);
  if (assignee    !== "全部") list = list.filter(t => t.assignee === assignee);
  if (pinFilter === "onlyPinned")   list = list.filter(t => t.pinned);
  if (pinFilter === "onlyUnpinned") list = list.filter(t => !t.pinned);
  list.sort((a, b) => {
    if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;
    if (a.done   !== b.done)   return a.done   ?  1 : -1;
    return (a.dueDate || "").localeCompare(b.dueDate || "");
  });
  return list;
}

function populateAssigneeFilter() {
  const sel = document.getElementById("assignee-filter");
  const cur = sel.value || "全部";
  const people = [...new Set(allTasks.map(t => t.assignee).filter(Boolean))].sort((a,b) => a.localeCompare(b,"zh-Hant"));
  sel.innerHTML = '<option value="全部">全部人員</option>' + people.map(p => `<option value="${p}">${p}</option>`).join("");
  if (people.includes(cur)) sel.value = cur;
}

function renderAll() {
  renderPinned();
  if (currentMode === "list") renderList();
  else renderCalendar();
}

function renderPinned() {
  const wrap   = document.getElementById("pinned-list");
  const pinned = getFiltered().filter(t => t.pinned);
  if (!pinned.length) { wrap.innerHTML = '<div class="empty">目前沒有 Pin 事項</div>'; return; }
  wrap.innerHTML = pinned.map(t => `
    <div class="pin-item">
      <div class="pin-top">
        <span class="pin-badge">PIN</span>
        <span class="muted">${t.dueDate || "未設定"}</span>
      </div>
      <div style="font-weight:800;margin-bottom:6px">${t.title}</div>
      <div class="muted">${t.dept}｜${t.assignee}｜${t.freq}</div>
    </div>
  `).join("");
}

function renderList() {
  const wl = document.getElementById("weekly-list");
  const ml = document.getElementById("monthly-list");
  wl.innerHTML = "";
  ml.innerHTML = "";
  const filtered = getFiltered();
  const weekly   = filtered.filter(t => t.freq === "每週");
  const monthly  = filtered.filter(t => t.freq === "每月");
  if (!weekly.length)  wl.innerHTML = '<div class="empty">目前無每週待辦</div>';
  if (!monthly.length) ml.innerHTML = '<div class="empty">目前無每月待辦</div>';
  weekly.forEach(t  => wl.appendChild(createItem(t)));
  monthly.forEach(t => ml.appendChild(createItem(t)));
}

function createItem(task) {
  const admin = isAdmin(currentUser?.email);
  const li = document.createElement("li");
  li.className = "task-item" + (task.done ? " done" : "");
  li.innerHTML = `
    <input type="checkbox" ${task.done ? "checked" : ""} />
    <div class="task-content">
      <div class="task-title-row">
        <span class="task-title">${task.title}</span>
        ${task.pinned ? '<span class="tag tag-pin">📌 緊急</span>' : ""}
      </div>
      <div class="task-meta">
        <span class="tag tag-dept">${task.dept}</span>
        <span>👤 ${task.assignee}</span>
        <span>${task.freq}</span>
        ${task.dueDate ? `<span class="tag tag-date">${task.dueDate}</span>` : ""}
      </div>
    </div>
    <div class="row-actions">
      ${admin ? `<button class="icon-btn ${task.pinned ? "pin-on" : ""}" data-action="pin">📌</button>` : ""}
      ${admin ? `<button class="icon-btn" data-action="delete">🗑</button>` : ""}
    </div>
  `;
  li.querySelector("input[type=checkbox]").addEventListener("change", e =>
    updateDoc(doc(db, "tasks", task.id), { done: e.target.checked, updatedAt: serverTimestamp() })
  );
  if (admin) {
    li.querySelector("[data-action=pin]")?.addEventListener("click", () =>
      updateDoc(doc(db, "tasks", task.id), { pinned: !task.pinned, updatedAt: serverTimestamp() })
    );
    li.querySelector("[data-action=delete]")?.addEventListener("click", () => {
      if (confirm("確定刪除此待辦？")) deleteDoc(doc(db, "tasks", task.id));
    });
  }
  return li;
}

function renderCalendar() {
  const grid  = document.getElementById("calendar-grid");
  const title = document.getElementById("calendar-title");
  const year  = currentMonth.getFullYear();
  const month = currentMonth.getMonth();
  title.textContent = `${year} 年 ${month + 1} 月`;
  grid.innerHTML    = "";
  ["日","一","二","三","四","五","六"].forEach(d => {
    const el = document.createElement("div");
    el.className = "weekday";
    el.textContent = d;
    grid.appendChild(el);
  });
  const firstDay    = new Date(year, month, 1).getDay();
  const daysInMonth = new Date(year, month + 1, 0).getDate();
  const prevDays    = new Date(year, month, 0).getDate();
  const filtered    = getFiltered();
  for (let i = 0; i < 42; i++) {
    let d, cur = true;
    if (i < firstDay)                     { d = new Date(year, month - 1, prevDays - firstDay + i + 1); cur = false; }
    else if (i >= firstDay + daysInMonth) { d = new Date(year, month + 1, i - (firstDay + daysInMonth) + 1); cur = false; }
    else                                  { d = new Date(year, month, i - firstDay + 1); }
    const dateStr  = fmtDate(d);
    const dayTasks = filtered.filter(t => t.dueDate === dateStr);
    const cell     = document.createElement("div");
    cell.className = "day-cell" + (cur ? "" : " other-month");
    cell.innerHTML = `<div class="day-num">${d.getDate()}</div><div class="day-events"></div>`;
    const evWrap   = cell.querySelector(".day-events");
    dayTasks.slice(0, 3).forEach(t => {
      const chip = document.createElement("div");
      chip.className   = "event-chip" + (t.pinned ? " pin" : "");
      chip.textContent = `${t.assignee}｜${t.title}`;
      evWrap.appendChild(chip);
    });
    if (dayTasks.length > 3) {
      const more = document.createElement("div");
      more.className   = "event-chip";
      more.textContent = `+${dayTasks.length - 3} more`;
      evWrap.appendChild(more);
    }
    grid.appendChild(cell);
  }
}

function fmtDate(date) {
  return `${date.getFullYear()}-${String(date.getMonth()+1).padStart(2,"0")}-${String(date.getDate()).padStart(2,"0")}`;
}