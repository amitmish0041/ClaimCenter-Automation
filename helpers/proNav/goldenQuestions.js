/**
 * helpers/proNav/goldenQuestions.js — golden question sets for the ProNavigator compliance assistant (CC Cloud FE,
 * Commercial Auto). Each question names the KMS source it should cite (ProNav KMS Document QA Sheet 09_01_26) and the
 * expected key points. Expected points are QA's reading of the source — to be confirmed by the Claims/Legal SME.
 */
'use strict';
module.exports = {
  PA: {
    claim: 'CA-PA-85-26-0748493',
    questions: [
      { id: 'PA-01', cite: /0146|Chapter 146/i, must: [/10 working days/i], q: 'What is the deadline to acknowledge receipt of a claim in Pennsylvania?', source: '031_0146 Chapter 146 Unfair Insurance Practices', expect: 'Within 10 working days of receiving notice of the claim (31 Pa. Code 146.5)' },
      { id: 'PA-02', cite: /0146|Chapter 146/i, must: [/15 working days/i], q: 'How long does an insurer have to accept or deny a claim after receiving proof of loss in Pennsylvania?', source: '031_0146 Chapter 146', expect: 'Within 15 working days of receiving proof of loss (146.7); if more time is needed, notify within 30 days and every 45 days after (146.6)' },
      { id: 'PA-03', cite: /Denial|0146|UIPA/i, must: [/provision|condition|exclusion/i], q: 'What must a written claim denial include in Pennsylvania?', source: 'Denial Regulations - PA UIPA / Ch 146', expect: 'Must reference the specific policy provision, condition or exclusion relied on (146.7(a)(1))' },
      { id: 'PA-04', cite: /Suit Limitation|5524/i, must: [/two|2/i, /year/i], q: 'What is the statute of limitations for a bodily injury lawsuit from an auto accident in Pennsylvania?', source: 'Pennsylvania - Suit Limitations / Section 5524 Title 42', expect: '2 years (42 Pa.C.S. §5524)' },
      { id: 'PA-05', cite: /0062|Chapter 62/i, must: [/apprais/i], q: 'What are the requirements for a motor vehicle physical damage appraisal in Pennsylvania?', source: '031_0062 Chapter 62 Motor Vehicle Physical Damage', expect: 'Licensed appraiser; appraisal/estimate rules of 31 Pa. Code Ch 62 (e.g. 62.3)' },
      { id: 'PA-06', cite: /25-10|BULLETIN/i, must: [/sales tax/i], q: 'How should sales tax be handled when settling a total loss with a salvage vehicle in Pennsylvania?', source: 'Bulletin No. 25-10 sales tax salvage vehicles', expect: 'Per Bulletin 25-10' },
      { id: 'PA-07', cite: /Diminution/i, must: [/diminution/i], q: 'Is diminution in value of an automobile payable in Pennsylvania?', source: 'Compliassist chart: Diminution in Value of Automobiles PA', expect: 'Per the Compliassist DV chart' },
      { id: 'PA-08', cite: /0063|Chapter 63|Uninsured/i, must: [/uninsured/i], q: 'What are the uninsured and underinsured motorist coverage requirements in Pennsylvania?', source: '031_0063 Chapter 63 UM coverage / APCIA UM-UIM laws', expect: 'UM/UIM must be offered; rejection/stacking waivers must be in writing on the statutory forms' },
      { id: 'PA-09', cite: /0069|Chapter 69|auto-insurance-guide|MVFRL|Financial/i, must: [/5,000/], q: 'What is the minimum first party medical benefit required under the Pennsylvania Motor Vehicle Financial Responsibility Law?', source: '031_0069 Chapter 69 / PA auto insurance guide', expect: '$5,000 medical benefits' },
      { id: 'PA-10', cite: /Act 205|UIPA|0146/i, must: [/unfair/i], q: 'What are unfair claim settlement practices under the Pennsylvania Unfair Insurance Practices Act?', source: '1974 Act 205 UIPA', expect: 'Lists the UIPA §5(a)(10) practices (misrepresenting facts, failing to acknowledge promptly, failing to adopt standards, etc.)' },
      { id: 'PA-N1', cite: null, must: [], mustNot: [/10 working days.*Maryland|Maryland.*10 working days/is], q: 'What is the deadline to acknowledge a claim in Maryland?', source: '(negative: PA filter selected)', expect: 'Should not answer from PA sources as if they were Maryland; either answers from MD sources or says the filter is Pennsylvania' },
      { id: 'PA-N2', cite: null, must: [/not|unable|no information|couldn/i], q: 'What does section 146.99 of the Pennsylvania insurance code say about claims?', source: '(negative: section does not exist)', expect: 'Says it cannot find it; does not invent content' },
    ],
  },
};

// ── Generated sets for every KMS-tagged Commercial Auto state (2026-11-25) ─────────────────────────────────────────
const NAMES = { MD: 'Maryland', VA: 'Virginia', DE: 'Delaware', NC: 'North Carolina', OH: 'Ohio', IN: 'Indiana', IL: 'Illinois', IA: 'Iowa',
  MI: 'Michigan', WI: 'Wisconsin', TN: 'Tennessee', SC: 'South Carolina', SD: 'South Dakota', NE: 'Nebraska', TX: 'Texas', UT: 'Utah',
  NM: 'New Mexico', CO: 'Colorado', AZ: 'Arizona' };
const CH = /Claims Handling|Unfair|Compliassist|PLRB|Regulatory Guidelines|Statutes|ADC|Code/i;
const common = (st, n) => [
  { id: `${st}-01`, cite: CH, must: [/day/i], q: `What is the deadline to acknowledge receipt of a claim in ${n}?`, source: 'Claims Handling & Unfair Trade Practices Compliance Guide 2026 (APCIA)' + (st === 'MD' ? ' / MD Unfair Claims Practices' : ''), expect: `${n} acknowledgement deadline, cited from a ${n} source${st === 'MD' ? ' (15 working days, MD ADC 31.15.07.03)' : ''}` },
  { id: `${st}-02`, cite: CH, must: [/day/i], q: `How long does an insurer have to accept or deny a claim after receiving proof of loss in ${n}?`, source: 'Claims Handling & Unfair Trade Practices Compliance Guide 2026 (APCIA)', expect: `${n} decision deadline, cited` },
  { id: `${st}-03`, cite: /Uninsured|Underinsured|UM/i, must: [/uninsured|underinsured/i], q: `What are the uninsured and underinsured motorist coverage requirements in ${n}?`, source: 'Uninsured-Underinsured Motorist Coverage Laws and Regulations (APCIA)', expect: `${n} UM/UIM requirements (limits, offer/rejection rules), cited` },
  { id: `${st}-04`, cite: /Physical Damage/i, must: [/total loss|sales tax|actual cash value/i], q: `What are the requirements for settling an automobile total loss in ${n}?`, source: 'Automobile Physical Damage Compliance Guide 2026 (APCIA)', expect: `${n} total loss settlement rules (ACV, taxes/fees, comparable vehicles), cited` },
  { id: `${st}-05`, cite: /Fraud/i, must: [/fraud/i], q: `What are the insurance fraud reporting requirements for insurers in ${n}?`, source: 'Insurance Fraud Compliance Guide 2026 (APCIA)', expect: `${n} fraud reporting obligations (to whom, timing), cited` },
];
const extra = {
  MD: [
    { id: 'MD-06', cite: /Maryland|PLRB|Unfair/i, must: [/unfair/i], q: 'What are unfair claim settlement practices in Maryland?', source: 'PLRB Members Portal - Maryland - Unfair Claims Practices', expect: 'Lists MD unfair claim settlement practices, cited' },
    { id: 'MD-07', cite: /Licens|Compliassist|Maryland/i, must: [/licens/i], q: 'What are the adjuster licensing requirements in Maryland?', source: 'Compliassist chart MD Example Licensing', expect: 'MD adjuster licensing requirements, cited' },
    { id: 'MD-08', cite: /Maryland|Regulatory|Statute/i, must: [/deni/i], q: 'What must a claim denial include in Maryland?', source: 'Regulatory Guidelines - Maryland / Maryland Statutes', expect: 'MD denial requirements, cited' },
  ],
  VA: [
    { id: 'VA-06', cite: /VA|HB 808|Disclosure|Virginia/i, must: [/disclos|reduc/i], q: 'What must an insurer disclose when reducing a payment on a claim in Virginia?', source: '2026 04 20 VA Requires Insurer Disclosures When Making Reductions / VA HB 808', expect: 'Disclosure requirements under VA HB 808, cited' },
  ],
  DE: [
    { id: 'DE-06', cite: /Delaware|Motorist/i, must: [/PIP|personal injury protection|motorist/i], q: "What does the Delaware Motorist's Protection Act require for personal injury protection?", source: "CM - Delaware Motorist's Protection Act", expect: 'DE PIP requirements, cited' },
  ],
  NC: [
    { id: 'NC-06', cite: /North Carolina|Selection/i, must: [/select|reject/i], q: 'What auto coverage selection or rejection forms are required in North Carolina?', source: 'CM - North Carolina Auto Selection Forms', expect: 'NC UM/UIM selection/rejection form rules, cited' },
  ],
};
for (const [st, n] of Object.entries(NAMES)) module.exports[st] = { stateName: n, questions: [...common(st, n), ...(extra[st] || [])] };
module.exports.PA.stateName = 'Pennsylvania';
module.exports.PA5 = { stateName: 'Pennsylvania', claim: 'CA-PA-85-26-0748493', questions: [module.exports.PA.questions[4], ...common('PA', 'Pennsylvania').slice(2).map((q) => ({ ...q, id: q.id.replace('PA-0', 'PA-1') }))] };
module.exports.POLICY = { stateName: 'Pennsylvania', claim: 'CA-PA-85-26-0748493', questions: [
  { id: 'POL-01', cite: /Silver Series/i, must: [/silver series/i], q: 'What additional coverages does the Silver Series Plus Business Auto Coverage Enhancement Endorsement provide?', source: 'Silver Series Plus - Business Auto Coverage Enhancement Endorsement', expect: 'Lists the enhancement coverages, cited' },
  { id: 'POL-02', cite: /Business Auto Coverage Form/i, must: [/hired/i], q: 'How does the Business Auto Coverage Form cover hired autos?', source: 'Business Auto Coverage Form (CA 00 01)', expect: 'Hired auto liability via symbol 8 / physical damage terms, cited' },
  { id: 'POL-03', cite: /MCS-90/i, must: [/MCS-90/i], q: 'What is the MCS-90 endorsement and when does it apply?', source: 'CM - MCS-90', expect: 'Federal motor carrier financial responsibility endorsement, cited' },
  { id: 'POL-04', cite: /Lay Up/i, must: [/lay.?up/i], q: 'How does the Commercial Auto lay up credit work?', source: 'CM - Commercial Auto "Lay Up" Credit', expect: 'Underwriting guide content: note whether claims users should see this' },
] };
