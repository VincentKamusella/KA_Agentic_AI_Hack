"use strict";
/* QuotePilot workspace.

   One research job at a time: the brief is posted to /api/research/, the job
   is polled until it finishes, and its id is remembered in this browser so a
   reload reconnects to it. Requirements are interpreted by the backend; the
   browser never derives criteria itself and only edits the list it was given.

   All supplier and model text is untrusted and is written with textContent. */

const $ = (id) => document.getElementById(id);
const POLL_MS = 2000;
const MAX_CRITERIA = 12;
const JOB_KEY = "quotepilot-job";
const AREA_KEY = "quotepilot-area";
const UNITS = ["pieces", "kg", "tonnes", "metres", "litres"];
const VIEWS = { brief: "Brief", results: "Shortlist", sources: "Sources" };
const STATUS = {
  pass: ["Pass", "pass", "check"],
  fail: ["Fail", "fail", "cross"],
  unknown: ["Unknown", "unknown", "unknown"],
  eligible: ["Eligible", "pass", "check"],
  ineligible: ["Not eligible", "fail", "cross"],
  needs_verification: ["Needs verification", "unknown", "unknown"],
  not_evaluated: ["Not evaluated", "none", "dash"],
};
const KINDS = { mandatory: "Must have", preference: "Nice to have" };
const PHASES = {
  queued: [
    "Waiting for a research worker",
    "Your search is queued and starts as soon as a worker is free.",
  ],
  interpreting: [
    "Understanding your requirements",
    "Your brief is being turned into must-haves and nice-to-haves.",
  ],
  discovery: [
    "Finding suppliers",
    "Searching across sources and languages, then retrieving supplier pages.",
  ],
  evaluation: [
    "Checking suppliers against your requirements",
    "Each supplier’s source passages are assessed against every requirement.",
  ],
  recommendation: [
    "Preparing recommendations and email drafts",
    "Reviewing the evidence and grades to suggest whom to contact and what to ask.",
  ],
};
const FIELD_ERRORS = {
  "requirements.product": ["product-error", "product"],
  "requirements.quantity": ["quantity-error", "quantity"],
  "requirements.quantity_unit": ["quantity-error", "unit"],
  "requirements.delivery_country": ["area-error", "area-open"],
  "requirements.needed_by": ["needed-by-error", "needed-by"],
  "requirements.other_requirements": ["other-error", "other"],
};

const state = {
  jobId: null,
  status: null, // "queued" | "running" | "completed" | "failed" | null
  result: null, // latest checkpoint or final result; any part may be missing
  request: null, // what the job was started with
  error: null,
  recommendationError: null,
  payload: null, // body that created the job, kept for "Retry"
  evidenceJobId: null, // latest completed job with suppliers: reusable evidence
  submitting: false,
  restoring: false,
  connection: null, // message when polling lost the server
  editing: false, // "Adjust requirements" is open
  watch: 0, // increments to cancel an older polling loop
  startedAt: 0,
};
let uid = 0;

const busy = () =>
  state.submitting || state.status === "queued" || state.status === "running";

/* ---------- DOM helpers ---------- */

function h(tag, props, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(props || {})) {
    if (value === undefined || value === null || value === false) continue;
    if (key === "class") node.className = value;
    else if (key === "text") node.textContent = value;
    else if (key in node) node[key] = value;
    else node.setAttribute(key, value === true ? "" : value);
  }
  node.append(
    ...children
      .flat()
      .filter((c) => c !== null && c !== undefined && c !== false),
  );
  return node;
}

function icon(name) {
  const NS = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(NS, "svg");
  svg.setAttribute("aria-hidden", "true");
  svg.setAttribute("class", "icon");
  const use = document.createElementNS(NS, "use");
  use.setAttribute("href", `#i-${name}`);
  svg.append(use);
  return svg;
}

function chip(value) {
  const [label, tone, glyph] = STATUS[value];
  return h("span", { class: `chip chip-${tone}` }, icon(glyph), label);
}

function externalLink(url, label, className) {
  if (!/^https?:\/\//i.test(String(url)))
    return h("span", { class: className, text: label });
  return h(
    "a",
    {
      class: className,
      href: url,
      target: "_blank",
      rel: "noopener noreferrer",
    },
    h("span", { text: label }),
    icon("external"),
    h("span", { class: "visually-hidden", text: " (opens in a new tab)" }),
  );
}

const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;
const announce = (text) => ($("notice").textContent = text);
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const link = (view, text) => h("a", { href: `#/${view}`, text });
const linkButton = (view, label, primary) =>
  h("a", {
    class: `btn ${primary ? "btn-primary" : "btn-outline-secondary"}`,
    href: `#/${view}`,
    text: label,
  });
const actionButton = (action, label, primary) =>
  h("button", {
    type: "button",
    class: `btn ${primary ? "btn-primary" : "btn-outline-secondary"}`,
    "data-action": action,
    disabled: state.submitting,
    text: label,
  });
const elapsedText = () =>
  `${Math.floor((Date.now() - state.startedAt) / 1000)}s elapsed`;

function panel({ tone, title, text, working, detail, extra, actions = [] }) {
  const node = h("div", {
    class: `state-panel${tone ? ` state-${tone}` : ""}`,
  });
  if (working)
    node.append(
      h(
        "div",
        { class: "state-busy" },
        h("span", {
          class: "spinner-border spinner-border-sm",
          "aria-hidden": "true",
        }),
        state.startedAt
          ? h("span", { class: "elapsed", text: elapsedText() })
          : null,
      ),
    );
  node.append(h("h2", { text: title }), h("p", { text }));
  if (detail) node.append(h("p", { class: "state-detail", text: detail }));
  if (extra) node.append(extra);
  if (actions.length)
    node.append(h("div", { class: "state-actions" }, ...actions));
  return node;
}

const formatDate = (iso) => {
  const [y, m, d] = String(iso).split("-").map(Number);
  return new Date(y, m - 1, d).toLocaleDateString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
};

/* ---------- The current job ---------- */

const suppliersOf = () => state.result?.suppliers || [];
const assessmentsOf = () => state.result?.assessments || [];

/* Interpreted requirements are authoritative once they exist. Jobs saved
   before interpretation existed only carry the submitted request. */
const requirementsOf = () =>
  state.result?.requirements || state.request?.requirements || null;

/* Must-haves first; these numbers label requirements across the page. */
function criteriaOf() {
  const all = requirementsOf()?.criteria || [];
  return [
    ...all.filter((c) => c.kind === "mandatory"),
    ...all.filter((c) => c.kind !== "mandatory"),
  ].map((c, i) => ({ ...c, number: i + 1 }));
}

function applyJob(id, job) {
  state.status = ["queued", "running", "completed"].includes(job.status)
    ? job.status
    : "failed";
  state.result = job.result || null;
  state.request = job.request || state.request;
  state.error =
    state.status === "failed"
      ? job.error ||
        "Research was interrupted. Retry to start it again; saved sources are reused where possible."
      : null;
  if (state.status !== "completed") return;
  // Only finished jobs with suppliers may lend their evidence to a re-check.
  if (state.request?.stage === "evaluate")
    state.evidenceJobId = state.request.discovery_job_id || null;
  else state.evidenceJobId = suppliersOf().length ? id : null;
}

function rememberJob(id) {
  try {
    if (id) localStorage.setItem(JOB_KEY, id);
    else localStorage.removeItem(JOB_KEY);
  } catch {
    announce(
      "Browser storage is unavailable. Keep this tab open to keep following your research.",
    );
  }
}
function recalledJob() {
  try {
    return localStorage.getItem(JOB_KEY);
  } catch {
    return null;
  }
}
/* A saved job only keeps the destination as text; the map selection behind
   it is remembered here so the dialog can reopen with it. */
function rememberArea(value) {
  try {
    if (value) localStorage.setItem(AREA_KEY, JSON.stringify(value));
    else localStorage.removeItem(AREA_KEY);
  } catch {
    /* not essential */
  }
}
function recalledArea(text) {
  try {
    const saved = JSON.parse(localStorage.getItem(AREA_KEY));
    return saved && deliveryText(saved) === text ? saved : null;
  } catch {
    return null;
  }
}

/* ---------- Brief form ---------- */

/* Criteria are left out on purpose: the backend interprets the brief. */
function readForm() {
  return {
    requirements: {
      product: $("product").value.trim(),
      quantity: Number($("quantity").value),
      quantity_unit:
        $("unit").value === "custom"
          ? $("unit-custom").value.trim()
          : $("unit").value,
      delivery_country: area ? deliveryText(area) : "",
      needed_by: $("needed-by").value || null, // null means flexible
      other_requirements: $("other").value.trim(),
    },
  };
}

function fillForm(requirements) {
  $("product").value = requirements.product ?? "";
  $("quantity").value = requirements.quantity ?? "";
  const unit = requirements.quantity_unit || "pieces";
  $("unit").value = UNITS.includes(unit) ? unit : "custom";
  $("unit-custom").value = UNITS.includes(unit) ? "" : unit;
  const destination = requirements.delivery_country || "";
  setArea(
    destination
      ? recalledArea(destination) || { type: "text", text: destination }
      : null,
  );
  $("needed-by").value = requirements.needed_by || "";
  $("other").value = requirements.other_requirements || "";
}

function clearFieldError(errorId, controlId) {
  $(errorId).hidden = true;
  $(errorId).textContent = "";
  if (controlId) $(controlId).removeAttribute("aria-invalid");
}
function clearErrors() {
  for (const node of $("brief-form").querySelectorAll(".field-error"))
    clearFieldError(node.id);
  for (const node of $("brief-form").querySelectorAll("[aria-invalid]"))
    node.removeAttribute("aria-invalid");
  $("form-error").hidden = true;
}
function fieldError(errorId, controlId, message) {
  const node = $(errorId);
  node.textContent = node.textContent
    ? `${node.textContent} ${message}`
    : message;
  node.hidden = false;
  if (controlId) $(controlId).setAttribute("aria-invalid", "true");
}
function focusFirstError() {
  const invalid = $("brief-form").querySelector("[aria-invalid]");
  (invalid || $("form-error")).focus();
}

/* Server validation: known paths go to their field, the rest to the form. */
function showServerErrors(message, fields) {
  clearErrors();
  const unmatched = [];
  for (const { path, message: detail } of fields || []) {
    const target = FIELD_ERRORS[path];
    if (target) fieldError(target[0], target[1], detail);
    else unmatched.push(detail);
  }
  if (unmatched.length || !fields?.length) {
    $("form-error").textContent = [message, ...unmatched]
      .filter(Boolean)
      .join(" ");
    $("form-error").hidden = false;
  }
  focusFirstError();
}

function validateForm() {
  clearErrors();
  const { requirements } = readForm();
  if (!requirements.product)
    fieldError("product-error", "product", "Describe what you need.");
  if (!(requirements.quantity > 0) || !Number.isFinite(requirements.quantity))
    fieldError(
      "quantity-error",
      "quantity",
      "Enter a quantity greater than 0. Decimals are allowed.",
    );
  if (!requirements.quantity_unit)
    fieldError("quantity-error", "unit-custom", "Enter a unit.");
  if (!area)
    fieldError(
      "area-error",
      "area-open",
      "Select a delivery destination on the map.",
    );
  if ($("needed-by").validity?.badInput)
    fieldError("needed-by-error", "needed-by", "Enter a complete date.");
  if (!$("brief-form").querySelector("[aria-invalid]")) return true;
  go("brief");
  focusFirstError();
  return false;
}

/* ---------- Requests ---------- */

class RequestError extends Error {
  constructor(message, status, fields) {
    super(message);
    this.status = status;
    this.fields = fields;
  }
}

async function postResearch(body) {
  const csrf = document.cookie
    .split("; ")
    .find((x) => x.startsWith("csrftoken="))
    ?.split("=")[1];
  let response;
  try {
    response = await fetch("/api/research/", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-CSRFToken": csrf || "",
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(30000),
    });
  } catch {
    throw new RequestError(
      "The server could not be reached. Check your connection and try again.",
    );
  }
  const data = await response.json().catch(() => null);
  if (response.ok && data?.job_id) return data;
  throw new RequestError(
    data?.error ||
      {
        403: "This page is out of date or your session expired. Reload the page and submit again; your entries stay in the form until you do.",
        413: "The request is too large.",
        429: "The research queue is full. Try again in a few minutes.",
      }[response.status] ||
      "The server could not start the research. Try again.",
    response.status,
    data?.fields,
  );
}

async function fetchJob(id) {
  const response = await fetch(`/api/research/${encodeURIComponent(id)}/`, {
    cache: "no-store",
    signal: AbortSignal.timeout(20000),
  });
  const job = await response.json().catch(() => null);
  if (!response.ok || !job)
    throw new RequestError(
      job?.error || "Could not load the research.",
      response.status,
    );
  return job;
}

/* origin: "brief" (new research), "editor" (re-check with edited
   requirements) or "retry" (same request again). */
async function startResearch(payload, origin) {
  if (busy()) return;
  state.submitting = true;
  try {
    render();
    const job = await postResearch(payload);
    state.watch++; // stop following any earlier job
    Object.assign(state, {
      jobId: job.job_id,
      status: "queued",
      result: null,
      request: { ...payload, stage: "research" },
      error: null,
      recommendationError: null,
      payload,
      connection: null,
      editing: false,
      startedAt: Date.now(),
    });
    // Evidence collected for a different brief must not be reused.
    if (!payload.discovery_job_id) state.evidenceJobId = null;
    rememberJob(job.job_id);
    go("results");
    announce("Research started.");
    watchJob(job.job_id);
  } catch (e) {
    if (origin === "brief") showServerErrors(e.message, e.fields);
    else if (origin === "editor") {
      $("editor-error").textContent = [
        e.message,
        ...(e.fields || []).map((f) => f.message),
      ].join(" ");
      $("editor-error").hidden = false;
      $("editor-error").focus();
    } else if (origin === "recommendation")
      state.recommendationError = e.message;
    else state.error = e.message;
    announce("The research could not be started.");
  } finally {
    state.submitting = false;
    render();
  }
}

async function watchJob(id) {
  const watch = ++state.watch;
  let failures = 0;
  let seen = "";
  for (;;) {
    let job = null;
    try {
      job = await fetchJob(id);
    } catch (e) {
      if (watch !== state.watch) return;
      if (e.status === 404) {
        rememberJob(null);
        Object.assign(state, {
          status: "failed",
          restoring: false,
          error:
            "This research is no longer saved on the server. Start a new search.",
        });
        return render();
      }
      if (++failures >= 3) {
        state.restoring = false;
        state.connection =
          "The server could not be reached. Research that was running continues on the server.";
        return render();
      }
    }
    if (watch !== state.watch) return;
    if (job) {
      failures = 0;
      const first = state.restoring;
      if (first) {
        state.restoring = false;
        state.payload = {
          requirements: job.request?.requirements,
          options: job.request?.options,
          ...(job.request?.discovery_job_id
            ? { discovery_job_id: job.request.discovery_job_id }
            : {}),
        };
      }
      applyJob(id, job);
      if (first && requirementsOf()) fillForm(requirementsOf());
      // Re-render only when something changed, so open panels stay open.
      const signature = JSON.stringify([job.status, job.result, job.error]);
      if (signature !== seen || first) {
        seen = signature;
        render();
      }
      if (!busy()) {
        return announce(
          state.status === "completed"
            ? `Research finished. ${plural((state.result?.recommended_supplier_ids || []).length, "supplier", "suppliers")} shortlisted.`
            : "Research did not finish.",
        );
      }
    }
    await wait(POLL_MS);
    if (watch !== state.watch) return;
  }
}

/* Reconnect to the job this browser last followed. */
function restore(id) {
  Object.assign(state, {
    jobId: id,
    restoring: true,
    connection: null,
    startedAt: 0,
  });
  render();
  watchJob(id);
}

/* ---------- Rendering ---------- */

function render() {
  const locked = busy() || state.restoring;
  $("brief-fields").disabled = locked;
  for (const node of document.querySelectorAll("[data-busy-lock]"))
    node.disabled = locked;
  $("unit-custom-field").hidden = $("unit").value !== "custom";
  renderBriefNote();
  renderSummary();
  renderResultsState();
  renderRequirements();
  renderResults();
  renderContactRecommendations();
  renderPerformance();
  renderNotes();
  renderCoverage();
  renderSources();
  const researchDetails = $("research-details");
  if (researchDetails)
    researchDetails.hidden = busy() || state.restoring || !state.result;
  if (busy()) {
    for (const id of [
      "requirements-block",
      "results-content",
      "contact-recommendations",
      "decision-performance",
      "notes-block",
      "coverage",
    ]) {
      $(id).hidden = true;
    }
  }
}

/* Without a step bar, this note links the brief to the research it started. */
function renderBriefNote() {
  const box = $("brief-note");
  let text = "";
  let links = [];
  if (state.restoring) text = "Restoring your saved research…";
  else if (busy() && state.jobId) {
    text =
      "Research for this brief is running. The form is locked until it finishes.";
    links = [link("results", "View progress")];
  } else if (state.status === "completed") {
    text =
      "Your latest search is saved. Changing these details and choosing Find my shortlist starts new research and reads your requirements again.";
    links = [
      link("results", "View shortlist"),
      suppliersOf().length ? link("sources", "View sources") : null,
    ];
  } else if (state.status === "failed") {
    text = "The last research did not finish.";
    links = [link("results", "View details")];
  }
  box.hidden = !text;
  if (text)
    box.replaceChildren(
      h("p", { text }),
      h("span", { class: "note-links" }, links),
    );
}

function renderSummary() {
  const r = requirementsOf();
  for (const box of document.querySelectorAll("[data-brief-summary]")) {
    box.hidden = !r;
    if (!r) continue;
    const onResults = box.closest("[data-view]").dataset.view === "results";
    const item = (term, value) =>
      h("div", null, h("dt", { text: term }), h("dd", { text: value }));
    box.replaceChildren(
      h(
        "dl",
        null,
        item("Product", r.product),
        item(
          "Quantity",
          `${Number(r.quantity).toLocaleString()} ${r.quantity_unit || "pieces"}`,
        ),
        item("Delivery destination", r.delivery_country),
        item("Needed by", r.needed_by ? formatDate(r.needed_by) : "Flexible"),
      ),
      h(
        "span",
        { class: "note-links" },
        link("brief", "Edit brief"),
        onResults
          ? suppliersOf().length
            ? link("sources", "View sources")
            : null
          : link("results", "View shortlist"),
      ),
    );
  }
}

function renderResultsState() {
  const box = $("results-state");
  box.replaceChildren();
  if (state.restoring)
    return box.append(
      panel({
        working: true,
        title: "Restoring your saved research",
        text: "Reconnecting to the research this browser last followed.",
      }),
    );
  if (state.connection)
    return box.append(
      panel({
        tone: "error",
        title: "Connection lost",
        text: state.connection,
        actions: [actionButton("reconnect", "Reconnect", true)],
      }),
    );
  if (!state.jobId)
    return box.append(
      panel({
        title: "No research yet",
        text: "Fill in the brief and choose Find my shortlist. Progress and results appear here.",
        actions: [linkButton("brief", "Go to the brief", true)],
      }),
    );
  if (busy()) {
    const phase =
      state.status === "running"
        ? PHASES[state.result?.phase]
          ? state.result.phase
          : "interpreting"
        : "queued";
    const crawling =
      phase === "discovery" &&
      ["query_budget", "diminishing_returns"].includes(
        state.result?.coverage?.stop_reason,
      );
    const loading = panel({
      title: crawling ? "Reading supplier websites" : PHASES[phase][0],
      text: crawling
        ? "Gathering the evidence for your shortlist."
        : PHASES[phase][1],
    });
    loading.classList.add("research-loading");
    const candidates = suppliersOf().slice(-3);
    const previews = h("div", {
      class: "loading-preview",
      "aria-hidden": "true",
      inert: "",
    });
    previews.style.setProperty("--preview-delay", `-${Date.now() % 9000}ms`);
    for (let i = 0; i < 3; i++) {
      const supplier = candidates[i];
      previews.append(
        h(
          "div",
          { class: "loading-preview-card" },
          supplier
            ? h("strong", { text: supplier.name })
            : h("span", { class: "preview-skeleton preview-name" }),
          supplier
            ? h("span", { text: supplier.website })
            : h("span", { class: "preview-skeleton preview-url" }),
          h("span", { class: "preview-skeleton preview-line" }),
          h("span", { class: "preview-skeleton preview-line-short" }),
        ),
      );
    }
    const copy = h("div", { class: "loading-copy" }, ...loading.childNodes);
    const count =
      state.result?.coverage?.candidates_found ?? suppliersOf().length;
    if (count)
      copy.append(
        h("p", {
          class: "loading-count",
          text: `${plural(count, "supplier", "suppliers")} discovered · Not yet a final shortlist`,
        }),
      );
    if (state.startedAt)
      copy.append(h("span", { class: "elapsed", text: elapsedText() }));
    loading.append(previews, copy);
    return box.append(loading);
  }
  if (state.status === "failed")
    return box.append(
      panel({
        tone: "error",
        title: "Research did not finish",
        text: state.error,
        detail: suppliersOf().length
          ? "What was collected before it stopped is shown below. It is incomplete: not every supplier or requirement was checked."
          : "Your brief is unchanged. Edit it or try again.",
        actions: [
          linkButton("brief", "Edit brief", !state.payload),
          state.payload ? actionButton("retry", "Retry", true) : null,
        ].filter(Boolean),
      }),
    );
  if (!suppliersOf().length)
    box.append(
      panel({
        title: "No suppliers were found",
        text:
          (state.result?.issues || []).find((i) => i.retryable)?.message ||
          "The search finished without usable supplier sources. Make the description more specific, then search again.",
        actions: [linkButton("brief", "Edit brief", true)],
      }),
    );
}

/* ----- Your requirements ----- */

function renderRequirements() {
  const criteria = criteriaOf();
  const block = $("requirements-block");
  block.hidden = !criteria.length && !state.editing;
  if (block.hidden) return;
  const canAdjust = state.status === "completed" && !!state.evidenceJobId;
  if (!canAdjust) state.editing = false;
  $("adjust").hidden = !canAdjust || state.editing;
  $("requirements-view").hidden = state.editing;
  $("requirements-editor").hidden = !state.editing;
  // A request that already carried criteria was reviewed by the user.
  const reviewed = !!state.request?.requirements?.criteria?.length;
  $("requirements-help").textContent = state.editing
    ? "Edit, add or remove requirements, and decide which are must-haves. Each one should be a single statement a supplier page can confirm or contradict."
    : reviewed
      ? "These are the requirements this shortlist was checked against."
      : "QuotePilot read these from your brief. Product, quantity, destination and date are always must-haves; the others quote your own wording. Check that must-haves and nice-to-haves are sorted the way you meant.";
  const group = (kind) => {
    const items = criteria.filter((c) => c.kind === kind);
    return h(
      "div",
      { class: "requirement-group" },
      h("h3", { text: KINDS[kind] }),
      items.length
        ? h(
            "ol",
            null,
            items.map((c) =>
              h(
                "li",
                null,
                h("span", { class: "legend-n", text: String(c.number) }),
                h("span", { text: c.description }),
              ),
            ),
          )
        : h("p", { class: "help", text: "None." }),
    );
  };
  $("requirements-view").replaceChildren(
    group("mandatory"),
    group("preference"),
  );
}

function addCriterion(criterion) {
  const n = ++uid;
  const text = h("textarea", {
    class: "form-control",
    id: `criterion-text-${n}`,
    rows: 2,
    maxLength: 1000,
    required: true,
    placeholder: "One requirement a supplier page can confirm",
    value: criterion?.description || "",
  });
  const kind = h("div", {
    class: "btn-group btn-group-sm kind",
    role: "group",
    "aria-label": "Requirement type",
  });
  for (const value of ["mandatory", "preference"]) {
    const radio = h("input", {
      type: "radio",
      class: "btn-check",
      name: `criterion-kind-${n}`,
      id: `criterion-kind-${n}-${value}`,
      value,
      checked: value === (criterion?.kind || "mandatory"),
    });
    kind.append(
      radio,
      h("label", {
        class: "btn btn-outline-secondary",
        htmlFor: radio.id,
        text: KINDS[value],
      }),
    );
  }
  const remove = h(
    "button",
    {
      type: "button",
      class: "btn btn-outline-secondary btn-sm remove",
      "aria-label": "Remove requirement",
      title: "Remove requirement",
    },
    icon("trash"),
  );
  const row = h(
    "li",
    { class: "criterion" },
    h(
      "div",
      { class: "criterion-text" },
      h("label", {
        class: "visually-hidden",
        htmlFor: text.id,
        text: "Requirement",
      }),
      text,
    ),
    h("div", { class: "criterion-controls" }, kind, remove),
  );
  // Existing IDs and weights are kept so assessments stay comparable.
  row.dataset.id = criterion?.id || "";
  row.dataset.weight = criterion?.weight ?? 1;
  remove.addEventListener("click", () => {
    row.remove();
    $("add").disabled = false;
    $("add").focus();
  });
  $("criteria").append(row);
  $("add").disabled = $("criteria").children.length >= MAX_CRITERIA;
  return text;
}

function openEditor() {
  $("criteria").replaceChildren();
  $("editor-error").hidden = true;
  $("suggested-box").hidden = true;
  for (const criterion of criteriaOf()) addCriterion(criterion);
  state.editing = true;
  render();
  $("criteria").querySelector("textarea")?.focus();
}

function readEditor() {
  const taken = new Set(
    [...$("criteria").children].map((row) => row.dataset.id).filter(Boolean),
  );
  let next = 1;
  return [...$("criteria").children].map((row) => {
    let id = row.dataset.id;
    if (!id) {
      while (taken.has(`custom_${next}`)) next++;
      id = `custom_${next}`;
      taken.add(id);
    }
    return {
      id,
      description: row.querySelector("textarea").value.trim(),
      kind: row.querySelector("input[type=radio]:checked").value,
      weight: Number(row.dataset.weight) || 1,
    };
  });
}

/* Re-check the saved evidence against the edited requirements. Purchase
   fields are sent back exactly as the job returned them. */
function submitEditor() {
  const criteria = readEditor();
  const problem = !criteria.length
    ? "Add at least one requirement."
    : criteria.some((c) => !c.description)
      ? "Fill in or remove the empty requirement."
      : "";
  $("editor-error").textContent = problem;
  $("editor-error").hidden = !problem;
  if (problem) return $("editor-error").focus();
  const payload = {
    requirements: { ...requirementsOf(), criteria },
    discovery_job_id: state.evidenceJobId,
  };
  if (state.request?.options) payload.options = state.request.options;
  startResearch(payload, "editor");
}

/* ----- Shortlist, comparison, details ----- */

function evidenceBlock(evidence) {
  const kind =
    { pdf: "PDF source passage", page: "Source passage" }[evidence.kind] ||
    "Search summary";
  return h(
    "div",
    { class: "evidence" },
    evidence.title
      ? h("p", { class: "evidence-title", text: evidence.title })
      : null,
    h("p", { class: "excerpt", text: evidence.excerpt }),
    h(
      "div",
      { class: "evidence-meta" },
      externalLink(
        evidence.source_url,
        String(evidence.source_url).replace(/^https?:\/\//i, ""),
        "source",
      ),
      evidence.kind === "search_summary" ? sourceTag("search") : null,
      h("span", {
        text: `${kind} · retrieved ${new Date(evidence.fetched_at).toLocaleString()}`,
      }),
    ),
  );
}

/* Shortlisted first in rank order, then eligible, needs verification,
   not eligible, not evaluated. Within a group: the backend's own ordering. */
function orderedSuppliers(suppliers, assessments, rank) {
  const groups = { eligible: 1, needs_verification: 2, ineligible: 3 };
  const group = (s) =>
    rank.has(s.supplier_id)
      ? 0
      : (groups[assessments.get(s.supplier_id)?.eligibility] ?? 4);
  return [...suppliers].sort((a, b) => {
    const x = assessments.get(a.supplier_id);
    const y = assessments.get(b.supplier_id);
    return (
      group(a) - group(b) ||
      (rank.get(a.supplier_id) ?? 0) - (rank.get(b.supplier_id) ?? 0) ||
      (y?.preference_score ?? 0) - (x?.preference_score ?? 0) ||
      (y?.evidence_coverage ?? 0) - (x?.evidence_coverage ?? 0) ||
      (a.supplier_id < b.supplier_id ? -1 : 1)
    );
  });
}

const mandatoryWith = (assessment, criteria, result) =>
  criteria.filter(
    (c) =>
      c.kind === "mandatory" &&
      assessment.criteria.find((a) => a.criterion_id === c.id)?.result ===
        result,
  );
const numbered = (items) =>
  `${items.length === 1 ? "requirement" : "requirements"} ${items.map((c) => c.number).join(", ")}`;

function eligibilityReason(assessment, criteria, shortlisted) {
  const mandatory = criteria.filter((c) => c.kind === "mandatory").length;
  if (assessment.eligibility === "ineligible")
    return `Not eligible: the evidence contradicts must-have ${numbered(mandatoryWith(assessment, criteria, "fail"))}. Nice-to-haves cannot offset this.`;
  if (assessment.eligibility === "needs_verification")
    return `Needs verification: the collected pages do not clearly confirm must-have ${numbered(mandatoryWith(assessment, criteria, "unknown"))}. This is not a pass; confirm it with the supplier.`;
  const basis = mandatory
    ? `Eligible: the evidence supports ${mandatory === 1 ? "the must-have" : `all ${mandatory} must-haves`}.`
    : "Eligible: there are no must-haves, so nothing gates this supplier.";
  return shortlisted
    ? basis
    : `${basis} Not shortlisted because three suppliers rank higher.`;
}

function clarificationDraft(supplier, unknown, r) {
  const destination = /^(within|worldwide)\b/i.test(r.delivery_country)
    ? r.delivery_country
    : `to ${r.delivery_country}`;
  const deadline = r.needed_by ? `, needed by ${formatDate(r.needed_by)}` : "";
  return `Hello ${supplier.name},\n\nWe are sourcing ${r.quantity} ${r.quantity_unit || "pieces"} of ${r.product} for delivery ${destination}${deadline}. Please confirm:\n\n${unknown.map((c) => `• ${c.description}`).join("\n")}\n\nPlease include supporting documentation and current commercial terms.\n\nThank you.`;
}

const detailTargets = new Map();

function renderContactRecommendations() {
  $("recommendation-overview")?.remove();
  const host = $("contact-recommendations");
  const report = state.result?.recommendation_report;
  const issue = (state.result?.issues || []).find(
    (i) => i.stage === "recommendation",
  );
  host.hidden =
    state.status !== "completed" ||
    state.restoring ||
    (!report && !suppliersOf().length && !issue);
  if (host.hidden) return;
  const expanded = new Set(
    [...host.querySelectorAll("details[open]")].map((node) => node.dataset.key),
  );
  host.replaceChildren(
    h(
      "div",
      { class: "block-head" },
      h("h2", { id: "contact-title", text: "Suppliers to contact" }),
    ),
  );
  if (!report) {
    if (state.recommendationError)
      host.append(
        h("p", {
          class: "note note-error",
          role: "alert",
          text: state.recommendationError,
        }),
      );
    host.append(
      panel({
        title: issue
          ? "Recommendations could not be prepared"
          : "No recommendations saved for this run",
        text: "Your research and grades are available below. Recheck the saved evidence to prepare recommendations and email drafts.",
        actions: state.evidenceJobId
          ? [
              actionButton(
                "retry-recommendations",
                "Prepare recommendations",
                true,
              ),
            ]
          : [],
      }),
    );
    return;
  }
  const researchDetails = $("research-details");
  if (researchDetails)
    researchDetails.append(
      h(
        "div",
        { id: "recommendation-overview", class: "content-block" },
        h("h2", { text: "Recommendation summary" }),
        h("p", { class: "contact-summary", text: report.summary }),
      ),
    );
  if (report.no_eligible_suppliers && report.recommendations.length)
    host.append(
      h("p", {
        class: "contact-intro",
        text: "These suppliers still need to confirm your requirements.",
      }),
    );
  if (!report.recommendations.length) {
    host.append(
      h("p", {
        class: "help",
        text: "No supplier was recommended for contact. Review the evidence or refine your brief before searching again.",
      }),
      linkButton("brief", "Edit brief"),
    );
    return;
  }
  const list = h("div", {
    class: "contact-list",
    "aria-label": "Supplier recommendations",
  });
  report.recommendations.forEach((recommendation, index) => {
    const supplier = suppliersOf().find(
      (s) => s.supplier_id === recommendation.supplier_id,
    );
    if (!supplier) return;
    const evidence = supplier.evidence || [];
    const article = h("article", { class: "contact-item" });
    const qualified =
      recommendation.qualification === "meets_documented_requirements";
    article.append(
      h(
        "div",
        { class: "contact-heading" },
        h("h3", { text: `${index + 1}. ${supplier.name}` }),
        h("p", {
          class: "contact-status",
          text: qualified
            ? "Meets documented requirements"
            : "Requirements not yet verified",
        }),
      ),
    );
    article.append(
      h(
        "ul",
        { class: "contact-reasons" },
        recommendation.reasons.map((reason) =>
          h(
            "li",
            null,
            h("p", { text: reason.text }),
            h(
              "span",
              { class: "contact-citations" },
              reason.evidence_ids.map((id) => {
                const sourceIndex = evidence.findIndex((e) => e.id === id);
                return sourceIndex < 0
                  ? null
                  : externalLink(
                      evidence[sourceIndex].source_url,
                      `Source ${sourceIndex + 1}`,
                    );
              }),
            ),
          ),
        ),
      ),
    );
    const reasons = article.querySelector(".contact-reasons");
    const strengths = h(
      "section",
      { class: "contact-strengths" },
      h("h4", { text: "Why consider this supplier" }),
      reasons,
    );
    const checks = h(
      "section",
      { class: "contact-checks" },
      h("h4", { text: "What to check before ordering" }),
    );
    if (recommendation.tradeoffs.length)
      checks.append(
        h(
          "ul",
          null,
          recommendation.tradeoffs.map((text) => h("li", { text })),
        ),
      );
    else
      checks.append(
        h("p", {
          text: "Confirm current pricing, availability and delivery with the supplier.",
        }),
      );
    if (recommendation.verification_questions.length)
      checks.append(
        h("p", {
          class: "contact-question-note",
          text: `${plural(recommendation.verification_questions.length, "open question", "open questions")} for the supplier — included in the email draft.`,
        }),
      );
    article.append(
      h("div", { class: "contact-evaluation" }, strengths, checks),
    );
    const key = `${supplier.supplier_id}-email`;
    const id = `contact-email-${index}`;
    const draft = recommendation.email_draft;
    article.append(
      h(
        "details",
        { class: "contact-email", "data-key": key, open: expanded.has(key) },
        h("summary", { text: "Review & email supplier" }),
        h(
          "div",
          { class: "block-head" },
          h("label", { htmlFor: id, text: `Email draft for ${supplier.name}` }),
          h(
            "button",
            {
              type: "button",
              class: "btn btn-outline-secondary btn-sm btn-icon",
              "data-action": "copy",
              "data-target": id,
            },
            icon("copy"),
            h("span", { text: "Copy draft" }),
          ),
        ),
        h("p", {
          class: "help",
          text: "Add the recipient and review the message in your email app before sending.",
        }),
        h("a", {
          class: "btn btn-primary contact-compose",
          href: `mailto:?subject=${encodeURIComponent(draft.subject)}&body=${encodeURIComponent(draft.body)}`,
          text: "Open in email app",
        }),
        h("textarea", {
          id,
          class: "form-control",
          readOnly: true,
          rows: 8,
          value: `Subject: ${draft.subject}\n\n${draft.body}`,
        }),
      ),
    );
    list.append(article);
  });
  const cards = [...list.children];
  if (!cards.length) return;
  if (host.dataset.deckJob !== state.jobId) {
    host.dataset.deckJob = state.jobId;
    host.dataset.deckIndex = "0";
    host.dataset.deckMode = "stack";
  }
  let current = Math.min(Number(host.dataset.deckIndex) || 0, cards.length - 1);
  const position = h("span", {
    class: "contact-position",
    role: "status",
    "aria-live": "polite",
  });
  const previous = h("button", {
    type: "button",
    class: "btn btn-outline-secondary",
    text: "Previous",
    "aria-label": "Previous recommendation",
  });
  const next = h("button", {
    type: "button",
    class: "btn btn-outline-secondary",
    text: "Next",
    "aria-label": "Next recommendation",
  });
  let fullList = host.dataset.deckMode === "list";
  const toggle = h("button", {
    type: "button",
    class: "btn btn-outline-secondary",
  });
  const show = () => {
    cards.forEach((card, index) => {
      card.hidden = !fullList && index !== current;
    });
    host.dataset.deckMode = fullList ? "list" : "stack";
    list.classList.toggle("has-stack", !fullList && cards.length > 1);
    list.classList.toggle("is-full-list", fullList);
    previous.hidden = next.hidden = fullList;
    toggle.textContent = fullList ? "Back to card stack" : "View full list";
    host.dataset.deckIndex = String(current);
    position.textContent = fullList
      ? `${cards.length} recommendations`
      : `${current + 1} of ${cards.length} recommendations`;
    previous.disabled = current === 0;
    next.disabled = current === cards.length - 1;
  };
  previous.addEventListener("click", () => {
    current--;
    show();
  });
  next.addEventListener("click", () => {
    current++;
    show();
  });
  toggle.addEventListener("click", () => {
    fullList = !fullList;
    show();
  });
  show();
  host.append(
    h(
      "div",
      { class: "contact-deck-controls" },
      position,
      previous,
      next,
      toggle,
    ),
    list,
  );
}

function renderSummaryPanel(context) {
  const { suppliers, assessments, rank, criteria, preferenceCount, score } =
    context;
  const all = [...assessments.values()];
  const tally = (value) => all.filter((a) => a.eligibility === value).length;
  const chosen = suppliers.filter((s) => rank.has(s.supplier_id));
  const unconfirmed = suppliers.filter(
    (s) => assessments.get(s.supplier_id)?.eligibility === "needs_verification",
  );
  const summary = $("recommendation");
  summary.classList.toggle("is-empty", !chosen.length);
  summary.replaceChildren(
    h(
      "div",
      { class: "summary-head" },
      h("h2", {
        text: chosen.length
          ? `${plural(chosen.length, "supplier", "suppliers")} shortlisted`
          : unconfirmed.length
            ? "No supplier is confirmed yet"
            : "No supplier is ready for the shortlist",
      }),
      sourceTag("rules"),
    ),
  );
  if (chosen.length)
    summary.append(
      h(
        "ol",
        { class: "ranked" },
        chosen.map((s) =>
          h(
            "li",
            null,
            h("strong", { text: s.name }),
            preferenceCount
              ? h("span", {
                  text: `Nice-to-have score ${score(assessments.get(s.supplier_id))}`,
                })
              : null,
          ),
        ),
      ),
    );
  summary.append(
    h("p", {
      text: !all.length
        ? "None of the suppliers could be assessed. See the research notes below, then retry."
        : chosen.length
          ? `These suppliers meet every must-have that their pages could confirm${preferenceCount ? " and rank highest on your nice-to-haves" : ""}. Check the sources and request quotations before deciding.`
          : unconfirmed.length
            ? "No supplier’s pages confirm every must-have. That is common for order details such as quantity, delivery and dates, which suppliers rarely publish."
            : "Every assessed supplier contradicts at least one must-have. Review the details below, or adjust the requirements and update the shortlist.",
    }),
  );
  if (unconfirmed.length) {
    const shown = unconfirmed.slice(0, 6);
    summary.append(
      h(
        "div",
        { class: "unconfirmed" },
        h("h3", { text: "Needs supplier confirmation" }),
        h("p", {
          text: `${plural(unconfirmed.length, "supplier matches", "suppliers match")} what could be checked, but ${unconfirmed.length === 1 ? "its" : "their"} pages leave must-haves open. Ask the supplier to confirm them; a clarification draft is in each supplier’s details.`,
        }),
        h(
          "ul",
          null,
          shown.map((s) =>
            h(
              "li",
              null,
              h("strong", { text: s.name }),
              h("span", {
                text: `Open: ${numbered(mandatoryWith(assessments.get(s.supplier_id), criteria, "unknown"))}`,
              }),
            ),
          ),
        ),
        unconfirmed.length > shown.length
          ? h("p", {
              class: "help",
              text: `And ${unconfirmed.length - shown.length} more in the comparison below.`,
            })
          : null,
      ),
    );
  }
  summary.append(
    h(
      "ul",
      { class: "tally" },
      [
        ["eligible", tally("eligible")],
        ["needs_verification", tally("needs_verification")],
        ["ineligible", tally("ineligible")],
        ["not_evaluated", suppliers.length - all.length],
      ]
        .filter(([, n]) => n > 0)
        .map(([value, n]) =>
          h("li", null, h("strong", { text: String(n) }), chip(value)),
        ),
    ),
    h("p", {
      class: "caveat",
      text: "QuotePilot reports what supplier pages state. It does not guarantee order capacity or delivery dates; confirm both with the supplier before ordering.",
    }),
  );
}

function renderResults() {
  const all = assessmentsOf();
  const done = state.status === "completed";
  $("results-content").hidden = !all.length || state.restoring;
  if ($("results-content").hidden) return ($("recommendation").hidden = true);

  const r = requirementsOf();
  const criteria = criteriaOf();
  const mandatoryCount = criteria.filter((c) => c.kind === "mandatory").length;
  const preferenceCount = criteria.length - mandatoryCount;
  const assessments = new Map(all.map((a) => [a.supplier_id, a]));
  // The shortlist is only final once the job has completed.
  const rank = new Map(
    (done ? state.result.recommended_supplier_ids || [] : []).map((id, i) => [
      id,
      i + 1,
    ]),
  );
  // While research runs, list only suppliers that already have a result.
  const suppliers = orderedSuppliers(
    suppliersOf().filter((s) => done || assessments.has(s.supplier_id)),
    assessments,
    rank,
  );
  const issues = state.result?.issues || [];
  const score = (a) =>
    preferenceCount ? `${Math.round(a.preference_score)} / 100` : "n/a";

  $("recommendation").hidden = !done;
  if (done)
    renderSummaryPanel({
      suppliers,
      assessments,
      rank,
      criteria,
      preferenceCount,
      score,
    });
  const progress = $("comparison-progress");
  progress.hidden = done;
  progress.textContent = busy()
    ? state.result?.phase === "recommendation"
      ? "Grading is complete. Recommendations and email drafts are being prepared."
      : `Evaluation is still running: ${all.length} of ${plural(suppliersOf().length, "supplier", "suppliers")} assessed so far. The shortlist appears when it finishes.`
    : "Research stopped before every supplier was assessed. This comparison is incomplete and no shortlist was built.";

  /* Comparison matrix */
  const groupRow = h(
    "tr",
    null,
    h("th", { colSpan: 5, class: "group-blank" }),
    mandatoryCount
      ? h("th", {
          colSpan: mandatoryCount,
          scope: "colgroup",
          class: "group",
          text: "Must have",
        })
      : null,
    preferenceCount
      ? h("th", {
          colSpan: preferenceCount,
          scope: "colgroup",
          class: "group",
          text: "Nice to have",
        })
      : null,
  );
  const headRow = h(
    "tr",
    null,
    h("th", { scope: "col", class: "num", text: "Rank" }),
    h("th", { scope: "col", text: "Supplier" }),
    h("th", { scope: "col", text: "Eligibility" }),
    h("th", { scope: "col", class: "num", text: "Nice-to-have score" }),
    h("th", { scope: "col", class: "num", text: "Evidence coverage" }),
    criteria.map((c) =>
      h(
        "th",
        { scope: "col", class: "crit", title: c.description },
        h("span", { "aria-hidden": "true", text: String(c.number) }),
        h("span", {
          class: "visually-hidden",
          text: `Requirement ${c.number}: ${c.description}`,
        }),
      ),
    ),
  );
  const body = h("tbody");
  for (const s of suppliers) {
    const a = assessments.get(s.supplier_id);
    const place = rank.get(s.supplier_id);
    const row = h(
      "tr",
      { class: place ? "is-shortlisted" : "" },
      h(
        "td",
        { class: "num rank" },
        place
          ? h("span", { class: "rank-n", text: String(place) })
          : h("span", { class: "visually-hidden", text: "Not shortlisted" }),
      ),
      h("th", { scope: "row", text: s.name }),
      h("td", null, chip(a ? a.eligibility : "not_evaluated")),
      h("td", { class: "num", text: a ? score(a) : "—" }),
      h("td", {
        class: "num",
        text: a ? `${Math.round(a.evidence_coverage * 100)}%` : "—",
      }),
    );
    for (const c of criteria) {
      const outcome = a?.criteria.find((x) => x.criterion_id === c.id)?.result;
      if (!outcome) {
        row.append(h("td", { class: "crit", text: "—" }));
        continue;
      }
      const [label, tone, glyph] = STATUS[outcome];
      const button = h(
        "button",
        {
          type: "button",
          class: `cell cell-${tone}`,
          title: `${label}: ${c.description}`,
          "aria-label": `${label}. ${s.name}, requirement ${c.number}. Show evidence.`,
        },
        icon(glyph),
      );
      button.addEventListener("click", () =>
        openDetail(`${s.supplier_id}|${c.id}`),
      );
      row.append(h("td", { class: "crit" }, button));
    }
    body.append(row);
  }
  $("comparison").replaceChildren(
    h(
      "div",
      { class: "table-responsive" },
      h(
        "table",
        { class: "table matrix" },
        h(
          "caption",
          { class: "visually-hidden" },
          "Suppliers compared by eligibility, nice-to-have score, evidence coverage and the result for each requirement.",
        ),
        h("thead", null, groupRow, headRow),
        body,
      ),
    ),
  );

  /* Assessment details; panels the user opened stay open across updates. */
  const open = new Set(
    [...$("details").querySelectorAll(".accordion-collapse.show")].map(
      (node) => node.dataset.supplier,
    ),
  );
  detailTargets.clear();
  const accordion = h("div", { class: "accordion" });
  suppliers.forEach((s, index) => {
    const a = assessments.get(s.supplier_id);
    const place = rank.get(s.supplier_id);
    const id = `detail-${index}`;
    const isOpen = open.has(s.supplier_id);
    const collapse = h("div", {
      class: `accordion-collapse collapse${isOpen ? " show" : ""}`,
      id,
      "aria-labelledby": `${id}-button`,
    });
    collapse.dataset.supplier = s.supplier_id;
    const content = h("div", { class: "accordion-body" });
    content.append(
      ...[fitLine(s), "price" in s ? priceLine(s) : null].filter(Boolean),
    );
    if (a) {
      content.append(
        h("p", {
          class: "reason",
          text: eligibilityReason(a, criteria, !!place),
        }),
      );
      for (const c of criteria) {
        const item = a.criteria.find((x) => x.criterion_id === c.id);
        if (!item) continue;
        const block = h(
          "div",
          { class: "assessment", tabIndex: -1 },
          h(
            "div",
            { class: "assessment-head" },
            h("span", { class: "legend-n", text: String(c.number) }),
            h("h3", { text: c.description }),
            chip(item.result),
          ),
          h(
            "p",
            { class: "assessment-meta" },
            h("span", {
              class: `kind-tag kind-${c.kind}`,
              text: KINDS[c.kind],
            }),
            sourceTag("decision"),
            h("span", { text: item.explanation }),
          ),
          item.decisions?.length
            ? decisionAnswers(item.decisions, s.evidence || [])
            : null,
          (item.evidence_ids || [])
            .map((eid) => (s.evidence || []).find((e) => e.id === eid))
            .filter(Boolean)
            .map(evidenceBlock),
        );
        detailTargets.set(`${s.supplier_id}|${c.id}`, { collapse, block });
        content.append(block);
      }
      const unknown = criteria.filter(
        (c) =>
          a.criteria.find((x) => x.criterion_id === c.id)?.result === "unknown",
      );
      if (unknown.length && r) {
        const draft = h("textarea", {
          class: "form-control",
          id: `${id}-draft`,
          readOnly: true,
          rows: 9,
          value: clarificationDraft(s, unknown, r),
        });
        content.append(
          h(
            "div",
            { class: "draft" },
            h(
              "div",
              { class: "block-head" },
              h(
                "h3",
                null,
                h("label", { htmlFor: draft.id, text: "Clarification draft" }),
              ),
              h(
                "button",
                {
                  type: "button",
                  class: "btn btn-outline-secondary btn-sm btn-icon",
                  "data-action": "copy",
                  "data-target": draft.id,
                },
                icon("copy"),
                h("span", { text: "Copy draft" }),
              ),
            ),
            draft,
            h("p", {
              class: "help",
              text: "Asks the supplier about the requirements rated unknown. Review it and copy it into your own email; QuotePilot does not send messages.",
            }),
          ),
        );
      }
    } else {
      const own = issues.filter((issue) => issue.supplier_id === s.supplier_id);
      content.append(
        h("p", {
          class: "reason",
          text: own.length
            ? `Not evaluated: ${own.map((i) => i.message).join(" ")} This is not a failed requirement.`
            : "Not evaluated: no assessment was returned for this supplier. This is not a failed requirement.",
        }),
      );
    }
    content.append(
      h(
        "p",
        { class: "help" },
        `${plural((s.evidence || []).length, "source passage was", "source passages were")} collected for this supplier. `,
        link("sources", "See all sources"),
      ),
    );
    collapse.append(content);
    accordion.append(
      h(
        "div",
        { class: "accordion-item" },
        h(
          "h3",
          { class: "accordion-header" },
          h(
            "button",
            {
              type: "button",
              class: `accordion-button${isOpen ? "" : " collapsed"}`,
              id: `${id}-button`,
              "data-bs-toggle": "collapse",
              "data-bs-target": `#${id}`,
              "aria-expanded": String(isOpen),
              "aria-controls": id,
            },
            h("span", { class: "detail-name", text: s.name }),
            place
              ? h("span", { class: "detail-rank", text: `Rank ${place}` })
              : null,
            chip(a ? a.eligibility : "not_evaluated"),
          ),
        ),
        collapse,
      ),
    );
  });
  $("details").replaceChildren(accordion);
}

/* Open a supplier's details at one requirement (from a matrix cell). */
function openDetail(key) {
  const target = detailTargets.get(key);
  if (!target) return;
  const reveal = () => {
    target.block.scrollIntoView({ block: "center", behavior: "smooth" });
    target.block.focus({ preventScroll: true });
    target.block.classList.remove("flash");
    void target.block.offsetWidth; // restart the highlight
    target.block.classList.add("flash");
  };
  if (target.collapse.classList.contains("show") || !window.bootstrap) {
    target.collapse.classList.add("show");
    return reveal();
  }
  target.collapse.addEventListener("shown.bs.collapse", reveal, { once: true });
  window.bootstrap.Collapse.getOrCreateInstance(target.collapse, {
    toggle: false,
  }).show();
}

async function copyDraft(button) {
  const field = $(button.dataset.target);
  let copied = false;
  try {
    await navigator.clipboard.writeText(field.value);
    copied = true;
  } catch {
    field.focus();
    field.select();
    try {
      copied = document.execCommand("copy");
    } catch {
      copied = false;
    }
  }
  const label = button.querySelector("span");
  label.textContent = copied ? "Copied" : "Select the text and copy it";
  announce(
    copied
      ? "Draft copied to the clipboard."
      : "Copying is blocked. Select the text and copy it manually.",
  );
  setTimeout(() => (label.textContent = "Copy draft"), 2500);
}

/* ----- Provenance, fit and decision-model detail ----- */

const DECISION_THRESHOLD = 0.85;
const SOURCES = {
  recommendation: [
    "Recommendation agent",
    "Model-written recommendations and drafts based on saved grades and source evidence",
  ],
  decision: [
    "Decision model",
    "Produced by the Gemini Decisions model (gemini-decision-1)",
  ],
  search: ["Search model", "Cited summary written by the Gemini search model"],
  code: ["Code", "Deterministic code; no model involved"],
  rules: [
    "Rules",
    "Deterministic gates and ranking applied to decision-model answers",
  ],
};
/* Says where a value came from. Only the decision model gets the solid chip. */
function sourceTag(kind, title) {
  return h(
    "span",
    { class: `src-tag src-${kind}`, title: title || SOURCES[kind][1] },
    icon(kind === "recommendation" ? "src-search" : `src-${kind}`),
    h("span", { text: SOURCES[kind][0] }),
  );
}
const percent = (value) => `${Math.round(value * 100)}%`;
// A pass/fail answer discarded for low confidence (unknown always abstains).
const ignored = (decision) =>
  !decision.counted && decision.choice !== "unknown";

function fitOrder(supplier) {
  if (supplier.fit_rank != null) return [0, supplier.fit_rank];
  if (supplier.fit_score != null) return [1, -supplier.fit_score];
  if (supplier.fit_result === "pass")
    return [2, -(supplier.fit_confidence ?? 0)];
  if (supplier.fit_result === "unknown") return [3, 0];
  if (!supplier.fit_result) return [4, 0];
  return [5, supplier.fit_confidence ?? 0];
}
/* Discovery order: best fit to the search prompt first, where it was ranked. */
function byFit(list) {
  if (!list.some((s) => s.fit_rank != null || s.fit_result)) return list;
  return [...list].sort((a, b) => {
    const [ga, va] = fitOrder(a);
    const [gb, vb] = fitOrder(b);
    return ga - gb || va - vb;
  });
}

function fitLine(supplier) {
  if (!supplier.fit_result && supplier.fit_score == null && !supplier.fit_rank)
    return null;
  const confidence =
    supplier.fit_confidence != null
      ? h("span", {
          class: "muted",
          text: `${percent(supplier.fit_confidence)} confidence`,
          title: supplier.fit_probabilities
            ? Object.entries(supplier.fit_probabilities)
                .map(([k, v]) => `Level ${k}: ${percent(v)}`)
                .join(" · ")
            : undefined,
        })
      : null;
  return h(
    "div",
    { class: "fit-line" },
    sourceTag(
      "decision",
      "Discovery ranking by gemini-decision-1, using the generated discovery prompt and the retrieved site evidence.",
    ),
    supplier.fit_rank
      ? h("span", {
          class: "rank-pill",
          text: `Discovery fit #${supplier.fit_rank}`,
        })
      : null,
    supplier.fit_score != null
      ? h("span", { text: `${Math.round(supplier.fit_score)} / 100 fit` })
      : null,
    supplier.fit_result ? chip(supplier.fit_result) : null,
    confidence,
  );
}

function priceLine(supplier) {
  return h(
    "p",
    { class: "price-line" },
    h("span", { class: "muted", text: "Listed price: " }),
    h("span", {
      class: supplier.price ? "price-value" : "muted",
      text: supplier.price || "Not listed in cited sources",
    }),
  );
}

function decisionAnswers(decisions, evidence) {
  return h(
    "div",
    { class: "decision-answers" },
    h("span", { class: "muted", text: "Per-excerpt answers" }),
    decisions.map((d) => {
      const index = evidence.findIndex((e) => e.id === d.evidence_id);
      const probabilities = d.probabilities
        ? ` · P(pass ${percent(d.probabilities.pass ?? 0)}, fail ${percent(d.probabilities.fail ?? 0)}, unknown ${percent(d.probabilities.unknown ?? 0)})`
        : "";
      return h("span", {
        class: `decision-chip choice-${d.choice}${ignored(d) ? " not-counted" : ""}`,
        text: `Excerpt ${index + 1} · ${STATUS[d.choice][0]} ${percent(d.confidence)}`,
        title: `${
          d.counted
            ? "Counted toward the requirement’s result."
            : d.choice === "unknown"
              ? "The decision model abstained for this excerpt."
              : `Ignored: below the ${percent(DECISION_THRESHOLD)} confidence threshold.`
        }${probabilities}`,
      });
    }),
  );
}

function renderPerformance() {
  const host = $("decision-performance");
  const result = state.result || {};
  const m = result.decision_metrics;
  const assessments = assessmentsOf();
  const decisions = assessments.flatMap((a) =>
    a.criteria.flatMap((c) => c.decisions || []),
  );
  host.hidden = (!m && !decisions.length) || state.restoring;
  if (host.hidden) return;
  const open = [...host.querySelectorAll("details")].map((d) => d.open);
  const suppliers = suppliersOf();
  const criteria = criteriaOf();
  const threshold = m?.confidence_threshold ?? DECISION_THRESHOLD;
  const model = m?.model || "gemini-decision-1";
  const count = (test) => decisions.filter(test).length;
  const questions = m?.questions ?? decisions.length;
  const passed =
    m?.pass_count ?? count((d) => d.counted && d.choice === "pass");
  const failed =
    m?.fail_count ?? count((d) => d.counted && d.choice === "fail");
  const counted = decisions.filter((d) => d.counted).map((d) => d.confidence);
  const cards = [
    [
      "API calls and latency",
      m
        ? `${plural(m.calls, "call", "calls")} · ${m.elapsed_seconds.toFixed(1)}s`
        : `${assessments.length} evaluated`,
      m?.calls
        ? `${(m.elapsed_seconds / m.calls).toFixed(2)}s per call on average${m.failed_calls ? ` · ${m.failed_calls} failed` : " · all succeeded"}`
        : "Measured from the evaluation calls",
    ],
    [
      "Questions and decisions",
      plural(questions, "question", "questions"),
      `${m?.counted ?? passed + failed} counted (${passed} pass · ${failed} fail)`,
    ],
    [
      "Confidence and abstentions",
      counted.length
        ? `${percent(counted.reduce((a, b) => a + b, 0) / counted.length)} average confidence`
        : "—",
      `${m?.abstained ?? count((d) => d.choice === "unknown")} abstained · ${m?.below_threshold ?? count(ignored)} ignored (below ${percent(threshold)})`,
    ],
    [
      "Supplier coverage",
      `${assessments.length} of ${suppliers.length} assessed`,
      m?.skipped_suppliers
        ? `${m.skipped_suppliers} skipped (no excerpts)`
        : m?.failed_calls
          ? plural(m.failed_calls, "provider issue", "provider issues")
          : "Every candidate with excerpts assessed",
    ],
  ];
  host.replaceChildren(
    h(
      "div",
      { class: "perf-head" },
      h("h2", { id: "performance-title", text: "Decision model performance" }),
      sourceTag("decision"),
      h("span", {
        class: "muted",
        text: `${model} · ${percent(threshold)} confidence threshold`,
      }),
    ),
    h(
      "div",
      { class: "perf-grid" },
      cards.map(([label, value, sub]) =>
        h(
          "div",
          { class: "perf-card" },
          h("span", { text: label }),
          h("strong", { text: value }),
          h("small", { text: sub }),
        ),
      ),
    ),
  );
  if (m?.discovery_ranking || m?.evaluation_instructions) {
    const dr = m.discovery_ranking;
    host.append(
      h(
        "details",
        { class: "perf-trace", open: open[0] ?? false },
        h("summary", {
          text: "What the decision model did (prompts, rubrics and actions)",
        }),
        h(
          "ol",
          null,
          dr
            ? h(
                "li",
                null,
                h("strong", {
                  text: `Ranked ${plural(suppliers.length, "discovered supplier", "discovered suppliers")} against the generated discovery prompt (${plural(dr.calls, "score call", "score calls")} · ${dr.elapsed_seconds.toFixed(1)}s · ${dr.status})`,
                }),
                dr.prompt
                  ? h("p", { text: `Generated discovery prompt: ${dr.prompt}` })
                  : null,
                dr.rubric?.length
                  ? h("p", {
                      text: `Scoring rubric (0–3): ${dr.rubric.map((d, i) => `${i}: ${d}`).join(" | ")}`,
                    })
                  : null,
                dr.message ? h("p", { text: dr.message }) : null,
              )
            : null,
          m.evaluation_instructions
            ? h(
                "li",
                null,
                h("strong", {
                  text: `Assessed each requirement and excerpt pair independently (${plural(m.calls, "choice call", "choice calls")} · ${plural(m.questions, "question", "questions")} · ${m.elapsed_seconds.toFixed(1)}s)`,
                }),
                h("p", { text: m.evaluation_instructions }),
              )
            : null,
        ),
      ),
    );
  }
  if (!suppliers.length || !criteria.length) return;
  const metrics = new Map((m?.suppliers || []).map((x) => [x.supplier_id, x]));
  const byId = new Map(assessments.map((a) => [a.supplier_id, a]));
  const lanes = suppliers.map((s) => {
    const sm = metrics.get(s.supplier_id);
    const a = byId.get(s.supplier_id);
    const evidence = s.evidence || [];
    const status = sm
      ? sm.status === "failed"
        ? `Failed · ${sm.elapsed_seconds.toFixed(1)}s`
        : sm.status === "skipped"
          ? "Skipped (no excerpts)"
          : `${sm.elapsed_seconds.toFixed(2)}s · ${sm.pass_count} pass · ${sm.fail_count} fail · ${sm.unknown_count} unknown${sm.below_threshold_count ? ` · ${sm.below_threshold_count} ignored` : ""}`
      : a
        ? `${plural(a.criteria.length, "requirement", "requirements")} assessed`
        : "Not assessed yet";
    const grid = h("div", { class: "decision-grid" });
    grid.style.setProperty("--cols", Math.max(1, evidence.length));
    for (const c of criteria) {
      const answers = new Map(
        (a?.criteria.find((x) => x.criterion_id === c.id)?.decisions || []).map(
          (d) => [d.evidence_id, d],
        ),
      );
      evidence.forEach((e, i) => {
        const d = answers.get(e.id);
        grid.append(
          h("span", {
            class: d
              ? `decision-cell choice-${d.choice}${ignored(d) ? " not-counted" : ""}`
              : "decision-cell",
            title: d
              ? `Requirement ${c.number} × excerpt ${i + 1}: ${STATUS[d.choice][0]} · ${percent(d.confidence)}${d.counted ? "" : d.choice === "unknown" ? " · abstained" : " · below threshold, ignored"}`
              : `Requirement ${c.number} × excerpt ${i + 1}: ${sm?.status === "failed" ? sm.message || "failed" : "no decision recorded"}`,
          }),
        );
      });
    }
    return h(
      "div",
      { class: "decision-lane", "data-status": sm?.status },
      h(
        "div",
        { class: "lane-head" },
        h("strong", { text: s.name }),
        h("span", { class: "muted", text: status }),
      ),
      grid,
    );
  });
  host.append(
    h(
      "details",
      { class: "perf-matrix", open: open[1] ?? open[0] ?? false },
      h("summary", {
        text: "Inspect the per-supplier decision matrix, confidence and latency",
      }),
      h("p", {
        class: "help",
        text: "One row per requirement, one column per source excerpt.",
      }),
      h("div", { class: "decision-lanes" }, lanes),
      h(
        "div",
        { class: "cell-key" },
        [
          ["choice-pass", "Pass"],
          ["choice-fail", "Fail"],
          ["choice-unknown", "Unknown"],
          ["choice-pass not-counted", `Below ${percent(threshold)}, ignored`],
        ].map(([cls, text]) =>
          h("span", null, h("span", { class: `decision-cell ${cls}` }), text),
        ),
      ),
    ),
  );
}

/* Optional suggestions from the backend for the requirements editor. */
async function suggestRequirements() {
  const r = requirementsOf();
  const box = $("suggested-box");
  const list = $("suggested-criteria");
  box.hidden = false;
  list.replaceChildren();
  $("suggested-status").textContent = "Asking for suggestions…";
  $("suggest").disabled = true;
  try {
    const csrf = document.cookie
      .split("; ")
      .find((x) => x.startsWith("csrftoken="))
      ?.split("=")[1];
    const response = await fetch("/api/suggest-criteria/", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-CSRFToken": csrf || "",
      },
      body: JSON.stringify({
        product: r.product,
        // The suggestion endpoint only accepts whole-number quantities.
        ...(Number.isInteger(r.quantity) ? { quantity: r.quantity } : {}),
        delivery_country: r.delivery_country,
      }),
      signal: AbortSignal.timeout(65000),
    });
    const data = await response.json().catch(() => null);
    if (!response.ok || !Array.isArray(data?.criteria))
      throw new Error(data?.error || "Suggestions are unavailable right now.");
    const present = new Set(
      [...$("criteria").querySelectorAll("textarea")].map((t) =>
        t.value.trim().toLowerCase(),
      ),
    );
    const fresh = data.criteria.filter(
      (c) => !present.has(String(c.description).trim().toLowerCase()),
    );
    $("suggested-status").textContent = fresh.length
      ? "Suggested by the model from your product description. Add the ones you want; nothing is included automatically."
      : "No further suggestions for this brief.";
    for (const c of fresh) {
      const add = h("button", {
        type: "button",
        class: "btn btn-outline-secondary btn-sm",
        text: "Add",
      });
      const item = h(
        "li",
        null,
        h("span", { class: `kind-tag kind-${c.kind}`, text: KINDS[c.kind] }),
        h("span", { text: c.description }),
        add,
      );
      add.addEventListener("click", () => {
        if ($("criteria").children.length >= MAX_CRITERIA) return;
        addCriterion({ description: c.description, kind: c.kind });
        item.remove();
      });
      list.append(item);
    }
  } catch (e) {
    $("suggested-status").textContent =
      e.name === "TimeoutError"
        ? "Suggestions took too long. Try again."
        : e.message;
  } finally {
    $("suggest").disabled = false;
  }
}

/* ----- Research notes and coverage ----- */

function renderNotes() {
  const issues = state.result?.issues || [];
  $("notes-block").hidden = !issues.length || state.restoring;
  if (!issues.length) return;
  const names = new Map(suppliersOf().map((s) => [s.supplier_id, s.name]));
  const open = $("results-notes").querySelector("details")?.open || false;
  $("results-notes").replaceChildren(
    h(
      "details",
      { open },
      h("summary", {
        text: `${plural(issues.length, "note", "notes")} about gaps and problems in this research`,
      }),
      h(
        "ul",
        null,
        issues.map((issue) =>
          h("li", {
            text: names.has(issue.supplier_id)
              ? `${names.get(issue.supplier_id)}: ${issue.message}`
              : issue.message,
          }),
        ),
      ),
    ),
  );
}

function renderCoverage() {
  const root = $("coverage");
  const coverage = state.result?.coverage;
  root.hidden = !coverage?.queries || state.restoring;
  if (root.hidden) return;
  const open = root.querySelector("details")?.open || false;
  const stop = {
    searching: "Still searching",
    query_budget: "Search budget reached",
    diminishing_returns: "Recent searches found no new suppliers",
  };
  root.replaceChildren(
    h("h2", { id: "coverage-title", text: "Research coverage" }),
    h("p", {
      text: `${plural(coverage.queries.length, "search pass", "search passes")} · ${coverage.candidates_found ?? 0} candidates found · ${coverage.researched ?? 0} researched · ${coverage.pending ?? 0} not researched. ${stop[coverage.stop_reason] || coverage.stop_reason || ""}. This is not an exhaustive supplier list.`,
    }),
    h(
      "details",
      { open },
      h("summary", { text: "Inspect searches and new suppliers" }),
      h(
        "ul",
        null,
        coverage.queries.map((q) =>
          h(
            "li",
            null,
            h("span", {
              text: `${q.query}: ${q.new_suppliers ?? 0} new, ${q.duplicate_suppliers ?? 0} duplicates${q.failed ? " · search failed" : ""}${q.cached ? " · cached" : ""}${q.unresolved_citations ? ` · ${q.unresolved_citations} unresolved citations` : ""}.`,
            }),
            q.actual_queries?.length
              ? h("small", {
                  text: `Search terms: ${q.actual_queries.join("; ")}`,
                })
              : null,
          ),
        ),
      ),
    ),
    state.jobId
      ? h("a", {
          class: "btn btn-outline-secondary btn-sm",
          href: `/api/research/${encodeURIComponent(state.jobId)}/`,
          download: "supplier-research.json",
          text: "Download research JSON",
        })
      : null,
  );
}

/* ----- Sources ----- */

function supplierMeta(s) {
  const pages = {
    complete: "pages retrieved",
    partial: "pages partly retrieved",
    unavailable: "pages could not be retrieved",
    pending: "pages not retrieved yet",
  };
  return [
    plural((s.evidence || []).length, "source passage", "source passages"),
    pages[s.crawl_status],
    s.identity_status === "site_identified"
      ? "identity from site metadata"
      : "identity needs verification",
    s.discovered_by?.length
      ? `found by ${plural(s.discovered_by.length, "search pass", "search passes")}`
      : null,
    s.legal_id ? `site-reported VAT ID ${s.legal_id}` : null,
  ]
    .filter(Boolean)
    .join(" · ");
}

function renderSources() {
  const box = $("sources-state");
  const suppliers = suppliersOf();
  box.replaceChildren();
  $("sources-content").hidden = !suppliers.length || state.restoring;
  if (state.restoring)
    return box.append(
      panel({
        working: true,
        title: "Restoring your saved research",
        text: "Reconnecting to the research this browser last followed.",
      }),
    );
  if (!suppliers.length)
    return box.append(
      busy() && state.jobId
        ? panel({
            working: true,
            title: "No suppliers found yet",
            text: "Suppliers and their source passages appear here while the research runs.",
            actions: [linkButton("results", "View progress")],
          })
        : panel({
            title: "No sources yet",
            text: state.jobId
              ? "This research has no supplier sources."
              : "Sources appear here once a search has found suppliers.",
            actions: [
              state.jobId
                ? linkButton("results", "View shortlist", true)
                : linkButton("brief", "Go to the brief", true),
            ],
          }),
    );
  const passages = suppliers.reduce((n, s) => n + (s.evidence || []).length, 0);
  $("sources-count").textContent =
    `${plural(suppliers.length, "supplier", "suppliers")} · ${plural(passages, "source passage", "source passages")}${busy() ? " so far" : ""}`;
  $("sources-list").replaceChildren(
    ...byFit(suppliers).map((s) =>
      h(
        "article",
        { class: "supplier" },
        h(
          "header",
          { class: "supplier-head" },
          h("h2", { text: s.name }),
          externalLink(s.website, "Open website", "supplier-site"),
        ),
        h("p", { class: "supplier-meta", text: supplierMeta(s) }),
        fitLine(s),
        "price" in s ? priceLine(s) : null,
        (s.evidence || []).length
          ? h("div", { class: "evidence-list" }, s.evidence.map(evidenceBlock))
          : h("p", {
              class: "help",
              text: "No source passages were collected.",
            }),
      ),
    ),
  );
  const deferred = state.result?.deferred_suppliers || [];
  $("deferred").hidden = !deferred.length;
  if (deferred.length)
    $("deferred").replaceChildren(
      h("h2", { id: "deferred-title", text: "Found but not researched" }),
      h("p", {
        class: "help",
        text: `${plural(deferred.length, "more candidate was", "more candidates were")} found than the research budget covers, so ${deferred.length === 1 ? "its" : "their"} pages were not retrieved or assessed.`,
      }),
      h(
        "ul",
        { class: "deferred-list" },
        deferred.map((s) =>
          h(
            "li",
            null,
            h("span", { text: s.name }),
            externalLink(s.website, "Open website", "supplier-site"),
          ),
        ),
      ),
    );
}

/* ---------- Navigation ---------- */

function currentView() {
  const name = location.hash.replace(/^#\//, "");
  return Object.hasOwn(VIEWS, name) ? name : "brief";
}

function showView(focus = true) {
  const name = currentView();
  if (location.hash !== `#/${name}`)
    history.replaceState(null, "", `#/${name}`);
  for (const view of document.querySelectorAll("[data-view]"))
    view.hidden = view.dataset.view !== name;
  setNav(false, true);
  document.title = `${VIEWS[name]} · QuotePilot`;
  if (focus) {
    window.scrollTo({ top: 0, behavior: "instant" });
    $("main").focus({ preventScroll: true });
  }
}

function go(name) {
  if (currentView() !== name) history.pushState(null, "", `#/${name}`);
  showView();
}

function reset() {
  if (state.submitting) return;
  if (
    state.jobId &&
    !window.confirm(
      busy()
        ? "Start a new search? The current research keeps running on the server, but this browser will stop following it."
        : "Start a new search? The current brief and results are cleared from this browser.",
    )
  )
    return;
  state.watch++;
  Object.assign(state, {
    jobId: null,
    status: null,
    result: null,
    request: null,
    error: null,
    payload: null,
    evidenceJobId: null,
    restoring: false,
    connection: null,
    editing: false,
    startedAt: 0,
  });
  rememberJob(null);
  rememberArea(null);
  $("brief-form").reset();
  setArea(null);
  clearErrors();
  go("brief");
  render();
  announce("New search. Describe what you need.");
}

/* ---------- Sidebar ---------- */

const narrow = () => window.matchMedia?.("(max-width: 720px)").matches ?? false;

/* Desktop: a rail that expands, remembered per browser. Narrow screens: a
   menu that opens over the page and closes again after navigating. */
function setNav(open, onlyIfNarrow = false) {
  if (onlyIfNarrow && !narrow()) return;
  $("app").classList.toggle("nav-open", open);
  const toggle = $("nav-toggle");
  const label = open ? "Collapse navigation" : "Expand navigation";
  toggle.setAttribute("aria-expanded", String(open));
  toggle.setAttribute("aria-label", label);
  toggle.title = label;
  if (!narrow())
    try {
      localStorage.setItem("qp-nav-open", open ? "1" : "0");
    } catch {
      /* storage unavailable: the choice just is not remembered */
    }
}

function initNav() {
  let open = false;
  try {
    open = !narrow() && localStorage.getItem("qp-nav-open") === "1";
  } catch {
    /* storage unavailable */
  }
  setNav(open);
  $("nav-toggle").addEventListener("click", () =>
    setNav(!$("app").classList.contains("nav-open")),
  );
}

/* ---------- Delivery destination (map) ---------- */

const NOMINATIM = "https://nominatim.openstreetmap.org";
const ESRI = "https://server.arcgisonline.com/ArcGIS/rest/services";
const MAX_DELIVERY_TEXT = 100; // backend limit for requirements.delivery_country
const WORLD_VIEW = [[25, 10], 2];

/* The confirmed delivery destination, one of:
     { type: "radius", lat, lng, radius (km), name }
     { type: "countries", countries: [{ id, name }] }
     { type: "continents", continents: [name] }
     { type: "world" }
     { type: "text", text }   restored from a saved job, which only keeps text */
let area = null;
const picker = {
  map: null,
  scope: "radius",
  draft: null, // radius selection being edited
  lookup: 0,
  circle: null,
  dot: null,
  countries: new Map(), // selected: id -> name
  continents: new Set(), // selected names
  features: null, // country boundaries, loaded on first use
  loading: null,
  layer: null,
};

const coordinates = (lat, lng) => `${lat.toFixed(3)}, ${lng.toFixed(3)}`;
const joinNames = (names) =>
  names.length < 2
    ? names.join("")
    : `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`;

function areaLabel(a) {
  if (a.type === "text") return a.text;
  if (a.type === "world") return "Worldwide";
  if (a.type === "continents") return joinNames(a.continents);
  if (a.type === "countries") {
    const names = a.countries.map((c) => c.name);
    return names.length <= 4
      ? joinNames(names)
      : `${names.slice(0, 3).join(", ")} and ${names.length - 3} more countries`;
  }
  return `Within ${a.radius} km of ${a.name}`;
}

/* The text sent to the API in delivery_country. */
function deliveryText(a) {
  if (a.type === "text") return a.text;
  if (a.type === "world") return "worldwide";
  if (a.type === "continents") return a.continents.join(", ");
  if (a.type === "countries") return a.countries.map((c) => c.name).join(", ");
  const prefix = `within ${a.radius} km of `;
  return prefix + a.name.slice(0, MAX_DELIVERY_TEXT - prefix.length);
}

function placeName(address) {
  if (!address) return "";
  const parts = [
    address.city ||
      address.town ||
      address.village ||
      address.municipality ||
      address.hamlet ||
      address.county,
    address.state,
    address.country,
  ].filter(Boolean);
  return [...new Set(parts)].join(", ");
}

function setArea(value) {
  area = value;
  const text = value ? areaLabel(value) : "Select on the map";
  $("area-text").textContent = text;
  $("area-open").title = value ? text : "";
  $("area-open").classList.toggle("is-empty", !value);
}

/* What "Use this area" would confirm for the current scope, or null. */
function pickedArea() {
  if (picker.scope === "world") return { type: "world" };
  if (picker.scope === "continents")
    return picker.continents.size
      ? { type: "continents", continents: [...picker.continents].sort() }
      : null;
  if (picker.scope === "countries")
    return picker.countries.size
      ? {
          type: "countries",
          countries: [...picker.countries]
            .map(([id, name]) => ({ id, name }))
            .sort((a, b) => a.name.localeCompare(b.name)),
        }
      : null;
  return picker.draft?.name ? { type: "radius", ...picker.draft } : null;
}

function pickerStatus(text) {
  const picked = pickedArea();
  const tooLong = picked && deliveryText(picked).length > MAX_DELIVERY_TEXT;
  $("area-confirm").disabled = !picked || tooLong;
  if (text) return ($("area-status").textContent = text);
  const { scope, draft } = picker;
  $("area-status").textContent = tooLong
    ? "This selection is too long to send (the limit is 100 characters). Select fewer countries, or use Continents or Worldwide."
    : scope === "world"
      ? "Worldwide: goods can be delivered anywhere."
      : scope === "continents"
        ? picker.continents.size
          ? `${plural(picker.continents.size, "continent", "continents")} selected.`
          : "No continent selected yet."
        : scope === "countries"
          ? picker.countries.size
            ? `${plural(picker.countries.size, "country", "countries")} selected.`
            : "No country selected yet."
          : draft?.name
            ? `Centre: ${draft.name} (${coordinates(draft.lat, draft.lng)})`
            : "No centre selected yet.";
}

/* ----- Radius ----- */

function drawDraft(fit = true) {
  const { map, draft } = picker;
  if (!map) return;
  picker.circle?.remove();
  picker.dot?.remove();
  picker.circle = picker.dot = null;
  if (!draft || picker.scope !== "radius") return;
  const point = [draft.lat, draft.lng];
  picker.circle = window.L.circle(point, {
    radius: draft.radius * 1000,
    color: "#edf0f5",
    weight: 2,
    fillColor: "#3865c2",
    fillOpacity: 0.3,
    interactive: false,
  }).addTo(map);
  picker.dot = window.L.circleMarker(point, {
    radius: 5,
    color: "#0c1017",
    weight: 2,
    fillColor: "#edf0f5",
    fillOpacity: 1,
    interactive: false,
  }).addTo(map);
  if (fit) map.fitBounds(picker.circle.getBounds(), { padding: [28, 28] });
}

async function setPoint(lat, lng, name) {
  const lookup = ++picker.lookup;
  picker.draft = {
    lat,
    lng,
    radius: Number($("area-radius").value),
    name: name || null,
  };
  drawDraft();
  if (name) return pickerStatus();
  pickerStatus("Looking up the place name…");
  let found = "";
  try {
    const response = await fetch(
      `${NOMINATIM}/reverse?format=jsonv2&zoom=10&accept-language=en&lat=${lat}&lon=${lng}`,
    );
    found = placeName((await response.json()).address);
  } catch {
    /* fall back to coordinates below */
  }
  if (lookup !== picker.lookup) return; // a newer point was selected
  picker.draft.name = found || coordinates(lat, lng);
  pickerStatus(
    found
      ? ""
      : `No place name was found for this point, so its coordinates are used: ${coordinates(lat, lng)}.`,
  );
}

async function searchPlaces(query) {
  pickerStatus("Searching…");
  let results;
  try {
    const response = await fetch(
      `${NOMINATIM}/search?format=jsonv2&addressdetails=1&limit=5&accept-language=en&q=${encodeURIComponent(query)}`,
    );
    results = await response.json();
    if (!Array.isArray(results)) throw new Error("unexpected response");
  } catch {
    return pickerStatus(
      "Place search is unavailable right now. Click the map to set the centre instead.",
    );
  }
  if (!results.length)
    return pickerStatus(`No place was found for “${query}”.`);
  pickerStatus("Choose a result, or click the map.");
  showResults(
    results.map((result) => [
      result.display_name,
      () =>
        setPoint(
          Number(result.lat),
          Number(result.lon),
          placeName(result.address) || result.display_name,
        ),
    ]),
  );
}

function showResults(entries) {
  const list = $("area-results");
  list.replaceChildren(
    ...entries.map(([text, choose]) => {
      const button = h("button", { type: "button", text });
      button.addEventListener("click", () => {
        list.hidden = true;
        choose();
      });
      return h("li", null, button);
    }),
  );
  list.hidden = !entries.length;
}

/* ----- Countries, continents, worldwide ----- */

function loadCountries() {
  picker.loading ??= fetch($("area-map").dataset.countriesUrl)
    .then((response) => {
      if (!response.ok) throw new Error("not found");
      return response.json();
    })
    .then((data) => (picker.features = data.features))
    .catch((error) => {
      picker.loading = null; // allow a retry
      throw error;
    });
  return picker.loading;
}

const isSelected = (feature) =>
  picker.scope === "world" ||
  (picker.scope === "continents" &&
    picker.continents.has(feature.properties.continent)) ||
  (picker.scope === "countries" && picker.countries.has(feature.id));

const countryStyle = (feature) =>
  isSelected(feature)
    ? {
        color: "#edf0f5",
        opacity: 0.95,
        weight: 1.2,
        fillColor: "#3865c2",
        fillOpacity: 0.5,
      }
    : {
        color: "#edf0f5",
        opacity: 0.5,
        weight: 0.7,
        fillColor: "#edf0f5",
        fillOpacity: 0.02,
      };

function toggleCountry(feature, fit = false) {
  if (picker.scope === "countries") {
    if (!picker.countries.delete(feature.id))
      picker.countries.set(feature.id, feature.properties.name);
  } else if (picker.scope === "continents") {
    const continent = feature.properties.continent;
    if (!picker.continents.delete(continent)) picker.continents.add(continent);
  } else return;
  refreshSelection(fit);
}

function refreshSelection(fit = false) {
  picker.layer?.setStyle(countryStyle);
  for (const box of $("area-continents").querySelectorAll("input"))
    box.checked = picker.continents.has(box.value);
  const chips = $("area-chips");
  chips.hidden = picker.scope !== "countries" || !picker.countries.size;
  chips.replaceChildren(
    ...[...picker.countries]
      .sort((a, b) => a[1].localeCompare(b[1]))
      .map(([id, name]) => {
        const remove = h(
          "button",
          { type: "button", "aria-label": `Remove ${name}`, title: "Remove" },
          icon("cross"),
        );
        remove.addEventListener("click", () => {
          picker.countries.delete(id);
          refreshSelection();
        });
        return h("li", null, h("span", { text: name }), remove);
      }),
  );
  if (fit) fitSelection();
  pickerStatus();
}

function fitSelection() {
  const { map, layer } = picker;
  if (!map) return;
  const bounds = window.L.latLngBounds([]);
  if (picker.scope !== "world")
    layer?.eachLayer((item) => {
      if (isSelected(item.feature)) bounds.extend(item.getBounds());
    });
  if (bounds.isValid()) map.fitBounds(bounds, { padding: [24, 24] });
  else map.setView(...WORLD_VIEW);
}

const SCOPE_HELP = {
  radius:
    "Click the map or search for a place to set the centre, then set a radius of 5 to 500 km. For anything larger, use Countries, Continents or Worldwide. The centre’s coordinates and your search text are sent to OpenStreetMap Nominatim to look up place names. Satellite imagery is loaded from Esri.",
  countries:
    "Click countries on the map, or search by name, to add or remove them. Country boundaries are Natural Earth data served with this app; satellite imagery is loaded from Esri.",
  continents:
    "Select continents with the buttons or by clicking the map. Each country belongs to exactly one continent in the Natural Earth data; for example, Russia is shown with Europe and Turkey with Asia.",
  world:
    "Use this when deliveries can go anywhere in the world. There is nothing else to select.",
};

/* Switch between radius / countries / continents / worldwide. */
async function setScope(scope, fit = true) {
  picker.scope = scope;
  $("area-body").dataset.scope = scope;
  $(`scope-${scope}`).checked = true;
  $("area-help").textContent = SCOPE_HELP[scope];
  $("area-results").hidden = true;
  const query = $("area-query");
  query.value = "";
  query.placeholder =
    scope === "countries"
      ? "Search for a country"
      : "Search for a city, region or address";
  $("area-query-label").textContent = query.placeholder;
  const { map } = picker;
  if (scope === "radius") {
    picker.layer?.remove();
    refreshSelection();
    drawDraft(fit);
    if (fit && map && !picker.draft) map.setView(...WORLD_VIEW);
    return;
  }
  drawDraft(false); // removes the circle
  refreshSelection();
  if (!picker.features) {
    pickerStatus("Loading country boundaries…");
    try {
      await loadCountries();
    } catch {
      return pickerStatus(
        scope === "world"
          ? ""
          : "Country boundaries could not be loaded. Close the dialog and try again.",
      );
    }
    if (picker.scope !== scope) return; // switched while loading
  }
  if (!map) return;
  picker.layer ??= window.L.geoJSON(
    { type: "FeatureCollection", features: picker.features },
    {
      style: countryStyle,
      onEachFeature: (feature, item) => {
        item.bindTooltip(feature.properties.name, { sticky: true });
        item.on("click", () => toggleCountry(feature));
      },
    },
  );
  picker.layer.addTo(map);
  refreshSelection(fit);
}

function searchCountries(query) {
  if (!picker.features)
    return pickerStatus("Country boundaries are still loading.");
  const needle = query.toLowerCase();
  const matches = picker.features
    .filter((f) => f.properties.name.toLowerCase().includes(needle))
    .slice(0, 8);
  if (!matches.length)
    return pickerStatus(`No country was found for “${query}”.`);
  showResults(
    matches.map((feature) => [
      picker.countries.has(feature.id)
        ? `${feature.properties.name} (selected, choose to remove)`
        : feature.properties.name,
      () => toggleCountry(feature, true),
    ]),
  );
}

function initAreaPicker() {
  const element = $("area-modal");
  // Without Bootstrap (unit tests) the dialog logic still works, unshown.
  const modal = window.bootstrap ? new window.bootstrap.Modal(element) : null;
  $("area-open").addEventListener("click", () => {
    picker.lookup++;
    picker.draft = area?.type === "radius" ? { ...area } : null;
    delete picker.draft?.type;
    picker.countries = new Map(
      area?.type === "countries"
        ? area.countries.map((c) => [c.id, c.name])
        : [],
    );
    picker.continents = new Set(
      area?.type === "continents" ? area.continents : [],
    );
    $("area-radius").value = picker.draft ? picker.draft.radius : 50;
    $("area-radius-value").textContent = `${$("area-radius").value} km`;
    setScope(
      ["countries", "continents", "world"].includes(area?.type)
        ? area.type
        : "radius",
      false,
    );
    modal?.show();
  });
  // Leaflet needs a visible container to size itself, so it starts here.
  element.addEventListener("shown.bs.modal", () => {
    if (!picker.map) {
      const map = window.L.map("area-map", {
        center: WORLD_VIEW[0],
        zoom: WORLD_VIEW[1],
        minZoom: 2,
        worldCopyJump: true,
        preferCanvas: true, // a few hundred country outlines
      });
      window.L.tileLayer(`${ESRI}/World_Imagery/MapServer/tile/{z}/{y}/{x}`, {
        maxZoom: 18,
        attribution:
          "Imagery © Esri, Maxar, Earthstar Geographics · Place names © OpenStreetMap contributors · Boundaries: Natural Earth",
      }).addTo(map);
      window.L.tileLayer(
        `${ESRI}/Reference/World_Boundaries_and_Places/MapServer/tile/{z}/{y}/{x}`,
        { maxZoom: 18 },
      ).addTo(map);
      map.on("click", (event) => {
        if (picker.scope !== "radius") return;
        const point = event.latlng.wrap();
        setPoint(point.lat, point.lng);
      });
      map.attributionControl.setPrefix(
        '<a href="https://leafletjs.com" target="_blank" rel="noopener noreferrer">Leaflet</a>',
      );
      picker.map = map;
    }
    picker.map.invalidateSize();
    setScope(picker.scope);
  });
  for (const radio of document.querySelectorAll("input[name=area-scope]"))
    radio.addEventListener("change", () => setScope(radio.value));
  for (const box of $("area-continents").querySelectorAll("input"))
    box.addEventListener("change", () => {
      if (box.checked) picker.continents.add(box.value);
      else picker.continents.delete(box.value);
      refreshSelection(true);
    });
  $("area-radius").addEventListener("input", (event) => {
    $("area-radius-value").textContent = `${event.target.value} km`;
    if (!picker.draft) return;
    picker.draft.radius = Number(event.target.value);
    drawDraft();
  });
  $("area-search").addEventListener("submit", (event) => {
    event.preventDefault();
    const query = $("area-query").value.trim();
    if (!query) return;
    if (picker.scope === "countries") searchCountries(query);
    else searchPlaces(query);
  });
  $("area-confirm").addEventListener("click", () => {
    const picked = pickedArea();
    if (!picked) return;
    setArea(picked);
    rememberArea(picked);
    modal?.hide();
    clearFieldError("area-error", "area-open");
    $("area-open").focus();
  });
  setArea(null);
}

/* ---------- Events ---------- */

$("brief-form").addEventListener("submit", (event) => {
  event.preventDefault();
  if (validateForm()) startResearch(readForm(), "brief");
});
$("requirements-editor").addEventListener("submit", (event) => {
  event.preventDefault();
  submitEditor();
});
$("add").addEventListener("click", () => {
  if ($("criteria").children.length < MAX_CRITERIA) addCriterion().focus();
});
$("unit").addEventListener("change", () => {
  render();
  if ($("unit").value === "custom") $("unit-custom").focus();
});
// Typing in a field clears the error shown for it.
for (const [errorId, controlId] of [
  ...Object.values(FIELD_ERRORS),
  ["quantity-error", "unit-custom"],
])
  $(controlId).addEventListener("input", () =>
    clearFieldError(errorId, controlId),
  );
document.addEventListener("click", (event) => {
  const button = event.target.closest("[data-action]");
  if (!button || button.disabled) return;
  const action = button.dataset.action;
  if (action === "reset") reset();
  else if (action === "retry-recommendations" && !busy() && state.evidenceJobId)
    startResearch(
      { requirements: requirementsOf(), discovery_job_id: state.evidenceJobId },
      "recommendation",
    );
  else if (action === "copy") copyDraft(button);
  else if (action === "adjust") openEditor();
  else if (action === "suggest") suggestRequirements();
  else if (action === "cancel-adjust") {
    state.editing = false;
    render();
    $("adjust").focus();
  } else if (action === "retry" && state.payload)
    startResearch(state.payload, "retry");
  else if (action === "reconnect" && state.jobId) restore(state.jobId);
});
window.addEventListener("hashchange", () => showView());
// The elapsed time is the only thing that changes every second.
setInterval(() => {
  if (!state.startedAt || !busy()) return;
  for (const node of document.querySelectorAll(".elapsed"))
    node.textContent = elapsedText();
}, 1000);

initNav();
initAreaPicker();
const startedOnBrief = !location.hash;
showView(false);
render();
const savedJob = recalledJob();
if (savedJob) {
  restore(savedJob);
  if (startedOnBrief) go("results");
}
