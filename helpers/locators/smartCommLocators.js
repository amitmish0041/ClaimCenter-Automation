/**
 * helpers/locators/smartCommLocators.js
 * Selectors for the ClaimCenter CLOUD "Create New Document" / SmartCOMM
 * on-demand generation flow (Actions -> New ... -> Create from a template).
 *
 * Built from user-supplied screenshots of a live cloud claim (DEV tier,
 * CA-OH-04-26-0000233) on 2026-09-03 — NOT yet confirmed via live codegen the
 * way onPremLocators.js's flows are (see that file's own "CONFIRMED" markers
 * for what live-verified provenance looks like). Verify against a real run
 * before trusting these beyond the happy path shown in the screenshots;
 * follow cloudLocators.js's existing convention of several fallback
 * candidates per control when something doesn't match live.
 */
'use strict';

const SmartCommLocators = {
  menu: {
    // Actions -> "New ..." submenu item, which itself opens a further
    // submenu containing "Create from a template" (screenshot 1).
    newSubmenu: 'New ...',
    createFromTemplate: 'Create from a template',
  },
  selectTemplate: {
    tab: 'Select Template',
    nameField: 'Name',
    // CONFIRMED via live run 2026-09-03 (cloud/dev): role=button name="Search"
    // resolves to TWO elements — a folder-picker icon button (id ends
    // "...TemplateFolder-PopulateFolderItems", accessible name "search"
    // lowercase) AND the real search action (id ends "...SearchLinksInputSet-
    // Search"). Scope to that id suffix instead of role+name.
    searchButtonId: '[id$="SearchLinksInputSet-Search"]',
    selectButtonInRow: 'Select',
  },
  recipients: {
    tab: 'Recipients',
    setPrimaryRecipientButton: 'Set Primary Recipient',
    additionalRecipientButton: 'Additional Recipient',
    // Not confirmed as a native <select> live — selectDeliveryChannel() in
    // documentService falls back to a combobox/option pattern if this fails.
    deliveryChannelDropdown: '[id*="DeliveryChannel"], select[name*="delivery" i], [aria-label*="Delivery Channel" i]',
    emailField: 'input[type="email"], [aria-label*="Email" i]',
  },
  additionalData: {
    tab: 'Additional Data',
    // Not visible in the supplied screenshot of this particular template's
    // Additional Data tab — treat as optional/best-effort, not required.
    languageDropdown: '[id*="Language"], [aria-label*="Language" i]',
    documentTypeDropdown: '[id*="DocumentType"], [aria-label*="Document Type" i]',
  },
  create: {
    tab: 'Create',
    generateButton: 'Generate',
    saveDocumentsButton: 'Save documents',
    closeButton: 'Close',
    resultsGrid: '[role="grid"], table',
    // Per the spec's preferred locator.
    downloadIcon: '[aria-label="document_download"]',
    // "Development" section's own button — CONFIRMED present in the same
    // screenshot showing a completed Generate result, described as
    // "Downloads the payload for investigation if an error occurs".
    downloadPayloadButton: 'Download Payload',
    // Clicking Generate can also fail server-side with CC's own inline error
    // instead of ever producing a results row — CONFIRMED live (DIG59,
    // claim CPP-DE-01-26-0000049): "Data required to create document not
    // found. Please try again. If problem persists, contact your
    // administrator", docked in the same south-panel wizard as an
    // accessible group named exactly this (its heading text).
    errorsGroup: 'Errors on current page:',
  },
};

module.exports = SmartCommLocators;
