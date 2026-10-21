# OneInc test runs — step-by-step guide

For QA running the OneInc test designs (one Jira story = one workbook) with the **ClaimCenter Runner**. Follow the
same checklist for every story; the story table tells you what is different for each one.

Everything lives on the team share — nothing is on anyone's own drive:

| What | Where |
|---|---|
| Test-design workbooks (one per Jira story) | `V:\Amit Int\OneInc\One Inc\` |
| Reports, screenshots, logs, evidence | `V:\Amit Int\OneInc\AutomationResults\` |
| Shared pool of test claims | `V:\Amit Int\OneInc\AutomationResults\TestData\claim-pool-test.json` |
| Policies used to create new claims | `V:\Amit Int\SmartComm\data\Test Data\ClaimsCreatedLast3YrsInTest_*.xlsx` |

---

## 1. One-time setup (each person)

1. Open the Runner — the shared one at **http://mar-guidewir-9:3000**, or your installed ClaimCenter Runner app.
2. **Settings** tab: enter your name, email, ClaimCenter username/password and the admin username/password
   (the admin login is used automatically for claims your own user may not open). Add your Jira email + API token
   so the tab can show each story's Jira readiness.
3. Make sure **V:** is mapped on your PC (`V:\Amit Int\OneInc` must open in Explorer).
4. Enter your email in the Report Email field (SmartCOMM or Jira tab) — the Runner uses it to know who is running.

> **Watching the run:** the browser always runs *visible*. It opens on the computer that runs the Runner — on the
> shared Runner that is mar-guidewir-9, on the installed app it is your own PC. Use the installed app if you want to
> watch the browser yourself.

## 2. Run one story — the checklist

1. **OneInc Payments** tab → pick **TEST**.
2. Find the story card at the top (e.g. *GCCM-759*). Check its readiness badge:
   - **READY** — dev Done and the Test Execution card is Ready for QA / In Progress → run it.
   - **DEV DONE** — dev Done, Test Execution still To Do → OK to run; tell the lead it started.
   - **DEV PENDING** — development not finished → don't run yet; its cases show BLOCKED with the Jira card named.
3. In the filters: **story** = that story, **category** = AUTOMATED → click **Select visible automated**.
4. Options:
   - **Create fresh test claims first** — leave ticked (default 2 per claim type). See section 3.
   - **Allow Finish** — tick only for the payment-validation stories (GCCM-763, GCCM-803). It *submits real payments
     on TEST* for the cases whose rule should let the payment through.
5. Click **Run selected**. Don't close the Runner tab while it runs (closing is fine for the browser; the run continues).
6. Track it (section 4) until the banner says the run finished.
7. Review the results (section 5) and update Jira (section 6).
8. Run the story's **manual / needs-data** cases by hand from the workbook (the table in section 7 says how many).

To re-run only what failed or was blocked: **Re-run failed/blocked** (uses the latest run).

## 3. How test data is created for the selected story

When **Create fresh test claims first** is ticked, before any scenario runs the tool:

1. Works out which **claim types** the selected scenarios need — e.g. GCCM-759 needs *PA personal auto* and
   *PA workers' comp*.
2. Looks in the **shared claim pool** for usable claims of each type. If there are fewer than the pool size you
   chose, it creates the missing ones:
   - takes a **policy from the TEST claim list** (`ClaimsCreatedLast3YrsInTest_*.xlsx`) that already has a cloud claim
     (so the policy is known to exist in TEST), a different policy for each new claim;
   - runs **FNOL** with a loss date **one day after that policy's existing claim** (inside the policy term);
   - **prepares** the claim: assigns it and its exposures, completes the Surcharging screen, adds a reserve if needed;
   - **checks** it opens the payment wizard with payees and an open reserve, then adds it to the pool.
3. Runs the scenarios on pool claims first. If no claim could be created, it falls back to known-good existing
   claims — every result says which claim it used.

You can see the pool in `…\AutomationResults\TestData\claim-pool-test.json` (claim, policy, loss date, which existing
claim it was based on, usable or not and why). To add a claim you created by hand:
`node scripts/provisionOneIncClaims.js --add PROP_PA=HO-PA-01-26-0748434` (types: AUTO_PA, AUTO_MI, WC_PA, PROP_PA).

> **Status 2026-10-20:** creating claims on cloud TEST fails at the final save with a server error ("An application
> error occurred") — being fixed. Until then runs use the existing claims.

## 4. Tracking a run

| Where | What you see |
|---|---|
| **The browser window** | the run itself, live (visible by default) |
| **OneInc Payments tab → banner** | "Run … in progress — N of M done (pass / fail / blocked)", refreshed every 15 s, with links to the partial report and live log |
| **Scenario table → Last status** | each scenario turns RUNNING → PASS / FAIL / BLOCKED as it finishes; **details** shows expected vs actual, steps, the claim used and screenshots |
| **Status / Console panels** (bottom of the tab) | progress bar and the raw log |
| **Run history** (bottom card) | every run: start time, duration, counts, links to HTML / JSON / CSV report and log |
| **V:\Amit Int\OneInc\AutomationResults** | `Reports\` (latest.html = newest run), `Logs\`, `Screenshots\<run>\<scenario>\`, `Evidence\…` (what each screen showed), `TestData\` (claims used), `RunHistory\history.csv` |

The report is rewritten after every scenario, so you can open it mid-run.

## 5. Reading the results

| Status | Meaning | What to do |
|---|---|---|
| **PASS** | every check ran and matched the expected result | nothing |
| **FAIL** | a check did not match | open **details** + screenshot. If it says **possible pending development** or lists a related bug (e.g. GCCM-1255), check that first; otherwise log a bug |
| **BLOCKED** | a precondition or the environment stopped it (no suitable claim data, server error, rule that needs Finish when Finish isn't allowed, story dev not Done) | read the reason; fix the data/setting and **Re-run failed/blocked**, or run it by hand |
| **NOT EXECUTED** | not run — manual, needs special data, superseded sheet, or not selected | run by hand from the workbook if it's in scope |

"ClaimCenter server error (environment, not a rule verdict)" = TEST itself failed; re-run later.

## 6. After the run — Jira

1. Open the HTML report (Run history → **HTML**). Attach it (or the CSV) to the story's **Test Execution** card.
2. Log a bug for each real FAIL (not the "pending development" ones until dev confirms); link it to the card.
3. Move the Test Execution card when all in-scope cases (automated + manual) have a result.

## 7. Story by story

| Story (test design) | Dev / Test Exec cards (2026-10-20) | Cases | Automated | Manual / needs data | Claim types it uses | Notes |
|---|---|---|---|---|---|---|
| **GCCM-759** Common UI Part 1 (Full Check) | GCCM-758 Done / GCCM-760 In Progress | 62 | 34 | 28 | PA auto, WC | CPD (ClaimsPay default) cases need a payee with *payment contact details* — BLOCKED until that data exists |
| **GCCM-799** Common UI Part 2 (Full Check) | GCCM-798 Done / GCCM-800 In Progress | 85 | 38 | 47 | PA auto, WC, HO, MI auto | Vendor cases pick an Approved vendor by Tax ID (ADJUSTMENT SERVICES INC 58-1623664 …) |
| **GCCM-1003** Quick Check / Quick Payment | GCCM-1006 Done / GCCM-1005 To Do | 258 | 36 | 222 | PA auto, HO | Most of its rule cases mirror GCCM-763/803 and need specific claim data |
| **GCCM-763** Payment validation part 1 | GCCM-762 Done / GCCM-764 Ready for QA | 62 | 7 | 55 | PA auto | Tick **Allow Finish** — rules are confirmed on Finish (submits payments on TEST) |
| **GCCM-803** Payment validation part 2 | GCCM-802 Done / GCCM-804 Ready for QA | 63 | 8 | 55 | PA auto | Tick **Allow Finish**; expense cases use a vendor payee |
| **GCCM-783** Parties Involved / CM accelerator | GCCM-782 Done / (none) | 3 | 2 | 1 | PA auto | TC-001 is in Contact Manager — manual |
| **GCCM-791** Bulk Invoice | GCCM-790 Done / GCCM-792 Ready for QA | 4 | 0 | 4 | — | Needs admin permission changes — manual |
| **GCCM-795** Update Contact in Contact Manager | GCCM-794 Done / GCCM-796 To Do | 7 | 0 | 7 | — | Contact Manager + integration — manual (3 cases on a superseded sheet) |
| **GCCM-1008** Additional Payment Details | GCCM-1009 **In Progress** / GCCM-1010 To Do | 19 | 0 | 19 | — | **Dev pending** — wait for GCCM-1009 |

The "Manual / needs data" cases each carry a reason in the tab (e.g. *Needs a Lienholder/Mortgagee contact…*,
*Needs OneInc webhook…*) — filter **category** to MANUAL or NEEDS_DATA to list them.

## 8. Command line (optional)

From the ClaimCenter-Automation folder:

```
node scripts/runOneInc.js --story GCCM-759 --provision --pool-size 2      # one story, fresh claims first
node scripts/runOneInc.js --rerun-failed <runId>                          # FAIL + BLOCKED of a run
node scripts/runOneInc.js --list --out oneinc-inventory.json              # every case with its category
ONEINC_ALLOW_FINISH=1 node scripts/runOneInc.js --story GCCM-803          # validation rules incl. Finish
```

The browser is visible by default; add `--headless` to hide it.

## 9. If something goes wrong

| Symptom | Fix |
|---|---|
| Tab shows "Could not load OneInc scenarios" | the Runner was started before an update — ask the owner to restart it |
| Everything BLOCKED at login | check your ClaimCenter password in Settings |
| "no permission to view claim" | the admin login (Settings) is missing — add it |
| Many "claim … not usable" | the pool is empty/used up — run with **Create fresh test claims first** |
| "ClaimCenter server error" | TEST environment problem — re-run later |
| V: paths not found | map the V: drive |
