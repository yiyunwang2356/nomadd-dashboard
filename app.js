import { initializeApp } from "https://www.gstatic.com/firebasejs/10.11.0/firebase-app.js";
import {
  getAuth, GoogleAuthProvider, signInWithPopup, signInWithRedirect,
  getRedirectResult, signOut, onAuthStateChanged
} from "https://www.gstatic.com/firebasejs/10.11.0/firebase-auth.js";
import {
  getFirestore, collection, addDoc, onSnapshot,
  doc, updateDoc, deleteDoc, serverTimestamp, query, orderBy, setDoc, getDoc
} from "https://www.gstatic.com/firebasejs/10.11.0/firebase-firestore.js";
import firebaseConfig from "./firebase-config.js";

const ALLOWED_DOMAIN = "nomaddhaus.com";
const ADMIN_EMAILS   = ["nomaddhaus@gmail.com"];

function isAllowed(email) {
  if (!email) return false;
  const e = email.toLowerCase().trim();
  return e.endsWith("@" + ALLOWED_DOMAIN) || ADMIN_EMAILS.map(x => x.toLowerCase()).includes(e);
}
function isAdmin(email) {
  if (!email) return false;
  return ADMIN_EMAILS.map(x => x.toLowerCase()).includes(email.toLowerCase().trim());
}

const app  = initializeApp(firebaseConfig);
const auth = getAuth(app);
const db   = getFirestore(app);

let currentUser    = null;
let currentDept    = "全部";
let currentMode    = "list";
let newTaskPinned  = false;
let currentMonth   = new Date(new Date().getFullYear(), new Date().getMonth(), 1);
let allTasks       = [];
let allMembers     = [];
let calendarMember = "全部";
let selectedDate   = null;

const LIST_LIMIT = 20;

const DAY_NAMES = ["週日","週一","週二","週三","週四","週五","週六"];

const TYPE_HINTS = {
  "每週重複": "🔁 每週重複：進入新的一週後，會自動取消完成勾選",
  "每月重複": "📆 每月重複：進入新的月份後，會自動取消完成勾選",
  "單次截止": "📌 單次截止：只有一個截止日期，完成後不會自動重置"
};

window.onTypeChange = () => {
  const type = document.getElementById("task-type").value;
  document.getElementById("type-hint").textContent              = TYPE_HINTS[type] || "";
  document.getElementById("task-repeat-day").style.display  = type === "每週重複" ? "block" : "none";
  document.getElementById("task-repeat-date").style.display = type === "每月重複" ? "block" : "none";
  document.getElementById("task-date").style.display        = type === "單次截止" ? "block" : "none";
};

window.onAssigneeChange = () => {
  const sel = document.getElementById("task-assignee");
  const selected = sel.options[sel.selectedIndex];
  document.getElementById("task-assignee-email").value = selected?.dataset.email || "";
};

function createGoogleProvider() {
  const provider = new GoogleAuthProvider();
  provider.setCustomParameters({ hd: ALLOWED_DOMAIN, prompt: "select_account" });
  return provider;
}

function isRedirectLoginDevice() {
  return isMobile() || /iPhone|iPad|iPod|Android/i.test(navigator.userAgent);
}

function showLoginError(error) {
  if (error?.code === "auth/cancelled-popup-request") {
    alert("登入視窗已被取消，請再按一次「使用 Google 登入」。");
    return;
  }
  if (error?.code === "auth/popup-blocked") {
    alert("瀏覽器阻擋了登入視窗，請允許彈出視窗後再試一次。");
    return;
  }
  alert("登入失敗：" + (error?.message || "請稍後再試"));
}

getRedirectResult(auth).catch(showLoginError);

document.getElementById("google-login-btn").addEventListener("click", async () => {
  const provider = createGoogleProvider();
  try {
    if (isRedirectLoginDevice()) {
      await signInWithRedirect(auth, provider);
      return;
    }
    await signInWithPopup(auth, provider);
  } catch (e) {
    showLoginError(e);
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
    const snap    = await getDoc(userRef);
    if (!snap.exists()) {
      await setDoc(userRef, {
        name: user.displayName || "", email: user.email,
        role: isAdmin(user.email) ? "admin" : "staff",
        createdAt: serverTimestamp()
      });
    }

    const adminCheck = isAdmin(user.email);
    document.getElementById("add-task-form").style.display = adminCheck ? "block" : "none";
    // 初始化欄位顯示
    onTypeChange();
    loadMembers();
    loadTasks();
  } else {
    currentUser = null;
    document.getElementById("login-screen").style.display = "flex";
    document.getElementById("main-app").style.display     = "none";
  }
});

function loadMembers() {
  const q = query(collection(db, "members"), orderBy("name"));
  onSnapshot(q, snapshot => {
    allMembers = snapshot.docs.map(d => d.data()).filter(m => m.name && m.email);

    const sel = document.getElementById("task-assignee");
    const cur = sel.value;
    sel.innerHTML = '<option value="">選擇負責人</option>' +
      allMembers.map(m => `<option value="${m.name}" data-email="${m.email}">${m.name}</option>`).join("");
    if (cur) sel.value = cur;

    renderCalendarMemberTabs();
  });
}

function renderCalendarMemberTabs() {
  const wrap = document.getElementById("cal-member-tabs");
  wrap.innerHTML = '<button class="cal-tab-btn active" data-member="全部">全部</button>' +
    allMembers.map(m =>
      `<button class="cal-tab-btn" data-member="${m.name}">${m.name}</button>`
    ).join("");

  wrap.querySelectorAll(".cal-tab-btn").forEach(btn => {
    btn.addEventListener("click", () => {
      wrap.querySelectorAll(".cal-tab-btn").forEach(b => b.classList.remove("active"));
      btn.classList.add("active");
      calendarMember = btn.dataset.member;
      selectedDate   = null;
      hideDayDetail();
      renderCalendar();
    });
  });
}

async function autoReset(tasks) {
  const today    = new Date();
  const todayStr = fmtDate(today);
  const currentWeekKey = getWeekKey(today);
  const currentMonthKey = getMonthKey(today);

  for (const task of tasks) {
    if (!task.done) continue;

    if (task.taskType === "每週重複") {
      if (task.lastResetCycle === currentWeekKey) continue;
      const completedDate = getTaskCompletedDate(task);
      if (completedDate && getWeekKey(completedDate) !== currentWeekKey) {
        await updateDoc(doc(db, "tasks", task.id), {
          done: false,
          completedAt: null,
          lastResetDate: todayStr,
          lastResetCycle: currentWeekKey,
          updatedAt: serverTimestamp()
        });
      }
    }

    if (task.taskType === "每月重複") {
      if (task.lastResetCycle === currentMonthKey) continue;
      const completedDate = getTaskCompletedDate(task);
      if (completedDate && getMonthKey(completedDate) !== currentMonthKey) {
        await updateDoc(doc(db, "tasks", task.id), {
          done: false,
          completedAt: null,
          lastResetDate: todayStr,
          lastResetCycle: currentMonthKey,
          updatedAt: serverTimestamp()
        });
      }
    }
  }
}

function getTaskCompletedDate(task) {
  return toDate(task.completedAt) || toDate(task.updatedAt) || toDate(task.createdAt);
}

function toDate(value) {
  if (!value) return null;
  if (typeof value.toDate === "function") return value.toDate();
  if (typeof value.seconds === "number") return new Date(value.seconds * 1000);
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function loadTasks() {
  const q = query(collection(db, "tasks"), orderBy("createdAt", "desc"));
  onSnapshot(q, async snapshot => {
    allTasks = snapshot.docs.map(d => ({ id: d.id, ...d.data() }));
    await autoReset(allTasks);
    populateAssigneeFilter();
    renderAll();
  });
}

document.getElementById("add-task-btn").addEventListener("click", async () => {
  const title         = document.getElementById("task-title").value.trim();
  const dept          = document.getElementById("task-dept").value;
  const taskType      = document.getElementById("task-type").value;
  const assignee      = document.getElementById("task-assignee").value.trim();
  const assigneeEmail = document.getElementById("task-assignee-email").value.trim();
  const dueDate       = document.getElementById("task-date").value;
  const repeatDay     = parseInt(document.getElementById("task-repeat-day").value);
  const repeatDate    = parseInt(document.getElementById("task-repeat-date").value);

  if (!title)    return alert("請輸入待辦事項名稱");
  if (!assignee) return alert("請選擇負責人");
  if (taskType === "單次截止" && !dueDate) return alert("單次截止任務請先填入截止日期");

  await addDoc(collection(db, "tasks"), {
    title, dept, taskType,
    assignee, assigneeEmail,
    dueDate:       dueDate || "",
    repeatDay:     taskType === "每週重複" ? repeatDay  : null,
    repeatDate:    taskType === "每月重複" ? repeatDate : null,
    pinned:        newTaskPinned,
    done:          false,
    lastResetDate: "",
    createdBy:     currentUser.uid,
    createdAt:     serverTimestamp(),
    updatedAt:     serverTimestamp()
  });

  document.getElementById("task-title").value          = "";
  document.getElementById("task-assignee").value       = "";
  document.getElementById("task-assignee-email").value = "";
  const dateEl = document.getElementById("task-date");
  dateEl.value = "";
  dateEl.type  = "text";
  setPinBtn(false);
});

document.getElementById("new-pin-btn").addEventListener("click", () => setPinBtn(!newTaskPinned));
function setPinBtn(state) {
  newTaskPinned = state;
  const btn = document.getElementById("new-pin-btn");
  btn.textContent       = state ? "📌 已置頂" : "📌 未置頂";
  btn.style.background  = state ? "#FFF3E8"   : "white";
  btn.style.borderColor = state ? "#f0cda3"   : "#E7DDD0";
  btn.style.color       = state ? "#C96F16"   : "#4B443D";
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

["assignee-filter","pin-filter","type-filter"].forEach(id =>
  document.getElementById(id).addEventListener("change", renderAll)
);

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
  selectedDate = null;
  hideDayDetail();
  renderCalendar();
};

function getFiltered() {
  const assignee   = document.getElementById("assignee-filter").value;
  const pinFilter  = document.getElementById("pin-filter").value;
  const typeFilter = document.getElementById("type-filter").value;
  let list = [...allTasks];
  if (currentDept  !== "全部") list = list.filter(t => t.dept === currentDept);
  if (assignee     !== "全部") list = list.filter(t => t.assignee === assignee);
  if (typeFilter   !== "全部") list = list.filter(t => t.taskType === typeFilter);
  if (pinFilter === "onlyPinned")   list = list.filter(t => t.pinned);
  if (pinFilter === "onlyUnpinned") list = list.filter(t => !t.pinned);
  list.sort((a, b) => {
    if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;
    if (a.done   !== b.done)   return a.done   ?  1 : -1;
    return (a.dueDate || "9999").localeCompare(b.dueDate || "9999");
  });
  return list;
}

// ─── 動態計算下一次截止日 ────────────────────────
function getNextDueDate(task, referenceDate) {
  const base = new Date(referenceDate || new Date());
  base.setHours(0, 0, 0, 0);

  if (task.taskType === "每週重複") {
    const targetDay = task.repeatDay ?? 1;
    const day  = base.getDay();
    const diff = day === targetDay ? 0 : (targetDay - day + 7) % 7;
    const next = new Date(base);
    next.setDate(base.getDate() + diff);
    return fmtDate(next);
  }

  if (task.taskType === "每月重複") {
    const targetDate = task.repeatDate ?? 1;
    let next;
    if (base.getDate() === targetDate) {
      next = new Date(base);
    } else if (base.getDate() < targetDate) {
      next = new Date(base.getFullYear(), base.getMonth(), targetDate);
    } else {
      next = new Date(base.getFullYear(), base.getMonth() + 1, targetDate);
    }
    return fmtDate(next);
  }

  return task.dueDate || "";
}

function getCalendarFiltered() {
  let list = [...allTasks];
  if (calendarMember !== "全部") list = list.filter(t => t.assignee === calendarMember);
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
  if (!pinned.length) { wrap.innerHTML = '<div class="empty">目前沒有置頂事項</div>'; return; }
  wrap.innerHTML = pinned.map(t => `
    <div class="pin-item">
      <div class="pin-top">
        <span class="pin-badge">置頂</span>
        <span class="muted">${repeatLabel(t)}</span>
      </div>
      <div style="font-weight:800;font-size:.92rem;margin-bottom:4px">${t.title}</div>
      <div class="muted">${t.dept}｜${t.assignee}｜${t.taskType}</div>
    </div>
  `).join("");
}

function repeatLabel(task) {
  if (task.taskType === "每週重複") return DAY_NAMES[task.repeatDay ?? 1];
  if (task.taskType === "每月重複") return `每月 ${task.repeatDate ?? 1} 號`;
  return task.dueDate || "未設定";
}

function renderList() {
  const wl = document.getElementById("weekly-list");
  const ml = document.getElementById("monthly-list");
  const ol = document.getElementById("once-list");
  wl.innerHTML = ml.innerHTML = ol.innerHTML = "";

  const filtered = getFiltered();
  const weekly  = filtered.filter(t => t.taskType === "每週重複");
  const monthly = filtered.filter(t => t.taskType === "每月重複");
  const once    = filtered.filter(t => t.taskType === "單次截止" || !t.taskType);

  renderTaskGroup(wl, weekly,  "目前沒有每週重複待辦");
  renderTaskGroup(ml, monthly, "目前沒有每月重複待辦");
  renderTaskGroup(ol, once,    "目前沒有單次截止待辦");
}

function renderTaskGroup(ul, tasks, emptyMsg) {
  const todo = tasks.filter(t => !t.done);
  const done = tasks.filter(t =>  t.done);

  if (!tasks.length) {
    ul.innerHTML = `<div class="empty">${emptyMsg}</div>`;
    return;
  }

  if (!todo.length) {
    ul.insertAdjacentHTML("beforeend", `<div class="empty">全部已完成 ✅</div>`);
  }
  todo.slice(0, LIST_LIMIT).forEach(t => ul.appendChild(createItem(t)));
  if (todo.length > LIST_LIMIT) {
    ul.insertAdjacentHTML("beforeend",
      `<div class="list-more">還有 ${todo.length - LIST_LIMIT} 項，請使用篩選器縮小範圍</div>`);
  }

  if (done.length) {
    const toggleId = `done-${Math.random().toString(36).slice(2)}`;
    const toggle = document.createElement("div");
    toggle.className = "done-toggle";
    toggle.innerHTML = `<span>✅ 已完成 ${done.length} 項</span><span class="done-arrow">▶</span>`;
    toggle.addEventListener("click", () => {
      const box   = document.getElementById(toggleId);
      const arrow = toggle.querySelector(".done-arrow");
      const open  = box.style.display !== "none";
      box.style.display = open ? "none" : "block";
      arrow.textContent = open ? "▶" : "▼";
    });
    ul.appendChild(toggle);

    const doneBox = document.createElement("div");
    doneBox.id            = toggleId;
    doneBox.style.display = "none";
    done.slice(0, LIST_LIMIT).forEach(t => doneBox.appendChild(createItem(t)));
    if (done.length > LIST_LIMIT) {
      doneBox.insertAdjacentHTML("beforeend",
        `<div class="list-more">還有 ${done.length - LIST_LIMIT} 項已完成</div>`);
    }
    ul.appendChild(doneBox);
  }
}

function createItem(task) {
  const admin = isAdmin(currentUser?.email);
  const li = document.createElement("li");
  li.className = "task-item" + (task.done ? " done" : "");
  const typeTag = task.taskType === "單次截止" ? '<span class="tag tag-once">單次</span>' : "";
  const repeatInfo = task.taskType === "每週重複"
    ? `<span class="tag tag-repeat">${DAY_NAMES[task.repeatDay ?? 1]}</span>`
    : task.taskType === "每月重複"
    ? `<span class="tag tag-repeat">每月 ${task.repeatDate ?? 1} 號</span>`
    : "";
  li.innerHTML = `
    <input type="checkbox" ${task.done ? "checked" : ""} />
    <div class="task-content">
      <div class="task-title-row">
        <span class="task-title">${task.title}</span>
        ${task.pinned ? '<span class="tag tag-pin">📌 緊急</span>' : ""}
        ${typeTag}
      </div>
      <div class="task-meta">
        <span class="tag tag-dept">${task.dept}</span>
        <span>👤 ${task.assignee}</span>
        ${repeatInfo}
        ${task.dueDate ? `<span class="tag tag-date">${task.dueDate}</span>` : ""}
      </div>
    </div>
    <div class="row-actions">
      ${admin ? `<button class="icon-btn" data-action="edit">✏️</button>` : ""}
      ${admin ? `<button class="icon-btn ${task.pinned ? "pin-on" : ""}" data-action="pin">📌</button>` : ""}
      ${admin ? `<button class="icon-btn" data-action="delete">🗑</button>` : ""}
    </div>
  `;
  li.querySelector("input[type=checkbox]").addEventListener("change", e =>
    updateDoc(doc(db, "tasks", task.id), {
      done: e.target.checked,
      completedAt: e.target.checked ? serverTimestamp() : null,
      updatedAt: serverTimestamp()
    })
  );
  if (admin) {
    li.querySelector("[data-action=pin]")?.addEventListener("click", () =>
      updateDoc(doc(db, "tasks", task.id), { pinned: !task.pinned, updatedAt: serverTimestamp() })
    );
    li.querySelector("[data-action=delete]")?.addEventListener("click", () => {
      if (confirm("確定刪除此待辦？")) deleteDoc(doc(db, "tasks", task.id));
    });
    li.querySelector("[data-action=edit]")?.addEventListener("click", () => {
      enterEditMode(li, task);
    });
  }
  return li;
}

function enterEditMode(li, task) {
  const memberOptions = allMembers.map(m =>
    `<option value="${m.name}" data-email="${m.email}" ${m.name === task.assignee ? "selected" : ""}>${m.name}</option>`
  ).join("");

  const weekOptions = ["週一","週二","週三","週四","週五","週六","週日"].map((d, i) => {
    const val = i === 6 ? 0 : i + 1;
    return `<option value="${val}" ${(task.repeatDay ?? 1) === val ? "selected" : ""}>${d}</option>`;
  }).join("");

  const dateOptions = Array.from({length:28}, (_,i) =>
    `<option value="${i+1}" ${(task.repeatDate ?? 1) === i+1 ? "selected" : ""}>${i+1} 號</option>`
  ).join("");

  li.innerHTML = `
    <div class="edit-form">
      <input class="edit-title" type="text" value="${task.title}" placeholder="待辦事項名稱" />
      <select class="edit-dept">
        ${["行政","會計","PT","文宣","場地","行銷"].map(d =>
          `<option ${d === task.dept ? "selected" : ""}>${d}</option>`
        ).join("")}
      </select>
      <select class="edit-type">
        ${["每週重複","每月重複","單次截止"].map(t =>
          `<option ${t === task.taskType ? "selected" : ""}>${t}</option>`
        ).join("")}
      </select>
      <select class="edit-repeat-day" style="${task.taskType === "每週重複" ? "" : "display:none"}">
        ${weekOptions}
      </select>
      <select class="edit-repeat-date" style="${task.taskType === "每月重複" ? "" : "display:none"}">
        ${dateOptions}
      </select>
      <select class="edit-assignee">
        <option value="">選擇負責人</option>
        ${memberOptions}
      </select>
      <input class="edit-date" type="date" value="${task.dueDate || ""}"
        style="${task.taskType === "單次截止" ? "" : "display:none"}" />
      <div class="edit-actions">
        <button class="primary-btn edit-save">✅ 儲存</button>
        <button class="ghost-btn edit-cancel">✖ 取消</button>
      </div>
    </div>
  `;

  // 編輯模式 type 切換
  li.querySelector(".edit-type").addEventListener("change", e => {
    const t = e.target.value;
    li.querySelector(".edit-repeat-day").style.display  = t === "每週重複" ? "block" : "none";
    li.querySelector(".edit-repeat-date").style.display = t === "每月重複" ? "block" : "none";
    li.querySelector(".edit-date").style.display        = t === "單次截止" ? "block" : "none";
  });

  li.querySelector(".edit-cancel").addEventListener("click", () => renderAll());
  li.querySelector(".edit-save").addEventListener("click", async () => {
    const newTitle     = li.querySelector(".edit-title").value.trim();
    const newDept      = li.querySelector(".edit-dept").value;
    const newType      = li.querySelector(".edit-type").value;
    const newAssignee  = li.querySelector(".edit-assignee").value;
    const newDate      = li.querySelector(".edit-date").value;
    const newRepeatDay  = parseInt(li.querySelector(".edit-repeat-day").value);
    const newRepeatDate = parseInt(li.querySelector(".edit-repeat-date").value);
    const newEmail     = li.querySelector(".edit-assignee")
                           .options[li.querySelector(".edit-assignee").selectedIndex]
                           ?.dataset.email || "";
    if (!newTitle)    return alert("請輸入待辦事項名稱");
    if (!newAssignee) return alert("請選擇負責人");
    if (newType === "單次截止" && !newDate) return alert("單次截止任務請先填入截止日期");
    await updateDoc(doc(db, "tasks", task.id), {
      title: newTitle, dept: newDept, taskType: newType,
      assignee: newAssignee, assigneeEmail: newEmail,
      dueDate:     newDate || "",
      repeatDay:   newType === "每週重複" ? newRepeatDay  : null,
      repeatDate:  newType === "每月重複" ? newRepeatDate : null,
      updatedAt:   serverTimestamp()
    });
  });
}

// ─── 月曆 ───────────────────────────────────────────

function isMobile() {
  return window.innerWidth <= 640;
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
    el.className = "weekday"; el.textContent = d;
    grid.appendChild(el);
  });

  const firstDay    = new Date(year, month, 1).getDay();
  const daysInMonth = new Date(year, month + 1, 0).getDate();
  const prevDays    = new Date(year, month, 0).getDate();
  const filtered    = getCalendarFiltered();
  const mobile      = isMobile();

  for (let i = 0; i < 42; i++) {
    let d, cur = true;
    if (i < firstDay)
      { d = new Date(year, month - 1, prevDays - firstDay + i + 1); cur = false; }
    else if (i >= firstDay + daysInMonth)
      { d = new Date(year, month + 1, i - (firstDay + daysInMonth) + 1); cur = false; }
    else
      { d = new Date(year, month, i - firstDay + 1); }

    const dateStr  = fmtDate(d);
    const dayTasks = filtered.filter(t =>
      getNextDueDate(t, new Date(d.getFullYear(), d.getMonth(), d.getDate())) === dateStr
    );

    const isSelected = selectedDate === dateStr;
    const cell = document.createElement("div");
    cell.className = "day-cell" +
      (cur ? "" : " other-month") +
      (isSelected ? " selected" : "");
    cell.dataset.date = dateStr;

    if (mobile) {
      const dots = dayTasks.length > 0
        ? `<div class="day-dots">${dayTasks.slice(0,3).map(t =>
            `<span class="day-dot${t.pinned ? " pin" : ""}"></span>`
          ).join("")}${dayTasks.length > 3
            ? `<span class="day-dot-more">+${dayTasks.length - 3}</span>` : ""}</div>`
        : "";
      cell.innerHTML = `<div class="day-num">${d.getDate()}</div>${dots}`;

      if (cur && dayTasks.length > 0) {
        cell.style.cursor = "pointer";
        cell.addEventListener("click", () => {
          if (selectedDate === dateStr) {
            selectedDate = null;
            hideDayDetail();
            cell.classList.remove("selected");
          } else {
            selectedDate = dateStr;
            document.querySelectorAll(".day-cell.selected").forEach(c => c.classList.remove("selected"));
            cell.classList.add("selected");
            showDayDetail(dateStr, dayTasks);
          }
        });
      }
    } else {
      cell.innerHTML = `<div class="day-num">${d.getDate()}</div><div class="day-events"></div>`;
      const evWrap = cell.querySelector(".day-events");
      dayTasks.slice(0, 2).forEach(t => {
        const chip = document.createElement("div");
        chip.className   = "event-chip" + (t.pinned ? " pin" : "");
        chip.textContent = `${t.assignee}｜${t.title}`;
        evWrap.appendChild(chip);
      });
      if (dayTasks.length > 2) {
        const more = document.createElement("div");
        more.className   = "event-chip more";
        more.textContent = `+${dayTasks.length - 2} 項`;
        evWrap.appendChild(more);
      }
    }

    grid.appendChild(cell);
  }
}

function showDayDetail(dateStr, tasks) {
  const wrap  = document.getElementById("cal-day-detail");
  const title = document.getElementById("cal-day-detail-title");
  const list  = document.getElementById("cal-day-task-list");
  title.textContent = `📅 ${dateStr} 的待辦（${tasks.length} 項）`;
  list.innerHTML = tasks.map(t => `
    <li class="cal-day-task-item ${t.done ? "done" : ""}">
      <span class="cal-day-task-title">${t.done ? "✅" : "⬜"} ${t.title}</span>
      <span class="cal-day-task-meta">${t.dept}｜👤 ${t.assignee}｜${repeatLabel(t)}</span>
    </li>
  `).join("");
  wrap.style.display = "block";
}

function hideDayDetail() {
  document.getElementById("cal-day-detail").style.display = "none";
  document.getElementById("cal-day-task-list").innerHTML  = "";
}

function fmtDate(date) {
  return `${date.getFullYear()}-${String(date.getMonth()+1).padStart(2,"0")}-${String(date.getDate()).padStart(2,"0")}`;
}

function getWeekKey(date) {
  return fmtDate(getWeekStart(date));
}

function getWeekStart(date) {
  const d = new Date(date);
  d.setHours(0, 0, 0, 0);
  const diffFromMonday = (d.getDay() + 6) % 7;
  d.setDate(d.getDate() - diffFromMonday);
  return d;
}

function getMonthKey(date) {
  return `${date.getFullYear()}-${String(date.getMonth()+1).padStart(2,"0")}`;
}
