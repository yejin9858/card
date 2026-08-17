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
  limit,
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
  teamFilter: "all", // all | 팀 이름
  categoryFilter: "all", // all | 카테고리 이름
  filterOptionsSeriesId: null, // 팀/카테고리 드롭다운을 채운 시리즈 id (시리즈 바뀌면 다시 채움)
  topCollectorBySeriesId: {}, // 캐시: { [seriesId]: { nickname, count } | null }
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

// "이 시리즈 누가 제일 많이 모았나" 랭킹용 - seriesProgress/{seriesId}/members/{uid}
// 에 본인의 (닉네임, 수집 개수)만 저장해둠. 다른 사람의 users/{uid}/collected를
// 직접 들여다볼 필요 없이 집계값만 공개해서 보여주는 방식.
async function syncSeriesProgress(seriesId, uid, nickname, count) {
  await setDoc(
    doc(db, "seriesProgress", seriesId, "members", uid),
    { nickname, count, updatedAt: serverTimestamp() },
    { merge: true }
  );
}

async function fetchTopCollector(seriesId) {
  const snap = await getDocs(
    query(
      collection(db, "seriesProgress", seriesId, "members"),
      orderBy("count", "desc"),
      limit(1)
    )
  );
  if (snap.empty) return null;
  const top = snap.docs[0].data();
  if (!top.count) return null; // 아직 아무도 수집을 안 했으면 표시 안 함
  return { nickname: top.nickname, count: top.count };
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
  topCollector: document.getElementById("top-collector"),
  statusFilter: document.getElementById("status-filter"),
  teamFilter: document.getElementById("team-filter"),
  categoryFilter: document.getElementById("category-filter"),
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
  state.teamFilter = "all";
  state.categoryFilter = "all";
  el.statusFilter.value = "all";
  renderSeriesMenu();
  await renderSeriesContent();
}

// 현재 시리즈에 실제로 등장하는 팀/카테고리 목록으로 드롭다운을 채움
// (하드코딩 목록이 아니라 방금 불러온 카드 데이터(DB 값)에서 뽑아냄.
//  시리즈마다 구성이 다르므로 시리즈가 바뀔 때만 다시 채움)
function populateFilterOptions(cards) {
  const teams = [...new Set(cards.map((c) => c.team).filter(Boolean))].sort((a, b) =>
    a.localeCompare(b, "ko")
  );
  el.teamFilter.innerHTML =
    `<option value="all">전체 팀</option>` +
    teams.map((t) => `<option value="${t}">${t}</option>`).join("");
  el.teamFilter.value = state.teamFilter;

  const categories = [...new Set(cards.map((c) => c.category).filter(Boolean))].sort((a, b) =>
    a.localeCompare(b, "ko")
  );
  el.categoryFilter.innerHTML =
    `<option value="all">전체 카테고리</option>` +
    categories.map((c) => `<option value="${c}">${c}</option>`).join("");
  el.categoryFilter.value = state.categoryFilter;
}

// 현재 선택된 시리즈의 "최다 수집 회원" 캐시를 화면에 반영
function renderTopCollector() {
  const top = state.topCollectorBySeriesId[state.currentSeriesId];
  el.topCollector.textContent = top ? `🏆 최다 수집: ${top.nickname}님 (${top.count}장)` : "";
}

/* ---------- 카드 목록 (좌측) ----------
   시리즈를 빠르게 여러 번 바꿔 눌렀을 때, 먼저 시작한 느린 요청이 나중에
   도착해서 지금 선택된 시리즈 화면을 덮어쓰지 않도록 요청 순번을 확인함 */
let renderSeq = 0;
async function renderSeriesContent() {
  const seq = ++renderSeq;
  const series = state.seriesList.find((s) => s.id === state.currentSeriesId);
  if (!series) return;

  el.emptyState.hidden = true;
  el.seriesContent.hidden = false;
  el.seriesTitle.textContent = series.name;

  if (!state.cardsBySeriesId[series.id]) {
    el.cardGrid.innerHTML = `<p class="loading">카드 불러오는 중...</p>`;
    let fetched;
    try {
      fetched = await fetchCardsForSeries(series.id);
    } catch (err) {
      console.error(err);
      if (seq !== renderSeq) return; // 그 사이 다른 시리즈가 선택됨
      el.cardGrid.innerHTML = `<p class="loading">카드를 불러오지 못했어요: ${err.message}<br/>(브라우저 콘솔(F12)에 Firestore 색인 생성 링크가 떴다면 그 링크를 눌러 색인을 만든 뒤 새로고침해보세요)</p>`;
      return;
    }
    state.cardsBySeriesId[series.id] = fetched;
    if (seq !== renderSeq) return; // 그 사이 다른 시리즈가 선택됐으면 화면은 갱신하지 않음(데이터는 캐시됨)
    renderSeriesMenu(); // 메뉴의 진행률(n/총) 갱신

    // 시리즈를 처음 열어볼 때, 내 수집 개수를 랭킹용 seriesProgress에 동기화하고
    // 최다 수집 회원을 조회함 (필터와 무관하게 시리즈 전체 기준)
    const fullDone = fetched.filter((c) => state.collected.has(c.id)).length;
    syncSeriesProgress(series.id, state.currentUser.uid, state.currentUser.nickname, fullDone).catch(
      (err) => console.error("진행률 동기화 실패:", err)
    );
    fetchTopCollector(series.id)
      .then((top) => {
        state.topCollectorBySeriesId[series.id] = top;
        if (series.id === state.currentSeriesId) renderTopCollector();
      })
      .catch((err) => console.error("최다 수집자 조회 실패:", err));
  }

  const cards = state.cardsBySeriesId[series.id];

  if (state.filterOptionsSeriesId !== series.id) {
    state.filterOptionsSeriesId = series.id;
    populateFilterOptions(cards);
  }

  renderTopCollector();

  // 진행률(progress bar)은 팀/카테고리 필터가 선택되어 있으면 그 범위 카드 기준으로,
  // 아니면 시리즈 전체 카드 기준으로 계산함 (수집함/미수집 필터는 진행률과 무관)
  const scopedCards = cards.filter((c) => {
    if (state.teamFilter !== "all" && c.team !== state.teamFilter) return false;
    if (state.categoryFilter !== "all" && c.category !== state.categoryFilter) return false;
    return true;
  });
  const total = scopedCards.length;
  const done = scopedCards.filter((c) => state.collected.has(c.id)).length;
  const pct = total === 0 ? 0 : Math.round((done / total) * 100);

  const scopeLabel = [
    state.teamFilter !== "all" ? state.teamFilter : null,
    state.categoryFilter !== "all" ? state.categoryFilter : null,
  ]
    .filter(Boolean)
    .join(" · ");
  el.progressText.textContent = scopeLabel
    ? `${scopeLabel} · ${done} / ${total} (${pct}%)`
    : `${done} / ${total} (${pct}%)`;
  el.progressFill.style.width = `${pct}%`;

  const visibleCards = scopedCards.filter((c) => {
    const isCollected = state.collected.has(c.id);
    if (state.filter === "collected" && !isCollected) return false;
    if (state.filter === "missing" && isCollected) return false;
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
    // 팀(또는 역할) / 카테고리 / 등급을 한 줄로 합치면 잘려서, 각각 줄바꿈해서 보여줌
    const subLines = [card.role || card.team || null, card.category, card.tierLabel].filter(
      Boolean
    );
    item.innerHTML = `
      <div class="thumb-wrap">
        <img src="${card.image}" alt="${card.name}" loading="lazy" />
        <div class="badge">✓</div>
        ${card.signed ? `<div class="signed-badge" title="친필 사인 카드">✒️</div>` : ""}
      </div>
      <div class="name">${card.name}</div>
      ${subLines.map((line) => `<div class="sub">${line}</div>`).join("")}
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

    // 이 카드가 속한 시리즈의 랭킹(seriesProgress)도 최신 수집 개수로 갱신
    const seriesId = card.seriesId;
    const seriesCards = state.cardsBySeriesId[seriesId] || [];
    const doneCount = seriesCards.filter((c) => state.collected.has(c.id)).length;
    syncSeriesProgress(seriesId, state.currentUser.uid, state.currentUser.nickname, doneCount).catch(
      (err) => console.error("진행률 동기화 실패:", err)
    );
    fetchTopCollector(seriesId)
      .then((top) => {
        state.topCollectorBySeriesId[seriesId] = top;
        if (seriesId === state.currentSeriesId) renderTopCollector();
      })
      .catch((err) => console.error("최다 수집자 조회 실패:", err));
  } catch (err) {
    // 실패하면 되돌리기
    if (nowCollected) state.collected.delete(card.id);
    else state.collected.add(card.id);
    renderSeriesMenu();
    renderSeriesContent();
    alert("저장에 실패했어요: " + err.message);
  }
}

/* ---------- 필터 드롭다운 ---------- */
el.statusFilter.addEventListener("change", () => {
  state.filter = el.statusFilter.value;
  renderSeriesContent();
});

el.teamFilter.addEventListener("change", () => {
  state.teamFilter = el.teamFilter.value;
  renderSeriesContent();
});

el.categoryFilter.addEventListener("change", () => {
  state.categoryFilter = el.categoryFilter.value;
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
    // onAuthStateChanged가 updateProfile 이전 시점(닉네임 반영 전)에 이미 한 번
    // 실행됐을 수 있어서, 화면에 보이는 닉네임을 여기서 직접 최신화해줌
    // (안 그러면 회원가입 직후에는 닉네임 대신 이메일이 잠깐 노출됨)
    if (state.currentUser && state.currentUser.uid === cred.user.uid) {
      state.currentUser.nickname = nickname;
      el.userNickname.textContent = `${nickname}님`;
      upsertUserProfile(cred.user.uid, cred.user.email, nickname).catch((err) =>
        console.error("프로필 저장 실패:", err)
      );
    }
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
