/* =========================================================
   카드 아카이브 - Firebase 연동 버전

   - 회원가입/로그인: Firebase Authentication (이메일/비밀번호)
   - 카드 시리즈(series) / 카드 목록(cards): Firestore, 읽기는 누구나 가능
     쓰기(신규 카드팩 추가 등)는 개발자 계정만 가능 (보안 규칙으로 제한)
     -> 데이터 등록/수정은 seed.html 로 진행
   - 사용자별 수집 여부: Firestore의 users/{uid}/collected/{cardId} 문서
     존재 여부로 판단 (문서가 있으면 수집한 것)
   ========================================================= */

import { initializeApp } from "https://www.gstatic.com/firebasejs/12.17.1/firebase-app.js";
import {
  getAuth,
  setPersistence,
  browserLocalPersistence,
  createUserWithEmailAndPassword,
  signInWithEmailAndPassword,
  signOut,
  onAuthStateChanged,
  updateProfile,
} from "https://www.gstatic.com/firebasejs/12.17.1/firebase-auth.js";
import {
  getFirestore,
  collection,
  getDocs,
  doc,
  setDoc,
  deleteDoc,
  query,
  orderBy,
  where,
  serverTimestamp,
} from "https://www.gstatic.com/firebasejs/12.17.1/firebase-firestore.js";
import { firebaseConfig } from "./firebase-config.js";

const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
const db = getFirestore(app);

// 브라우저를 껐다 켜도 로그인 상태가 유지되도록 명시적으로 설정
// (로그인 상태가 유지되어야 본인이 체크한 수집 여부도 그대로 이어서 보여요)
setPersistence(auth, browserLocalPersistence).catch((err) => console.error(err));

const state = {
  currentUser: null, // { uid, email, nickname }
  seriesList: [], // [{ id, name, order }]
  cardsBySeriesId: {}, // 캐시: { [seriesId]: [{id, name, image, order}] }
  collected: new Set(), // 로그인한 사용자가 수집한 카드 id 모음
  currentSeriesId: null,
  filter: "all", // all | collected | missing
};

/* ---------- Firestore 접근 함수 ---------- */
async function fetchSeriesList() {
  const snap = await getDocs(query(collection(db, "series"), orderBy("order")));
  return snap.docs.map((d) => ({ id: d.id, ...d.data() }));
}

async function fetchCardsForSeries(seriesId) {
  const q = query(
    collection(db, "cards"),
    where("seriesId", "==", seriesId),
    orderBy("order")
  );
  const snap = await getDocs(q);
  return snap.docs.map((d) => ({ id: d.id, ...d.data() }));
}

async function fetchCollectedIds(uid) {
  const snap = await getDocs(collection(db, "users", uid, "collected"));
  return new Set(snap.docs.map((d) => d.id));
}

async function setCardCollected(uid, cardId, collected) {
  const ref = doc(db, "users", uid, "collected", cardId);
  if (collected) {
    await setDoc(ref, { collectedAt: serverTimestamp() });
  } else {
    await deleteDoc(ref);
  }
}

// users/{uid} 문서 자체에 프로필을 남겨서 Firestore 콘솔의 users 목록에서
// 바로 닉네임/이메일이 보이도록 함 (collected는 그 아래 서브컬렉션에 별도 저장됨)
async function upsertUserProfile(uid, email, nickname) {
  await setDoc(
    doc(db, "users", uid),
    { email, nickname, lastSeenAt: serverTimestamp() },
    { merge: true }
  );
}

/* ---------- 화면 요소 ---------- */
const el = {
  authScreen: document.getElementById("auth-screen"),
  appScreen: document.getElementById("app-screen"),

  tabLogin: document.getElementById("tab-login"),
  tabSignup: document.getElementById("tab-signup"),
  loginForm: document.getElementById("login-form"),
  signupForm: document.getElementById("signup-form"),
  loginError: document.getElementById("login-error"),
  signupError: document.getElementById("signup-error"),

  userNickname: document.getElementById("user-nickname"),
  logoutBtn: document.getElementById("logout-btn"),

  emptyState: document.getElementById("empty-state"),
  seriesContent: document.getElementById("series-content"),
  seriesTitle: document.getElementById("series-title"),
  progressText: document.getElementById("progress-text"),
  progressFill: document.getElementById("progress-fill"),
  filterBar: document.querySelector(".filter-bar"),
  cardGrid: document.getElementById("card-grid"),

  seriesList: document.getElementById("series-list"),
};

/* ---------- 화면 전환 ---------- */
function showAuthScreen() {
  el.authScreen.hidden = false;
  el.appScreen.hidden = true;
}

async function showAppScreen() {
  el.authScreen.hidden = true;
  el.appScreen.hidden = false;
  el.userNickname.textContent = `${state.currentUser.nickname}님`;

  el.seriesList.innerHTML = `<li class="loading">불러오는 중...</li>`;
  try {
    state.seriesList = await fetchSeriesList();
    state.collected = await fetchCollectedIds(state.currentUser.uid);
  } catch (err) {
    console.error(err);
    el.seriesList.innerHTML = `<li class="loading">불러오기 실패: ${err.message}</li>`;
    return;
  }

  renderSeriesMenu();

  if (state.currentSeriesId) {
    renderSeriesContent();
  } else {
    el.emptyState.hidden = false;
    el.seriesContent.hidden = true;
  }
}

/* ---------- 시리즈 메뉴 (우측) ---------- */
function renderSeriesMenu() {
  el.seriesList.innerHTML = "";

  if (state.seriesList.length === 0) {
    el.seriesList.innerHTML = `<li class="loading">아직 등록된 카드 시리즈가 없어요.</li>`;
    return;
  }

  state.seriesList.forEach((series) => {
    const cards = state.cardsBySeriesId[series.id];
    const total = cards ? cards.length : series.cardCount ?? null;
    const done = cards ? cards.filter((c) => state.collected.has(c.id)).length : null;

    const li = document.createElement("li");
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className =
      "series-item" + (series.id === state.currentSeriesId ? " active" : "");
    const progressLabel = total !== null && done !== null ? `${done}/${total}` : "";
    btn.innerHTML = `<span>${series.name}</span><span class="mini-progress">${progressLabel}</span>`;
    btn.addEventListener("click", () => selectSeries(series.id));

    li.appendChild(btn);
    el.seriesList.appendChild(li);
  });
}

async function selectSeries(seriesId) {
  state.currentSeriesId = seriesId;
  state.filter = "all";
  [...el.filterBar.children].forEach((b) =>
    b.classList.toggle("active", b.dataset.filter === "all")
  );
  renderSeriesMenu();
  await renderSeriesContent();
}

/* ---------- 카드 목록 (좌측) ---------- */
async function renderSeriesContent() {
  const series = state.seriesList.find((s) => s.id === state.currentSeriesId);
  if (!series) return;

  el.emptyState.hidden = true;
  el.seriesContent.hidden = false;
  el.seriesTitle.textContent = series.name;

  if (!state.cardsBySeriesId[series.id]) {
    el.cardGrid.innerHTML = `<p class="loading">카드 불러오는 중...</p>`;
    try {
      state.cardsBySeriesId[series.id] = await fetchCardsForSeries(series.id);
    } catch (err) {
      console.error(err);
      el.cardGrid.innerHTML = `<p class="loading">카드를 불러오지 못했어요: ${err.message}<br/>(브라우저 콘솔(F12)에 Firestore 색인 생성 링크가 떴다면 그 링크를 눌러 색인을 만든 뒤 새로고침해보세요)</p>`;
      return;
    }
    renderSeriesMenu(); // 메뉴의 진행률(n/총) 갱신
  }

  const cards = state.cardsBySeriesId[series.id];
  const total = cards.length;
  const done = cards.filter((c) => state.collected.has(c.id)).length;
  const pct = total === 0 ? 0 : Math.round((done / total) * 100);

  el.progressText.textContent = `${done} / ${total} (${pct}%)`;
  el.progressFill.style.width = `${pct}%`;

  const visibleCards = cards.filter((c) => {
    const isCollected = state.collected.has(c.id);
    if (state.filter === "collected") return isCollected;
    if (state.filter === "missing") return !isCollected;
    return true;
  });

  el.cardGrid.innerHTML = "";
  visibleCards.forEach((card) => {
    const isCollected = state.collected.has(card.id);
    const item = document.createElement("div");
    item.className =
      "card-item" +
      (isCollected ? " collected" : "") +
      (card.tier ? ` tier-${card.tier}` : "");
    const subLabel = [card.role || card.team || card.category || "", card.tierLabel]
      .filter(Boolean)
      .join(" · ");
    item.innerHTML = `
      <div class="thumb-wrap">
        <img src="${card.image}" alt="${card.name}" loading="lazy" />
        <div class="badge">✓</div>
        ${card.signed ? `<div class="signed-badge" title="친필 사인 카드">✒️</div>` : ""}
      </div>
      <div class="name">${card.name}</div>
      ${subLabel ? `<div class="sub">${subLabel}</div>` : ""}
    `;
    item.addEventListener("click", () => toggleCard(card));
    el.cardGrid.appendChild(item);
  });
}

async function toggleCard(card) {
  const wasCollected = state.collected.has(card.id);
  const nowCollected = !wasCollected;

  // 낙관적으로 화면부터 갱신
  if (nowCollected) state.collected.add(card.id);
  else state.collected.delete(card.id);
  renderSeriesMenu();
  renderSeriesContent();

  try {
    await setCardCollected(state.currentUser.uid, card.id, nowCollected);
  } catch (err) {
    // 실패하면 되돌리기
    if (nowCollected) state.collected.delete(card.id);
    else state.collected.add(card.id);
    renderSeriesMenu();
    renderSeriesContent();
    alert("저장에 실패했어요: " + err.message);
  }
}

/* ---------- 필터 버튼 ---------- */
el.filterBar.addEventListener("click", (e) => {
  const btn = e.target.closest(".filter-btn");
  if (!btn) return;
  state.filter = btn.dataset.filter;
  [...el.filterBar.children].forEach((b) => b.classList.toggle("active", b === btn));
  renderSeriesContent();
});

/* ---------- 로그인 / 회원가입 탭 ---------- */
el.tabLogin.addEventListener("click", () => {
  el.tabLogin.classList.add("active");
  el.tabSignup.classList.remove("active");
  el.loginForm.hidden = false;
  el.signupForm.hidden = true;
});

el.tabSignup.addEventListener("click", () => {
  el.tabSignup.classList.add("active");
  el.tabLogin.classList.remove("active");
  el.signupForm.hidden = false;
  el.loginForm.hidden = true;
});

/* ---------- 인증 이벤트 ---------- */
el.loginForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  el.loginError.textContent = "";
  const email = document.getElementById("login-email").value.trim();
  const password = document.getElementById("login-password").value;
  const submitBtn = el.loginForm.querySelector("button[type=submit]");
  submitBtn.disabled = true;
  try {
    await signInWithEmailAndPassword(auth, email, password);
    el.loginForm.reset();
  } catch (err) {
    el.loginError.textContent = authErrorMessage(err);
  } finally {
    submitBtn.disabled = false;
  }
});

el.signupForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  el.signupError.textContent = "";
  const nickname = document.getElementById("signup-nickname").value.trim();
  const email = document.getElementById("signup-email").value.trim();
  const password = document.getElementById("signup-password").value;
  const submitBtn = el.signupForm.querySelector("button[type=submit]");
  submitBtn.disabled = true;
  try {
    const cred = await createUserWithEmailAndPassword(auth, email, password);
    await updateProfile(cred.user, { displayName: nickname });
    el.signupForm.reset();
  } catch (err) {
    el.signupError.textContent = authErrorMessage(err);
  } finally {
    submitBtn.disabled = false;
  }
});

el.logoutBtn.addEventListener("click", () => {
  signOut(auth);
  el.tabLogin.click(); // 로그인 탭으로 초기화
});

function authErrorMessage(err) {
  const map = {
    "auth/email-already-in-use": "이미 가입된 이메일이에요.",
    "auth/invalid-email": "이메일 형식이 올바르지 않아요.",
    "auth/weak-password": "비밀번호는 6자 이상이어야 해요.",
    "auth/invalid-credential": "이메일 또는 비밀번호가 올바르지 않아요.",
    "auth/user-not-found": "가입되지 않은 이메일이에요.",
    "auth/wrong-password": "비밀번호가 올바르지 않아요.",
  };
  return map[err.code] || err.message;
}

/* ---------- 시작: 로그인 상태 감지 ---------- */
onAuthStateChanged(auth, async (user) => {
  if (user) {
    state.currentUser = {
      uid: user.uid,
      email: user.email,
      nickname: user.displayName || user.email,
    };
    state.currentSeriesId = null;
    upsertUserProfile(user.uid, user.email, state.currentUser.nickname).catch((err) =>
      console.error("프로필 저장 실패:", err)
    );
    await showAppScreen();
  } else {
    state.currentUser = null;
    state.cardsBySeriesId = {};
    state.collected = new Set();
    showAuthScreen();
  }
});
