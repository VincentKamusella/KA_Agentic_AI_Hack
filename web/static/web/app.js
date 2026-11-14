"use strict";
const $ = (id) => document.getElementById(id);
let suppliers = [],
  discoveryIssues = [],
  coverage = null,
  discoveryJobId = null,
  coverageRenderKey = "",
  evaluation = null,
  busy = false,
  criterionCounter = 0,
  suggestTimer = null,
  suggestAbort = null,
  suggestedBriefKey = "";
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
        ? "Re-run evaluation →"
        : "Evaluate suppliers →";
  $("reevaluate").textContent =
    value && suppliers.length ? "Evaluating…" : "Re-run evaluation";
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
  $("suggest").disabled = value;
  if (message) notice(message);
  $("content").setAttribute("aria-busy", String(value));
}
function clearSuggestions() {
  clearTimeout(suggestTimer);
  suggestAbort?.abort();
  suggestAbort = null;
  suggestedBriefKey = "";
  $("suggested-criteria").replaceChildren();
  $("suggested-status").textContent = "";
  $("suggested-box").hidden = true;
  $("select-all-suggestions").hidden = true;
}
function updateCriteriaHint() {
  const rows = [...$("criteria").children];
  $("criteria-empty").hidden = rows.length > 0;
  $("add").disabled = busy || rows.length >= 12;
  $("suggest").hidden = !suppliers.length;
  $("active-criteria-count").textContent = `${rows.length}`;
  $("criteria-sync-note").hidden = !(suppliers.length && !evaluation);
  rows.forEach((row, index) => {
    const kind = row.querySelector("select").value;
    const weight = Number(row.querySelector("input").value) || 1;
    const tag = row.querySelector(".criterion-role");
    const num = row.querySelector(".criterion-num");
    if (num) num.textContent = `#${index + 1}`;
    if (tag) {
      tag.textContent =
        kind === "mandatory" ? "Mandatory gate" : `Preference · w ${weight}`;
      tag.dataset.kind = kind;
    }
  });
  const active = rows
    .map((row) => ({
      description: row.querySelector("textarea").value.trim(),
      kind: row.querySelector("select").value,
    }))
    .filter((c) => c.description);
  const mandatoryCount = active.filter((c) => c.kind === "mandatory").length;
  const prefCount = active.length - mandatoryCount;
  $("eval-criteria-preview").textContent = active.length
    ? `Uses ${active.length} active ${active.length === 1 ? "criterion" : "criteria"} (${mandatoryCount} mandatory, ${prefCount} preference): ${active.map((c) => c.description).join(" · ")}`
    : "Add or select at least 1 active criterion on the left before evaluating.";
}
function syncSuggestionChecks() {
  const active = new Set(
    [...$("criteria").children].map((row) => row.dataset.id),
  );
  for (const input of $("suggested-criteria").querySelectorAll(
    "input[type='checkbox']",
  ))
    input.checked = active.has(input.dataset.criterionId);
  const all = [
    ...$("suggested-criteria").querySelectorAll("input[type='checkbox']"),
  ];
  $("select-all-suggestions").hidden =
    !all.length || all.every((input) => input.checked);
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
  $("evaluated-criteria").hidden = true;
  $("evaluated-criteria").replaceChildren();
  $("decision-performance").hidden = true;
  $("decision-performance").replaceChildren();
  $("comparison").replaceChildren();
  if (discovery) {
    suppliers = [];
    discoveryIssues = [];
    coverage = null;
    discoveryJobId = null;
    clearSuggestions();
    $("suggest").hidden = true;
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
  const head = el("div", undefined, "criterion-head");
  const label = el("label", undefined, "form-label criterion-label");
  label.append(el("span", "#", "criterion-num"), el("span", "Criterion"));
  const inputId = `criterion-${++criterionCounter}`;
  label.htmlFor = inputId;
  const role = el("span", "", "criterion-role");
  head.append(label, role);
  const description = el("textarea");
  description.id = inputId;
  description.value = c.description;
  description.placeholder = "Describe a verifiable requirement…";
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
    updateCriteriaHint();
    invalidate();
  });
  const remove = el("button", "Remove", "btn btn-link btn-sm remove");
  remove.type = "button";
  remove.addEventListener("click", () => {
    row.remove();
    updateCriteriaHint();
    syncSuggestionChecks();
    invalidate();
  });
  description.addEventListener("input", () => {
    updateCriteriaHint();
    invalidate();
  });
  weight.addEventListener("input", () => {
    updateCriteriaHint();
    invalidate();
  });
  controls.append(kind, weightField, remove);
  row.append(head, description, controls);
  $("criteria").append(row);
  updateCriteriaHint();
  syncSuggestionChecks();
}
function csrfToken() {
  return (
    document.cookie
      .split("; ")
      .find((x) => x.startsWith("csrftoken="))
      ?.split("=")[1] || ""
  );
}
function briefPayload() {
  const qty = Number($("quantity").value);
  return {
    product: $("product").value.trim(),
    quantity: Number.isInteger(qty) && qty > 0 ? qty : null,
    delivery_country: $("country").value.trim(),
  };
}
function renderSuggestions(items) {
  $("suggested-criteria").replaceChildren();
  for (const item of items) {
    const id = `suggest-${item.id}`;
    const wrap = el("div", undefined, "form-check suggested-item");
    const box = el("input", undefined, "form-check-input");
    box.type = "checkbox";
    box.id = id;
    box.dataset.criterionId = item.id;
    box.disabled = busy;
    box.addEventListener("change", () => {
      if (box.checked) {
        for (const blank of [...$("criteria").children]) {
          if (!blank.querySelector("textarea").value.trim()) blank.remove();
        }
        if ($("criteria").children.length >= 12) {
          box.checked = false;
          error("You can include at most 12 decision criteria.");
          return;
        }
        const existing = [...$("criteria").children].find(
          (row) => row.dataset.id === item.id,
        );
        if (!existing) addCriterion(item);
      } else {
        const existing = [...$("criteria").children].find(
          (row) => row.dataset.id === item.id,
        );
        existing?.remove();
        updateCriteriaHint();
      }
      syncSuggestionChecks();
      invalidate();
    });
    const label = el("label", undefined, "form-check-label");
    label.htmlFor = id;
    label.append(
      el("span", item.description, "suggested-desc"),
      el(
        "small",
        item.kind === "mandatory"
          ? "Mandatory gate"
          : `Preference · weight ${item.weight}`,
        "suggested-meta",
      ),
    );
    wrap.append(box, label);
    $("suggested-criteria").append(wrap);
  }
  syncSuggestionChecks();
}
async function fetchSuggestions(brief, { manual = false } = {}) {
  suggestAbort?.abort();
  const controller = new AbortController();
  suggestAbort = controller;
  $("suggested-box").hidden = false;
  $("suggested-box").dataset.state = "loading";
  $("suggested-status").textContent = "Generating suggested criteria…";
  $("select-all-suggestions").hidden = true;
  try {
    const response = await fetch("/api/suggest-criteria/", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-CSRFToken": csrfToken(),
      },
      body: JSON.stringify(brief),
      signal: controller.signal,
    });
    const data = await response.json().catch(() => ({
      error: "Could not read suggested criteria.",
    }));
    if (!response.ok)
      throw new Error(data.error || "Could not generate suggested criteria.");
    if (suggestAbort !== controller) return;
    suggestedBriefKey = JSON.stringify(brief);
    $("suggested-box").dataset.state = "ready";
    renderSuggestions(data.criteria || []);
    $("suggested-status").textContent = (data.criteria || []).length
      ? "Check any criteria to include them in evaluation."
      : "No suggestions generated. Click Add to write your own.";
  } catch (e) {
    if (e.name === "AbortError") return;
    if (suggestAbort !== controller) return;
    $("suggested-box").dataset.state = "error";
    $("suggested-status").textContent = manual
      ? e.message
      : "Automatic suggestions unavailable; click Suggest to retry or Add your own.";
  }
}
function scheduleSuggestions(immediate = false) {
  clearTimeout(suggestTimer);
  const brief = briefPayload();
  if (brief.product.length < 4) {
    suggestAbort?.abort();
    if (immediate) {
      $("suggested-box").hidden = false;
      $("suggested-box").dataset.state = "error";
      $("suggested-status").textContent =
        "Enter at least a short product description first.";
      $("suggested-criteria").replaceChildren();
      $("select-all-suggestions").hidden = true;
    } else if (!$("suggested-criteria").children.length) {
      $("suggested-box").hidden = true;
    }
    return;
  }
  const key = JSON.stringify(brief);
  if (!immediate && key === suggestedBriefKey) return;
  if (immediate) fetchSuggestions(brief, { manual: true });
  else suggestTimer = setTimeout(() => fetchSuggestions(brief), 800);
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
        Accept: "application/x-ndjson, application/json",
        "X-CSRFToken": csrf || "",
      },
      body: JSON.stringify({
        requirements: readRequirements(),
        options: readOptions(),
        discovery_job_id: discoveryJobId,
      }),
      signal: controller.signal,
    });
    if (
      !response.ok ||
      !response.headers.get("Content-Type")?.includes("ndjson")
    ) {
      const data = await response.json().catch(() => ({
        error: "The server returned an unreadable response. Retry the request.",
      }));
      if (!response.ok)
        throw new Error(data.error || "Request failed. Please retry.");
      return data;
    }
    return await readStream(response, onEvent);
  } finally {
    clearTimeout(timer);
  }
}
// Reads NDJSON progress events until the terminal result or error line.
async function readStream(response, onEvent) {
  const reader = response.body.getReader(),
    decoder = new TextDecoder();
  let buffer = "";
  for (;;) {
    const { value, done } = await reader.read();
    buffer += decoder.decode(value, { stream: !done });
    let newline;
    while ((newline = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      if (!line) continue;
      let event;
      try {
        event = JSON.parse(line);
      } catch {
        throw new Error("The server sent an unreadable update. Please retry.");
      }
      if (event.type === "result") return event.data;
      if (event.type === "error")
        throw new Error(event.error || "Request failed. Please retry.");
      try {
        onEvent(event);
      } catch (e) {
        console.error(e);
      }
    }
    if (done)
      throw new Error(
        "The connection closed before the stage finished. Please retry.",
      );
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
  const meta = el("div", undefined, "evidence-meta");
  meta.append(
    sourceTag("search"),
    el(
      "small",
      `${evidence.kind === "search_summary" ? "Legacy search summary" : evidence.kind === "pdf" ? "PDF source passage" : "Source passage"} · retrieved ${new Date(evidence.fetched_at).toLocaleString()}`,
    ),
  );
  box.append(a, meta);
  parent.append(box);
}
function render() {
  const assessments = new Map(
    (evaluation?.assessments || []).map((a) => [a.supplier_id, a]),
  );
  const displaySuppliers = evaluation
    ? sortSuppliersByEvaluation(
        suppliers,
        assessments,
        evaluation.recommended_supplier_ids || [],
      )
    : sortSuppliersByFit(suppliers);
  updateTotals();
  updateViewStates();
  updateCriteriaHint();
  if (!suppliers.length) clearSuggestions();
  renderCandidates(displaySuppliers, assessments);
  setWorkspaceState(
    evaluation ? "evaluated" : suppliers.length ? "candidates" : "empty",
  );

  $("content").hidden = false;
  $("count").textContent =
    `${suppliers.length} candidate supplier${suppliers.length === 1 ? "" : "s"} · ${suppliers.reduce((n, s) => n + s.evidence.length, 0)} source excerpts`;
  $("evaluate").hidden = !suppliers.length;
  $("evaluate").textContent = evaluation
    ? "Re-run evaluation →"
    : "Evaluate suppliers →";
  $("reevaluate").hidden = !suppliers.length || !discoveryJobId;
  $("sources").replaceChildren();
  $("evaluated-criteria").replaceChildren();
  $("evaluated-criteria").hidden = !evaluation;
  $("decision-performance").replaceChildren();
  $("decision-performance").hidden = !evaluation;
  $("comparison").replaceChildren();
  $("recommendation").hidden = !evaluation;
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
    renderEvaluatedCriteria([...criteria.values()]);
    renderDecisionPerformance(evaluation, displaySuppliers, [
      ...criteria.values(),
    ]);
    const wrap = el("div", undefined, "table-responsive"),
      table = el("table"),
      head = el("thead"),
      hr = el("tr");
    const hasPreferences = [...criteria.values()].some(
      (c) => c.kind === "preference",
    );
    for (const [text, source] of [
      ["Supplier"],
      ["Price"],
      ["Mandatory status", "rules"],
      ["Criteria match", "rules"],
      ["Evidence coverage", "rules"],
    ]) {
      const th = el("th", text);
      if (source)
        th.append(
          sourceTag(
            source,
            "Computed by deterministic rules from decision-model answers",
          ),
        );
      hr.append(th);
    }
    head.append(hr);
    table.append(head);
    const body = el("tbody");
    displaySuppliers.forEach((s, index) => {
      const a = assessments.get(s.supplier_id),
        row = el("tr"),
        name = el("td");
      const tier = a
        ? a.eligibility === "eligible"
          ? "strong"
          : a.eligibility === "needs_verification"
            ? "unknown"
            : "poor"
        : fitTier(s);
      if (tier) row.dataset.fit = tier;
      const titleRow = el("div", undefined, "candidate-title");
      titleRow.append(el("span", `#${index + 1}`, "rank-pill"));
      titleRow.append(el("strong", s.name));
      name.append(titleRow);
      if (chosen.includes(s)) name.append(el("small", "Shortlisted"));
      const fit = fitLine(s, true);
      if (fit) name.append(fit);
      row.append(name);
      const priceCell = el(
        "td",
        s.price || "Not listed",
        s.price ? "price-value" : "muted",
      );
      const status = el("td");
      status.append(a ? badge(a.eligibility) : badge("Not evaluated"));
      const matchCell = el("td");
      const coverageCell = el("td");
      if (a) {
        const stats = criteriaBreakdown(a);
        matchCell.append(
          el("strong", `${stats.passed} / ${stats.total} passed (${stats.passPct}%)`),
          el(
            "small",
            `${stats.passed} pass · ${stats.failed} fail · ${stats.unknown} unknown${hasPreferences ? ` · Pref ${Math.round(a.preference_score)}/100` : ""}`,
          ),
        );
        coverageCell.append(
          el("strong", `${Math.round(a.evidence_coverage * 100)}%`),
          el("small", `${stats.known} / ${stats.total} known`),
        );
      } else {
        matchCell.textContent = "—";
        coverageCell.textContent = "—";
      }
      row.append(priceCell, status, matchCell, coverageCell);
      body.append(row);
    });
    table.append(body);
    wrap.append(table);
    $("comparison").append(wrap);
  }
  $("sources").append(
    el("h3", "Evidence & assessment details", "source-title"),
  );
  displaySuppliers.forEach((s, index) => {
    const a = assessments.get(s.supplier_id);
    const rankNum = evaluation ? index + 1 : s.fit_rank || index + 1;
    const title = `#${rankNum} · ${s.name}${a ? ` (${criteriaBreakdown(a).passed}/${criteriaBreakdown(a).total} passed)` : s.fit_score != null ? ` (${Math.round(s.fit_score)}/100)` : ""}`;
    const panel = accordion(title, "supplier"),
      details = panel.body;
    const tier = a
      ? a.eligibility === "eligible"
        ? "strong"
        : a.eligibility === "needs_verification"
          ? "unknown"
          : "poor"
      : fitTier(s);
    if (tier) panel.root.dataset.fit = tier;
    details.append(priceLine(s));
    const fit = fitLine(s, Boolean(evaluation));
    if (fit) details.append(fit);
    if (s.discovered_by?.length) {
      details.append(
        el(
          "p",
          `Found by ${s.discovered_by.length} search passes. ${s.legal_id ? `Site-reported VAT ID: ${s.legal_id}. ` : ""}Identity still requires human verification.`,
          "help",
        ),
      );
    }
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
          sourceTag(
            "decision",
            "Criterion result combined by rules from per-excerpt gemini-decision-1 answers",
          ),
        );
        block.append(heading, el("p", c.explanation));
        if (c.decisions?.length)
          block.append(decisionAnswers(c.decisions, s.evidence));
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
  });
  for (const issue of [...discoveryIssues, ...(evaluation?.issues || [])])
    $("sources").append(el("p", issue.message, "alert alert-warning issue"));
}
// ── Provenance: every model-derived value is tagged with where it came from. ──
const DECISION_THRESHOLD = 0.85;
const SOURCES = {
  decision: {
    label: "Decision model",
    title: "Produced by the Gemini Decisions model (gemini-decision-1)",
    icon: '<path d="M8 1.5 14.5 8 8 14.5 1.5 8z"/><path d="M8 5v6M5 8h6"/>',
  },
  search: {
    label: "Search model",
    title: "Cited summary written by the Gemini search model",
    icon: '<circle cx="7" cy="7" r="4.5"/><path d="m10.5 10.5 4 4"/>',
  },
  code: {
    label: "Code",
    title: "Deterministic code; no model involved",
    icon: '<path d="m5.5 4-4 4 4 4M10.5 4l4 4-4 4"/>',
  },
  rules: {
    label: "Rules",
    title: "Deterministic gates and ranking applied to decision-model answers",
    icon: '<path d="M2 4h12M2 8h12M2 12h7"/>',
  },
};
function sourceTag(kind, title) {
  const source = SOURCES[kind],
    tag = el("span", undefined, `src-tag src-${kind}`);
  tag.title = title || source.title;
  // Static, trusted SVG markup only.
  tag.innerHTML = `<svg viewBox="0 0 16 16" aria-hidden="true">${source.icon}</svg>`;
  tag.append(el("span", source.label));
  return tag;
}
function percent(value) {
  return `${Math.round(value * 100)}%`;
}
function fitTier(supplier) {
  if (!supplier.fit_result) return "";
  if (supplier.fit_result === "pass")
    return (supplier.fit_confidence ?? 0) >= DECISION_THRESHOLD
      ? "strong"
      : "moderate";
  if (supplier.fit_result === "unknown") return "unknown";
  return "poor";
}
function fitRank(supplier) {
  if (supplier.fit_rank != null) return [0, supplier.fit_rank];
  const conf = supplier.fit_confidence ?? 0;
  if (supplier.fit_score != null) return [1, -supplier.fit_score];
  if (supplier.fit_result === "pass") return [2, -conf];
  if (supplier.fit_result === "unknown") return [3, 0];
  if (!supplier.fit_result) return [4, 0];
  return [5, conf];
}
function sortSuppliersByFit(list) {
  return [...list].sort((a, b) => {
    const [ra, ca] = fitRank(a),
      [rb, cb] = fitRank(b);
    return ra - rb || ca - cb;
  });
}
function eligibilityRank(eligibility) {
  if (eligibility === "eligible") return 0;
  if (eligibility === "needs_verification") return 1;
  if (eligibility === "ineligible") return 2;
  return 3;
}
function sortSuppliersByEvaluation(list, assessments, recommendedIds = []) {
  const shortlistIndex = new Map(recommendedIds.map((id, idx) => [id, idx]));
  return [...list].sort((a, b) => {
    const sa = shortlistIndex.has(a.supplier_id)
      ? shortlistIndex.get(a.supplier_id)
      : Number.MAX_SAFE_INTEGER;
    const sb = shortlistIndex.has(b.supplier_id)
      ? shortlistIndex.get(b.supplier_id)
      : Number.MAX_SAFE_INTEGER;
    if (sa !== sb) return sa - sb;
    const aa = assessments.get(a.supplier_id),
      ab = assessments.get(b.supplier_id);
    const ea = eligibilityRank(aa?.eligibility),
      eb = eligibilityRank(ab?.eligibility);
    if (ea !== eb) return ea - eb;
    if (aa && ab) {
      const pa = criteriaBreakdown(aa),
        pb = criteriaBreakdown(ab);
      if (pb.passed !== pa.passed) return pb.passed - pa.passed;
      if (ab.preference_score !== aa.preference_score)
        return ab.preference_score - aa.preference_score;
      if (ab.evidence_coverage !== aa.evidence_coverage)
        return ab.evidence_coverage - aa.evidence_coverage;
      if (pa.failed !== pb.failed) return pa.failed - pb.failed;
    }
    const [ra, ca] = fitRank(a),
      [rb, cb] = fitRank(b);
    return ra - rb || ca - cb || a.supplier_id.localeCompare(b.supplier_id);
  });
}
function priceLine(supplier) {
  const line = el("p", undefined, "price-line");
  line.append(
    el("span", "Listed price: ", "muted"),
    el(
      "span",
      supplier.price || "Not listed in cited sources",
      supplier.price ? "price-value" : "muted",
    ),
  );
  return line;
}
function fitLine(supplier, evaluated = false) {
  if (!supplier.fit_result && supplier.fit_score == null && !supplier.fit_rank)
    return null;
  const line = el("div", undefined, "fit-line");
  line.append(
    sourceTag(
      "decision",
      "Discovery prompt ranking by gemini-decision-1 using the generated discovery prompt and crawled site evidence.",
    ),
  );
  if (supplier.fit_rank)
    line.append(
      el(
        "span",
        evaluated ? `Discovery #${supplier.fit_rank}` : `Rank #${supplier.fit_rank}`,
        "rank-pill compact",
      ),
    );
  if (supplier.fit_score != null)
    line.append(
      el("span", `${Math.round(supplier.fit_score)} / 100 fit`, "fit-score"),
    );
  if (supplier.fit_result) line.append(badge(supplier.fit_result));
  if (supplier.fit_confidence != null) {
    const conf = el(
      "span",
      `${percent(supplier.fit_confidence)} confidence`,
      "muted",
    );
    if (supplier.fit_probabilities) {
      conf.title = Object.entries(supplier.fit_probabilities)
        .map(([k, v]) => `Level ${k}: ${percent(v)}`)
        .join(" · ");
    }
    line.append(conf);
  }
  return line;
}
// A pass/fail answer discarded for low confidence (unknown always abstains).
function ignored(decision) {
  return !decision.counted && decision.choice !== "unknown";
}
function formatProbabilities(probabilities) {
  if (!probabilities) return "";
  return ` · P(pass ${percent(probabilities.pass ?? 0)}, fail ${percent(probabilities.fail ?? 0)}, unknown ${percent(probabilities.unknown ?? 0)})`;
}
function decisionAnswers(decisions, evidence) {
  const box = el("div", undefined, "decision-answers");
  box.append(el("span", "Per-excerpt answers", "muted"));
  for (const d of decisions) {
    const index = evidence.findIndex((e) => e.id === d.evidence_id);
    const chip = el(
      "span",
      `Excerpt ${index + 1} · ${labels[d.choice]} ${percent(d.confidence)}`,
      `decision-chip choice-${d.choice}${ignored(d) ? " not-counted" : ""}`,
    );
    const statusNote = d.counted
      ? "Counted toward the criterion result."
      : d.choice === "unknown"
        ? "The decision model abstained for this excerpt."
        : `Ignored: below the ${percent(DECISION_THRESHOLD)} confidence threshold.`;
    chip.title = `${statusNote}${formatProbabilities(d.probabilities)}`;
    box.append(chip);
  }
  return box;
}
function criteriaBreakdown(assessment) {
  const total = assessment.criteria.length;
  const passed = assessment.criteria.filter((c) => c.result === "pass").length;
  const failed = assessment.criteria.filter((c) => c.result === "fail").length;
  const unknown = total - passed - failed;
  const known = passed + failed;
  const passPct = total ? Math.round((passed / total) * 100) : 0;
  return { total, passed, failed, unknown, known, passPct };
}
function renderEvaluatedCriteria(criteriaList) {
  const host = $("evaluated-criteria");
  if (!criteriaList.length) {
    host.hidden = true;
    return;
  }
  host.hidden = false;
  const header = el("div", undefined, "evaluated-criteria-head");
  header.append(
    el("strong", `Evaluated against ${criteriaList.length} criteria`),
    el(
      "span",
      `${criteriaList.filter((c) => c.kind === "mandatory").length} mandatory · ${criteriaList.filter((c) => c.kind === "preference").length} preference`,
      "subtle",
    ),
  );
  const list = el("ul", undefined, "evaluated-criteria-list");
  criteriaList.forEach((c, index) => {
    const item = el("li", undefined, "evaluated-criterion-chip");
    item.dataset.kind = c.kind;
    item.append(
      el("span", `#${index + 1}`, "criterion-num"),
      el(
        "span",
        c.kind === "mandatory" ? "Mandatory" : `Pref w${c.weight}`,
        "criterion-role",
      ),
      el("span", c.description || c.id, "evaluated-criterion-text"),
    );
    list.append(item);
  });
  host.replaceChildren(header, list);
}
function renderDecisionPerformance(result, supplierList, criteriaList) {
  const host = $("decision-performance");
  const m = result.decision_metrics;
  const allDecisions = (result.assessments || []).flatMap((a) =>
    a.criteria.flatMap((c) => c.decisions || []),
  );
  if (!m && !allDecisions.length) {
    host.hidden = true;
    return;
  }
  host.hidden = false;
  const threshold = m?.confidence_threshold ?? DECISION_THRESHOLD;
  const model = m?.model || "gemini-decision-1";
  const questions = m?.questions ?? allDecisions.length;
  const passCount =
    m?.pass_count ??
    allDecisions.filter((d) => d.counted && d.choice === "pass").length;
  const failCount =
    m?.fail_count ??
    allDecisions.filter((d) => d.counted && d.choice === "fail").length;
  const countedTotal = m?.counted ?? passCount + failCount;
  const abstained =
    m?.abstained ?? allDecisions.filter((d) => d.choice === "unknown").length;
  const belowThreshold =
    m?.below_threshold ?? allDecisions.filter((d) => ignored(d)).length;
  const countedConfs = allDecisions
    .filter((d) => d.counted)
    .map((d) => d.confidence);
  const avgConfidence = countedConfs.length
    ? countedConfs.reduce((sum, v) => sum + v, 0) / countedConfs.length
    : null;
  const header = el("div", undefined, "decision-perf-head");
  header.append(
    el("h2", "Decision model performance"),
    sourceTag("decision", `Model: ${model} · ${percent(threshold)} threshold`),
    el(
      "span",
      `${model} · ${percent(threshold)} confidence threshold`,
      "subtle",
    ),
  );
  const grid = el("div", undefined, "decision-perf-grid");
  const cards = [
    [
      "API calls & latency",
      m
        ? `${m.calls} call${m.calls === 1 ? "" : "s"} · ${m.elapsed_seconds.toFixed(1)}s`
        : `${result.assessments.length} evaluated`,
      m && m.calls
        ? `${(m.elapsed_seconds / m.calls).toFixed(2)}s avg/call${m.failed_calls ? ` · ${m.failed_calls} failed` : " · all succeeded"}`
        : "Measured from live evaluation calls",
    ],
    [
      "Questions & decisions",
      `${questions} question${questions === 1 ? "" : "s"}`,
      `${countedTotal} counted (${passCount} pass · ${failCount} fail)`,
    ],
    [
      "Calibration & abstentions",
      avgConfidence !== null ? `${percent(avgConfidence)} avg confidence` : "—",
      `${abstained} abstained · ${belowThreshold} ignored (<${percent(threshold)})`,
    ],
    [
      "Supplier coverage",
      `${result.assessments.length} / ${supplierList.length} assessed`,
      m?.skipped_suppliers
        ? `${m.skipped_suppliers} skipped (no excerpts)`
        : m?.failed_calls
          ? `${m.failed_calls} provider issue${m.failed_calls === 1 ? "" : "s"}`
          : "Every candidate with excerpts assessed",
    ],
  ];
  for (const [label, value, sub] of cards) {
    const card = el("div", undefined, "perf-card");
    card.append(el("span", label), el("strong", value), el("small", sub));
    grid.append(card);
  }
  host.replaceChildren(header, grid);
  if (m?.discovery_ranking || m?.evaluation_instructions) {
    const traceBox = el("details", undefined, "perf-trace");
    traceBox.open = true;
    traceBox.append(
      el("summary", "What the decision model did (prompts, rubrics & actions)"),
    );
    const steps = el("ol", undefined, "perf-steps");
    if (m.discovery_ranking) {
      const dr = m.discovery_ranking;
      const item = el("li", undefined, "perf-step");
      item.append(
        el(
          "strong",
          `1. Ranked ${supplierList.length} discovered suppliers against the generated discovery prompt (${dr.calls} score call${dr.calls === 1 ? "" : "s"} · ${dr.elapsed_seconds.toFixed(1)}s · ${dr.status})`,
        ),
      );
      if (dr.prompt) {
        const promptEl = el("p", undefined, "perf-prompt");
        promptEl.append(el("span", "Generated discovery prompt: ", "muted"), dr.prompt);
        item.append(promptEl);
      }
      if (dr.rubric?.length) {
        const rubricEl = el("p", undefined, "perf-rubric");
        rubricEl.append(
          el("span", "Scoring rubric (0–3): ", "muted"),
          dr.rubric.map((desc, idx) => `${idx}: ${desc}`).join(" | "),
        );
        item.append(rubricEl);
      }
      if (dr.message) item.append(el("p", dr.message, "help"));
      steps.append(item);
    }
    if (m.evaluation_instructions) {
      const item = el("li", undefined, "perf-step");
      item.append(
        el(
          "strong",
          `2. Assessed each (criterion, excerpt) pair independently (${m.calls} choice call${m.calls === 1 ? "" : "s"} · ${m.questions} questions · ${m.elapsed_seconds.toFixed(1)}s)`,
        ),
        el("p", m.evaluation_instructions, "perf-prompt"),
      );
      steps.append(item);
    }
    traceBox.append(steps);
    host.append(traceBox);
  }
  const supplierMetricMap = new Map(
    (m?.suppliers || []).map((item) => [item.supplier_id, item]),
  );
  const assessmentMap = new Map(
    (result.assessments || []).map((a) => [a.supplier_id, a]),
  );
  if (supplierList.length && criteriaList.length) {
    const details = el("details", undefined, "perf-matrix");
    details.append(
      el(
        "summary",
        "Inspect per-supplier decision matrix, confidence, and latency",
      ),
    );
    const lanes = el("div", undefined, "decision-lanes");
    for (const s of supplierList) {
      const sm = supplierMetricMap.get(s.supplier_id);
      const a = assessmentMap.get(s.supplier_id);
      const lane = el("div", undefined, "decision-lane");
      if (sm?.status) lane.dataset.status = sm.status;
      const head = el("div", undefined, "lane-head");
      const statusText = sm
        ? sm.status === "failed"
          ? `Failed · ${sm.elapsed_seconds.toFixed(1)}s`
          : sm.status === "skipped"
            ? "Skipped (no excerpts)"
            : `${sm.elapsed_seconds.toFixed(2)}s · ${sm.pass_count} pass · ${sm.fail_count} fail · ${sm.unknown_count} unknown${sm.below_threshold_count ? ` · ${sm.below_threshold_count} ignored` : ""}`
        : a
          ? `${a.criteria.length} criteria assessed`
          : "Not assessed";
      head.append(el("strong", s.name), el("span", statusText, "lane-status"));
      const matrix = el("div", undefined, "decision-grid");
      matrix.style.setProperty("--cols", Math.max(1, s.evidence.length));
      const criterionAssessments = new Map(
        (a?.criteria || []).map((ca) => [ca.criterion_id, ca]),
      );
      for (const c of criteriaList) {
        const ca = criterionAssessments.get(c.id);
        const decisionByEv = new Map(
          (ca?.decisions || []).map((d) => [d.evidence_id, d]),
        );
        s.evidence.forEach((ev, ei) => {
          const d = decisionByEv.get(ev.id);
          const cell = el(
            "span",
            undefined,
            d
              ? `decision-cell choice-${d.choice}${ignored(d) ? " not-counted" : ""}`
              : "decision-cell",
          );
          cell.title = d
            ? `${c.description || c.id} × excerpt ${ei + 1}: ${labels[d.choice]} · ${percent(d.confidence)}${d.counted ? "" : d.choice === "unknown" ? " · abstained" : " · below threshold, ignored"}${formatProbabilities(d.probabilities)}`
            : `${c.description || c.id} × excerpt ${ei + 1}: ${sm?.status === "failed" ? sm.message || "failed" : "no decision recorded"}`;
          matrix.append(cell);
        });
      }
      lane.append(head, matrix);
      lanes.append(lane);
    }
    const key = el("div", undefined, "cell-key");
    for (const [cls, text] of [
      ["choice-pass", "Pass"],
      ["choice-fail", "Fail"],
      ["choice-unknown", "Unknown"],
      ["choice-pass not-counted", `Below ${percent(threshold)}`],
    ]) {
      const item = el("span");
      item.append(el("span", undefined, `decision-cell ${cls}`), text);
      key.append(item);
    }
    details.append(lanes, key);
    host.append(details);
  }
}

// ── Live run trace: renders real server events. Nothing here is simulated. ──
const STEP_PLANS = {
  discover: [
    ["search", "Search public sources", "search"],
    ["sources", "Resolve citations and group excerpts by supplier", "code"],
    ["fit", "Relevance screen for each candidate", "decision"],
  ],
  evaluate: [
    ["assess", "Assess every criterion against every excerpt", "decision"],
    ["rank", "Apply mandatory gates and rank", "rules"],
  ],
};
const STATUS_TEXT = {
  pending: "Waiting",
  running: "Running",
  done: "Done",
  failed: "Failed",
  skipped: "Skipped",
};
let trace = null;
function startTrace(stage) {
  clearInterval(trace?.timer);
  const steps = new Map(),
    list = $("run-steps");
  list.replaceChildren();
  for (const [id, label, source] of STEP_PLANS[stage]) {
    const node = el("li", undefined, `run-step src-step-${source}`);
    node.dataset.status = "pending";
    const marker = el("span", undefined, "run-marker"),
      body = el("div", undefined, "run-body"),
      head = el("div", undefined, "run-step-head"),
      state = el("span", STATUS_TEXT.pending, "run-state"),
      time = el("span", "", "run-time"),
      detail = el("p", "", "run-detail"),
      extra = el("div", undefined, "run-extra");
    marker.setAttribute("aria-hidden", "true");
    head.append(el("strong", label), sourceTag(source), state, time);
    body.append(head, detail, extra);
    node.append(marker, body);
    list.append(node);
    steps.set(id, { node, state, time, detail, extra, start: null, end: null });
  }
  const criteria = readRequirements().criteria;
  trace = {
    stage,
    steps,
    criteria,
    lanes: new Map(),
    calls: 0,
    answers: 0,
    started: performance.now(),
    timer: setInterval(tickTrace, 250),
  };
  $("run-trace").dataset.state = "running";
  $("run-trace-title").textContent =
    stage === "discover" ? "Live run · Discovery" : "Live run · Evaluation";
  $("run-trace-summary").textContent = "";
  $("run-trace").hidden = false;
  if (stage === "evaluate") buildLanes();
  tickTrace();
}
function traceSeconds() {
  return (performance.now() - trace.started) / 1000;
}
function tickTrace() {
  if (!trace) return;
  const now = traceSeconds();
  if ($("run-trace").dataset.state === "running")
    $("run-trace-time").textContent = `${Math.floor(now)}s elapsed`;
  for (const step of trace.steps.values()) {
    if (step.start === null) continue;
    const end = step.end ?? now;
    step.time.textContent = `${Math.max(0, end - step.start).toFixed(1)}s`;
  }
}
function setStep(id, status, detail) {
  const step = trace?.steps.get(id);
  if (!step) return null;
  step.node.dataset.status = status;
  step.state.textContent = STATUS_TEXT[status] || status;
  if (status === "running" && step.start === null) step.start = traceSeconds();
  if (["done", "failed", "skipped"].includes(status)) {
    step.start ??= traceSeconds();
    step.end = traceSeconds();
  }
  if (detail !== undefined) step.detail.textContent = detail;
  tickTrace();
  return step;
}
function buildLanes() {
  const step = trace.steps.get("assess"),
    lanes = el("div", undefined, "decision-lanes");
  for (const s of suppliers) {
    const lane = el("div", undefined, "decision-lane");
    lane.dataset.status = "pending";
    const head = el("div", undefined, "lane-head"),
      status = el("span", "Waiting", "lane-status"),
      grid = el("div", undefined, "decision-grid");
    head.append(el("strong", s.name), status);
    grid.style.setProperty("--cols", Math.max(1, s.evidence.length));
    grid.setAttribute("role", "img");
    const cells = new Map();
    trace.criteria.forEach((c, ci) =>
      s.evidence.forEach((e, ei) => {
        const cell = el("span", undefined, "decision-cell");
        cell.style.setProperty("--i", ci * s.evidence.length + ei);
        cell.title = `${c.description || c.id} × excerpt ${ei + 1}: awaiting decision`;
        cells.set(`${c.id}|${e.id}`, { cell, criterion: c, index: ei });
        grid.append(cell);
      }),
    );
    grid.setAttribute(
      "aria-label",
      `${cells.size} pending decisions for ${s.name}`,
    );
    lane.append(head, grid);
    lanes.append(lane);
    trace.lanes.set(s.supplier_id, { lane, status, grid, cells, name: s.name });
  }
  const key = el("div", undefined, "cell-key");
  for (const [cls, text] of [
    ["choice-pass", "Pass"],
    ["choice-fail", "Fail"],
    ["choice-unknown", "Unknown"],
    ["choice-pass not-counted", `Below ${percent(DECISION_THRESHOLD)}`],
  ]) {
    const item = el("span");
    item.append(el("span", undefined, `decision-cell ${cls}`), text);
    key.append(item);
  }
  step.extra.replaceChildren(lanes, key);
}
function updateLane(event) {
  const lane = trace.lanes.get(event.supplier_id);
  if (!lane) return;
  lane.lane.dataset.status = event.status;
  if (event.status === "queued")
    lane.status.textContent = "Queued · at most 3 decision calls run at once";
  else if (event.status === "running")
    lane.status.textContent = `Decision model answering ${lane.cells.size} questions…`;
  else if (event.status === "skipped")
    lane.status.textContent = event.message || "Skipped";
  else if (event.status === "failed") {
    trace.calls++;
    lane.status.textContent = event.message || "Decision call failed";
  } else if (event.status === "done") {
    trace.calls++;
    const tally = { pass: 0, fail: 0, unknown: 0 };
    let belowThreshold = 0;
    for (const a of event.answers || []) {
      const slot = lane.cells.get(`${a.criterion_id}|${a.evidence_id}`);
      tally[a.choice]++;
      if (ignored(a)) belowThreshold++;
      if (!slot) continue;
      slot.cell.className = `decision-cell choice-${a.choice}${ignored(a) ? " not-counted" : ""}`;
      slot.cell.title = `${slot.criterion.description || slot.criterion.id} × excerpt ${slot.index + 1}: ${labels[a.choice]} · ${percent(a.confidence)} confidence${a.counted ? "" : a.choice === "unknown" ? " · abstained" : " · below threshold, ignored"}`;
    }
    trace.answers += (event.answers || []).length;
    lane.status.textContent = `${tally.pass} pass · ${tally.fail} fail · ${tally.unknown} unknown${belowThreshold ? ` · ${belowThreshold} below threshold` : ""}`;
    lane.grid.setAttribute(
      "aria-label",
      `Decisions for ${lane.name}: ${lane.status.textContent}`,
    );
  }
}
function traceEvent(event) {
  if (!trace) return;
  if (event.type === "supplier") return updateLane(event);
  const d = event.detail || {};
  const model = event.model ? ` · ${event.model}` : "";
  const texts = {
    search: {
      running: `Gemini is searching the web with Google Search grounding${model}.`,
      done: `${d.citations ?? 0} cited passages returned${model}.`,
    },
    sources: {
      running: "Resolving citation links to supplier websites…",
      done: `${d.suppliers ?? 0} candidate suppliers · ${d.excerpts ?? 0} source excerpts.`,
    },
    fit: {
      running: `One decision per candidate: does it offer this product?${model}`,
      done: `${(d.answers || []).length} relevance decisions${model}. Advisory only; it does not affect rank.`,
      failed:
        "The relevance screen was unavailable. Candidates are shown unscreened.",
      skipped: "No candidates to screen.",
    },
    assess: {
      running: `${d.questions ?? 0} questions in ${d.calls ?? 0} decision calls${model} · answers below ${percent(d.threshold ?? DECISION_THRESHOLD)} confidence are ignored.`,
      done: d.issues
        ? `${d.issues} supplier${d.issues === 1 ? "" : "s"} could not be assessed.`
        : undefined,
    },
    rank: {
      running: "Mandatory gates, then weighted preferences. No model involved.",
      done: `${d.shortlisted ?? 0} supplier${d.shortlisted === 1 ? "" : "s"} shortlisted. No model involved.`,
    },
  };
  const step = setStep(
    event.step,
    event.status,
    texts[event.step]?.[event.status],
  );
  if (event.step === "fit" && step) {
    if (event.status === "running") {
      const chips = el("div", undefined, "fit-chips");
      for (const s of d.suppliers || []) {
        const chip = el("span", undefined, "fit-chip");
        chip.dataset.id = s.supplier_id;
        chip.append(el("span", s.name), el("span", "…", "fit-chip-result"));
        chips.append(chip);
      }
      step.extra.replaceChildren(chips);
    }
    if (event.status === "done") {
      trace.calls++;
      trace.answers += (d.answers || []).length;
      for (const a of d.answers || []) {
        const chip = step.extra.querySelector(
          `[data-id="${CSS.escape(a.supplier_id)}"]`,
        );
        if (!chip) continue;
        chip.dataset.choice = a.choice;
        if (a.confidence < DECISION_THRESHOLD)
          chip.dataset.lowConfidence = "true";
        chip.lastChild.textContent = `${labels[a.choice]} ${percent(a.confidence)}`;
      }
    }
    if (event.status === "failed") trace.calls++;
  }
  if (event.status === "running" && event.source === "decision")
    notice("The decision model is now answering.");
}
function finishTrace(ok, message) {
  if (!trace) return;
  clearInterval(trace.timer);
  for (const step of trace.steps.values()) {
    const status = step.node.dataset.status;
    if (status === "running") setStepNode(step, ok ? "done" : "failed");
    else if (status === "pending" && !ok)
      setStepNode(step, "skipped", "Not run.");
  }
  for (const lane of trace.lanes.values())
    if (
      !ok &&
      ["pending", "queued", "running"].includes(lane.lane.dataset.status)
    ) {
      lane.lane.dataset.status = "failed";
      lane.status.textContent = "Not completed";
    }
  $("run-trace").dataset.state = ok ? "done" : "failed";
  $("run-trace-time").textContent = "";
  const calls = `${trace.calls} decision-model call${trace.calls === 1 ? "" : "s"} · ${trace.answers} answer${trace.answers === 1 ? "" : "s"}`;
  $("run-trace-summary").textContent = ok
    ? `Finished in ${traceSeconds().toFixed(1)}s · ${calls}`
    : `Stopped after ${traceSeconds().toFixed(1)}s · ${message || "the stage failed"}`;
  $("run-trace-title").textContent =
    trace.stage === "discover"
      ? "Last run · Discovery"
      : "Last run · Evaluation";
}
function setStepNode(step, status, detail) {
  for (const [id, value] of trace.steps)
    if (value === step) return setStep(id, status, detail);
}
function hideTrace() {
  clearInterval(trace?.timer);
  trace = null;
  $("run-trace").hidden = true;
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
async function runEvaluation() {
  if (busy || !$("requirements").reportValidity()) return;
  if (!$("criteria").children.length) {
    error("Select or add at least one decision criterion for evaluation.");
    if (currentView() !== "discovery") location.hash = "/discovery";
    $("add").focus();
    return;
  }
  if (!discoveryJobId) {
    error("Run discovery first so saved supplier evidence is available.");
    return;
  }
  error();
  setWorkspaceState("evaluating");
  setBusy(true, "Evaluating evidence against your criteria…");
  try {
    const job = await post();
    rememberJob(job.job_id);
    evaluation = await pollResearch(job.job_id);
    suppliers = evaluation.suppliers;
    coverage = evaluation.coverage;
    discoveryJobId = discoveryJobId || job.job_id;
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
}
$("evaluate").addEventListener("click", runEvaluation);
$("reevaluate").addEventListener("click", runEvaluation);
$("shortlist-empty-eval").addEventListener("click", runEvaluation);
$("add").addEventListener("click", () => {
  if ($("criteria").children.length < 12) {
    addCriterion();
    invalidate();
    $("criteria").lastChild.querySelector("textarea").focus();
  }
});
$("suggest").addEventListener("click", () => {
  if (!busy && suppliers.length) scheduleSuggestions(true);
});
$("select-all-suggestions").addEventListener("click", () => {
  for (const box of $("suggested-criteria").querySelectorAll(
    "input[type='checkbox']:not(:checked)",
  )) {
    if ($("criteria").children.length >= 12) break;
    box.checked = true;
    box.dispatchEvent(new Event("change"));
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
  clearSuggestions();
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
  const hasCandidates = suppliers.length > 0 && !!discoveryJobId;
  $("shortlist-empty-title").textContent = hasCandidates
    ? "Criteria changed — re-run evaluation"
    : "No evaluation yet.";
  $("shortlist-empty-desc").textContent = hasCandidates
    ? "Your discovered suppliers are preserved. Re-run evaluation to score them against the active criteria."
    : "Submit your brief to research suppliers and build your shortlist.";
  $("shortlist-empty-eval").hidden = !hasCandidates;
  $("shortlist-evidence-link").hidden = !evaluation;
  $("reevaluate").hidden = !hasCandidates;
  $("evidence-empty").hidden = suppliers.length > 0;
  $("sources").hidden = !suppliers.length && !discoveryIssues.length;
}
function renderCandidates(list = suppliers, assessments = new Map()) {
  $("candidates").replaceChildren();
  const hasEval = assessments.size > 0;
  list.forEach((supplier, index) => {
    const row = el("div", undefined, "candidate-row");
    const a = assessments.get(supplier.supplier_id);
    const tier = a
      ? a.eligibility === "eligible"
        ? "strong"
        : a.eligibility === "needs_verification"
          ? "unknown"
          : "poor"
      : fitTier(supplier);
    if (tier) row.dataset.fit = tier;
    const description = el("div");
    const titleRow = el("div", undefined, "candidate-title");
    const rankNum = hasEval ? index + 1 : supplier.fit_rank || index + 1;
    titleRow.append(el("span", `#${rankNum}`, "rank-pill"));
    titleRow.append(el("h3", supplier.name));
    description.append(
      titleRow,
      el(
        "p",
        `${supplier.evidence.length} source passages · ${supplier.crawl_status || "pending"} · ${supplier.identity_status === "site_identified" ? "identity from site metadata" : "identity needs verification"}`,
      ),
      priceLine(supplier),
    );
    const fit = fitLine(supplier, hasEval);
    if (fit) description.append(fit);
    if (a) {
      const stats = criteriaBreakdown(a);
      const evalLine = el("div", undefined, "fit-line");
      evalLine.append(
        sourceTag("rules", "Deterministic evaluation against active criteria"),
        badge(a.eligibility),
        el(
          "span",
          `${stats.passed} / ${stats.total} criteria passed (${stats.passPct}%)`,
          "fit-score",
        ),
        el(
          "span",
          `${stats.failed} fail · ${stats.unknown} unknown`,
          "muted",
        ),
      );
      description.append(evalLine);
    }
    const link = el("a", "Review evidence", "btn btn-outline-secondary btn-sm");
    link.href = "#/evidence";
    row.append(description, link);
    $("candidates").append(row);
  });
}
document
  .querySelectorAll("[data-source-tag]")
  .forEach((node) => node.replaceWith(sourceTag(node.dataset.sourceTag)));
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
      const m = job.result.decision_metrics;
      $("loading-message").textContent = m
        ? `${job.result.assessments.length}/${job.result.suppliers?.length || job.result.assessments.length} suppliers assessed · ${m.calls} decision calls · ${m.questions} questions · ${m.elapsed_seconds.toFixed(1)}s`
        : `${job.result.assessments.length} suppliers assessed`;
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
