/**
 * helpers/smartComm/reviewCasePayloadAdapter.js
 * The payload fetched via the Create tab's "Download Payload" button (payloadService.js's original design)
 * is a direct <ccDocumentCreationRequest><claim>...</claim></ccDocumentCreationRequest> document. The payload
 * fetched via S3 (ClaimCenter Outbound > smartcomm > input — see s3AdminService.js) for the SAME transaction
 * is a completely different envelope — CONFIRMED live 2026-09-30 against real DIG52/DIG78 downloads: a
 * Thunderhead-internal "review-case" transaction log,
 *   <review-case ...><transaction><objects><object class="..." name="ccDocumentCreationRequest">
 *     <property name="archiveFileName" value="..."/>
 *     <property name="claim"><object class="..." name="claim"> ... </object></property>
 *     ...
 *   </object></objects></transaction></review-case>
 * i.e. every field is a generic <property name="X" value="Y"/> (scalar) or <property name="X"><object
 * name="X">...</object></property> (nested), rather than a real <X>Y</X> element.
 *
 * Arrays get a THIRD wrapping level, with an explicit index attribute marking each slot — CONFIRMED against
 * "contacts"/"editableRoles"/"roles" in the same real payloads:
 *   <property name="contacts"><object name="contacts">
 *     <property index="0" name="contacts"><object name="contacts">...item 0's own properties...</object></property>
 *     <property index="1" name="contacts"><object name="contacts">...item 1...</object></property>
 *   </object></property>
 * (a scalar array looks the same but with index+value on the inner <property> directly and no nested
 * <object> — CONFIRMED live: <property index="0" name="dropDown1" value=""/>.)
 *
 * Rather than teach payloadService.js/payloadXpathService.js a second field-access convention, this adapter
 * converts a review-case document into the EXACT SAME shape fast-xml-parser already produces for the old
 * direct format — the classic wrapper-tag-equals-item-tag double-wrap fast-xml-parser gives
 * <contacts><contacts>item0</contacts><contacts>item1</contacts></contacts> with isArray:
 * `claim.contacts === [ { contacts: [item0, item1] } ]`. Producing that same shape here means every existing
 * asArray()/ARRAY_TAGS-based reader in both files works unchanged against either payload source.
 */
'use strict';
const fs = require('fs');
const { XMLParser } = require('fast-xml-parser');

function isReviewCaseXml(xmlText) {
  return /<review-case[\s>]/.test(xmlText.slice(0, 400));
}

function asArr(v) {
  if (v === undefined || v === null) return [];
  return Array.isArray(v) ? v : [v];
}

// A single <property> element (already parsed, attributes under @_ prefix) -> its JS value: a scalar string,
// a plain object, or (when its <object> child is itself an array container - see convertObject) an array.
function convertProperty(propNode) {
  if (propNode['@_value'] !== undefined) return propNode['@_value'];
  const objChildren = asArr(propNode.object);
  if (!objChildren.length) return undefined;
  return convertObject(objChildren[0]);
}

// A single <object> element -> either a plain {field: value, ...} object, or — when EVERY one of its own
// <property> children carries an index attribute (the array-slot marker) — the old-shape 1-element array
// [{ name: [item0, item1, ...] }] wrapping the real item list under its own name, matching what
// fast-xml-parser's isArray double-wrap already produces for the direct-XML format.
function convertObject(objNode) {
  const props = asArr(objNode.property);
  const isArrayContainer = props.length > 0 && props.every((p) => p['@_index'] !== undefined);
  if (isArrayContainer) {
    const sorted = [...props].sort((a, b) => Number(a['@_index']) - Number(b['@_index']));
    const items = sorted.map((p) => convertProperty(p));
    return [{ [objNode['@_name']]: items }];
  }
  const result = {};
  for (const p of props) result[p['@_name']] = convertProperty(p);
  return result;
}

// Returns the same { ccDocumentCreationRequest: {...} } shape parsePayload/parseRawPayload already build
// from the direct-XML format, so callers need no branching of their own once they have this object.
function convertReviewCaseXml(xmlText) {
  const parser = new XMLParser({
    ignoreAttributes: false,
    attributeNamePrefix: '@_',
    parseAttributeValue: false, // keep every value a string — same reasoning as payloadService's parseTagValue:false
    isArray: (name) => name === 'property' || name === 'object',
  });
  const doc = parser.parse(xmlText);
  const reviewCase = doc['review-case'];
  if (!reviewCase) throw new Error('reviewCasePayloadAdapter: not a recognized review-case document — no <review-case> root element');
  const rootObj = asArr(reviewCase.transaction && reviewCase.transaction.objects && reviewCase.transaction.objects.object)[0];
  if (!rootObj || rootObj['@_name'] !== 'ccDocumentCreationRequest') {
    throw new Error('reviewCasePayloadAdapter: review-case document has no ccDocumentCreationRequest object under transaction > objects');
  }
  const root = convertObject(rootObj);
  return { ccDocumentCreationRequest: root };
}

function convertReviewCaseXmlFile(filePath) {
  return convertReviewCaseXml(fs.readFileSync(filePath, 'utf8'));
}

module.exports = { isReviewCaseXml, convertReviewCaseXml, convertReviewCaseXmlFile };
