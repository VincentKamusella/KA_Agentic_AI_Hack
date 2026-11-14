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
function setBusy(value, message = "") {
  busy = value;
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
    for (const [text, source] of [
      ["Supplier"],
      ["Price"],
      ["Mandatory status", "rules"],
      ["Preferences", "rules"],
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
    for (const s of suppliers) {
      const a = assessments.get(s.supplier_id),
        row = el("tr"),
        name = el("td");
      const tier = fitTier(s);
      if (tier) row.dataset.fit = tier;
      name.append(el("strong", s.name));
      if (chosen.includes(s)) name.append(el("small", "Shortlisted"));
      const fit = fitLine(s);
      if (fit) name.append(fit);
      row.append(name);
      const priceCell = el(
        "td",
        s.price || "Not listed",
        s.price ? "price-value" : "muted",
      );
      const status = el("td");
      status.append(a ? badge(a.eligibility) : badge("Not evaluated"));
      row.append(
        priceCell,
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
  }
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
  const conf = supplier.fit_confidence ?? 0;
  if (supplier.fit_result === "pass") return [0, -conf];
  if (supplier.fit_result === "unknown") return [1, 0];
  if (!supplier.fit_result) return [2, 0];
  return [3, conf];
}
function sortSuppliersByFit(list) {
  return [...list].sort((a, b) => {
    const [ra, ca] = fitRank(a),
      [rb, cb] = fitRank(b);
    return ra - rb || ca - cb;
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
function fitLine(supplier) {
  if (!supplier.fit_result) return null;
  const line = el("div", undefined, "fit-line");
  line.append(
    sourceTag(
      "decision",
      "Relevance screen by gemini-decision-1 during discovery. Advisory only: it does not affect eligibility or rank.",
    ),
    el("span", "Relevance"),
    badge(supplier.fit_result),
    el("span", `${percent(supplier.fit_confidence ?? 0)} confidence`, "muted"),
  );
  if ((supplier.fit_confidence ?? 0) < DECISION_THRESHOLD)
    line.append(el("span", "Low confidence", "muted"));
  return line;
}
// A pass/fail answer discarded for low confidence (unknown always abstains).
function ignored(decision) {
  return !decision.counted && decision.choice !== "unknown";
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
    chip.title = d.counted
      ? "Counted toward the criterion result."
      : d.choice === "unknown"
        ? "The decision model abstained for this excerpt."
        : `Ignored: below the ${percent(DECISION_THRESHOLD)} confidence threshold.`;
    box.append(chip);
  }
  return box;
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
  startTrace("discover");
  let ok = false;
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
    finishTrace(ok);
    setBusy(false);
  }
});
$("evaluate").addEventListener("click", async () => {
  if (busy || !$("requirements").reportValidity()) return;
  error();
  setWorkspaceState("evaluating");
  setBusy(true, "Evaluating evidence against your criteria…");
  startTrace("evaluate");
  let ok = false;
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
    finishTrace(ok);
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
    const tier = fitTier(supplier);
    if (tier) row.dataset.fit = tier;
    const description = el("div");
    description.append(
      el("h3", supplier.name),
      el(
        "p",
        `${supplier.evidence.length} source passages · ${supplier.crawl_status || "pending"} · ${supplier.identity_status === "site_identified" ? "identity from site metadata" : "identity needs verification"}`,
      ),
    );
    const fit = fitLine(supplier);
    if (fit) description.append(fit);
    const link = el("a", "Review evidence", "btn btn-outline-secondary btn-sm");
    link.href = "#/evidence";
    row.append(description, link);
    $("candidates").append(row);
  }
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
