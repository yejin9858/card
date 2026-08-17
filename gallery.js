/* =========================================================
   카드 갤러리 (미리보기 전용, 로그인 불필요)

   series/cards 컬렉션은 누구나 읽기 가능하도록 되어 있어서
   로그인 없이 바로 모든 카드 이미지를 훑어볼 수 있어요.
   수집 체크 기능은 없고 순수 보기 전용입니다.
   ========================================================= */

import { initializeApp } from "https://www.gstatic.com/firebasejs/12.17.1/firebase-app.js";
import {
  getFirestore,
  collection,
  getDocs,
  query,
  orderBy,
  where,
} from "https://www.gstatic.com/firebasejs/12.17.1/firebase-firestore.js";
import { firebaseConfig } from "./firebase-config.js";

const app = initializeApp(firebaseConfig);
const db = getFirestore(app);

const el = {
  select: document.getElementById("series-select"),
  countLabel: document.getElementById("count-label"),
  grid: document.getElementById("card-grid"),
};

async function loadSeriesList() {
  const snap = await getDocs(query(collection(db, "series"), orderBy("order")));
  return snap.docs.map((d) => ({ id: d.id, ...d.data() }));
}

async function loadCards(seriesId) {
  const q = query(collection(db, "cards"), where("seriesId", "==", seriesId), orderBy("order"));
  const snap = await getDocs(q);
  return snap.docs.map((d) => ({ id: d.id, ...d.data() }));
}

function renderCards(cards) {
  el.countLabel.textContent = `${cards.length}장`;
  el.grid.innerHTML = "";
  cards.forEach((card) => {
    // 팀(또는 역할) / 카테고리 / 등급을 한 줄로 합치면 잘려서, 각각 줄바꿈해서 보여줌
    const subLines = [card.role || card.team || null, card.category, card.tierLabel].filter(
      Boolean
    );
    const item = document.createElement("div");
    item.className = "card-item show-num" + (card.tier ? ` tier-${card.tier}` : "");
    item.innerHTML = `
      <div class="thumb-wrap">
        <img src="${card.image}" alt="${card.name}" loading="lazy" />
        ${card.baseNumber ? `<div class="base-num">#${card.baseNumber}</div>` : ""}
        ${card.signed ? `<div class="signed-badge" title="친필 사인 카드">✒️</div>` : ""}
      </div>
      <div class="name">${card.name}</div>
      ${subLines.map((line) => `<div class="sub">${line}</div>`).join("")}
    `;
    el.grid.appendChild(item);
  });
}

async function main() {
  let seriesList;
  try {
    seriesList = await loadSeriesList();
  } catch (err) {
    el.select.innerHTML = `<option>불러오기 실패: ${err.message}</option>`;
    return;
  }

  if (seriesList.length === 0) {
    el.select.innerHTML = `<option>등록된 시리즈가 없어요</option>`;
    return;
  }

  el.select.innerHTML = seriesList
    .map((s) => `<option value="${s.id}">${s.name}</option>`)
    .join("");

  // 드롭다운을 빠르게 여러 번 바꿨을 때, 먼저 시작한 느린 요청이 나중에
  // 도착해서 최신 선택 결과를 덮어쓰지 않도록 요청 순번을 확인함
  let requestSeq = 0;
  async function loadSelected() {
    const seq = ++requestSeq;
    const seriesId = el.select.value;
    el.grid.innerHTML = `<p class="loading">불러오는 중...</p>`;
    try {
      const cards = await loadCards(seriesId);
      if (seq !== requestSeq) return; // 이 사이 더 최신 요청이 시작됐으면 무시
      renderCards(cards);
    } catch (err) {
      if (seq !== requestSeq) return;
      el.grid.innerHTML = `<p class="loading">불러오기 실패: ${err.message}</p>`;
    }
  }

  el.select.addEventListener("change", loadSelected);
  loadSelected();
}

main();
