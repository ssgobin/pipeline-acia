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

  // keep compact KPIs; send secondary counts to ticker
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
    .slice(0, 8);

  if (!ranked.length) {
    $("slaList").innerHTML = `<div class="item"><div class="item-left"><div class="item-title">Sem alertas no momento</div></div></div>`;
    return;
  }

  $("slaList").innerHTML = ranked.map(lead => {
    const name = lead.nome || lead.company || "Lead sem nome";
    const company = lead.company || "Sem empresa";
    const sla = lead._sla;

    let label = `${sla.days}d`;
    if (sla.totalBreach) label += " • >10d total";

    return `
      <div class="item">
        <div class="item-left">
          <div class="item-title">${escapeHtml(name)}</div>
          <div class="item-sub">${escapeHtml(company)} • ${escapeHtml(lead.status || "PENDENTE")}</div>
        </div>
        <div class="badge-pill ${badgeClassBySla(sla)}">${escapeHtml(label)}</div>
      </div>
    `;
  }).join("");
}

function renderOwners(list) {
  const map = new Map();

  for (const lead of list) {
    const owner = (lead.responsavel || "Sem responsável").trim();
    if (!map.has(owner)) {
      map.set(owner, { total: 0, hot: 0, approved: 0 });
    }
    const row = map.get(owner);
    row.total++;

    const st = canon(lead.status);
    if (["AVANCADO", "EM NEGOCIACAO", "FECHAMENTO", "APROVADO"].includes(st)) row.hot++;
    if (st === "APROVADO") row.approved++;
  }

  const owners = [...map.entries()]
    .map(([name, data]) => ({ name, ...data }))
    .sort((a, b) => b.total - a.total || b.hot - a.hot)
    .slice(0, 8);

  if (!owners.length) {
    $("ownersList").innerHTML = `<div class="item"><div class="item-left"><div class="item-title">Nenhum lead cadastrado</div></div></div>`;
    return;
  }

  $("ownersList").innerHTML = owners.map((o, idx) => `
    <div class="item">
      <div class="item-left">
        <div class="item-title">#${idx + 1} ${escapeHtml(o.name)}</div>
        <div class="item-sub">Quentes: ${o.hot} • Aprovados: ${o.approved}</div>
      </div>
      <div class="badge-pill badge-purple">${o.total} leads</div>
    </div>
  `).join("");
}

function renderLatest(list) {
  const latest = [...list]
    .sort((a, b) => new Date(b.updatedAtDate || b.createdAtDate || 0) - new Date(a.updatedAtDate || a.createdAtDate || 0))
    .slice(0, 6);

  if (!latest.length) {
    $("latestLeads").innerHTML = `<div class="item"><div class="item-left"><div class="item-title">Sem dados ainda</div></div></div>`;
    return;
  }

  $("latestLeads").innerHTML = latest.map(lead => {
    const title = lead.company || lead.nome || "Lead sem nome";
    const subtitle = [lead.nome, lead.responsavel, lead.segmento].filter(Boolean).join(" • ");
    const status = lead.status || "PENDENTE";

    return `
      <div class="item">
        <div class="item-left">
          <div class="item-title">${escapeHtml(title)}</div>
          <div class="item-sub">${escapeHtml(subtitle || "Sem detalhes")}</div>
        </div>
        <div class="badge-pill badge-blue">${escapeHtml(status)}</div>
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
    `Total: ${total} leads • Aprovados: ${approved} • Pendentes: ${pending} • Em negociação/fechamento: ${inNegotiation} • Alertas críticos SLA: ${redCount}`;
}

function renderAll() {
  const kpiSummary = renderKPIs(LEADS);
  renderFunnel(LEADS);
  renderSLA(LEADS);
  renderOwners(LEADS);
  renderLatest(LEADS);
  renderTicker(LEADS, kpiSummary);
  startFunnelAutoScroll();
}

// ========= Rotator =========
const ROTATOR = [
  { title: "Atenção SLA", icon: "bi-exclamation-triangle", panel: "sla" },
  { title: "Top responsáveis", icon: "bi-trophy", panel: "owners" },
  { title: "Últimos leads", icon: "bi-building", panel: "latest" },
];

let rotatorIndex = 0;
let rotatorTimer = null;

function setRotator(index) {
  rotatorIndex = (index + ROTATOR.length) % ROTATOR.length;
  const meta = ROTATOR[rotatorIndex];
  const title = $("rotatorTitle");
  if (title) {
    title.innerHTML = `<i class="bi ${meta.icon}"></i> ${meta.title}`;
  }

  document.querySelectorAll(".rotator-panel").forEach(panel => {
    panel.classList.toggle("active", panel.dataset.panel === meta.panel);
  });

  document.querySelectorAll(".rotator-dots .dot").forEach(dot => {
    dot.classList.toggle("active", Number(dot.dataset.rotator) === rotatorIndex);
  });
}

function startRotator() {
  const dots = document.querySelectorAll(".rotator-dots .dot");
  dots.forEach(dot => {
    dot.addEventListener("click", () => {
      setRotator(Number(dot.dataset.rotator));
      if (rotatorTimer) {
        clearInterval(rotatorTimer);
        rotatorTimer = setInterval(() => setRotator(rotatorIndex + 1), 8000);
      }
    });
  });

  setRotator(0);
  rotatorTimer = setInterval(() => setRotator(rotatorIndex + 1), 8000);
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
startRotator();
startFunnelAutoScroll();