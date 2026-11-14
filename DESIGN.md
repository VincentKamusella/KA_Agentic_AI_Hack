# QuotePilot workspace

Dark workspace for procurement specialists: a simple purchase brief goes in, one research job runs on the server, and a shortlist with its evidence comes back. Operate mode; code-first app screen. At the user's request it uses a collapsible left sidebar instead of a top bar, and adds status colours to the two-neutrals-plus-accent palette.

## Component system

Bootstrap 5.3.9 is the UI foundation. Use its form-control, form-select, input-group, btn, btn-group/btn-check, table, spinner, modal, and accordion components; do not add another component library. Bootstrap owns component behaviour, focus handling, disabled states, and collapse animation. `web/static/web/app.css` owns layout and the CSS-variable theme. `web/static/web/app.js` builds all dynamic markup through the `h()` helper using `textContent`, because supplier excerpts are untrusted text; never use `innerHTML`. Status is rendered with `chip()`, pending/empty/error states with `panel()`.

Dependencies are pinned in package-lock.json. `npm run build` vendors Bootstrap, Leaflet, IBM Plex Sans (Latin, weights 400/500/600) and their licenses into Django static assets. Libraries and fonts are always local, never from a CDN. The only runtime calls to other hosts come from the delivery-area dialog: Esri satellite tiles and OpenStreetMap Nominatim place lookups; the dialog says so. `npm run check` enforces formatting and syntax.

## Palette and type

- Ground: black, with one fixed, very subtle page gradient requested by the user: black at the top, fading through dark blue, to a trace of orange at the very bottom (`body::before` in `app.css`). Black must stay dominant; do not brighten it or add further gradients.
- Neutrals: near-black `#07090d` and off-white `#edf0f5`. Panels, the sidebar, inputs, and borders are translucent tints of off-white or black so the gradient shows through; they are not filled. Only layers that must hide what is beneath them use the opaque `--qp-solid`: the map dialog, map controls, and the pinned supplier column.
- Accent: blue `#3865c2` for primary actions, the current workflow step, focus, rank markers, and the shortlist summary. Link text uses a lighter mix of the accent for contrast.
- Status, results only: green `#58c594` for Pass / Eligible, red `#f0796c` for Fail / Not eligible, amber `#e0b454` for Unknown / Needs verification. Always paired with an icon and a text label; "Not evaluated" stays neutral. Do not use these colours for decoration.
- Type: IBM Plex Sans, 15px body. Tabular numerals for scores, counts, and elapsed time.
- Icons: the inline SVG sprite in `index.html`, one stroke weight. No emoji or glyph icons.

No other decorative gradients, fake company data, extra product areas, or invented metrics.

## Layout

A left sidebar holds the navigation. It is a 64px icon rail by default and expands to 244px with labels through the hamburger button; the choice is remembered in the browser. It lists Current research, the future features History, Preferences, and Old suppliers (disabled, tagged "Soon"), and at the bottom Settings (also disabled until it exists). Do not make a placeholder look or behave as if it worked.

There is no top bar and no step indicator; the user removed both. The research page has three views, reached through the actions and links on each view, never through a separate navigation element. Every view has "New search" beside its title. When adding a view, make sure it stays reachable this way. Content is a single column, maximum 1160px.

- **Brief** (`#/brief`): three required inputs (what is needed, quantity with unit, delivery destination) and two optional ones (needed-by date, other requirements). Units are a select with a custom option. There are no research-budget or search-scope controls; the user removed them, so research runs with the backend defaults. The primary action is "Find my shortlist". Do not add budgets, certifications, weights, or a criteria editor to this form: the backend interprets the brief.
- **Delivery destination**: a button that opens a modal with a satellite map and four scopes in a segmented control: Radius (search or click for the centre, slider for 5–500 km, drawn as a circle), Countries (click or search to toggle, shown as removable chips), Continents (toggle buttons or map click), and Worldwide. Selected countries are filled with the accent colour. The choice is sent as text and the backend accepts 100 characters, so the dialog blocks longer selections.
- **Shortlist** (`#/results`): progress while the job runs, then the summary, "Your requirements" grouped into Must have and Nice to have, the comparison matrix, assessment details, research notes, and research coverage. Requirement numbers are the same in the list, the matrix columns, and the details. "Adjust requirements" turns the list into an editor (wording, must-have or nice-to-have, add, remove; never weights) and "Update shortlist" re-checks the saved evidence.
- **Sources** (`#/sources`): every researched supplier with its retrieved passages, and candidates that were found but not researched.

Below 720px the sidebar becomes a row with the hamburger and brand whose menu opens in place and closes after navigating, controls stack, the map dialog is full screen, and the matrix scrolls horizontally with the supplier column pinned. Check changes at 1440px and 390px with real comparison data and expanded details.

## Live runs and provenance

While a job runs, a loading panel shows one current activity, elapsed time, and an optional link to sources over a blurred stack of real candidate previews. Before candidates arrive, abstract skeleton cards occupy the stack. Preview content is inert and hidden from assistive technology; a clear discovered count carries the information. Cards continuously shuffle through three staggered positions, preserving animation phase across polling updates; reduced-motion users see a static stack. The loading panel has no supplier-preview button. Search and website retrieval have distinct messages. The technical step checklist and detailed result sections stay hidden until the run ends; source evidence remains accessible. Nothing is simulated. The decision-model panel fills in as evaluation checkpoints arrive: calls, latency, counted and ignored answers, the prompts and rubric that were used, and one requirement × excerpt matrix per supplier.

Every model-derived value carries a `sourceTag()`: the solid, inverted **Decision model** chip is reserved for `gemini-decision-1` output; **Search model**, **Code**, and **Rules** stay outlined. Show decision confidence next to decision results, and mark answers ignored under the threshold with dashed, struck-through chips. Suppliers show their discovery fit rank and listed price where the backend provides them, and Sources is ordered by fit. "Suggest requirements" in the requirements editor offers model suggestions that the user adds one by one; none is included automatically.

## States and copy

The Shortlist view shows exactly one job state at a time: nothing yet, queued, a running phase ("Understanding your requirements", "Finding suppliers", "Checking suppliers against your requirements"), finished, no suppliers found, failed, or connection lost. Each says what happened and what to do next. Running states show real elapsed seconds and real counts from the job, never simulated progress. Partial results appear as soon as the job reports them and are labelled as incomplete; the shortlist summary appears only when the job has completed.

The submitted form is kept, locked, while a job runs, and kept on every error. Validation messages sit under the field they belong to; anything that cannot be matched to a field goes in the message at the top of the form. A failed job keeps the brief and offers "Edit brief" and "Retry".

"Needs verification" is never presented as a pass. When no supplier is confirmed, the summary still lists the suppliers that need confirmation and which requirements are open. Copy never implies that order capacity or delivery dates are guaranteed, that orders are placed, or that messages are sent. A supplier whose evaluation failed is "Not evaluated", never failed. Source passages are labelled by kind (source passage, PDF source passage, search summary).

Copy states only what the code does.

Supplier recommendations use a deck: one complete card is visible at a time, with layered edges, a position count, and Previous/Next buttons. A View full list / Back to card stack toggle switches layouts without losing the selected card. Contact priority order is preserved; evidence and email drafts stay inside each card.

The results page prioritizes reviewing supplier cards and opening quotation drafts in an email app. Detailed comparisons, requirements, grading metrics and research notes live in a collapsed Research details section. Each card keeps its qualification and leading reason visible, with evidence and questions on demand. Email drafts can be opened via mailto or copied; recipients are entered in the email app, and the app itself does not send messages.

The results view omits the purchase-summary bar. Edit brief and View sources links remain inside Research details.

Recommendation cards show evidence by default in two groups: Why consider this supplier and What to check before ordering. These are side by side on desktop and stacked on mobile; citations are secondary, and the email action follows below. The section introduction contains only a heading and one short qualification message when needed.

Research details is no longer exposed on the results page. Supplier recommendation cards are the results interface; legacy grading/editor DOM remains hidden and inert for compatibility.

Supplier cards expose only Open in email app for outreach. Inline draft previews and their copy control have been removed; the full subject and message are passed to the email app.

The deck uses Previous/Next only; the full-list option is removed. Directional 440ms card transitions reverse for Previous, with instant switching for reduced motion.
