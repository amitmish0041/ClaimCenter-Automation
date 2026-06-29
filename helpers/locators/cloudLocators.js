/**
 * helpers/locators/cloudLocators.js
 * Selectors for Guidewire ClaimCenter CLOUD (modern React/Jutro UI)
 * URL pattern: .guidewire.com/cc/
 * DOM pattern: standard HTML elements, data-testid, aria roles
 */

const CloudLocators = {

  // ── Login ─────────────────────────────────────────────────────────────────
  login: {
    username : '#USERNAME, input[name="username"], input[type="email"]',
    password : '#PASSWORD, input[name="password"], input[type="password"]',
    submit   : 'input[type="submit"], button[type="submit"], button:has-text("Log In")',
  },

  // ── Post-login: wait for desktop ──────────────────────────────────────────
  desktop: {
    ready    : '#TabBar, [id*="TabBar"], nav[class*="TabBar"]',
  },

  // ── Top navigation ────────────────────────────────────────────────────────
  nav: {
    newClaim   : '#TabBar-NewClaimTab, a[id*="NewClaim"]',
    myWork     : '#TabBar-MyWorkTab, a[id*="MyWork"]',
    claimSearch: '#TabBar-ClaimTab, a[id*="ClaimSearch"]',
    team       : '#TabBar-TeamTab, a[id*="Team"]',
    admin      : '#TabBar-AdminTab, a[id*="Admin"]',
  },

  // ── FNOL ──────────────────────────────────────────────────────────────────
  fnol: {
    policyNumber : '#fnol-PolicyNumber, input[id*="PolicyNumber"]',
    searchButton : 'button:has-text("Search"), input[value="Search"]',
    policyRow    : '.gw-PolicySearchResultsLV tr.gw-row, [id*="PolicyResults"] tr',
    lossDate     : '[id*="LossDate"], #fnol-LossDate',
    lossState    : '[id*="LossState"], #fnol-LossState',
    lossCause    : '[id*="LossCause"], #fnol-LossCause',
    description  : '[id*="Description"], #fnol-Description',
    nextButton   : 'button:has-text("Next"), [id*="Next"]',
    finishButton : 'button:has-text("Finish"), #Finish',
    addExposure  : 'button:has-text("Add Exposure"), [id*="AddExposure"]',
    coverageType : '[id*="CoverageType"]',
    claimNumber  : '[id*="ClaimNumber"], [id*="claimNumber"]',
  },

  // ── Financials ────────────────────────────────────────────────────────────
  financials: {
    tab          : '[id*="FinancialsTab"], a:has-text("Financials")',
    reservesTab  : '[id*="ReservesTab"], a:has-text("Reserves")',
    paymentsTab  : '[id*="PaymentsTab"], a:has-text("Payments")',
    recoveryTab  : '[id*="RecoveryTab"], a:has-text("Recovery")',
    editButton   : 'button:has-text("Edit"), [id*="Edit"]',
    newPayment   : 'button:has-text("New Payment"), [id*="NewPayment"]',
    reserveAmount: '[id*="ReserveAmount"]',
    paymentAmount: '[id*="PaymentAmount"], [id*="CheckAmount"]',
    costType     : '[id*="CostType"]',
    costCategory : '[id*="CostCategory"]',
    checkType    : '[id*="CheckType"]',
    updateButton : 'button[id$="-Update"], button:has-text("Update")',
  },

  // ── Approval queue ────────────────────────────────────────────────────────
  approval: {
    myWorkTab    : '[id*="MyWorkTab"], a:has-text("My Work")',
    approvalsTab : '[id*="ApprovalsTab"], a:has-text("Approvals")',
    approveButton: 'button:has-text("Approve"), a:has-text("Approve")',
    denyButton   : 'button:has-text("Deny"), a:has-text("Deny")',
    queueRow     : 'tr.gw-row',
  },

  // ── Claim actions ─────────────────────────────────────────────────────────
  actions: {
    actionsMenu  : '[id*="Actions"], button:has-text("Actions")',
    closeClaim   : 'a:has-text("Close Claim"), [id*="CloseClaim"]',
    reopenClaim  : 'a:has-text("Reopen"), [id*="Reopen"]',
    archiveClaim : 'a:has-text("Archive"), [id*="Archive"]',
  },

  // ── Workplan ──────────────────────────────────────────────────────────────
  workplan: {
    tab          : '[id*="WorkplanTab"], a:has-text("Workplan"), a:has-text("Activities")',
    newActivity  : 'button:has-text("New Activity"), [id*="NewActivity"]',
    activityRow  : 'tr.gw-row',
    completeBtn  : 'button:has-text("Complete"), a:has-text("Complete")',
  },

  // ── Cloud uses native <select> for dropdowns ──────────────────────────────
  combo: {
    trigger      : (fieldName) => `[id*="${fieldName}"]`,
    listItem     : (value)     => `option:has-text("${value}")`,
  },

  field: {
    byName       : (name)  => `[name*="${name}"]`,
    byId         : (id)    => `[id*="${id}"]`,
  },

  toolbar: {
    save  : 'button[id$="-Update"], button:has-text("Update"), button:has-text("Save")',
    cancel: 'button:has-text("Cancel")',
  },
};

module.exports = CloudLocators;
