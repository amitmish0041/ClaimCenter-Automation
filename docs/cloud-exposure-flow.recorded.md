# Cloud exposure + assignment flow — RECORDED reference

Captured with `npx playwright codegen` against cloud DEV on claim
`CA-OH-85-26-0000181`. This is ground truth: every locator below was produced
by Playwright from the live page, not inferred.

## What this corrects

Several assumptions made while guessing at this flow were **wrong**:

| Assumption | Reality |
|---|---|
| `getByRole('menuitem', {name})` can't work — labels are child divs | **It works.** Playwright computes the accessible name from the child `.gw-label`. |
| `getByRole('button', {name:'Update'})` can't match split text | **It works.** |
| Coverage menu needs column scoping / aria-label gymnastics | Plain `getByRole('menuitem', {name})` is enough. |
| `Auto BI/PD Single Limit` is a selectable coverage | It is a GROUPER. The selectable leaf is `Bodily Injury Liability`. |

The real reason the exposure step failed was **not** the locators: the walk
stopped on a grouper (`Auto BI/PD Single Limit`), so the New Exposure screen
never opened and there was no Update button to find.

## Assignment

```js
await page.getByRole('button', { name: 'deferred Actions' }).click();
await page.getByLabel('Assign Claim').click();
await page.getByLabel('Select from list:').selectOption('Mitch Parham (Bodily Injury Claims Division)');
await page.getByRole('button', { name: 'Assign' }).click();
```

Note `selectOption` (native `<select>`) and `getByRole('button', {name:'Assign'})`
— both already implemented and working.

## Exposure 1 — a liability coverage (leaf reached directly)

```js
await page.getByRole('button', { name: 'deferred Actions' }).click();
await page.getByRole('menuitem', { name: 'Bodily Injury Liability' }).click();

// New Exposure screen
await page.getByLabel('Claimant Number').selectOption('160');
await page.getByLabel('Cause of Loss').selectOption('LC03');
await page.getByLabel('Cause of Loss Description').selectOption('dogbite');

// Injury incident sub-popup (WC/liability only)
await page.locator('#NewExposure-NewExposureScreen-NewExposureDV-Injury_Incident-Injury_IncidentMenuIcon')
  .getByRole('button', { name: 'options' }).click();
await page.getByLabel('New Incident...').click();
await page.getByLabel('Injured Person').selectOption('Person:5829');
await page.getByLabel('Loss Party').selectOption('insured');
await page.getByRole('textbox', { name: 'Describe Injuries' }).fill('test injuries');
await page.locator('#NewInjuryIncidentPopup-NewInjuryIncidentScreen-InjuryIncidentDV-InjuryIncidentInputSet-EditableBodyPartDetailsLV_tb-Add')
  .getByRole('button', { name: 'Add' }).click();
await page.getByLabel('Area of BodyArea of Body').selectOption('head');
await page.getByLabel('Body PartBody Part').selectOption('10');
await page.getByRole('textbox', { name: 'PPD Percentage' }).fill('15');
await page.getByLabel('Treatment Type').selectOption('acup');
await page.getByLabel('Primary Doctor').selectOption('Person:5829');
await page.getByLabel('Disabled Due To Accident?').selectOption('notdisabled');
await page.getByRole('radiogroup', { name: 'Ambulance Used?' }).getByLabel('No', { exact: true }).click();
await page.getByRole('radiogroup', { name: 'Lost Wages?' }).getByLabel('No', { exact: true }).click();
await page.getByRole('button', { name: 'OK' }).click();

await page.getByLabel('Claimant', { exact: true }).selectOption('Person:5829');
await page.getByLabel('Type').selectOption('insured');
await page.getByRole('button', { name: 'Update' }).click();
```

## Exposure 2 — via Choose by Coverage > Policy Level Coverage

```js
await page.getByRole('button', { name: 'deferred Actions' }).click();
await page.getByRole('menuitem', { name: 'Choose by Coverage' }).click();
await page.getByRole('menuitem', { name: 'Policy Level Coverage' }).click();
await page.getByLabel('Business Income (including').click();     // <-- getByLabel, NOT menuitem

// New Exposure screen
await page.getByLabel('Claimant Number').selectOption('162');
await page.getByLabel('Cause of Loss').selectOption('LC98');
await page.getByLabel('Cause of Loss Description').selectOption('all_other');
await page.getByLabel('Claimant', { exact: true }).selectOption('Company:5827');
await page.getByLabel('Litigation Status').selectOption('N');
await page.getByLabel('Location', { exact: true }).selectOption('Address:6407');
await page.getByRole('textbox', { name: 'Description', exact: true }).fill('desription');
await page.getByRole('button', { name: 'Update' }).click();
```

## Points to carry into the helper

1. **Menu navigation is CLICK, one level at a time**, using
   `getByRole('menuitem', { name })`. No hover, no column scoping.
2. **The deepest entry is reached with `getByLabel(...)`, not `menuitem`** —
   see `Business Income (including`. Leaves and groupers differ in role.
3. **The New Exposure screen is a form of native `<select>`s** driven by
   `getByLabel(...).selectOption(...)`. Values are codes
   (`LC03`, `Person:5829`, `Address:6407`) that vary per claim, so they must be
   chosen at run time (first non-`<none>` option) rather than hardcoded.
4. **`Claimant Number` is selected explicitly** (160, 162) — this is the same
   uniqueness constraint the on-prem flow handles, so the existing
   used-claimant-number tracking applies.
5. **Liability/injury coverages need an Injury Incident** sub-popup; property
   coverages do not. The step set is coverage-dependent, exactly as on-prem.

---

# RECORDING 2 — vehicle-level coverages (Collision + Comprehensive)

Claim `CA-OH-85-26-0000175`. This is the path that all hand-written attempts
failed on. It corrects several more assumptions.

## The menu path

```js
await page.getByRole('button', { name: 'deferred Actions' }).click();
await page.getByLabel('Choose by Coverage', { exact: true }).click();   // getByLabel, NOT menuitem
await page.getByLabel('FORD F350 (VIN#: 31138)').click();               // vehicle: getByLabel
await page.getByRole('menuitem', { name: 'Collision' }).first().click();
await page.locator('#Claim-ClaimMenuActions-ClaimMenuActions_NewExposure-NewExposureMenuItemSet-NewExposureMenuItemSet_ByCoverage-2-item-1-item-0-item')
  .getByRole('menuitem', { name: 'Collision' }).click();
```

### The decisive finding: menu item ids are DETERMINISTIC

```
#Claim-ClaimMenuActions-ClaimMenuActions_NewExposure-NewExposureMenuItemSet-
   NewExposureMenuItemSet_ByCoverage-<grouperIdx>-item-<coverageIdx>-item-<leafIdx>-item

Collision      -> ByCoverage-2-item-1-item-0-item
Comprehensive  -> ByCoverage-4-item-2-item-0-item
```

So the tree can be walked by INDEX instead of by matching names. This sidesteps
every problem hit so far: duplicate names ("Collision" is both grouper and
leaf), split text, ambiguous roles, and hover-vs-click.

Note the grouper label is `FORD F350 (VIN#: 31138)` — **no model year**, though
the menu displays "2022 FORD F350". Name matching on the displayed text fails.

## Vehicle Incident popup — required for Collision

```js
await page.getByLabel('Loss Party').selectOption('insured');
await page.getByLabel('Claimant Number').selectOption('160');
await page.getByLabel('Cause of Loss').selectOption('LC15');
await page.getByLabel('Cause of Loss Description').selectOption('all_other');

await page.locator('#NewExposure-NewExposureScreen-NewExposureDV-NewClaimVehicleDamageDV-Vehicle_Incident-Vehicle_IncidentMenuIcon')
  .getByRole('button', { name: 'options' }).click();
await page.getByLabel('New Incident...').click();
await page.getByLabel('Select vehicle').selectOption('Vehicle:2236');
await page.getByLabel('Was the vehicle parked?').selectOption('Yes');
await page.getByLabel('Driver Type').selectOption('listed');
await page.getByLabel('Driver Name').selectOption('Person:5799');
await page.getByLabel('Relation to Insured').selectOption('self');
await page.getByRole('textbox', { name: 'Damage Description' }).fill('fgj');
await page.getByRole('radiogroup', { name: 'Is there a loan on the' }).getByLabel('No', { exact: true }).click();
await page.getByLabel('Is this loss:').selectOption('collision');
await page.getByRole('radiogroup', { name: 'Does this vehicle carry' }).getByLabel('No', { exact: true }).click();
await page.getByRole('button', { name: 'OK' }).click();
await page.getByRole('button', { name: 'Update' }).click();
```

## Claimant-number collision is REAL here too

```js
await page.getByRole('button', { name: 'Update' }).click();
await page.getByLabel('Claimant Number').selectOption('166');   // first number rejected
await page.getByRole('button', { name: 'Update' }).click();     // retry
```

Update was pressed, rejected, the claimant number changed, and Update pressed
again — the same retry loop already implemented for the FNOL wizard. It applies
on the New Exposure screen as well.

## Exposure 2 — Comprehensive, straight to the leaf

```js
await page.getByRole('button', { name: 'deferred Actions' }).click();
await page.locator('#Claim-ClaimMenuActions-...-ByCoverage-4-item-2-item-0-item')
  .getByRole('menuitem', { name: 'Comprehensive' }).click();
await page.getByLabel('Loss Party').selectOption('insured');
await page.getByLabel('Claimant Number').selectOption('167');
await page.getByLabel('Cause of Loss').selectOption('LC11');
await page.getByRole('button', { name: 'Update' }).click();
```

No Vehicle Incident popup for Comprehensive — the step set is coverage-specific,
exactly as on-prem.

## Rewrite plan for pickCloudCoverage

1. Open Actions, then `getByLabel('Choose by Coverage', { exact: true })`.
2. Enumerate `[id*="NewExposureMenuItemSet_ByCoverage-"]` items and walk them by
   INDEX, reading each one's own label — do not match on displayed text.
3. Click leaf ids ending `-item-<n>-item-<n>-item`; a click that opens the New
   Exposure screen (Update button present) is the only success signal.
4. On the New Exposure screen: if a Vehicle/Injury Incident picker exists,
   complete it before Update.
5. Handle claimant-number rejection by re-selecting and pressing Update again.
