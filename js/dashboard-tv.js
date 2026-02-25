import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.4/firebase-app.js";
import {
  getFirestore,
  collection,
  onSnapshot,
  query,
  orderBy
} from "https://www.gstatic.com/firebasejs/10.12.4/firebase-firestore.js";

import { firebaseConfig } from "./firebase-config.js";

// ========= Config / helpers =========
const STATUSES = [
  "PENDENTE",
  "AVANÇADO",
  "EM NEGOCIAÇÃO",
  "FECHAMENTO",
  "APROVADO",
  "STAND BY",
  "PERDIDO",
];

const COLORS = {
  PENDENTE: "#f59e0b",
  AVANCADO: "#3b82f6",
  "EM NEGOCIACAO": "#8b5cf6",
  FECHAMENTO: "#ec4899",
  APROVADO: "#22c55e",
  "STAND BY": "#6366f1",
  PERDIDO: "#ef4444",
};

const SLA_RULES = {
  "PENDENTE": { green: 1, yellow: 2 },
  "AVANCADO": { green: 2, yellow: 3 },
  "EM NEGOCIACAO": { green: 2, yellow: 3 },
  "FECHAMENTO": { green: 2, yellow: 3 },
  "APROVADO": { green: 1, yellow: 2 },
  "STAND BY": { green: 15, yellow: 15 },
};

const TOTAL_MAX_DAYS = 10;
const $ = (id) => document.getElementById(id);

function canon(v) {
  return String(v || "")
    .trim()
    .toUpperCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "");
}

function escapeHtml(str) {
  return String(str ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function diffDays(a, b) {
  const ms = Math.abs(a.getTime() - b.getTime());
  return Math.floor(ms / (1000 * 60 * 60 * 24));
}

function leadTimeDays(lead) {
  const base = lead.ultimoContato
    ? new Date(lead.ultimoContato)
    : (lead.createdAtDate ? new Date(lead.createdAtDate) : null);
  if (!base) return 0;
  return diffDays(new Date(), base);
}

function classifySLA(lead) {
  const key = canon(lead.status || "PENDENTE");
  if (key === "PERDIDO") return null;

  const days = leadTimeDays(lead);
  const rule = SLA_RULES[key] || SLA_RULES["PENDENTE"];

  let color = "green";
  if (key === "STAND BY") {
    color = days >= rule.green ? "yellow" : "green";
  } else {
    if (days > rule.yellow) color = "red";
    else if (days > rule.green) color = "yellow";
  }

  const cISO = lead.createdAtDate || "";
  const totalDays = cISO ? diffDays(new Date(), new Date(cISO)) : 0;
  const totalBreach = totalDays > TOTAL_MAX_DAYS && !["APROVADO", "PERDIDO"].includes(key);

  return { color, days, totalDays, totalBreach };
}

function formatDateTimeClock() {
  const now = new Date();
  const time = now.toLocaleTimeString("pt-BR");
  const date = now.toLocaleDateString("pt-BR", {
    weekday: "short",
    day: "2-digit",
    month: "2-digit",
    year: "numeric"
  });
  $("clockTime").textContent = time;
  $("clockDate").textContent = date;
}

function badgeClassBySla(sla) {
  if (!sla) return "badge-blue";
  if (sla.totalBreach || sla.color === "red") return "badge-red";
  if (sla.color === "yellow") return "badge-yellow";
  return "badge-green";
}

// ========= Firebase =========
const app = initializeApp(firebaseConfig);
const db = getFirestore(app);
const leadsCol = collection(db, "leads");

let LEADS = [];
let OWNERS = [];
let currentOwnerIndex = 0;
let ownerChartInstance = null;
let ownerRotationTimer = null;

// ========= Render =========
function renderKPIs(list) {
  const total = list.length;
  const hot = list.filter(l => ["AVANCADO", "EM NEGOCIACAO", "FECHAMENTO", "APROVADO"].includes(canon(l.status))).length;
  const lost = list.filter(l => canon(l.status) === "PERDIDO").length;
  const approved = list.filter(l => canon(l.status) === "APROVADO").length;
  const pending = list.filter(l => canon(l.status) === "PENDENTE").length;

  const today = list.filter(l => {
    const iso = l.updatedAtDate || l.createdAtDate || "";
    if (!iso) return false;
    return new Date(iso).toDateString() === new Date().toDateString();
  }).length;

  $("kpiTotal").textContent = String(total);
  $("kpiHot").textContent = String(hot);
  $("kpiLost").textContent = String(lost);
  $("kpiToday").textContent = String(today);

  return { approved, pending };
}

function renderFunnel(list) {
  const counts = {};
  for (const s of STATUSES) counts[canon(s)] = 0;

  for (const lead of list) {
    const k = canon(lead.status || "PENDENTE");
    counts[k] = (counts[k] || 0) + 1;
  }

  const max = Math.max(1, ...Object.values(counts));

  $("funnelRows").innerHTML = STATUSES.map(status => {
    const key = canon(status);
    const count = counts[key] || 0;
    const pct = Math.max(4, Math.round((count / max) * 100));

    return `
      <div class="funnel-row">
        <div class="funnel-top">
          <div class="funnel-label">${escapeHtml(status)}</div>
          <div class="funnel-count">${count}</div>
        </div>
        <div class="bar-track">
          <div class="bar-fill" style="width:${pct}%"></div>
        </div>
      </div>
    `;
  }).join("");
}

function getOwnersList(list) {
  const map = new Map();

  for (const lead of list) {
    const owner = (lead.responsavel || "Sem responsável").trim();
    if (!map.has(owner)) {
      map.set(owner, { total: 0, hot: 0, approved: 0, pendente: 0, leads: [] });
    }
    const row = map.get(owner);
    row.total++;
    row.leads.push(lead);

    const st = canon(lead.status);
    if (["AVANCADO", "EM NEGOCIACAO", "FECHAMENTO", "APROVADO"].includes(st)) row.hot++;
    if (st === "APROVADO") row.approved++;
    if (st === "PENDENTE") row.pendente++;
  }

  return [...map.entries()]
    .map(([name, data]) => ({ name, ...data }))
    .sort((a, b) => b.total - a.total || b.hot - a.hot);
}

function updateOwnersList() {
  OWNERS = getOwnersList(LEADS);
  if (OWNERS.length === 0) {
    OWNERS = [{ name: "Sem dados", total: 0, hot: 0, approved: 0, pendente: 0, leads: [] }];
  }
  if (currentOwnerIndex >= OWNERS.length) {
    currentOwnerIndex = 0;
  }
}

function renderOwnerChart() {
  if (OWNERS.length === 0) return;

  const owner = OWNERS[currentOwnerIndex];
  const ownerTitle = $("ownerChartTitle");
  const ownerCounter = $("ownerCounter");
  const ownerStats = $("ownerStats");
  const ownerChartWrap = $("ownerChart").parentElement;

  // Fade out
  ownerChartWrap.classList.add("fade-out");

  setTimeout(() => {
    ownerTitle.innerHTML = `<i class="bi bi-person-check"></i> ${escapeHtml(owner.name)}`;
    ownerCounter.textContent = `${currentOwnerIndex + 1}/${OWNERS.length}`;

    // Contar leads por status do responsável atual
    const statusCounts = {};
    for (const s of STATUSES) statusCounts[canon(s)] = 0;

    for (const lead of owner.leads) {
      const k = canon(lead.status || "PENDENTE");
      statusCounts[k] = (statusCounts[k] || 0) + 1;
    }

    // Preparar dados para o gráfico
    const chartLabels = STATUSES;
    const chartData = STATUSES.map(s => statusCounts[canon(s)]);
    const chartColors = STATUSES.map(s => COLORS[canon(s)]);

    // Destruir gráfico anterior se existir
    if (ownerChartInstance) {
      ownerChartInstance.destroy();
    }

    // Criar novo gráfico
    const ctx = $("ownerChart").getContext("2d");
    ownerChartInstance = new Chart(ctx, {
      type: "bar",
      data: {
        labels: chartLabels,
        datasets: [{
          label: "Leads por Status",
          data: chartData,
          backgroundColor: chartColors,
          borderColor: "rgba(255,255,255,.1)",
          borderWidth: 2,
          borderRadius: 8,
        }]
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: {
          legend: {
            display: false
          },
          tooltip: {
            backgroundColor: "rgba(0,0,0,.8)",
            titleColor: "rgba(234,240,255,1)",
            bodyColor: "rgba(234,240,255,.9)",
            borderColor: "rgba(255,255,255,.2)",
            borderWidth: 1,
            callbacks: {
              label: function(context) {
                return context.raw + " leads";
              }
            }
          }
        },
        scales: {
          y: {
            beginAtZero: true,
            grid: {
              color: "rgba(255,255,255,.06)",
              drawBorder: false
            },
            ticks: {
              color: "rgba(234,240,255,.65)",
              font: { size: 11 }
            }
          },
          x: {
            grid: {
              drawBorder: false,
              display: false
            },
            ticks: {
              color: "rgba(234,240,255,.85)",
              font: { size: 12, weight: "500" }
            }
          }
        }
      }
    });

    // Renderizar estatísticas
    ownerStats.innerHTML = `
      <div class="owner-stat-item">
        <div class="owner-stat-label">Leads</div>
        <div class="owner-stat-value">${owner.total}</div>
      </div>
      <div class="owner-stat-item">
        <div class="owner-stat-label">Quentes</div>
        <div class="owner-stat-value">${owner.hot}</div>
      </div>
      <div class="owner-stat-item">
        <div class="owner-stat-label">Aprovados</div>
        <div class="owner-stat-value">${owner.approved}</div>
      </div>
      <div class="owner-stat-item">
        <div class="owner-stat-label">Pendentes</div>
        <div class="owner-stat-value">${owner.pendente}</div>
      </div>
    `;

    // Fade in
    ownerChartWrap.classList.remove("fade-out");
    ownerChartWrap.classList.add("fade-in");

    setTimeout(() => {
      ownerChartWrap.classList.remove("fade-in");
    }, 400);
  }, 400);
}

function renderSLA(list) {
  const ranked = [...list]
    .map(l => ({ ...l, _sla: classifySLA(l) }))
    .filter(l => l._sla)
    .sort((a, b) => {
      const sev = (x) => x._sla.totalBreach ? 3 : x._sla.color === "red" ? 2 : x._sla.color === "yellow" ? 1 : 0;
      const d = sev(b) - sev(a);
      if (d) return d;
      return (b._sla.days || 0) - (a._sla.days || 0);
    })
    .slice(0, 10);

  if (!ranked.length) {
    $("slaList").innerHTML = `<div class="item"><div class="item-left"><div class="item-title">Sem alertas no momento</div></div></div>`;
    return;
  }

  $("slaList").innerHTML = ranked.map(lead => {
    const name = lead.nome || lead.company || "Lead sem nome";
    const company = lead.company || "Sem empresa";
    const sla = lead._sla;

    let label = `${sla.days}d`;
    if (sla.totalBreach) label += " • >10d";

    return `
      <div class="item">
        <div class="item-left">
          <div class="item-title">${escapeHtml(name)}</div>
          <div class="item-sub">${escapeHtml(company)} • ${escapeHtml(lead.responsavel || "?")} • ${escapeHtml(lead.status || "PENDENTE")}</div>
        </div>
        <div class="badge-pill ${badgeClassBySla(sla)}">${escapeHtml(label)}</div>
      </div>
    `;
  }).join("");
}

function renderTicker(list, summary = {}) {
  const total = list.length;
  const approved = list.filter(l => canon(l.status) === "APROVADO").length;
  const inNegotiation = list.filter(l => ["EM NEGOCIACAO", "FECHAMENTO"].includes(canon(l.status))).length;
  const redCount = list.filter(l => {
    const sla = classifySLA(l);
    return sla && (sla.totalBreach || sla.color === "red");
  }).length;
  const pending = list.filter(l => canon(l.status) === "PENDENTE").length;

  $("ticker").textContent =
    `Total: ${total} • Aprovados: ${approved} • Pendentes: ${pending} • Em negociação: ${inNegotiation} • Alertas SLA: ${redCount}`;
}

function renderAll() {
  renderKPIs(LEADS);
  renderFunnel(LEADS);
  updateOwnersList();
  renderOwnerChart();
  renderSLA(LEADS);
  renderTicker(LEADS);
  startFunnelAutoScroll();
}

// ========= Owner rotation =========
function nextOwner() {
  currentOwnerIndex = (currentOwnerIndex + 1) % OWNERS.length;
  renderOwnerChart();
  resetOwnerRotationTimer();
}

function prevOwner() {
  currentOwnerIndex = (currentOwnerIndex - 1 + OWNERS.length) % OWNERS.length;
  renderOwnerChart();
  resetOwnerRotationTimer();
}

function startOwnerRotation() {
  resetOwnerRotationTimer();
}

function resetOwnerRotationTimer() {
  if (ownerRotationTimer) {
    clearInterval(ownerRotationTimer);
  }
  ownerRotationTimer = setInterval(nextOwner, 8000);
}

// ========= Funnel auto-scroll =========
let funnelScrollTimer = null;
let funnelScrollDir = 1;

function startFunnelAutoScroll() {
  const el = document.getElementById("funnelRows");
  if (!el) return;

  if (funnelScrollTimer) {
    clearInterval(funnelScrollTimer);
    funnelScrollTimer = null;
  }

  funnelScrollTimer = setInterval(() => {
    const max = el.scrollHeight - el.clientHeight;
    if (max <= 0) return;

    const next = el.scrollTop + (0.6 * funnelScrollDir);
    if (next >= max) {
      funnelScrollDir = -1;
    } else if (next <= 0) {
      funnelScrollDir = 1;
    }
    el.scrollTop = Math.max(0, Math.min(max, next));
  }, 30);
}

// ========= Event listeners =========
function attachEventListeners() {
  const prevBtn = $("prevOwner");
  const nextBtn = $("nextOwner");

  if (prevBtn) prevBtn.addEventListener("click", prevOwner);
  if (nextBtn) nextBtn.addEventListener("click", nextOwner);
}

// ========= Realtime listener =========
function start() {
  const qy = query(leadsCol, orderBy("updatedAt", "desc"));

  onSnapshot(qy, (snap) => {
    LEADS = snap.docs.map(d => {
      const data = d.data() || {};

      const createdAtISO = data.createdAt?.toDate
        ? data.createdAt.toDate().toISOString()
        : (data.createdAtDate || "");

      const updatedAtISO = data.updatedAt?.toDate
        ? data.updatedAt.toDate().toISOString()
        : (data.updatedAtDate || data.createdAtDate || "");

      return {
        id: d.id,
        ...data,
        createdAtDate: createdAtISO,
        updatedAtDate: updatedAtISO,
      };
    });

    renderAll();
  }, (err) => {
    console.error(err);
    $("ticker").textContent = `Erro no Firestore: ${err.message}`;
  });
}

// ========= boot =========
formatDateTimeClock();
setInterval(formatDateTimeClock, 1000);
start();
attachEventListeners();
setTimeout(() => {
  startOwnerRotation();
}, 100);