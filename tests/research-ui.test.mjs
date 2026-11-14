import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { JSDOM } from "jsdom";

const html = await readFile(
  new URL("../web/templates/index.html", import.meta.url),
  "utf8",
);
const script = await readFile(
  new URL("../web/static/web/app.js", import.meta.url),
  "utf8",
);
const fixture = JSON.parse(
  await readFile(
    new URL("../fixtures/example_pipeline.json", import.meta.url),
    "utf8",
  ),
);

const jobId = "a".repeat(64);
const nextJobId = "b".repeat(64);
const options = {
  max_suppliers: 60,
  max_queries: 8,
  max_pages_per_supplier: 5,
  countries: ["Poland"],
  languages: ["English"],
  refresh: false,
};
const coverage = {
  queries: [
    {
      query: "aluminium containers manufacturers",
      actual_queries: ["container factories"],
      new_suppliers: 3,
      duplicate_suppliers: 1,
    },
  ],
  candidates_found: 3,
  researched: 3,
  pending: 0,
  stop_reason: "query_budget",
};
const suppliers = fixture.response.suppliers.map((s) => ({
  ...s,
  crawl_status: "partial",
  evidence: s.evidence.map((e) => ({ ...e, kind: "page" })),
}));

// What the simple form submits, and what the backend makes of it.
const submitted = {
  product: "Food-grade aluminium containers, 750 ml",
  quantity: 2.5,
  quantity_unit: "pallets",
  delivery_country: "worldwide",
  needed_by: null,
  other_requirements:
    "EU manufacturing required; recyclable packaging preferred",
};
const interpreted = {
  ...submitted,
  criteria: [
    {
      id: "product",
      description: submitted.product,
      kind: "mandatory",
      weight: 1,
    },
    {
      id: "quantity",
      description: "Can fulfil an order of 2.5 pallets.",
      kind: "mandatory",
      weight: 1,
    },
    {
      id: "destination",
      description: "Can deliver the requested order to worldwide.",
      kind: "mandatory",
      weight: 1,
    },
    {
      id: "extra_1",
      description: "EU manufacturing required",
      kind: "mandatory",
      weight: 1,
    },
    {
      id: "extra_2",
      description: "recyclable packaging preferred",
      kind: "preference",
      weight: 1,
    },
  ],
};
const request = { requirements: submitted, options, stage: "research" };

function assessment(supplier, results) {
  const criteria = interpreted.criteria.map((c, i) => ({
    criterion_id: c.id,
    result: results[i],
    score:
      c.kind === "preference" && results[i] !== "unknown"
        ? results[i] === "pass"
          ? 100
          : 0
        : null,
    evidence_ids: results[i] === "unknown" ? [] : [supplier.evidence[0].id],
    explanation: `Saved ${results[i]} explanation.`,
  }));
  const mandatory = criteria
    .filter((_, i) => interpreted.criteria[i].kind === "mandatory")
    .map((c) => c.result);
  return {
    supplier_id: supplier.supplier_id,
    criteria,
    eligibility: mandatory.includes("fail")
      ? "ineligible"
      : mandatory.includes("unknown")
        ? "needs_verification"
        : "eligible",
    preference_score: criteria.at(-1).score || 0,
    evidence_coverage: results.filter((r) => r !== "unknown").length / 5,
  };
}
const complete = {
  suppliers,
  assessments: [
    assessment(suppliers[0], ["pass", "pass", "pass", "pass", "pass"]),
    assessment(suppliers[1], ["fail", "unknown", "pass", "unknown", "unknown"]),
    assessment(suppliers[2], [
      "pass",
      "unknown",
      "unknown",
      "unknown",
      "unknown",
    ]),
  ],
  recommended_supplier_ids: ["alpha"],
  issues: [],
  coverage,
  deferred_suppliers: [],
  requirements: interpreted,
  phase: "complete",
};
const completedJob = { status: "completed", result: complete, request };

function setup(fetch, saved = null) {
  const dom = new JSDOM(html.replace(/{%.*?%}/g, ""), {
    url: "http://localhost/",
    runScripts: "outside-only",
  });
  const { window } = dom;
  window.HTMLElement.prototype.scrollIntoView = () => {};
  window.scrollTo = () => {};
  window.AbortSignal = AbortSignal;
  window.fetch = fetch;
  window.setInterval = () => 1;
  window.clearInterval = () => {};
  // Poll immediately instead of every two seconds.
  const realTimeout = window.setTimeout.bind(window);
  window.setTimeout = (callback, delay, ...args) =>
    realTimeout(callback, delay === 2000 ? 10 : delay, ...args);
  if (saved) window.localStorage.setItem("quotepilot-job", saved);
  window.eval(script);
  return dom;
}
const reply = (data, status = 200) => ({
  ok: status < 400,
  status,
  json: async () => structuredClone(data),
});
async function settle(check, message = "UI did not settle") {
  for (let i = 0; i < 200; i++) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail(message);
}
const text = (d, id) => d.getElementById(id).textContent;
const finished = (d) => () => !d.getElementById("recommendation").hidden;

/* Fill the brief the way a user would; the destination goes through the
   map dialog's "Worldwide" scope, which needs no map. */
function fillBrief(dom, values = {}) {
  const d = dom.window.document;
  const event = (type) => new dom.window.Event(type, { bubbles: true });
  d.getElementById("product").value = values.product ?? submitted.product;
  d.getElementById("quantity").value = values.quantity ?? "2.5";
  d.getElementById("unit").value = "custom";
  d.getElementById("unit").dispatchEvent(event("change"));
  d.getElementById("unit-custom").value = values.unit ?? "pallets";
  d.getElementById("area-open").click();
  d.getElementById("scope-world").checked = true;
  d.getElementById("scope-world").dispatchEvent(event("change"));
  d.getElementById("area-confirm").click();
  d.getElementById("needed-by").value = values.neededBy ?? "";
  d.getElementById("other").value =
    values.other ?? submitted.other_requirements;
}
const submit = (dom) =>
  dom.window.document
    .getElementById("brief-form")
    .dispatchEvent(new dom.window.Event("submit", { cancelable: true }));
const posts = (calls) =>
  calls
    .filter((c) => c.init?.method === "POST")
    .map((c) => JSON.parse(c.init.body));

/* A server that queues the job, then serves the given poll responses in
   order and repeats the last one. */
function server(responses, calls = []) {
  let polls = 0;
  return async (url, init) => {
    calls.push({ url, init });
    if (init?.method === "POST")
      return reply({ job_id: jobId, status: "queued" }, 202);
    if (!String(url).startsWith("/api/research/"))
      return reply({ features: [] });
    return reply(responses[Math.min(polls++, responses.length - 1)]);
  };
}

test("the brief is submitted without criteria, with a decimal quantity, custom unit and null date", async (t) => {
  const calls = [];
  const dom = setup(server([completedJob], calls));
  t.after(() => dom.window.close());
  const d = dom.window.document;
  fillBrief(dom);
  submit(dom);
  await settle(finished(d));
  const [body] = posts(calls);
  assert.deepEqual(body.requirements, submitted);
  assert.equal("criteria" in body.requirements, false);
  assert.equal("discovery_job_id" in body, false);
  assert.equal("options" in body, false);
  const research = calls.filter((c) => c.url.startsWith("/api/research/"));
  assert.equal(research[0].url, "/api/research/");
  assert.equal(research[1].url, `/api/research/${jobId}/`);
  assert.equal(dom.window.localStorage.getItem("quotepilot-job"), jobId);
});

test("a chosen date is sent as YYYY-MM-DD and optional text may be empty", async (t) => {
  const calls = [];
  const dom = setup(server([completedJob], calls));
  t.after(() => dom.window.close());
  fillBrief(dom, { neededBy: "2027-03-01", other: "" });
  submit(dom);
  await settle(() => posts(calls).length === 1);
  const { requirements } = posts(calls)[0];
  assert.equal(requirements.needed_by, "2027-03-01");
  assert.equal(requirements.other_requirements, "");
});

test("an incomplete brief shows field messages and is not sent", async (t) => {
  const calls = [];
  const dom = setup(server([completedJob], calls));
  t.after(() => dom.window.close());
  const d = dom.window.document;
  d.getElementById("quantity").value = "-1";
  submit(dom);
  assert.equal(posts(calls).length, 0);
  assert.match(text(d, "product-error"), /what you need/i);
  assert.match(text(d, "quantity-error"), /greater than 0/);
  assert.match(text(d, "area-error"), /destination/i);
  assert.equal(
    d.getElementById("product").getAttribute("aria-invalid"),
    "true",
  );
});

test("server field errors map to their fields, the rest to the form, and input is kept", async (t) => {
  const dom = setup(async (url, init) =>
    init?.method === "POST"
      ? reply(
          {
            error: "Check your purchase details.",
            fields: [
              {
                path: "requirements.quantity",
                message: "Input should be greater than 0",
              },
              { path: "options.max_queries", message: "Too many searches" },
              {
                path: "requirements",
                message: "Value error, product must not be blank",
              },
            ],
          },
          400,
        )
      : reply({ features: [] }),
  );
  t.after(() => dom.window.close());
  const d = dom.window.document;
  fillBrief(dom);
  submit(dom);
  await settle(() => !d.getElementById("form-error").hidden);
  assert.match(text(d, "quantity-error"), /greater than 0/);
  assert.match(text(d, "form-error"), /Too many searches/);
  assert.match(text(d, "form-error"), /Check your purchase details/);
  assert.match(text(d, "form-error"), /must not be blank/);
  assert.equal(d.getElementById("product").value, submitted.product);
  assert.equal(d.getElementById("brief-fields").disabled, false);
});

test("validation errors without a field list, and 403 and 429, show a form-level message", async (t) => {
  for (const [status, data, expected] of [
    [400, { error: "Invalid request." }, /Invalid request/],
    [429, { error: "Research queue is full. Try again later." }, /queue/],
    [403, null, /Reload the page/],
  ]) {
    const dom = setup(async (url, init) =>
      init?.method === "POST"
        ? {
            ok: false,
            status,
            json: async () => {
              if (!data) throw new SyntaxError("not JSON");
              return data;
            },
          }
        : reply({ features: [] }),
    );
    t.after(() => dom.window.close());
    const d = dom.window.document;
    fillBrief(dom);
    submit(dom);
    await settle(() => !d.getElementById("form-error").hidden);
    assert.match(text(d, "form-error"), expected);
    assert.equal(d.getElementById("product").value, submitted.product);
  }
});

test("interpreting checkpoints without requirements or suppliers render progress, then the interpreted requirements", async (t) => {
  let release;
  const responses = [
    { status: "queued", result: null, request },
    {
      status: "running",
      result: { phase: "interpreting", requirements: null },
      request,
    },
  ];
  let polls = 0;
  const dom = setup(async (url, init) => {
    if (init?.method === "POST")
      return reply({ job_id: jobId, status: "queued" }, 202);
    if (!String(url).startsWith("/api/research/"))
      return reply({ features: [] });
    if (polls < responses.length) return reply(responses[polls++]);
    if (!release)
      return new Promise((resolve) => {
        release = resolve;
      });
    return reply(completedJob);
  });
  t.after(() => dom.window.close());
  const d = dom.window.document;
  fillBrief(dom);
  submit(dom);
  await settle(() => Boolean(release));
  assert.match(text(d, "results-state"), /Understanding your requirements/);
  assert.equal(d.getElementById("requirements-block").hidden, true);
  assert.equal(d.getElementById("results-content").hidden, true);
  // The submitted form is preserved, locked, while the job runs.
  assert.equal(d.getElementById("product").value, submitted.product);
  assert.equal(d.getElementById("brief-fields").disabled, true);
  release(
    reply({
      status: "running",
      result: { phase: "interpreting", requirements: interpreted },
      request,
    }),
  );
  await settle(finished(d));
  const view = d.getElementById("requirements-view");
  assert.match(view.textContent, /Must have/);
  assert.match(view.textContent, /Nice to have/);
  const [must, nice] = view.querySelectorAll(".requirement-group");
  assert.match(must.textContent, /EU manufacturing required/);
  assert.match(nice.textContent, /recyclable packaging preferred/);
  assert.equal(d.getElementById("requirements-block").hidden, false);
  assert.equal(d.getElementById("adjust").hidden, false);
});

test("a finished job shows the shortlist, labels assessments by criterion and renders sources as text", async (t) => {
  const hostile = structuredClone(completedJob);
  hostile.result.suppliers[0].name = "<img src=x onerror=alert(1)>";
  hostile.result.suppliers[0].evidence[0].excerpt =
    "<script>window.injected=true</script>";
  const dom = setup(server([hostile]), jobId);
  t.after(() => dom.window.close());
  const d = dom.window.document;
  await settle(finished(d));
  assert.match(text(d, "recommendation"), /1 supplier shortlisted/);
  assert.match(text(d, "recommendation"), /does not guarantee/);
  assert.equal(d.querySelectorAll("#comparison tbody tr").length, 3);
  assert.match(text(d, "details"), /Can fulfil an order of 2.5 pallets/);
  assert.match(text(d, "sources-list"), /Source passage/);
  assert.match(text(d, "sources-list"), /window.injected/);
  assert.equal(d.querySelector("#sources-list script"), null);
  assert.equal(d.querySelector("#main img"), null);
  assert.match(text(d, "coverage"), /3 researched/);
  assert.equal(
    d.querySelector("#coverage a").download,
    "supplier-research.json",
  );
});

test("an empty shortlist still shows the suppliers that need verification", async (t) => {
  const job = structuredClone(completedJob);
  job.result.recommended_supplier_ids = [];
  job.result.assessments[0] = assessment(suppliers[0], [
    "pass",
    "unknown",
    "pass",
    "pass",
    "pass",
  ]);
  const dom = setup(server([job]), jobId);
  t.after(() => dom.window.close());
  const d = dom.window.document;
  await settle(finished(d));
  const summary = text(d, "recommendation");
  assert.match(summary, /No supplier is confirmed yet/);
  assert.match(summary, /Needs supplier confirmation/);
  assert.match(summary, /Example Alpha/);
  assert.match(summary, /Open: requirement 2/);
  assert.match(summary, /does not guarantee order capacity or delivery dates/);
  assert.doesNotMatch(summary, /shortlisted/);
  assert.match(text(d, "details"), /This is not a pass/);
});

test("adjusting requirements re-checks saved evidence with preserved IDs and purchase fields", async (t) => {
  const calls = [];
  const dom = setup(async (url, init) => {
    calls.push({ url, init });
    if (init?.method === "POST")
      return reply({ job_id: nextJobId, status: "queued" }, 202);
    return reply(completedJob);
  }, jobId);
  t.after(() => dom.window.close());
  const d = dom.window.document;
  await settle(finished(d));
  d.getElementById("adjust").click();
  const rows = [...d.querySelectorAll("#criteria .criterion")];
  assert.equal(rows.length, 5);
  assert.equal(d.querySelector("#criteria input[type=number]"), null);
  // Reword one requirement, make another a nice-to-have, add a new one.
  rows[3].querySelector("textarea").value = "Manufactured in the EU";
  rows[3].querySelector("input[value=preference]").checked = true;
  rows[3].querySelector("input[value=mandatory]").checked = false;
  d.getElementById("add").click();
  d.querySelector("#criteria .criterion:last-child textarea").value =
    "Offers samples";
  d.getElementById("requirements-editor").dispatchEvent(
    new dom.window.Event("submit", { cancelable: true }),
  );
  await settle(() => posts(calls).length === 1);
  const [body] = posts(calls);
  assert.equal(body.discovery_job_id, jobId);
  assert.equal("suppliers" in body, false);
  assert.deepEqual(body.options, options);
  const { criteria, ...purchase } = body.requirements;
  assert.deepEqual(purchase, submitted);
  assert.deepEqual(
    criteria.map((c) => [c.id, c.kind]),
    [
      ["product", "mandatory"],
      ["quantity", "mandatory"],
      ["destination", "mandatory"],
      ["extra_1", "preference"],
      ["extra_2", "preference"],
      ["custom_1", "mandatory"],
    ],
  );
  assert.equal(criteria[3].description, "Manufactured in the EU");
  assert.equal(criteria[5].weight, 1);
  await settle(() =>
    calls.some((c) => c.url === `/api/research/${nextJobId}/`),
  );
  assert.equal(dom.window.localStorage.getItem("quotepilot-job"), nextJobId);
});

test("an empty requirement is not submitted", async (t) => {
  const calls = [];
  const dom = setup(server([completedJob], calls), jobId);
  t.after(() => dom.window.close());
  const d = dom.window.document;
  await settle(finished(d));
  d.getElementById("adjust").click();
  d.querySelector("#criteria textarea").value = " ";
  d.getElementById("requirements-editor").dispatchEvent(
    new dom.window.Event("submit", { cancelable: true }),
  );
  assert.equal(posts(calls).length, 0);
  assert.match(text(d, "editor-error"), /empty requirement/);
});

test("changing a purchase field starts fresh research without criteria or saved evidence", async (t) => {
  const calls = [];
  const dom = setup(server([completedJob], calls), jobId);
  t.after(() => dom.window.close());
  const d = dom.window.document;
  await settle(finished(d));
  d.getElementById("quantity").value = "40";
  submit(dom);
  await settle(() => posts(calls).length === 1);
  const [body] = posts(calls);
  assert.equal(body.requirements.quantity, 40);
  assert.equal("criteria" in body.requirements, false);
  assert.equal("discovery_job_id" in body, false);
  // The rest of the restored brief is carried over unchanged.
  assert.equal(
    body.requirements.other_requirements,
    submitted.other_requirements,
  );
  assert.equal(body.requirements.delivery_country, "worldwide");
  assert.equal(body.requirements.quantity_unit, "pallets");
});

test("reload restores the brief from the interpreted requirements", async (t) => {
  const job = structuredClone(completedJob);
  job.result.requirements.product = "Authoritative product";
  const dom = setup(server([job]), jobId);
  t.after(() => dom.window.close());
  const d = dom.window.document;
  await settle(finished(d));
  assert.equal(d.getElementById("product").value, "Authoritative product");
  assert.equal(d.getElementById("quantity").value, "2.5");
  assert.equal(d.getElementById("unit").value, "custom");
  assert.equal(d.getElementById("unit-custom").value, "pallets");
  assert.equal(text(d, "area-text"), "worldwide");
  assert.equal(d.getElementById("needed-by").value, "");
  assert.equal(d.getElementById("other").value, submitted.other_requirements);
});

test("jobs saved before interpretation existed render from the request's criteria", async (t) => {
  const legacy = {
    status: "completed",
    result: { ...fixture.response, coverage },
    request: { ...fixture.request, stage: "research" },
  };
  const dom = setup(server([legacy]), jobId);
  t.after(() => dom.window.close());
  const d = dom.window.document;
  await settle(finished(d));
  assert.equal(d.getElementById("product").value, "Steel bolts");
  assert.equal(d.getElementById("unit").value, "pieces");
  assert.equal(text(d, "area-text"), "Germany");
  assert.match(
    text(d, "requirements-view"),
    /supplier manufactures steel bolts/,
  );
  assert.match(text(d, "details"), /supplier ships to Germany/);
  assert.match(text(d, "recommendation"), /Example Alpha/);
});

test("an interpretation failure keeps the brief and offers editing and retrying", async (t) => {
  const calls = [];
  const dom = setup(
    server(
      [
        {
          status: "failed",
          result: { phase: "interpreting", requirements: null },
          request,
          error:
            "Could not interpret your requirements reliably. Rephrase them and retry.",
        },
      ],
      calls,
    ),
  );
  t.after(() => dom.window.close());
  const d = dom.window.document;
  fillBrief(dom);
  submit(dom);
  await settle(() => Boolean(d.querySelector("#results-state .state-error")));
  const state = d.getElementById("results-state");
  assert.match(state.textContent, /Could not interpret your requirements/);
  assert.ok(state.querySelector('a[href="#/brief"]'));
  assert.equal(d.getElementById("results-content").hidden, true);
  assert.equal(d.getElementById("recommendation").hidden, true);
  assert.equal(d.getElementById("product").value, submitted.product);
  assert.equal(d.getElementById("brief-fields").disabled, false);
  state.querySelector("[data-action=retry]").click();
  await settle(() => posts(calls).length === 2);
  assert.deepEqual(posts(calls)[1], posts(calls)[0]);
});

test("a job that stops early shows its partial results as incomplete, without a shortlist", async (t) => {
  const partial = structuredClone(complete);
  partial.assessments = partial.assessments.slice(0, 1);
  partial.phase = "evaluation";
  const dom = setup(
    server([
      {
        status: "interrupted",
        result: partial,
        request,
        error: "Worker stopped. Retry.",
      },
    ]),
    jobId,
  );
  t.after(() => dom.window.close());
  const d = dom.window.document;
  await settle(() => !d.getElementById("results-content").hidden);
  assert.match(text(d, "results-state"), /Worker stopped/);
  assert.equal(d.getElementById("recommendation").hidden, true);
  assert.match(text(d, "comparison-progress"), /incomplete/);
  assert.equal(d.querySelectorAll("#comparison tbody tr").length, 1);
  // Evidence from a failed job must not be offered for re-checking.
  assert.equal(d.getElementById("adjust").hidden, true);
  assert.equal(d.querySelectorAll("#sources-list .supplier").length, 3);
});

test("polling a running job does not create a second job and keeps opened panels open", async (t) => {
  const calls = [];
  let release;
  const running = structuredClone(completedJob);
  running.status = "running";
  running.result.phase = "evaluation";
  let polls = 0;
  const dom = setup(async (url, init) => {
    calls.push({ url, init });
    polls++;
    if (polls === 1) return reply(running);
    if (polls === 2)
      return new Promise((resolve) => {
        release = resolve;
      });
    return reply(completedJob);
  }, jobId);
  t.after(() => dom.window.close());
  const d = dom.window.document;
  await settle(() => Boolean(release));
  assert.equal(d.getElementById("recommendation").hidden, true);
  assert.match(text(d, "comparison-progress"), /still running/);
  d.querySelector("#coverage details").open = true;
  d.querySelector("#details .accordion-collapse").classList.add("show");
  const changed = structuredClone(running);
  changed.result.coverage.candidates_found = 4;
  release(reply(changed));
  await settle(finished(d));
  assert.equal(posts(calls).length, 0);
  assert.equal(d.querySelector("#coverage details").open, true);
  assert.ok(
    d.querySelector("#details .accordion-collapse").classList.contains("show"),
  );
  assert.equal(dom.window.localStorage.getItem("quotepilot-job"), jobId);
});

test("a saved job that no longer exists is forgotten with a clear message", async (t) => {
  const dom = setup(
    async () => reply({ error: "Research job not found." }, 404),
    jobId,
  );
  t.after(() => dom.window.close());
  const d = dom.window.document;
  await settle(() => Boolean(d.querySelector("#results-state .state-error")));
  assert.match(text(d, "results-state"), /no longer saved/);
  assert.equal(dom.window.localStorage.getItem("quotepilot-job"), null);
});

test("decision-model detail, fit, price and provenance from the backend are shown", async (t) => {
  const job = structuredClone(completedJob);
  Object.assign(job.result.suppliers[1], {
    fit_rank: 1,
    fit_score: 88,
    fit_result: "pass",
    fit_confidence: 0.93,
    price: "from EUR 0.42 per piece",
  });
  Object.assign(job.result.suppliers[0], { fit_rank: 2, price: null });
  job.result.assessments[0].criteria[0].decisions = [
    {
      evidence_id: suppliers[0].evidence[0].id,
      choice: "pass",
      confidence: 0.6,
      counted: false,
    },
  ];
  job.result.decision_metrics = {
    model: "gemini-decision-1",
    confidence_threshold: 0.85,
    calls: 3,
    questions: 15,
    counted: 9,
    pass_count: 7,
    fail_count: 2,
    abstained: 5,
    below_threshold: 1,
    elapsed_seconds: 4.2,
    evaluation_instructions: "Assess only the given excerpt.",
    suppliers: [],
  };
  const dom = setup(server([job]), jobId);
  t.after(() => dom.window.close());
  const d = dom.window.document;
  await settle(finished(d));
  const performance = text(d, "decision-performance");
  assert.match(performance, /3 calls · 4.2s/);
  assert.match(performance, /1 ignored \(below 85%\)/);
  assert.match(performance, /Assess only the given excerpt/);
  assert.ok(d.querySelector("#details .decision-chip.not-counted"));
  assert.ok(d.querySelector("#recommendation .src-rules"));
  assert.ok(d.querySelector("#details .src-decision"));
  // Sources are ordered by discovery fit and show the cited price.
  const first = d.querySelector("#sources-list .supplier");
  assert.match(first.textContent, /Example Beta/);
  assert.match(first.textContent, /Discovery fit #1/);
  assert.match(first.textContent, /from EUR 0.42 per piece/);
  assert.match(text(d, "sources-list"), /Not listed in cited sources/);
});

test("suggested requirements are offered in the editor and only added on request", async (t) => {
  const calls = [];
  const dom = setup(async (url, init) => {
    calls.push({ url, init });
    if (url === "/api/suggest-criteria/")
      return reply({
        criteria: [
          {
            id: "iso",
            description: "Holds ISO 9001 certification.",
            kind: "mandatory",
            weight: 1,
          },
          {
            id: "dup",
            description: "EU manufacturing required",
            kind: "mandatory",
            weight: 1,
          },
        ],
      });
    return reply(completedJob);
  }, jobId);
  t.after(() => dom.window.close());
  const d = dom.window.document;
  await settle(finished(d));
  d.getElementById("adjust").click();
  d.getElementById("suggest").click();
  await settle(() => d.querySelectorAll("#suggested-criteria li").length > 0);
  const sent = JSON.parse(
    calls.find((c) => c.url === "/api/suggest-criteria/").init.body,
  );
  // 2.5 is not a whole number, so the quantity is left out for this endpoint.
  assert.deepEqual(sent, {
    product: submitted.product,
    delivery_country: "worldwide",
  });
  // The suggestion that repeats an existing requirement is not offered.
  assert.equal(d.querySelectorAll("#suggested-criteria li").length, 1);
  assert.equal(d.querySelectorAll("#criteria .criterion").length, 5);
  d.querySelector("#suggested-criteria button").click();
  assert.equal(d.querySelectorAll("#criteria .criterion").length, 6);
  assert.equal(
    d.querySelector("#criteria .criterion:last-child textarea").value,
    "Holds ISO 9001 certification.",
  );
});

test("the loading screen shows only the current activity", async (t) => {
  const dom = setup(
    server([
      {
        status: "running",
        result: { phase: "discovery", requirements: interpreted },
        request,
      },
    ]),
    jobId,
  );
  t.after(() => dom.window.close());
  const d = dom.window.document;
  await settle(() => Boolean(d.querySelector(".research-loading")));
  assert.match(text(d, "results-state"), /Finding suppliers/);
  assert.equal(d.querySelector(".run-steps"), null);
  assert.equal(d.getElementById("requirements-block").hidden, true);
});

function withRecommendations() {
  const job = structuredClone(completedJob);
  job.result.recommendation_report = {
    summary:
      "Contact Example Alpha first; keep Example Gamma as an alternative.",
    no_eligible_suppliers: false,
    candidate_supplier_ids: ["alpha", "gamma"],
    recommendations: ["alpha", "gamma"].map((id) => ({
      supplier_id: id,
      qualification:
        id === "alpha" ? "meets_documented_requirements" : "outreach_only",
      reasons: [
        {
          text: `Evidence supports contacting ${id}.`,
          evidence_ids: [`${id}-about`],
        },
      ],
      tradeoffs: ["Price and delivery dates need confirmation."],
      verification_questions:
        id === "gamma"
          ? [
              {
                criterion_id: "quantity",
                question: "Can you fulfil 2.5 pallets?",
              },
            ]
          : [],
      email_draft: {
        subject: `Quotation request for ${id}`,
        body: "Hello,\n\nPlease quote for 2.5 pallets delivered worldwide.\n\n[Your name]",
      },
    })),
  };
  return job;
}

test("saved recommendations show contact priority, qualification, citations and complete copyable drafts", async (t) => {
  const dom = setup(server([withRecommendations()]), jobId);
  t.after(() => dom.window.close());
  const d = dom.window.document;
  await settle(() => d.querySelectorAll(".contact-item").length === 2);
  const section = d.getElementById("contact-recommendations");
  assert.match(section.textContent, /1\. Example Alpha/);
  assert.match(section.textContent, /2\. Example Gamma/);
  assert.match(section.textContent, /Meets documented requirements/);
  assert.match(section.textContent, /Outreach only/);
  assert.match(section.textContent, /Can you fulfil 2.5 pallets/);
  assert.equal(
    section.querySelector(".contact-citations a").href,
    "https://alpha.example/about",
  );
  assert.ok(section.querySelector(".src-recommendation"));
  assert.equal(section.querySelector(".src-decision"), null);
  let copied;
  Object.defineProperty(dom.window.navigator, "clipboard", {
    value: {
      writeText: async (value) => {
        copied = value;
      },
    },
  });
  section.querySelector('[data-action="copy"]').click();
  await settle(() => /Draft copied/.test(text(d, "notice")));
  assert.equal(
    copied,
    "Subject: Quotation request for alpha\n\nHello,\n\nPlease quote for 2.5 pallets delivered worldwide.\n\n[Your name]",
  );
  assert.match(text(d, "notice"), /copied/);
  assert.ok(d.querySelector("#recommendation .src-rules"));
});

test("recommendation phase shows real progress without claiming evaluation is still running", async (t) => {
  const job = withRecommendations();
  job.status = "running";
  job.result.phase = "recommendation";
  job.result.recommendation_report = null;
  const dom = setup(server([job]), jobId);
  t.after(() => dom.window.close());
  const d = dom.window.document;
  await settle(() => Boolean(d.querySelector(".research-loading")));
  assert.match(
    text(d, "results-state"),
    /Preparing recommendations and email drafts/,
  );
  assert.match(text(d, "comparison-progress"), /Grading is complete/);
  assert.equal(d.getElementById("contact-recommendations").hidden, true);
  assert.equal(d.getElementById("results-content").hidden, true);
  assert.equal(d.getElementById("decision-performance").hidden, true);
});

test("failed recommendation generation keeps grades and retries with saved evidence", async (t) => {
  const job = structuredClone(completedJob);
  job.result.recommendation_report = null;
  job.result.issues = [
    {
      stage: "recommendation",
      code: "recommendation_unavailable",
      message: "Provider unavailable",
      retryable: true,
    },
  ];
  const calls = [];
  const dom = setup(server([job], calls), jobId);
  t.after(() => dom.window.close());
  const d = dom.window.document;
  await settle(finished(d));
  assert.match(text(d, "contact-recommendations"), /could not be prepared/);
  assert.ok(d.querySelector("#comparison tbody tr"));
  d.querySelector('[data-action="retry-recommendations"]').click();
  await settle(() => posts(calls).length === 1);
  assert.equal(posts(calls)[0].discovery_job_id, jobId);
  assert.deepEqual(posts(calls)[0].requirements, interpreted);
});

test("legacy jobs and empty recommendation reports have distinct states", async (t) => {
  const legacy = setup(server([completedJob]), jobId);
  t.after(() => legacy.window.close());
  await settle(finished(legacy.window.document));
  assert.match(
    text(legacy.window.document, "contact-recommendations"),
    /No recommendations saved/,
  );
  const job = withRecommendations();
  job.result.recommendation_report.no_eligible_suppliers = true;
  job.result.recommendation_report.recommendations = [];
  const empty = setup(server([job]), jobId);
  t.after(() => empty.window.close());
  await settle(finished(empty.window.document));
  assert.match(
    text(empty.window.document, "contact-recommendations"),
    /No supplier was recommended/,
  );
  assert.equal(
    empty.window.document.querySelectorAll(".contact-email").length,
    0,
  );
});

test("recommendation text is untrusted and blocked clipboard access has a manual fallback", async (t) => {
  const job = withRecommendations();
  job.result.recommendation_report.summary = '<img src=x onerror="alert(1)">';
  job.result.recommendation_report.recommendations[0].reasons[0].text =
    "<script>alert(1)</script>";
  job.result.suppliers[0].evidence[0].source_url = "javascript:alert(1)";
  const dom = setup(server([job]), jobId);
  t.after(() => dom.window.close());
  const d = dom.window.document;
  await settle(finished(d));
  const section = d.getElementById("contact-recommendations");
  assert.equal(section.querySelector("img, script"), null);
  assert.equal(section.querySelector('a[href^="javascript:"]'), null);
  assert.match(section.textContent, /<img/);
  section.querySelector('[data-action="copy"]').click();
  await settle(() => /Copying is blocked/.test(text(d, "notice")));
  assert.equal(d.activeElement.id, "contact-email-0");
});

test("a failed recommendation retry shows an actionable error and keeps saved results", async (t) => {
  const dom = setup(
    async (url, init) =>
      init?.method === "POST"
        ? reply({ error: "Research queue is full. Try again later." }, 429)
        : reply(completedJob),
    jobId,
  );
  t.after(() => dom.window.close());
  const d = dom.window.document;
  await settle(finished(d));
  d.querySelector('[data-action="retry-recommendations"]').click();
  await settle(() =>
    Boolean(d.querySelector('#contact-recommendations [role="alert"]')),
  );
  assert.match(text(d, "contact-recommendations"), /Research queue is full/);
  assert.ok(d.querySelector("#comparison tbody tr"));
  assert.equal(
    d.querySelector('[data-action="retry-recommendations"]').disabled,
    false,
  );
});
