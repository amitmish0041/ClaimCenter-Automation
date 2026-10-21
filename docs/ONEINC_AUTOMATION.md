# OneInc payment automation

Automates the OneInc test designs (the `GCCM-xxx … Test Design` workbooks) against **ClaimCenter Cloud**, reusing
this repo's ClaimCenter login, claim search and payment-wizard knowledge. It runs from the Runner's **OneInc Payments**
tab or from the command line, and writes an HTML / JSON / CSV report with screenshots and evidence for every run.

It is **read-only by default**: it opens the payment wizards, fills them far enough to reach the screen under test,
reads the screen, and **always cancels**. It never creates claims, contacts, reserves or payments.

## Where things are

| What | Where |
|---|---|
| Test-design workbooks | `V:\Amit Int\OneInc` — the team share (`ONEINC_DIR`). If only `One Inc.zip` is there it is unpacked once, next to itself. |
| Shared claim pool / remembered claims | `<ONEINC_DIR>\AutomationResults\TestData\claim-pool-<tier>.json`, `claims-<tier>.json` |
| Policy/claim list used to create claims | `V:\Amit Int\SmartComm\data\Test Data\ClaimsCreatedLast3YrsInTest_*.xlsx` (`SMARTCOMM_DATA_DIR`) |
| Results | `<ONEINC_DIR>\AutomationResults` (`ONEINC_RESULTS_DIR`) |
| Code | `helpers/oneInc/*`, `scripts/runOneInc.js`, `tests/offline/oneInc.offline.js` |
| Runner tab | `Commercial Line Performance test/runner` → **OneInc Payments** (server suite `oneInc`) |

`AutomationResults` layout (run ids are `OneInc_<yyyymmdd>_<hhmmss>_<tier>`, so nothing is overwritten):

```
Reports\      OneInc_<runId>.html / .json / .csv, latest.html, latest.json
Screenshots\  <runId>\<scenario>\NN-check-N.png   (one per checked screen, plus blocked/error shots)
Evidence\     <runId>\<scenario>\NN-*.json        (what the screen showed: fields, required/read-only, options, messages)
Logs\         <runId>.log
TestData\     <runId>-claims.json                 (which existing claim each scenario used)
RunHistory\   <runId>.json, history.csv
```

## How it works

1. **Inventory** (`inventoryService.js`) reads every workbook. All test-case sheets share one 11-column layout;
   reference sheets (overview, mock-ups, dropdown lists) are listed but not treated as cases. Scenario ids are
   `<story>/<sheet>/<TC id>`, e.g. `GCCM-799/UIF/TC-066` (TC ids restart on every sheet).
2. **Jira readiness** (`jiraReadiness.js`) reads the GCCM OneInc cards (`CC_Requirements_ / CC_Dev_ / CC_Test Design_ /
   CC_Test Execution_OneInc_<feature>`) and gives each story READY / DEV_DONE / DEV_PENDING / UNKNOWN. It also loads
   the OneInc bugs so a failure can point at an already-logged bug. JQL override: `ONEINC_JIRA_JQL`.
3. **Classification** (`classifier.js`) — every case gets one category, so none is silently skipped:
   `AUTOMATED` (has a recipe), `SUPERSEDED` (older sheet replaced by a "… New" sheet), `DEV_PENDING` (Jira dev not Done),
   `NEEDS_DATA` (needs claim/contact setup the read-only suite can't create), `MANUAL` (needs OneInc payloads/webhooks,
   Contact Manager, admin permission changes, or a submitted payment).
4. **Recipes** (`scenarioRecipes.js`) — per automated case: the claim profile, the steps that set up its precondition,
   and the checks that compare the screen with its Expected Result.
5. **Execution** (`scenarioRunner.js` + `wizardDriver.js` + `screenReader.js`) — opens the claim, drives the wizard,
   evaluates checks, screenshots each checked screen, cancels.
6. **Reports** (`reportService.js`).

### Status rules

| Status | Meaning |
|---|---|
| PASS | Every check ran and passed (a scenario with no check that ran is never a PASS) |
| FAIL | A check failed, or ClaimCenter errored during a mandatory step |
| BLOCKED | A precondition/environment issue stopped it first (login, claim access, missing claim data, a rule that can only be confirmed by submitting a payment, story dev not Done) |
| NOT EXECUTED | Not run: manual / needs data / superseded / not selected |

**Executed** = PASS + FAIL + BLOCKED. **Pass %** = PASS ÷ executed (the report also shows PASS ÷ (PASS + FAIL)).

**"Possible pending development"** — a FAIL where the expected field / option / message is simply not on the screen
is flagged this way, with the story's Jira Dev and Test Execution status and any matching logged OneInc bug. Check
those before logging a new defect.

### Claims used

Every test design starts with "issue a policy in PolicyCenter and create a claim". The suite satisfies that with an
**existing** cloud claim of the right line/state instead, picked from the SQL-extracted claim list the SmartCOMM suite
already uses (`helpers/smartComm/testDataService.js`). Profiles: `AUTO_PA`, `AUTO_MI`, `WC_PA`, `PROP_PA`
(`claimPicker.js`). A claim that worked is remembered in `<ONEINC_DIR>AutomationResultsTestDataaims-<tier>.json`; if a claim can't be used
(no open reserve, no payees…) the next candidate is tried. Pin one with e.g. `ONEINC_CLAIM_WC_PA=WC-PA-01-26-0748037`.

### Creating test claims upfront (provisioning)

The preferred source of claims. `scripts/provisionOneIncClaims.js` creates fresh claims per profile with the same
`completeFNOL` call the LOB e2e tests use, on **policies taken from the TEST claim list** (`SMARTCOMM_DATA_DIR\Test
Data\ClaimsCreatedLast3YrsInTest_*.xlsx`) — they already have a cloud claim, so they exist in TEST — with the loss date
set to the **day after that existing claim's loss date**. Each new claim is prepared (assigned, Surcharging, reserve)
and checked, then added to the **claim pool** (`<ONEINC_DIR>AutomationResultsTestDataaim-pool-<tier>.json`, shared by the team), which runs use first.

```
node scripts/provisionOneIncClaims.js --profiles AUTO_PA,WC_PA --count 2      # create claims (TEST only)
node scripts/provisionOneIncClaims.js --add PROP_PA=HO-PA-01-26-0748434       # add an existing / hand-made claim
node scripts/runOneInc.js --story GCCM-759 --provision --pool-size 2           # top up the pool for the selected scenarios, then run
```

In the Runner: tick **"Create fresh test claims first"** (TEST only). If provisioning can't produce a claim, scenarios
fall back to existing test-data claims and the report says which claim each one used.

**Status 2026-10-20:** FNOL on cloud TEST fails at the final save with a server-side "An application error occurred"
(reproduced by hand; being fixed on the application side), and adding an exposure / reserve to an existing claim hits
the same error — so the pool is empty until that is fixed; runs use the known-good existing claims meanwhile.

### Finding and preparing test claims (scout)

`scripts/scoutOneIncClaims.js` checks candidate claims per profile and pins the best one (written to
`<ONEINC_DIR>\AutomationResults\TestData\claims-<tier>.json`, findings in `scout-<tier>.json` next to it):

```
node scripts/scoutOneIncClaims.js                       # read-only: report which claims are usable
node scripts/scoutOneIncClaims.js --profiles AUTO_MI,PROP_PA --prepare   # TEST only: also fix what blocks payment
```

Per claim it records: opens? (claims the standard user can't view are opened with `CC_ADMIN_USER`), does New Payment
open (and if not, ClaimCenter's "New Payment Error" reason), payees, which payees have payment contact details, and
which reserve lines have open reserve. `--prepare` (TEST only, approved 2026-10-20) fixes the blockers it knows:
completes an unfinished **Surcharging** screen (answers "No"), **assigns** an unassigned claim and its exposures, and
adds a **$2,500 reserve** when a claim has none. If no claim can be made usable, create one with the existing FNOL
automation (e.g. `npm run e2e:cloud:ho`) and pin it with `ONEINC_CLAIM_<PROFILE>`.

### Vendor payees

Vendor scenarios add an Approved **Vendor (Company)** from the Address Book through the Step 1 Name picker › Search,
matched by Tax ID. Defaults (cloud TEST, supplied 2026-10-20): ADJUSTMENT SERVICES INC 58-1623664, LITIGATION
SOLUTIONS LLC 25-1834107, TAYLOR REPORTING SERVICE 58-2338930, ESQUIRE DEPOSITION SOLUTIONS LLC 45-3463120. Override
with `ONEINC_VENDORS='[{"name":"…","search":"…","taxId":"NN-NNNNNNN"}]'`.

### "Payment contact details" (ClaimsPay defaults)

The ClaimsPay default cases (CPD) depend on whether ClaimCenter considers the payee to have payment contact details
(it shows "Payees other than vendor should have the payment contact details set up on the parties involved" when
not). Observed 2026-10-20: this is **not** the claim contact's E-mail/Phone — contacts with both still show it — while
an Address-Book-linked contact with no email showed no warning, and ClaimsPay test contacts ("test claimpay … contact")
on MI claims have it. The CPD recipes gate on that warning and report BLOCKED with the reason when the payee doesn't
meet the case's precondition.

### Validation rules and Finish

The VBR test cases say "click Finish". The suite triggers each rule with **Next** first (CC fires most rules there).
If the rule doesn't fire on Next, confirming it needs **Finish**, which *submits the payment to OneInc* when no error
appears — so it is off by default and the scenario is BLOCKED with that reason. To run those, set
`ONEINC_ALLOW_FINISH=1` (or tick "Allow Finish" in the Runner); it is honoured on the **test/dev** tiers only.

## Running

Runner: **OneInc Payments** tab → pick tier → select scenarios (or *Run all automated* / *Re-run failed/blocked*).
Live per-scenario status shows in the table; reports and logs are in *Run history*.

Command line (from this repo):

```
npm run oneinc:test                                        # all automated, cloud TEST
node scripts/runOneInc.js --story GCCM-759,GCCM-799        # by story
node scripts/runOneInc.js --ids "GCCM-759/UIF/TC-001,GCCM-799/UIF/TC-066"
node scripts/runOneInc.js --rerun-failed OneInc_20261020_120000_test
npm run oneinc:list                                        # inventory + classification + readiness, no browser
options: --headless (visible browser is the default)  --max-claims 4
npm run test:offline                                       # unit checks (no browser)
```

### Configuration

| Variable | Default | Purpose |
|---|---|---|
| `CC_TIER` | `test` | Cloud tier (`test` / `dev`); `CC_ENV` is forced to `cloud` |
| `CC_USER` / `CC_PASS` | `.env` / Runner Settings | ClaimCenter login (never written to results) |
| `ONEINC_DIR` | `V:\Amit Int\OneInc` | Workbook + results folder (team share) |
| `ONEINC_HEADLESS` | off | `1` hides the browser (default: visible, so runs can be watched); same as `--headless` |
| `ONEINC_RESULTS_DIR` | `<ONEINC_DIR>\AutomationResults` | Output folder |
| `JIRA_EMAIL` / `JIRA_API_TOKEN` / `JIRA_SITE` | this repo's `.env`, else the Runner repo's `.env` | Story readiness + bug matching (read-only) |
| `ONEINC_JIRA_JQL` | OneInc cards in GCCM | Override the readiness query |
| `ONEINC_CLAIM_<PROFILE>` | — | Pin a claim per profile |
| `ONEINC_ALLOW_FINISH` | off | Let validation scenarios press Finish (submits payments) on test/dev |

## Adding a recipe

Add an entry in `helpers/oneInc/scenarioRecipes.js` keyed by the scenario id (see `npm run oneinc:list` for ids).
Building blocks: `FULL_PAYEES(who)`, `FULL_PAYMENTS(who, reserve)`, `FULL_INSTRUCTIONS(who)`, `NEW_LINE(costType)`,
`QUICK()`, `QUICK_DETAILS()`, checks `V(label, {...})` (visible + required/editable/readonly/includes/excludes/value)
and `H(label)` (hidden). Use `unlessBlocked: '<why>'` on a visibility check when it depends on claim data the suite
can't confirm, so an absent field reports BLOCKED instead of FAIL. Run `npm run test:offline` afterwards — it checks
every recipe id exists in the workbooks.

## Troubleshooting

- **Everything BLOCKED at login** — check `CC_USER`/`CC_PASS` (Runner Settings) and that the cloud tier is up.
- **"claim … not usable"** — the picked claim has no open reserve or no payees; the next candidate is tried. Pin a
  known-good claim with `ONEINC_CLAIM_<PROFILE>`.
- **Wizard left open between scenarios** — CC's Cancel asks for a native browser confirm; `cancelWizard` accepts it.
  If CC changes that dialog, this is where to look.
- **Jira readiness UNKNOWN** — no `JIRA_EMAIL`/`JIRA_API_TOKEN`; the run still works, without the readiness notes.
