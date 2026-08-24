import assert from "node:assert/strict";
import test from "node:test";
import { assertSafeProcurementUrl, parseDocumentListHtml, parseSearchHtml } from "../src/etenders.js";

test("parses current-opportunity rows using the public eTenders column order", () => {
  const html = `
    <table><tbody>
      <tr><th>#</th><th>Title</th><th>Resource ID</th><th>CA</th><th>Info</th><th>Published</th><th>Deadline</th><th>Procedure</th><th>Status</th><th>PDF</th><th>Award</th><th>Value</th><th>Cycle</th></tr>
      <tr><td>1</td><td><a href="/epps/cft/prepareViewCfTWS.do?resourceId=8796138">RFQ for PMP Training</a></td><td>8796138</td><td>BioPharmaChem Skillnet</td><td>PMP preparation training and programme delivery</td><td>06/08/2026 10:54:29</td><td>27/08/2026 12:00:00</td><td>Open</td><td>Tender Submission</td><td></td><td></td><td>49,000.00</td><td>1</td></tr>
    </tbody></table>`;
  const parsed = parseSearchHtml(html);
  assert.equal(parsed.items.length, 1);
  assert.equal(parsed.items[0].externalId, "8796138");
  assert.equal(parsed.items[0].procedure, "Open");
  assert.equal(parsed.items[0].estimatedValue, "49,000.00");
  assert.match(parsed.items[0].sourceUrl, /resourceId=8796138/);
});

test("parses public tender-document links and rejects hostile destinations", () => {
  const html = `<table><tr><td>N/A</td><td>RFT</td><td><a href="/epps/cft/downloadDocument.do?documentId=42">Tender RFT.docx</a></td><td>Main RFT</td></tr></table>`;
  const docs = parseDocumentListHtml(html, "https://www.etenders.gov.ie/epps/cft/listContractDocuments.do?resourceId=42", "42");
  assert.equal(docs[0].filename, "Tender RFT.docx");
  assert.match(docs[0].url, /^https:\/\/www\.etenders\.gov\.ie\//);
  assert.throws(() => assertSafeProcurementUrl("https://example.com/steal?resourceId=42"), /restricted/);
  assert.throws(() => assertSafeProcurementUrl("http://www.etenders.gov.ie/epps/"), /HTTPS/);
});
