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
const options = {
  max_suppliers: 30,
  max_queries: 8,
  max_pages_per_supplier: 5,
  countries: [],
  languages: ["English"],
  refresh: false,
};
const coverage = {
  queries: [
    {
      query: "steel bolts manufacturers",
      actual_queries: ["bolt factories"],
      new_suppliers: 3,
      duplicate_suppliers: 1,
    },
  ],
  candidates_found: 3,
  researched: 3,
  pending: 0,
  stop_reason: "query_budget",
};
const suppliers = structuredClone(fixture.response.suppliers).map((s) => ({
  ...s,
  crawl_status: "partial",
  evidence: s.evidence.map((e) => ({ ...e, kind: "page" })),
}));
const result = { suppliers, issues: [], coverage };
const request = { ...fixture.request, options, stage: "discover" };

function setup(fetch, saved = null) {
  const dom = new JSDOM(html.replace(/{%.*?%}/g, ""), {
    url: "http://localhost/",
    runScripts: "outside-only",
  });
  const { window } = dom;
  window.HTMLElement.prototype.scrollIntoView = () => {};
  window.AbortSignal = AbortSignal;
  window.fetch = fetch;
  window.setInterval = () => 1;
  window.clearInterval = () => {};
  if (saved) window.localStorage.setItem("quotepilot-job", saved);
  window.eval(script);
  return dom;
}
const reply = (data) => ({ ok: true, json: async () => structuredClone(data) });
async function settle(check) {
  for (let i = 0; i < 100; i++) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail("UI did not settle");
}

test("discovery posts budgets, polls saved jobs, and renders source passages safely", async (t) => {
  const calls = [];
  const dom = setup(async (url, init) => {
    calls.push({ url, init });
    return reply(
      url === "/api/research/"
        ? { job_id: jobId }
        : { status: "completed", result, request },
    );
  });
  t.after(() => dom.window.close());
  const d = dom.window.document;
  d.getElementById("product").value = "steel bolts";
  d.getElementById("quantity").value = "100";
  d.getElementById("country").value = "Germany";
  d.querySelector("#criteria textarea").value = "ISO 9001";
  d.getElementById("requirements").dispatchEvent(
    new dom.window.Event("submit", { cancelable: true }),
  );
  await settle(() => d.getElementById("loading").hidden);
  assert.equal(JSON.parse(calls[0].init.body).options.max_suppliers, 30);
  assert.equal(calls[1].url, `/api/research/${jobId}/`);
  assert.equal(dom.window.localStorage.getItem("quotepilot-job"), jobId);
  assert.match(d.getElementById("coverage").textContent, /3 researched/);
  assert.match(d.getElementById("sources").textContent, /Source passage/);
  assert.doesNotMatch(
    d.getElementById("sources").textContent,
    /Cited AI summary/,
  );
  assert.equal(d.getElementById("error").hidden, true);
});

test("reload restores the saved brief, source evidence, and research download", async (t) => {
  const dom = setup(
    async () => reply({ status: "completed", result, request }),
    jobId,
  );
  t.after(() => dom.window.close());
  const d = dom.window.document;
  await settle(() => d.getElementById("loading").hidden);
  assert.equal(d.getElementById("product").value, request.requirements.product);
  assert.equal(d.getElementById("supplier-budget").value, "30");
  assert.equal(d.querySelectorAll("#candidates .candidate-row").length, 3);
  assert.equal(
    d.querySelector("#coverage a").download,
    "supplier-research.json",
  );
  assert.equal(d.getElementById("error").hidden, true);
});

test("interrupted jobs show their partial sources and a recovery message", async (t) => {
  const dom = setup(
    async () =>
      reply({
        status: "interrupted",
        result,
        request,
        error: "Worker stopped. Retry.",
      }),
    jobId,
  );
  t.after(() => dom.window.close());
  const d = dom.window.document;
  await settle(() => d.getElementById("loading").hidden);
  assert.equal(d.querySelectorAll("#candidates .candidate-row").length, 3);
  assert.match(d.getElementById("error").textContent, /Worker stopped/);
  assert.equal(d.getElementById("evaluate").disabled, false);
});

test("source text is not executed as HTML", async (t) => {
  const hostile = structuredClone(result);
  hostile.suppliers[0].name = "<img src=x onerror=alert(1)>";
  hostile.suppliers[0].evidence[0].excerpt =
    "<script>window.injected=true</script>";
  const dom = setup(
    async () => reply({ status: "completed", result: hostile, request }),
    jobId,
  );
  t.after(() => dom.window.close());
  await settle(() => dom.window.document.getElementById("loading").hidden);
  assert.equal(dom.window.document.querySelector("#sources script"), null);
  assert.equal(dom.window.document.querySelector("#candidates img"), null);
  assert.match(
    dom.window.document.getElementById("sources").textContent,
    /window.injected/,
  );
});

test("saved evaluation remains visible when its discovery record cannot be loaded", async (t) => {
  const evaluationId = "b".repeat(64);
  const dom = setup(async (url) => {
    if (url.includes(evaluationId))
      return reply({
        status: "completed",
        result: fixture.response,
        request: { ...request, stage: "evaluate", discovery_job_id: jobId },
      });
    return {
      ok: false,
      json: async () => ({ error: "Research job not found." }),
    };
  }, evaluationId);
  t.after(() => dom.window.close());
  const d = dom.window.document;
  await settle(() => d.getElementById("loading").hidden);
  assert.equal(d.getElementById("recommendation").hidden, false);
  assert.equal(d.querySelectorAll("#candidates .candidate-row").length, 3);
  assert.match(d.getElementById("error").textContent, /coverage/i);
});

test("polling a running job shows progress and does not create a second job", async (t) => {
  let polls = 0;
  const dom = setup(async (url, init) => {
    assert.equal(init?.method, undefined);
    polls++;
    return reply({
      status: polls === 1 ? "running" : "completed",
      result,
      request,
    });
  }, jobId);
  t.after(() => dom.window.close());
  const realTimeout = dom.window.setTimeout.bind(dom.window);
  dom.window.setTimeout = (callback, delay, ...args) =>
    realTimeout(callback, delay === 2000 ? 10 : delay, ...args);
  const d = dom.window.document;
  await settle(() => d.getElementById("loading").hidden);
  assert.ok(polls >= 2);
  assert.equal(dom.window.localStorage.getItem("quotepilot-job"), jobId);
  assert.equal(d.getElementById("error").hidden, true);
});

test("coverage details stay open when polling updates the counts", async (t) => {
  let calls = 0,
    release;
  const changed = structuredClone(result);
  changed.coverage.candidates_found = 4;
  const dom = setup(async () => {
    calls++;
    if (calls === 1) return reply({ status: "running", result, request });
    if (calls === 2)
      return new Promise((resolve) => {
        release = resolve;
      });
    return reply({ status: "completed", result: changed, request });
  }, jobId);
  t.after(() => dom.window.close());
  const realTimeout = dom.window.setTimeout.bind(dom.window);
  dom.window.setTimeout = (callback, delay, ...args) =>
    realTimeout(callback, delay === 2000 ? 10 : delay, ...args);
  const d = dom.window.document;
  // restoreResearch first fetches the request, then starts polling.
  await settle(() => Boolean(release));
  release(reply({ status: "running", result, request }));
  await settle(() => Boolean(d.querySelector("#coverage details")));
  d.querySelector("#coverage details").open = true;
  await settle(() => d.getElementById("loading").hidden);
  assert.equal(d.querySelector("#coverage details").open, true);
});
