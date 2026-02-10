import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.4/firebase-app.js";
import {
  getFirestore,
  collection,
  addDoc,
  updateDoc,
  deleteDoc,
  doc,
  serverTimestamp,
  onSnapshot,
  query,
  orderBy
} from "https://www.gstatic.com/firebasejs/10.12.4/firebase-firestore.js";

import { firebaseConfig } from "./firebase-config.js";

// ---------- Options (from spreadsheet) ----------
const OPTIONS = {
  segmento: ["INDUSTRIA", "COMERCIO", "PRESTADOR SERVICO"],
  porte: ["POTENTE", "GRANDE", "MEDIO", "BAIXO"],
  tempoAssociacao: ["MENOS DE 1 ANO", "ENTRE 1 E 3 ANOS", "ENTRE 3 E 5 ANOS", "ENTRE 5 E 7 ANOS", "ACIMA DE 7 ANOS", "NAO ASSOCIADO"],
  historicoPatrocinio: ["NUNCA", "ALGUMAS VEZES", "RECORRENTE", "EVENTO ANTERIOR", "OUTRO EVENTO"],
  historico: ["ASSOCIADO", "ACIA NETWORKING", "BENEFICIOS"],
  evento: ["TODOS", "65 ANOS", "JANTAR EMPRESARIO", "EXPOEMPRESAS", "65 ANOS + JANTAR", "JANTAR + EXPO", "65 ANOS + EXPO"],
  responsavel: ["BRUNA", "GERSON", "JULIAO", "JAMES", "ADOLPHO", "LEONARDO", "MONICA", "THAIS"],
  cota: ["NAMING RIGHTS", "DIAMANTE", "SAFIRA", "OURO", "EXPOSITORA", "CONVIDADA"],
};

// Status (exibicao) + regra 1-1-1 (STATUS -> FEEDBACK -> PRÓXIMA AÇÃO)
// Observação: a chave do mapa é CANÔNICA (sem acentos), mas o valor exibido mantém acentos.
const STATUSES = [
  "PENDENTE",
  "AVANÇADO",
  "EM NEGOCIAÇÃO",
  "FECHAMENTO",
  "APROVADO",
  "STAND BY",
  "PERDIDO",
];

const STATUS_MAP = {
  "PENDENTE": { feedback: "1º CONTATO + PITCH", proxima: "ENVIAR PROPOSTA" },
  "AVANCADO": { feedback: "CLIENTE INTERESSADO", proxima: "NEGOCIAR/FECHAR" },
  "EM NEGOCIACAO": { feedback: "NEGOCIANDO PROPOSTA", proxima: "ENVIAR CONTRATO" },
  "FECHAMENTO": { feedback: "CONTRATO ENVIADO", proxima: "NEGÓCIO FECHADO" },
  "APROVADO": { feedback: "PAGAMENTO/CONTRATO", proxima: "CONFIRMAR PAGTO." },
  "STAND BY": { feedback: "SEM INTERESSE", proxima: "NOVO CONTATO 15 DIAS" },
  "PERDIDO": { feedback: "NÃO APROVADO", proxima: "NEGÓCIO PERDIDO" },
};

function canonStatus(v) {
  return String(v || "")
    .trim()
    .toUpperCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "");
}

// ---------- DOM helpers ----------
const $ = (id) => document.getElementById(id);

function fillSelect(selectEl, values, includeBlank = true) {
  selectEl.innerHTML = "";
  if (includeBlank) {
    const op = document.createElement("option");
    op.value = "";
    op.textContent = "-";
    selectEl.appendChild(op);
  }
  for (const v of values) {
    const op = document.createElement("option");
    op.value = v;
    op.textContent = v;
    selectEl.appendChild(op);
  }
}

function toast(message, type = "info") {
  const host = $("alertHost");
  const div = document.createElement("div");
  div.className = `alert alert-${type} alert-dismissible fade show`; // uses bootstrap colors
  div.innerHTML = `${escapeHtml(message)}<button type="button" class="btn-close" data-bs-dismiss="alert" aria-label="Close"></button>`;
  host.appendChild(div);
  setTimeout(() => {
    try { div.classList.remove("show"); div.remove(); } catch {}
  }, 4000);
}

function escapeHtml(str) {
  return String(str ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function toDateInputValue(date) {
  if (!date) return "";
  const d = new Date(date);
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function diffDays(a, b) {
  const ms = Math.abs(a.getTime() - b.getTime());
  return Math.floor(ms / (1000 * 60 * 60 * 24));
}

function leadTimeDays(lead) {
  const base = lead.ultimoContato ? new Date(lead.ultimoContato) : (lead.createdAtDate ? new Date(lead.createdAtDate) : null);
  if (!base) return 0;
  return diffDays(new Date(), base);
}

function applyStatusToFields(status, feedbackEl, proximaEl) {
  const key = canonStatus(status);
  const map = STATUS_MAP[key] || STATUS_MAP["PENDENTE"];
  feedbackEl.value = map.feedback;
  proximaEl.value = map.proxima;
  return map;
}

// ---------- Firebase ----------
function assertConfig() {
  const bad = !firebaseConfig || Object.values(firebaseConfig).some(v => !v || String(v).includes("PASTE_HERE"));
  if (bad) {
    toast("Cole seu firebaseConfig em js/firebase-config.js (firebase console).", "warning");
    throw new Error("Missing firebaseConfig");
  }
}

assertConfig();
const app = initializeApp(firebaseConfig);
const db = getFirestore(app);
const leadsCol = collection(db, "leads");

// ---------- State ----------
let LEADS = [];
let unsubscribe = null;

// ---------- Init selects ----------
fillSelect($("segmento"), OPTIONS.segmento);
fillSelect($("porte"), OPTIONS.porte);
fillSelect($("tempoAssociacao"), OPTIONS.tempoAssociacao);
fillSelect($("historicoPatrocinio"), OPTIONS.historicoPatrocinio);
fillSelect($("historico"), OPTIONS.historico);
fillSelect($("evento"), OPTIONS.evento);
fillSelect($("responsavel"), OPTIONS.responsavel);
fillSelect($("cotaIdeal"), OPTIONS.cota);
fillSelect($("cotaOpcao2"), OPTIONS.cota);
fillSelect($("cotaOpcao3"), OPTIONS.cota);
fillSelect($("status"), STATUSES, false);

fillSelect($("filterStatus"), STATUSES, true);
fillSelect($("filterResp"), OPTIONS.responsavel, true);
fillSelect($("filterSeg"), OPTIONS.segmento, true);

applyStatusToFields($("status").value || "PENDENTE", $("feedback"), $("proximaAcao"));

$("status").addEventListener("change", () => {
  applyStatusToFields($("status").value, $("feedback"), $("proximaAcao"));
});

// ---------- Modal ----------
const modal = new bootstrap.Modal($("leadModal"));

function resetForm() {
  $("leadId").value = "";
  $("firstName").value = "";
  $("lastName").value = "";
  $("company").value = "";
  $("segmento").value = "";
  $("porte").value = "";
  $("tempoAssociacao").value = "";
  $("historicoPatrocinio").value = "";
  $("historico").value = "";
  $("evento").value = "";
  $("cotaIdeal").value = "";
  $("cotaOpcao2").value = "";
  $("cotaOpcao3").value = "";
  $("responsavel").value = "";
  $("status").value = "PENDENTE";
  applyStatusToFields($("status").value, $("feedback"), $("proximaAcao"));
  $("ultimoContato").value = "";
  $("contato").value = "";
  $("observacoes").value = "";
  $("btnDeleteLead").classList.add("d-none");
  $("leadModalTitle").textContent = "Novo lead";
}

function openNew() {
  resetForm();
  modal.show();
}

function openEdit(lead) {
  resetForm();
  $("leadId").value = lead.id;
  $("firstName").value = lead.firstName || "";
  $("lastName").value = lead.lastName || "";
  $("company").value = lead.company || "";
  $("segmento").value = lead.segmento || "";
  $("porte").value = lead.porte || "";
  $("tempoAssociacao").value = lead.tempoAssociacao || "";
  $("historicoPatrocinio").value = lead.historicoPatrocinio || "";
  $("historico").value = lead.historico || "";
  $("evento").value = lead.evento || "";
  $("cotaIdeal").value = lead.cotaIdeal || "";
  $("cotaOpcao2").value = lead.cotaOpcao2 || "";
  $("cotaOpcao3").value = lead.cotaOpcao3 || "";
  $("responsavel").value = lead.responsavel || "";
  $("status").value = (lead.status || "PENDENTE").toUpperCase();
  applyStatusToFields($("status").value, $("feedback"), $("proximaAcao"));
  $("ultimoContato").value = toDateInputValue(lead.ultimoContato);
  $("contato").value = lead.contato || "";
  $("observacoes").value = lead.observacoes || "";
  $("btnDeleteLead").classList.remove("d-none");
  $("leadModalTitle").textContent = "Editar lead";
  modal.show();
}

// ---------- CRUD ----------
function buildPayload() {
  const status = $("status").value || "PENDENTE"; // mantém acentos (exibicao)
  const statusKey = canonStatus(status); // canônico (sem acentos)
  const map = STATUS_MAP[statusKey] || STATUS_MAP.PENDENTE;

  const primeiro = ($("firstName").value || "").trim();
  const sobrenome = ($("lastName").value || "").trim();
  const nome = `${primeiro} ${sobrenome}`.trim();

  const ultimoContato = $("ultimoContato").value ? new Date($("ultimoContato").value + "T00:00:00") : null;

  return {
    firstName: primeiro,
    lastName: sobrenome,
    nome,
    company: ($("company").value || "").trim(),
    segmento: $("segmento").value || "",
    porte: $("porte").value || "",
    tempoAssociacao: $("tempoAssociacao").value || "",
    historicoPatrocinio: $("historicoPatrocinio").value || "",
    historico: $("historico").value || "",
    evento: $("evento").value || "",
    cotaIdeal: $("cotaIdeal").value || "",
    cotaOpcao2: $("cotaOpcao2").value || "",
    cotaOpcao3: $("cotaOpcao3").value || "",
    responsavel: $("responsavel").value || "",
    status,
    statusKey,
    feedback: map.feedback,
    proximaAcao: map.proxima,
    ultimoContato: ultimoContato ? ultimoContato.toISOString() : "",
    contato: ($("contato").value || "").trim(),
    observacoes: ($("observacoes").value || "").trim(),
  };
}

async function saveLead() {
  const id = $("leadId").value;
  const payload = buildPayload();

  // light validation
  if (!payload.company && !payload.nome) {
    toast("Preencha nome ou empresa.", "warning");
    return;
  }

  try {
    if (!id) {
      const docRef = await addDoc(leadsCol, {
        ...payload,
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
        // for lead time fallback without querying timestamps
        createdAtDate: new Date().toISOString(),
      });
      toast(`Lead criado (${docRef.id.slice(0,6)}...)`, "success");
    } else {
      await updateDoc(doc(db, "leads", id), {
        ...payload,
        updatedAt: serverTimestamp(),
      });
      toast("Lead atualizado", "success");
    }
    modal.hide();
  } catch (e) {
    console.error(e);
    toast(`Erro ao salvar: ${e.message}`, "danger");
  }
}

async function removeLead(id) {
  if (!id) return;
  if (!confirm("Deletar este lead?")) return;
  try {
    await deleteDoc(doc(db, "leads", id));
    toast("Lead deletado", "success");
    modal.hide();
  } catch (e) {
    console.error(e);
    toast(`Erro ao deletar: ${e.message}`, "danger");
  }
}

async function setLeadStatus(id, newStatus) {
  const status = newStatus || "PENDENTE"; // exibicao
  const statusKey = canonStatus(status);
  const map = STATUS_MAP[statusKey] || STATUS_MAP.PENDENTE;
  try {
    await updateDoc(doc(db, "leads", id), {
      status,
      statusKey,
      feedback: map.feedback,
      proximaAcao: map.proxima,
      updatedAt: serverTimestamp(),
    });
  } catch (e) {
    console.error(e);
    toast(`Erro ao alterar status: ${e.message}`, "danger");
  }
}

// ---------- Rendering ----------
function normalized(str) {
  return canonStatus(str);
}

function getFilteredLeads() {
  const qText = normalized($("q").value).trim();
  const fStatus = normalized($("filterStatus").value).trim();
  const fResp = normalized($("filterResp").value).trim();
  const fSeg = normalized($("filterSeg").value).trim();

  return LEADS.filter(l => {
    if (fStatus && normalized(l.status) !== fStatus) return false;
    if (fResp && normalized(l.responsavel) !== fResp) return false;
    if (fSeg && normalized(l.segmento) !== fSeg) return false;
    if (!qText) return true;

    const hay = normalized(`${l.nome} ${l.company} ${l.responsavel} ${l.evento} ${l.segmento}`);
    return hay.includes(qText);
  });
}

function renderKPIs(list) {
  const total = list.length;
  const hot = list.filter(l => ["AVANCADO","EM NEGOCIACAO","FECHAMENTO","APROVADO"].includes(normalized(l.status))).length;
  const lost = list.filter(l => normalized(l.status) === "PERDIDO").length;
  const today = list.filter(l => {
    const iso = l.updatedAtDate || l.createdAtDate || "";
    if (!iso) return false;
    const d = new Date(iso);
    const now = new Date();
    return d.toDateString() === now.toDateString();
  }).length;

  $("kpiTotal").textContent = String(total);
  $("kpiHot").textContent = String(hot);
  $("kpiLost").textContent = String(lost);
  $("kpiToday").textContent = String(today);
}

function statusBadge(status) {
  const key = normalized(status) || "PENDENTE";
  const label = STATUSES.find(x => normalized(x) === key) || "PENDENTE";
  let icon = "bi-dot";
  if (key === "APROVADO") icon = "bi-check2-circle";
  if (key === "PERDIDO") icon = "bi-x-circle";
  if (key === "EM NEGOCIACAO") icon = "bi-chat-left-dots";
  if (key === "FECHAMENTO") icon = "bi-file-earmark-text";
  if (key === "AVANCADO") icon = "bi-rocket-takeoff";
  if (key === "STAND BY") icon = "bi-pause-circle";

  return `<span class="badge badge-soft"><i class="bi ${icon}"></i> ${escapeHtml(label)}</span>`;
}

function renderTable(list) {
  const tbody = $("tableBody");
  tbody.innerHTML = "";

  for (const lead of list) {
    const tr = document.createElement("tr");
    const name = escapeHtml(lead.nome || "-");
    const company = escapeHtml(lead.company || "-");
    const resp = escapeHtml(lead.responsavel || "-");
    const feedback = escapeHtml(lead.feedback || "-");
    const prox = escapeHtml(lead.proximaAcao || "-");
    const ultimo = lead.ultimoContato ? toDateInputValue(lead.ultimoContato) : "-";

    const statusSelect = `
      <select class="form-select form-select-sm bg-transparent text-light border-0" data-action="status" data-id="${lead.id}">
        ${STATUSES.map(s => `<option value="${escapeHtml(s)}" ${normalized(lead.status) === normalized(s) ? "selected" : ""}>${escapeHtml(s)}</option>`).join("")}
      </select>
    `;

    tr.innerHTML = `
      <td><div class="cell-main">${name}</div></td>
      <td><div class="cell-sub">${company}</div></td>
      <td><span class="cell-chip"><i class="bi bi-person"></i> ${resp}</span></td>
      <td>${statusSelect}</td>
      <td><div class="cell-wrap">${feedback}</div></td>
      <td><div class="cell-wrap">${prox}</div></td>
      <td>${escapeHtml(ultimo)}</td>
      <td class="text-end">
        <button class="btn btn-sm btn-outline-light" data-action="edit" data-id="${lead.id}" title="Editar"><i class="bi bi-pencil"></i></button>
        <button class="btn btn-sm btn-outline-danger" data-action="delete" data-id="${lead.id}" title="Deletar"><i class="bi bi-trash"></i></button>
      </td>
    `;

    tr.addEventListener("dblclick", () => openEdit(lead));

    tbody.appendChild(tr);
  }

  // delegate events
  tbody.querySelectorAll("[data-action='edit']").forEach(btn => {
    btn.addEventListener("click", () => {
      const id = btn.dataset.id;
      const lead = LEADS.find(x => x.id === id);
      if (lead) openEdit(lead);
    });
  });
  tbody.querySelectorAll("[data-action='delete']").forEach(btn => {
    btn.addEventListener("click", () => removeLead(btn.dataset.id));
  });
  tbody.querySelectorAll("[data-action='status']").forEach(sel => {
    sel.addEventListener("change", () => setLeadStatus(sel.dataset.id, sel.value));
  });
}

function render() {
  const list = getFilteredLeads();
  renderKPIs(list);
  renderTable(list);
}

// ---------- Firestore realtime ----------
function startListener() {
  if (unsubscribe) unsubscribe();

  const qy = query(leadsCol, orderBy("updatedAt", "desc"));
  unsubscribe = onSnapshot(qy, (snap) => {
    LEADS = snap.docs.map(d => {
      const data = d.data() || {};

      // keep ISO fallback dates for kpi today
      const createdAtISO = data.createdAt?.toDate ? data.createdAt.toDate().toISOString() : (data.createdAtDate || "");
      const updatedAtISO = data.updatedAt?.toDate ? data.updatedAt.toDate().toISOString() : (data.updatedAtDate || data.createdAtDate || "");

      // enforce 1-1-1 on read too
      const key = canonStatus(data.statusKey || data.status || "PENDENTE");
      const map = STATUS_MAP[key] || STATUS_MAP.PENDENTE;
      const status = STATUSES.find(s => canonStatus(s) === key) || "PENDENTE";

      return {
        id: d.id,
        ...data,
        status,
        statusKey: key,
        feedback: map.feedback,
        proximaAcao: map.proxima,
        createdAtDate: createdAtISO,
        updatedAtDate: updatedAtISO,
      };
    });

    render();
  }, (err) => {
    console.error(err);
    toast(`Firestore: ${err.message}`, "danger");
  });
}

startListener();

// ---------- UI events ----------

$("btnNewLead").addEventListener("click", openNew);
$("btnSaveLead").addEventListener("click", saveLead);
$("btnDeleteLead").addEventListener("click", () => removeLead($("leadId").value));

$("btnRefresh").addEventListener("click", () => {
  startListener();
  toast("Recarregado", "info");
});

$("q").addEventListener("input", render);
$("filterStatus").addEventListener("change", render);
$("filterResp").addEventListener("change", render);
$("filterSeg").addEventListener("change", render);
$("btnClearFilters").addEventListener("click", () => {
  $("filterStatus").value = "";
  $("filterResp").value = "";
  $("filterSeg").value = "";
  $("q").value = "";
  render();
});

$("btnSeedDemo").addEventListener("click", async () => {
  const demo = [
    { firstName: "Joao", lastName: "Vitor", company: "ACIA", segmento: "COMERCIO", porte: "MEDIO", tempoAssociacao: "ENTRE 1 E 3 ANOS", historicoPatrocinio: "ALGUMAS VEZES", historico: "ASSOCIADO", evento: "65 ANOS", cotaIdeal: "OURO", cotaOpcao2: "SAFIRA", cotaOpcao3: "EXPOSITORA", responsavel: "BRUNA", status: "PENDENTE" },
    { firstName: "Mirelli", lastName: "Basso", company: "ExpoCo", segmento: "INDUSTRIA", porte: "GRANDE", tempoAssociacao: "ACIMA DE 7 ANOS", historicoPatrocinio: "RECORRENTE", historico: "BENEFICIOS", evento: "JANTAR + EXPO", cotaIdeal: "DIAMANTE", cotaOpcao2: "OURO", cotaOpcao3: "SAFIRA", responsavel: "LEONARDO", status: "AVANÇADO" },
    { firstName: "Ana", lastName: "Lima", company: "ServPro", segmento: "PRESTADOR SERVICO", porte: "BAIXO", tempoAssociacao: "MENOS DE 1 ANO", historicoPatrocinio: "NUNCA", historico: "ACIA NETWORKING", evento: "TODOS", cotaIdeal: "CONVIDADA", cotaOpcao2: "EXPOSITORA", cotaOpcao3: "OURO", responsavel: "JAMES", status: "STAND BY" },
  ];

  try {
    for (const d of demo) {
      const status = d.status;
      const map = STATUS_MAP[canonStatus(status)] || STATUS_MAP.PENDENTE;
      const nome = `${d.firstName} ${d.lastName}`.trim();
      await addDoc(leadsCol, {
        ...d,
        nome,
        feedback: map.feedback,
        proximaAcao: map.proxima,
        ultimoContato: "",
        contato: "",
        observacoes: "",
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
        createdAtDate: new Date().toISOString(),
      });
    }
    toast("Demo criada", "success");
  } catch (e) {
    console.error(e);
    toast(`Erro ao criar demo: ${e.message}`, "danger");
  }
});

