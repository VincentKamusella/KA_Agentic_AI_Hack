"use strict";
const $ = (id) => document.getElementById(id);
let suppliers = [],
  discoveryIssues = [],
  coverage = null,
  discoveryJobId = null,
  coverageRenderKey = "",
  evaluation = null,
  busy = false,
  criterionCounter = 0;
const labels = {
  eligible: "Eligible",
  ineligible: "Not eligible",
  needs_verification: "Needs verification",
  pass: "Pass",
  fail: "Fail",
  unknown: "Unknown",
};
function el(tag, text, className) {
  const node = document.createElement(tag);
  if (text !== undefined) node.textContent = text;
  const defaults = {
    input: "form-control",
    select: "form-select",
    textarea: "form-control",
    label: "form-label",
    table: "table align-middle",
  };
  node.className = className || defaults[tag] || "";
  if (["input", "select", "textarea"].includes(tag))
    node.setAttribute("form", "requirements");
  return node;
}
function badge(value) {
  const tone =
    {
      pass: "success",
      eligible: "success",
      fail: "danger",
      ineligible: "danger",
      unknown: "warning",
      needs_verification: "warning",
    }[value] || "secondary";
  return el(
    "span",
    labels[value] || value,
    `badge bg-${tone}-subtle text-${tone}-emphasis`,
  );
}
function notice(text) {
  $("notice").textContent = text;
}
function error(text = "") {
  $("error").textContent = text;
  $("error").hidden = !text;
}
function step(name) {
  for (const [i, key] of ["discover", "eval", "shortlist"].entries()) {
    const node = $(`stage-${key}`);
    node.removeAttribute("aria-current");
    node.classList.toggle(
      "complete",
      i < ["discover", "eval", "shortlist"].indexOf(name),
    );
    if (key === name) node.setAttribute("aria-current", "step");
  }
}
function setWorkspaceState(name) {
  const states = {
    ready: [
      "Start with your purchase brief",
      "Describe the product, quantity, and destination. Add the requirements suppliers must meet, then find your shortlist.",
    ],
    searching: [
      "Finding supplier evidence",
      "We are finding suppliers, collecting source evidence, and checking your requirements. Your shortlist will appear when research finishes.",
    ],
    candidates: [
      "Saved supplier evidence",
      "Run research to assess these saved candidates against your current requirements.",
    ],
    evaluating: [
      "Checking your requirements",
      "Each supplier’s evidence is being assessed against your criteria. Mandatory checks determine eligibility before preferences determine rank.",
    ],
    evaluated: [
      "Your evaluation is ready",
      "Open the shortlist to compare eligibility and ranking. Source evidence explains each assessment.",
    ],
    empty: [
      "No usable supplier evidence",
      "The search completed, but no usable supplier citations were collected. Add a specification or more precise product description, then try again.",
    ],
    discoveryError: [
      "Discovery could not finish",
      "Check the error above. Your brief and criteria are preserved; retry when the issue is resolved.",
    ],
    evaluationError: [
      "Evaluation could not finish",
      "Your candidates and sources are preserved. Check the error above, then retry evaluation.",
    ],
  };
  $("state-title").textContent = states[name][0];
  $("state-description").textContent = states[name][1];
  $("retry").hidden = !["empty", "discoveryError"].includes(name);
  $("view-shortlist-action").hidden = name !== "evaluated";
  $("workspace-state").dataset.state = name;
}
let loadingTimer;
function setBusy(value, message = "") {
  busy = value;
  clearInterval(loadingTimer);
  $("loading").hidden = !value;
  $("loading-message").textContent = "Request in progress";
  $("loading-time").textContent = "";
  $("discover").textContent =
    value && !suppliers.length ? "Searching…" : "Find my shortlist →";
  $("evaluate").textContent =
    value && suppliers.length
      ? "Evaluating…"
      : evaluation
        ? "Update shortlist"
        : "Update shortlist";
  if (value) {
    $("workspace-state").scrollIntoView({
      block: "nearest",
      behavior: "instant",
    });
    const started = Date.now();
    loadingTimer = setInterval(() => {
      $("loading-time").textContent =
        `${Math.floor((Date.now() - started) / 1000)}s elapsed`;
    }, 1000);
  }

  document
    .querySelectorAll("button,input,select,textarea")
    .forEach((n) => (n.disabled = value));
  $("add").disabled = value || $("criteria").children.length >= 12;
  if (message) notice(message);
  $("content").setAttribute("aria-busy", String(value));
}
function readRequirements() {
  return {
    product: $("product").value.trim(),
    quantity: Number($("quantity").value),
    delivery_country: $("country").value.trim(),
    criteria: [...$("criteria").children].map((row) => ({
      id: row.dataset.id,
      description: row.querySelector("textarea").value.trim(),
      kind: row.querySelector("select").value,
      weight: Number(row.querySelector("input").value),
    })),
  };
}
function updateTotals() {
  document.querySelector(".research-totals").hidden = !suppliers.length;
  $("total-suppliers").textContent = suppliers.length;
  $("total-evidence").textContent = suppliers.reduce(
    (n, s) => n + s.evidence.length,
    0,
  );
  $("total-shortlist").textContent =
    evaluation?.recommended_supplier_ids.length || 0;
}
function invalidate(discovery = false) {
  if (discovery) rememberJob(null);
  evaluation = null;
  $("recommendation").hidden = true;
  $("comparison").replaceChildren();
  if (discovery) {
    suppliers = [];
    discoveryIssues = [];
    coverage = null;
    discoveryJobId = null;
    $("coverage").hidden = true;
    $("sources").replaceChildren();
    $("candidates").replaceChildren();
    $("content").hidden = true;

    step("discover");
    setWorkspaceState("ready");
    notice("Brief changed. Discover suppliers to refresh the evidence.");
  } else if (suppliers.length) {
    step("eval");
    render();
    notice(
      "Criteria changed. Choose Update shortlist to assess the saved evidence.",
    );
  }
  updateTotals();
  updateViewStates();
  error();
}
function addCriterion(
  c = {
    id: `custom-${++criterionCounter}`,
    description: "",
    kind: "mandatory",
    weight: 1,
  },
) {
  const row = el("div", undefined, "criterion");
  row.dataset.id = c.id;
  const label = el("label", "Requirement");
  const inputId = `criterion-${++criterionCounter}`;
  label.htmlFor = inputId;
  const description = el("textarea");
  description.id = inputId;
  description.value = c.description;
  description.required = true;
  description.maxLength = 1000;
  description.rows = 2;
  const controls = el("div", undefined, "criterion-controls");
  const kind = el("select");
  kind.setAttribute("aria-label", "Criterion type");
  for (const [value, text] of [
    ["mandatory", "Mandatory"],
    ["preference", "Preference"],
  ]) {
    const o = el("option", text);
    o.value = value;
    kind.append(o);
  }
  kind.value = c.kind;
  const weightField = el("div", undefined, "weight-field"),
    weightLabel = el("label", "Weight"),
    weight = el("input");
  weight.type = "number";
  weight.min = "0.1";
  weight.max = "100";
  weight.step = "0.1";
  weight.required = true;
  weight.value = c.weight;
  weight.id = `weight-${criterionCounter}`;
  weightLabel.htmlFor = weight.id;
  weightField.append(weightLabel, weight);
  weightField.hidden = c.kind !== "preference";
  kind.addEventListener("change", () => {
    weightField.hidden = kind.value !== "preference";
    invalidate();
  });
  const remove = el("button", "Remove", "btn btn-link btn-sm remove");
  remove.type = "button";
  remove.addEventListener("click", () => {
    row.remove();
    $("add").disabled = false;
    invalidate();
  });
  description.addEventListener("input", () => invalidate());
  weight.addEventListener("input", () => invalidate());
  controls.append(kind, weightField, remove);
  row.append(label, description, controls);
  $("criteria").append(row);
  $("add").disabled = $("criteria").children.length >= 12;
}
async function post() {
  const csrf = document.cookie
    .split("; ")
    .find((x) => x.startsWith("csrftoken="))
    ?.split("=")[1];
  const controller = new AbortController(),
    timer = setTimeout(() => controller.abort(), 240000);
  try {
    const response = await fetch("/api/research/", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-CSRFToken": csrf || "",
      },
      body: JSON.stringify({
        requirements: readRequirements(),
        options: readOptions(),
        discovery_job_id: discoveryJobId,
      }),
      signal: controller.signal,
    });
    const data = await response.json().catch(() => ({
      error: "The server returned an unreadable response. Retry the request.",
    }));
    if (!response.ok)
      throw new Error(data.error || "Request failed. Please retry.");
    return data;
  } finally {
    clearTimeout(timer);
  }
}
let disclosureCounter = 0;
function accordion(title, className) {
  const id = `disclosure-${++disclosureCounter}`;
  const root = el("div", undefined, `accordion accordion-flush ${className}`),
    item = el("div", undefined, "accordion-item");
  const heading = el("h3", undefined, "accordion-header"),
    button = el("button", title, "accordion-button collapsed");
  button.type = "button";
  button.dataset.bsToggle = "collapse";
  button.dataset.bsTarget = `#${id}`;
  button.setAttribute("aria-expanded", "false");
  button.setAttribute("aria-controls", id);
  button.id = `${id}-button`;
  const collapse = el("div", undefined, "accordion-collapse collapse");
  collapse.id = id;
  collapse.setAttribute("aria-labelledby", button.id);
  const body = el("div", undefined, "accordion-body");
  heading.append(button);
  collapse.append(body);
  item.append(heading, collapse);
  root.append(item);
  return { root, body };
}
function renderEvidence(evidence, parent) {
  const box = el("div", undefined, "evidence");
  box.append(el("p", evidence.excerpt));
  const a = el("a", evidence.source_url);
  a.href = evidence.source_url;
  a.target = "_blank";
  a.rel = "noopener noreferrer";
  box.append(
    a,
    el(
      "small",
      `${evidence.kind === "search_summary" ? "Legacy search summary" : evidence.kind === "pdf" ? "PDF source passage" : "Source passage"} · retrieved ${new Date(evidence.fetched_at).toLocaleString()}`,
    ),
  );
  parent.append(box);
}
function render() {
  updateTotals();
  updateViewStates();
  renderCandidates();
  setWorkspaceState(
    evaluation ? "evaluated" : suppliers.length ? "candidates" : "empty",
  );

  $("content").hidden = false;
  $("count").textContent =
    `${suppliers.length} candidate supplier${suppliers.length === 1 ? "" : "s"} · ${suppliers.reduce((n, s) => n + s.evidence.length, 0)} source excerpts`;
  $("evaluate").hidden = !suppliers.length;
  $("evaluate").textContent = evaluation
    ? "Update shortlist"
    : "Update shortlist";
  $("sources").replaceChildren();
  $("comparison").replaceChildren();
  $("recommendation").hidden = !evaluation;
  const assessments = new Map(
    (evaluation?.assessments || []).map((a) => [a.supplier_id, a]),
  );
  const criteria = new Map(readRequirements().criteria.map((c) => [c.id, c]));
  if (evaluation) {
    const chosen = evaluation.recommended_supplier_ids
      .map((id) => suppliers.find((s) => s.supplier_id === id))
      .filter(Boolean);
    $("recommendation").replaceChildren(
      el(
        "h3",
        chosen.length
          ? `Shortlist: ${chosen.map((s) => s.name).join(", ")}`
          : "No supplier is ready for the shortlist.",
      ),
    );
    $("recommendation").append(
      el(
        "p",
        ![...criteria.values()].some((c) => c.kind === "mandatory")
          ? "No mandatory gates are configured. This shortlist reflects preference scores only; it does not establish purchase compliance."
          : chosen.length
            ? "These candidates meet the assessed mandatory criteria and lead on weighted preference attainment. Verify original sources and obtain quotations before making a purchasing decision."
            : "Review failed and unknown criteria below. Clarify missing evidence, or change a requirement and evaluate again.",
      ),
    );
    const wrap = el("div", undefined, "table-responsive"),
      table = el("table"),
      head = el("thead"),
      hr = el("tr");
    for (const text of [
      "Supplier",
      "Mandatory status",
      "Preferences",
      "Evidence coverage",
    ])
      hr.append(el("th", text));
    head.append(hr);
    table.append(head);
    const body = el("tbody");
    for (const s of suppliers) {
      const a = assessments.get(s.supplier_id),
        row = el("tr"),
        name = el("td");
      name.append(el("strong", s.name));
      if (chosen.includes(s)) name.append(el("small", "Shortlisted"));
      row.append(name);
      const status = el("td");
      status.append(a ? badge(a.eligibility) : badge("Not evaluated"));
      row.append(
        status,
        el("td", a ? `${Math.round(a.preference_score)} / 100` : "—"),
        el("td", a ? `${Math.round(a.evidence_coverage * 100)}%` : "—"),
      );
      body.append(row);
    }
    table.append(body);
    wrap.append(table);
    $("comparison").append(wrap);
  }
  $("sources").append(
    el("h3", "Evidence & assessment details", "source-title"),
  );
  for (const s of suppliers) {
    const panel = accordion(s.name, "supplier"),
      details = panel.body;
    if (s.discovered_by?.length) {
      details.append(
        el(
          "p",
          `Found by ${s.discovered_by.length} search passes. ${s.legal_id ? `Site-reported VAT ID: ${s.legal_id}. ` : ""}Identity still requires human verification.`,
          "help",
        ),
      );
    }
    const a = assessments.get(s.supplier_id);
    if (a) {
      for (const c of a.criteria) {
        const block = el("div", undefined, "assessment"),
          heading = el("div", undefined, "assessment-heading");
        heading.append(
          badge(c.result),
          el(
            "span",
            criteria.get(c.criterion_id)?.description || c.criterion_id,
          ),
        );
        block.append(heading, el("p", c.explanation));
        for (const id of c.evidence_ids) {
          const evidence = s.evidence.find((e) => e.id === id);
          if (evidence) renderEvidence(evidence, block);
        }
        details.append(block);
      }
      const missing = a.criteria.filter((c) => c.result === "unknown");
      if (missing.length) {
        const draftPanel = accordion("Draft clarification questions", "draft"),
          draft = draftPanel.body;
        const text = el("textarea");
        text.readOnly = true;
        text.setAttribute("aria-label", `Clarification draft for ${s.name}`);
        text.value = `Hello ${s.name},\n\nWe are sourcing ${readRequirements().quantity} units of ${readRequirements().product} for delivery to ${readRequirements().delivery_country}. Please confirm:\n\n${missing.map((c) => `• ${criteria.get(c.criterion_id)?.description || c.criterion_id}`).join("\n")}\n\nPlease include supporting documentation and current commercial terms.\n\nThank you.`;
        draft.append(
          text,
          el(
            "p",
            "Review and copy this draft. QuotePilot does not send messages.",
            "help",
          ),
        );
        details.append(draftPanel.root);
      }
    }
    const sourcePanel = accordion(
      `All ${s.evidence.length} source excerpts`,
      "all-sources",
    );
    for (const e of s.evidence) renderEvidence(e, sourcePanel.body);
    details.append(sourcePanel.root);
    $("sources").append(panel.root);
  }
  for (const issue of [...discoveryIssues, ...(evaluation?.issues || [])])
    $("sources").append(el("p", issue.message, "alert alert-warning issue"));
}
$("requirements").addEventListener("submit", async (event) => {
  event.preventDefault();
  if (busy) return;
  if (!$("criteria").children.length) {
    error("Add at least one decision criterion.");
    return;
  }
  error();
  invalidate(true);
  setWorkspaceState("searching");
  setBusy(true, "Searching supplier sources with Gemini…");
  notice("Searching supplier sources with Gemini…");
  try {
    const job = await post();
    discoveryJobId = job.job_id;
    rememberJob(job.job_id);
    const result = await pollResearch(job.job_id);
    suppliers = result.suppliers;
    evaluation = result.assessments ? result : null;
    discoveryIssues = result.issues;
    coverage = result.coverage;
    renderCoverage();
    render();
    step(evaluation ? "shortlist" : "discover");
    notice(
      suppliers.length
        ? "Research complete. Your shortlist and supporting evidence are ready."
        : discoveryIssues.find((issue) => issue.retryable)?.message ||
            "No supplier evidence found. Refine the brief and retry.",
    );
  } catch (e) {
    error(
      e.name === "AbortError"
        ? "Discovery timed out. Please retry."
        : e.message,
    );
    setWorkspaceState("discoveryError");
    notice("Discovery did not complete.");
  } finally {
    setBusy(false);
  }
});
$("evaluate").addEventListener("click", async () => {
  if (busy || !$("requirements").reportValidity()) return;
  error();
  setWorkspaceState("evaluating");
  setBusy(true, "Evaluating evidence against your criteria…");
  try {
    const job = await post();
    rememberJob(job.job_id);
    evaluation = await pollResearch(job.job_id);
    suppliers = evaluation.suppliers;
    coverage = evaluation.coverage;
    discoveryJobId = job.job_id;
    renderCoverage();
    render();
    step("shortlist");
    if (currentView() === "discovery") location.hash = "/shortlist";
    notice(
      "Evaluation complete. Open each supplier to inspect the supporting evidence.",
    );
  } catch (e) {
    error(
      e.name === "AbortError"
        ? "Evaluation timed out. Please retry."
        : e.message,
    );
    setWorkspaceState("evaluationError");
    notice("Evaluation did not complete.");
  } finally {
    setBusy(false);
  }
});
$("add").addEventListener("click", () => {
  if ($("criteria").children.length < 12) {
    addCriterion();
    invalidate();
    $("criteria").lastChild.querySelector("textarea").focus();
  }
});
for (const id of [
  "product",
  "quantity",
  "country",
  "supplier-budget",
  "query-budget",
  "page-budget",
  "search-countries",
  "search-languages",
  "refresh-sources",
])
  $(id).addEventListener("input", () => invalidate(true));
function reset(navigate = true) {
  if (busy) return;
  if (navigate) location.hash = "/discovery";
  error();
  $("product").value = "";
  $("quantity").value = "";
  $("country").value = "";
  $("criteria").replaceChildren();
  addCriterion();
  invalidate(true);
  notice("Enter your purchase brief and decision criteria to find suppliers.");
}
const views = {
  discovery: [
    "Industrial supplier discovery",
    "Find suppliers and evaluate their capabilities against your purchase brief.",
  ],
  shortlist: [
    "Supplier shortlist",
    "Compare evaluated suppliers and review the recommendation.",
  ],
  evidence: [
    "Source evidence",
    "Inspect the sources behind each assessment and clarify missing information.",
  ],
  method: [
    "Evaluation method",
    "Understand how evidence becomes an explainable shortlist.",
  ],
};
function currentView() {
  const name = location.hash.replace(/^#\//, "");
  return Object.hasOwn(views, name) ? name : "discovery";
}
function showView(focus = true) {
  const name = currentView();
  if (location.hash !== `#/${name}`)
    history.replaceState(null, "", `#/${name}`);
  document.querySelectorAll("[data-view]").forEach((panel) => {
    panel.hidden = panel.dataset.view !== name;
  });
  document.querySelectorAll(".sidebar .nav-link").forEach((link) => {
    const active = link.hash === `#/${name}`;
    link.classList.toggle("active", active);
    if (active) link.setAttribute("aria-current", "page");
    else link.removeAttribute("aria-current");
  });
  $("page-title").textContent = views[name][0];
  $("page-description").textContent = views[name][1];
  document.title = `QuotePilot · ${views[name][0]}`;
  updateViewStates();
  if (focus) {
    $("page-title").focus({ preventScroll: true });
    window.scrollTo({ top: 0, behavior: "instant" });
  }
}
function updateViewStates() {
  $("shortlist-empty").hidden = !!evaluation;
  $("shortlist-evidence-link").hidden = !evaluation;
  $("evidence-empty").hidden = suppliers.length > 0;
  $("sources").hidden = !suppliers.length && !discoveryIssues.length;
}
function renderCandidates() {
  $("candidates").replaceChildren();
  for (const supplier of suppliers) {
    const row = el("div", undefined, "candidate-row");
    const description = el("div");
    description.append(
      el("h3", supplier.name),
      el(
        "p",
        `${supplier.evidence.length} source passages · ${supplier.crawl_status || "pending"} · ${supplier.identity_status === "site_identified" ? "identity from site metadata" : "identity needs verification"}`,
      ),
    );
    const link = el("a", "Review evidence", "btn btn-outline-secondary btn-sm");
    link.href = "#/evidence";
    row.append(description, link);
    $("candidates").append(row);
  }
}
window.addEventListener("hashchange", () => showView());
$("retry").addEventListener("click", () => $("requirements").requestSubmit());
$("reset").addEventListener("click", () => reset());
const savedJob = recalledJob();
showView(false);
reset(false);
if (savedJob) restoreResearch(savedJob);

function readOptions() {
  const terms = (id) =>
    $(id)
      .value.split(",")
      .map((s) => s.trim())
      .filter(Boolean);
  return {
    max_suppliers: Number($("supplier-budget").value),
    max_queries: Number($("query-budget").value),
    max_pages_per_supplier: Number($("page-budget").value),
    countries: terms("search-countries"),
    languages: terms("search-languages"),
    refresh: $("refresh-sources").checked,
  };
}
function rememberJob(id) {
  try {
    if (id) localStorage.setItem("quotepilot-job", id);
    else localStorage.removeItem("quotepilot-job");
  } catch {
    notice(
      "Browser storage is unavailable. Keep this tab open to retain your research link.",
    );
  }
}
function recalledJob() {
  try {
    return localStorage.getItem("quotepilot-job");
  } catch {
    return null;
  }
}
function renderCoverage() {
  const root = $("coverage");
  root.hidden = !coverage;
  if (!coverage) return;
  const renderKey = JSON.stringify([discoveryJobId, coverage]);
  if (renderKey === coverageRenderKey) return;
  coverageRenderKey = renderKey;
  const expanded = root.querySelector("details")?.open || false;
  root.replaceChildren();
  const stop = {
    searching: "Searching",
    query_budget: "Search budget reached",
    diminishing_returns: "Recent searches found no new suppliers",
  };
  root.append(
    el("h3", "Research coverage"),
    el(
      "p",
      `${coverage.queries.length} search passes · ${coverage.candidates_found} candidates found · ${coverage.researched} researched · ${coverage.pending} not researched. ${stop[coverage.stop_reason] || coverage.stop_reason}. This is not an exhaustive supplier list.`,
    ),
  );
  const details = el("details"),
    summary = el("summary", "Inspect searches and new suppliers");
  details.open = expanded;
  details.append(summary);
  for (const q of coverage.queries) {
    details.append(
      el(
        "p",
        `${q.query}: ${q.new_suppliers} new, ${q.duplicate_suppliers} duplicates${q.failed ? " · search failed" : ""}${q.cached ? " · cached" : ""}${q.unresolved_citations ? ` · ${q.unresolved_citations} unresolved citations` : ""}.`,
      ),
    );
    if (q.actual_queries.length)
      details.append(
        el("small", `Search terms: ${q.actual_queries.join("; ")}`),
      );
  }
  root.append(details);
  if (discoveryJobId) {
    const download = el(
      "a",
      "Download research JSON",
      "btn btn-outline-secondary btn-sm mt-2",
    );
    download.href = `/api/research/${encodeURIComponent(discoveryJobId)}/`;
    download.download = "supplier-research.json";
    root.append(download);
  }
}
async function fetchResearch(id) {
  const response = await fetch(`/api/research/${encodeURIComponent(id)}/`, {
    cache: "no-store",
    signal: AbortSignal.timeout(20000),
  });
  const job = await response.json();
  if (!response.ok) throw new Error(job.error || "Could not load research.");
  return job;
}
async function pollResearch(id) {
  for (;;) {
    const job = await fetchResearch(id);
    if (job.result?.phase === "evaluation") {
      step("eval");
      setWorkspaceState("evaluating");
    }
    if (job.result?.coverage) {
      coverage = job.result.coverage;
      renderCoverage();
      $("loading-message").textContent =
        `${coverage.queries.length} searches · ${coverage.researched} candidates researched`;
    }
    if (job.result?.assessments) {
      $("loading-message").textContent =
        `${job.result.assessments.length} suppliers assessed`;
    }
    if (job.status === "completed") return job.result;
    if (job.status === "queued") {
      $("loading-message").textContent =
        "Queued — waiting for a research worker…";
    }
    if (!["queued", "running"].includes(job.status)) {
      if (job.result?.suppliers) {
        suppliers = job.result.suppliers;
        discoveryIssues = job.result.issues || [];
        if (job.result.assessments) evaluation = job.result;
        render();
      }
      throw new Error(
        job.error || "Research was interrupted. Retry to reuse saved work.",
      );
    }
    await new Promise((resolve) => setTimeout(resolve, 2000));
  }
}
async function restoreResearch(id) {
  setBusy(true, "Restoring saved research…");
  rememberJob(id);
  try {
    const job = await fetchResearch(id),
      request = job.request;
    $("product").value = request.requirements.product;
    $("quantity").value = request.requirements.quantity;
    $("country").value = request.requirements.delivery_country;
    $("criteria").replaceChildren();
    request.requirements.criteria.forEach(addCriterion);
    for (const [field, key] of [
      ["supplier-budget", "max_suppliers"],
      ["query-budget", "max_queries"],
      ["page-budget", "max_pages_per_supplier"],
    ]) {
      const value = String(request.options[key]);
      if (![...$(field).options].some((option) => option.value === value)) {
        const option = el("option", value);
        option.value = value;
        $(field).append(option);
      }
      $(field).value = value;
    }
    $("search-countries").value = request.options.countries.join(", ");
    $("search-languages").value = request.options.languages.join(", ");
    $("refresh-sources").checked = request.options.refresh;
    setBusy(true);
    setWorkspaceState(
      request.stage === "evaluate" ? "evaluating" : "searching",
    );
    discoveryJobId =
      request.stage === "evaluate" ? request.discovery_job_id : id;
    const result = await pollResearch(id);
    suppliers = result.suppliers;
    if (request.stage === "research") {
      evaluation = result.assessments ? result : null;
      discoveryJobId = id;
      coverage = result.coverage;
      discoveryIssues = result.issues || [];
    } else if (request.stage === "evaluate") {
      evaluation = result;
      discoveryJobId = request.discovery_job_id;
      if (discoveryJobId) {
        try {
          const discovery = await fetchResearch(discoveryJobId);
          coverage = discovery.result?.coverage;
          discoveryIssues = discovery.result?.issues || [];
        } catch {
          error(
            "Evaluation restored, but search coverage could not be loaded. Reload to retry.",
          );
        }
      }
    } else {
      discoveryJobId = id;
      discoveryIssues = result.issues;
      coverage = result.coverage;
    }
    renderCoverage();
    render();
    step(evaluation ? "shortlist" : suppliers.length ? "eval" : "discover");
    notice("Saved research restored.");
  } catch (e) {
    error(`${e.message} Reload to reconnect, or start a new search.`);
    setWorkspaceState("discoveryError");
  } finally {
    setBusy(false);
  }
}
