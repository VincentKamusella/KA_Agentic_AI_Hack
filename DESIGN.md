# QuotePilot workspace

The user supplied a dark industrial-supplier discovery reference and explicitly requested two neutrals and one accent. This replaces the earlier green workspace. Operate mode; code-first app screen.

## Component system

Bootstrap 5.3.9 is the UI foundation, as requested by the user. Use its form-control, form-select, btn, alert, badge, table, and accordion components throughout. Do not introduce competing custom controls or another component library. Component behavior, focus, disabled states, and collapse animations belong to Bootstrap; `web/static/web/app.css` owns layout and a single CSS-variable theme. Render dynamic accordions with the shared `accordion()` helper and status badges with `badge()`.

Dependencies are pinned in package-lock.json. `npm run build` vendors Bootstrap CSS, JS, and its MIT license into Django static assets. Runtime uses local assets, never a CDN. `npm run check` enforces frontend formatting and syntax. Changes should be checked at desktop and 390px widths with actual comparison data and expanded evidence.

## Palette and layout

Exactly three source colors: charcoal `#0c1017`, off-white `#edf0f5`, and blue `#3865c2`. Surface, border, and muted text values are mixtures of the two neutrals. Blue is reserved for primary actions, active navigation, focus, and progress. Do not add green/red/amber statuses: use explicit Pass / Fail / Unknown text and solid/dashed borders.

A compact sidebar contains only working workspace navigation. The main area has a descriptive title, three counts derived from actual session data, a wide supplier brief panel, and a compact criteria/results split. Tables use a raised neutral header and restrained rules. Evidence expands through Bootstrap accordions. No decorative gradients, fake company data, extra product areas, or invented metrics. At narrow widths the sidebar becomes a compact top navigation and the criteria stack above results.

## Workspace states

The purchase brief is primary before discovery; criteria remain beside the supplier workspace. The workspace presents one task-specific state: ready, searching, candidates ready, evaluating, evaluated, no usable evidence, or stage failure. Each explains what happened and the next action. Pending states show real elapsed time, never simulated percentages. Counts appear only after suppliers exist. Discovery failures retain inputs; evaluation failures retain candidates. Empty results must not look like successful evaluation. Navigation separates discovery, shortlist, source evidence, and method views.
