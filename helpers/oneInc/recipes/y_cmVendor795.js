/**
 * helpers/oneInc/recipes/y_cmVendor795.js — GCCM-795 INT.001 (CreateVendor trigger) TC-002 / 003 / 004 on NEW ContactManager
 * companies (helpers/oneInc/cmCreate.js), read back on OneInc staging's Business/Vendor Report — the visible effect of the
 * CreateVendor call (the payload itself is not reachable). Added 2026-11-13 (user OK to leave the new test contacts on
 * TEST; they are listed in <TestData>/cm-created-test.json). Needs CM_USER / CM_PASS inline and the OneInc portal
 * window signed in (scripts/oneIncPortalSession.js).
 */
'use strict';

module.exports = (api) => {
  const { add, V } = api;
  const cm = (fn, ...a) => ({ call: [`cmCreate.${fn}`, ...a] });
  const NOTE = 'Creates a new company in ContactManager (Name "ONEINC AUTO …", random Tax ID 99-xxxxxxx), adds it to a TEST claim from Address Book / 1099 Contacts (role Other), then reads OneInc\'s Business/Vendor Report by that Tax ID. ';

  add('GCCM-795/INT/TC-002', 'ONEINC_ISSUED', [cm('createCompany', { vendor: true, address: true, tag: 'VENDOR' }), cm('addToClaim'), cm('onOneInc', { expect: 'present', waitMin: 20 })],
    [V('OneInc Vendor', { value: /^on the report/i }), V('OneInc Vendor BillingStreet', { value: /1103 RICHMONT/i }), V('OneInc Vendor City', { value: /SCRANTON/i })],
    NOTE + 'Vendor (Company) with a primary address (1103 Richmont St, Scranton PA 18509): CreateVendor must bring it to OneInc with that name and address (waits up to 20 min).');
  add('GCCM-795/INT/TC-003', 'ONEINC_ISSUED', [cm('createCompany', { vendor: false, address: true, tag: 'NONVENDOR' }), cm('addToClaim'), cm('onOneInc', { expect: 'absent', waitMin: 20 })],
    [V('OneInc Vendor', { value: /^not on the report/i })],
    NOTE + 'Company NOT tagged Vendor (New Company › Company: tags Client / Company) with a primary address: no CreateVendor — it must not appear on OneInc within 20 min.');
  add('GCCM-795/INT/TC-004', 'ONEINC_ISSUED', [cm('createCompany', { vendor: true, address: false, tag: 'NOADDR' }), cm('addToClaim'), cm('onOneInc', { expect: 'absent', waitMin: 20 })],
    [V('OneInc Vendor', { value: /^not on the report/i })],
    NOTE + 'Vendor (Company) WITHOUT a primary address: no CreateVendor — it must not appear on OneInc within 20 min.');
};
