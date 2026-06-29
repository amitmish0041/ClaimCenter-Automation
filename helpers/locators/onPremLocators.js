/**
 * helpers/locators/onPremLocators.js
 * Selectors for Guidewire ClaimCenter ON-PREMISE (ExtJS UI)
 * URL pattern: ClaimCenter.do
 * DOM pattern: .gw-* classes, -inputEl suffix IDs, .x-form-* fields
 */

const OnPremLocators = {

  // ── Login ────────────────────────────────────────────────────────────────
  login: {
    username : 'input[name="Login:LoginScreen:LoginDV:username"]',
    password : 'input[name="Login:LoginScreen:LoginDV:password"]',
    submit   : '#Login\\:LoginScreen\\:LoginDV\\:submit-btnInnerEl',
  },

  // ── Post-login: wait for this to confirm desktop loaded ──────────────────
  desktop: {
    ready    : '.gw-TabbedMenuItem, .gw-desktop-TabbedMenuItem, [id*="TabBar"]',
  },

  // ── Top navigation tabs ───────────────────────────────────────────────────
  nav: {
    newClaim   : '.gw-TabbedMenuItem:has-text("New Claim"), [id*="NewClaim"]',
    myWork     : '.gw-TabbedMenuItem:has-text("My Work"), [id*="MyWork"]',
    claimSearch: '.gw-TabbedMenuItem:has-text("Search"), [id*="ClaimSearch"]',
    team       : '.gw-TabbedMenuItem:has-text("Team"), [id*="Team"]',
    admin      : '.gw-TabbedMenuItem:has-text("Administration"), [id*="Admin"]',
  },

  // ── FNOL - Policy search ───────────────────────────────────────────────────
  fnol: {
    policyNumber : 'input[name*="PolicySearchCriteriaDV"][name*="PolicyNumber"]',
    searchButton : '.gw-ToolbarButton:has-text("Search"), [id*="Search"] input[type=button]',
    policyRow    : '.gw-ListViewWidget tr.x-grid-row',
    lossDate     : 'input[name*="LossDate"]',
    lossState    : 'input[name*="LossState"]',
    lossCause    : 'input[name*="LossCause"]',
    description  : 'textarea[name*="Description"], input[name*="Description"]',
    nextButton   : '.gw-ToolbarButton:has-text("Next"), input[type=button][value="Next"]',
    finishButton : '.gw-ToolbarButton:has-text("Finish"), input[type=button][value="Finish"]',
    addExposure  : '.gw-ToolbarButton:has-text("Add"), [id*="AddExposure"]',
    coverageType : 'input[name*="CoverageType"]',
    claimNumber  : '[id*="ClaimNumber-inputEl"], .gw-label:has-text("Claim #") + .gw-label',
  },

  // ── Financials ────────────────────────────────────────────────────────────
  financials: {
    tab          : '.gw-TabbedMenuItem:has-text("Financials"), [id*="Financials"]',
    reservesTab  : '.gw-TabbedMenuItem:has-text("Reserves"), [id*="Reserves"]',
    paymentsTab  : '.gw-TabbedMenuItem:has-text("Payments"), [id*="Payments"]',
    recoveryTab  : '.gw-TabbedMenuItem:has-text("Recovery"), [id*="Recovery"]',
    editButton   : '.gw-ToolbarButton:has-text("Edit"), input[type=button][value="Edit"]',
    newPayment   : '.gw-ToolbarButton:has-text("New Payment"), [id*="NewPayment"]',
    reserveAmount: 'input[name*="ReserveAmount"]',
    paymentAmount: 'input[name*="Amount"]',
    costType     : 'input[name*="CostType"]',
    costCategory : 'input[name*="CostCategory"]',
    checkType    : 'input[name*="CheckType"]',
    updateButton : '.gw-ToolbarButton:has-text("Update"), input[type=button][value="Update"]',
  },

  // ── Approval queue ────────────────────────────────────────────────────────
  approval: {
    myWorkTab    : '.gw-TabbedMenuItem:has-text("My Work")',
    approvalsTab : '.gw-TabbedMenuItem:has-text("Approvals"), [id*="Approvals"]',
    approveButton: '.gw-ToolbarButton:has-text("Approve")',
    denyButton   : '.gw-ToolbarButton:has-text("Deny")',
    queueRow     : '.gw-ListViewWidget tr.x-grid-row',
  },

  // ── Claim actions ─────────────────────────────────────────────────────────
  actions: {
    actionsMenu  : '.gw-ToolbarButton:has-text("Actions"), [id*="Actions"]',
    closeClaim   : '.x-menu-item:has-text("Close Claim")',
    reopenClaim  : '.x-menu-item:has-text("Reopen")',
    archiveClaim : '.x-menu-item:has-text("Archive")',
  },

  // ── Workplan ──────────────────────────────────────────────────────────────
  workplan: {
    tab          : '.gw-TabbedMenuItem:has-text("Workplan"), .gw-TabbedMenuItem:has-text("Activities")',
    newActivity  : '.gw-ToolbarButton:has-text("New Activity")',
    activityRow  : '.gw-ListViewWidget tr.x-grid-row',
    completeBtn  : '.gw-ToolbarButton:has-text("Complete")',
  },

  // ── GW ExtJS field helpers ────────────────────────────────────────────────
  // In ExtJS, dropdowns are combo boxes — NOT native <select>
  // To select a value: click the trigger, then click the list item
  combo: {
    trigger      : (fieldName) => `[name*="${fieldName}"] ~ .x-form-trigger, [id*="${fieldName}"] .x-form-trigger`,
    listItem     : (value)     => `.x-list-plain li:has-text("${value}"), .x-boundlist-item:has-text("${value}")`,
  },

  // ExtJS text field: id ends in -inputEl
  field: {
    byName       : (name)  => `input[name*="${name}"]`,
    byId         : (id)    => `input[id*="${id}-inputEl"]`,
  },

  // ExtJS save/update
  toolbar: {
    save  : 'input[type=button][value="Update"], input[type=button][value="Save"], .gw-ToolbarButton:has-text("Update")',
    cancel: 'input[type=button][value="Cancel"], .gw-ToolbarButton:has-text("Cancel")',
  },
};

module.exports = OnPremLocators;
