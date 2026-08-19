import archiver from 'archiver';
import path from 'path';
import fs from 'fs';
import { createWriteStream } from 'fs';
import { tmpdir } from 'os';
import { randomUUID } from 'crypto';
import PDFDocument from 'pdfkit';

const OUTPUT_DIR = process.env.ZIP_OUTPUT_DIR || path.join(tmpdir(), 'tenderly-bids');

function ensureOutputDir() {
  if (!fs.existsSync(OUTPUT_DIR)) fs.mkdirSync(OUTPUT_DIR, { recursive: true });
}

/**
 * Generate the full bid document set as a ZIP archive.
 * @param {object} options
 * @param {object} options.tender
 * @param {object} options.bidSubmission
 * @param {object} options.company
 * @param {string[]} options.cvPaths - paths to uploaded CV files
 * @returns {string} path to the generated ZIP file
 */
export async function generateBidZip({ tender, bidSubmission, company, cvPaths = [] }) {
  ensureOutputDir();

  const bidId = bidSubmission.id || randomUUID();
  const zipName = `bid-${slugify(tender.title)}-${bidId.substring(0, 8)}.zip`;
  const zipPath = path.join(OUTPUT_DIR, zipName);

  return new Promise((resolve, reject) => {
    const output = createWriteStream(zipPath);
    const archive = archiver('zip', { zlib: { level: 9 } });

    output.on('close', () => resolve(zipPath));
    archive.on('error', reject);
    archive.pipe(output);

    // 1. Cover letter PDF
    const coverLetterPdf = generateCoverLetterPdf(tender, company, bidSubmission);
    archive.append(coverLetterPdf, { name: '01_Cover_Letter.pdf' });

    // 2. Technical proposal PDF
    const technicalPdf = generateTechnicalProposalPdf(tender, bidSubmission);
    archive.append(technicalPdf, { name: '02_Technical_Proposal.pdf' });

    // 3. Company profile PDF
    const profilePdf = generateCompanyProfilePdf(company, bidSubmission);
    archive.append(profilePdf, { name: '03_Company_Profile.pdf' });

    // 4. Pricing / financial proposal PDF
    const financialPdf = generateFinancialProposalPdf(tender, bidSubmission);
    archive.append(financialPdf, { name: '04_Financial_Proposal.pdf' });

    // 5. Scored questions responses PDF (if any)
    const qResponses = bidSubmission.questions_responses || [];
    if (qResponses.length > 0) {
      const qPdf = generateQResponsesPdf(qResponses, tender);
      archive.append(qPdf, { name: '05_Scored_Questions_Responses.pdf' });
    }

    // 6. CVs
    cvPaths.forEach((cvPath, i) => {
      if (fs.existsSync(cvPath)) {
        const ext = path.extname(cvPath) || '.pdf';
        archive.file(cvPath, { name: `CVs/CV_${String(i + 1).padStart(2, '0')}${ext}` });
      }
    });

    // 7. Checklist / README
    const checklist = generateSubmissionChecklist(tender, bidSubmission, cvPaths);
    archive.append(checklist, { name: 'SUBMISSION_CHECKLIST.txt' });

    archive.finalize();
  });
}

// ─── PDF Generators ──────────────────────────────────────────────────────────

function generateCoverLetterPdf(tender, company, bid) {
  const doc = new PDFDocument({ margin: 60, size: 'A4' });
  const buffers = [];
  doc.on('data', (d) => buffers.push(d));

  doc.fontSize(20).font('Helvetica-Bold').text('COVER LETTER', { align: 'center' });
  doc.moveDown();
  doc.fontSize(11).font('Helvetica');
  doc.text(`Date: ${new Date().toLocaleDateString('en-IE')}`);
  doc.moveDown();
  doc.text(`To: ${tender.contracting_authority || 'The Contracting Authority'}`);
  doc.text(`Re: ${tender.title}`);
  if (tender.reference_number) doc.text(`Reference: ${tender.reference_number}`);
  doc.moveDown();
  doc.text(
    `Dear Procurement Officer,\n\nWe, ${company?.name || '[Company Name]'}, hereby submit our proposal in response to the above tender notice published on eTenders.ie.\n\nWe confirm that we have read and understood all tender documents, terms, and conditions, and we are pleased to present our comprehensive proposal.\n\nOur organisation meets all the eligibility criteria and looks forward to the opportunity to deliver excellence for ${tender.contracting_authority || 'your organisation'}.\n\nYours sincerely,\n\n${company?.name || '[Authorised Signatory]'}\n${company?.contact_email || ''}\n${company?.contact_phone || ''}`
  );

  doc.end();
  return Buffer.concat(buffers);
}

function generateTechnicalProposalPdf(tender, bid) {
  const doc = new PDFDocument({ margin: 60, size: 'A4' });
  const buffers = [];
  doc.on('data', (d) => buffers.push(d));

  const formData = bid.form_data || {};

  doc.fontSize(20).font('Helvetica-Bold').text('TECHNICAL PROPOSAL', { align: 'center' });
  doc.moveDown();

  addSection(doc, '1. Understanding of Requirements', formData.understanding_of_requirements ||
    `We have thoroughly reviewed the requirements set out in the tender for "${tender.title}" and demonstrate a clear understanding of the deliverables expected.`);

  addSection(doc, '2. Proposed Methodology', formData.methodology ||
    'Our methodology is structured around proven industry best practices, agile delivery, and continuous stakeholder engagement.');

  addSection(doc, '3. Project Team & Expertise', formData.team_expertise ||
    'Our team brings extensive experience in the required domains. Detailed CVs are provided separately.');

  addSection(doc, '4. Project Plan & Timeline', formData.project_plan ||
    `We propose a phased delivery approach aligned with the contract requirements and deadline of ${tender.deadline ? new Date(tender.deadline).toLocaleDateString('en-IE') : 'as specified'}.`);

  addSection(doc, '5. Quality Assurance', formData.quality_assurance ||
    'Quality is embedded at every stage of our delivery model through robust QA processes, regular reporting, and KPI tracking.');

  addSection(doc, '6. Risk Management', formData.risk_management ||
    'We have identified key risks and mitigation strategies to ensure uninterrupted, high-quality delivery.');

  doc.end();
  return Buffer.concat(buffers);
}

function generateCompanyProfilePdf(company, bid) {
  const doc = new PDFDocument({ margin: 60, size: 'A4' });
  const buffers = [];
  doc.on('data', (d) => buffers.push(d));
  const formData = bid.form_data || {};

  doc.fontSize(20).font('Helvetica-Bold').text('COMPANY PROFILE', { align: 'center' });
  doc.moveDown();

  addSection(doc, 'Company Details', [
    `Company Name: ${company?.name || formData.company_name || '[Name]'}`,
    `Registration Number: ${company?.registration_number || formData.registration_number || '[Reg No]'}`,
    `Address: ${company?.address || formData.address || '[Address]'}`,
    `Contact Email: ${company?.contact_email || formData.contact_email || '[Email]'}`,
    `Contact Phone: ${company?.contact_phone || formData.contact_phone || '[Phone]'}`,
  ].join('\n'));

  addSection(doc, 'Core Competencies', formData.competencies ||
    (company?.expertise || []).join(', ') || 'Please specify core competencies in the bid builder.');

  addSection(doc, 'Relevant Experience', formData.relevant_experience ||
    'Our team has successfully delivered similar engagements for public and private sector clients.');

  addSection(doc, 'Financial Standing', formData.financial_standing ||
    'We confirm that our organisation is financially sound and meets all specified financial thresholds.');

  addSection(doc, 'Insurance & Certifications', formData.insurance ||
    'We maintain all required insurance cover and hold relevant industry certifications.');

  doc.end();
  return Buffer.concat(buffers);
}

function generateFinancialProposalPdf(tender, bid) {
  const doc = new PDFDocument({ margin: 60, size: 'A4' });
  const buffers = [];
  doc.on('data', (d) => buffers.push(d));
  const formData = bid.form_data || {};

  doc.fontSize(20).font('Helvetica-Bold').text('FINANCIAL PROPOSAL', { align: 'center' });
  doc.moveDown();

  doc.fontSize(11).font('Helvetica');
  doc.text(`Tender: ${tender.title}`);
  doc.text(`Reference: ${tender.reference_number || 'N/A'}`);
  doc.moveDown();

  if (formData.pricing_table && Array.isArray(formData.pricing_table)) {
    doc.font('Helvetica-Bold').text('Pricing Breakdown:', { underline: true });
    doc.moveDown(0.5);
    doc.font('Helvetica');
    formData.pricing_table.forEach((row, i) => {
      doc.text(`${i + 1}. ${row.item}: €${Number(row.price || 0).toLocaleString()}`);
    });
    doc.moveDown();
    const total = formData.pricing_table.reduce((s, r) => s + Number(r.price || 0), 0);
    doc.font('Helvetica-Bold').text(`TOTAL: €${total.toLocaleString()}`);
  } else {
    addSection(doc, 'Proposed Price', formData.total_price
      ? `Total Proposed Price: €${Number(formData.total_price).toLocaleString()} (ex. VAT)`
      : 'Price details to be completed in the Bid Builder form.');
  }

  addSection(doc, 'Payment Terms', formData.payment_terms ||
    'Payment terms as specified in the tender documents.');

  doc.end();
  return Buffer.concat(buffers);
}

function generateQResponsesPdf(qResponses, tender) {
  const doc = new PDFDocument({ margin: 60, size: 'A4' });
  const buffers = [];
  doc.on('data', (d) => buffers.push(d));

  doc.fontSize(20).font('Helvetica-Bold').text('SCORED QUESTIONS — RESPONSES', { align: 'center' });
  doc.moveDown(0.5);
  doc.fontSize(10).font('Helvetica').text(`Tender: ${tender.title}`, { align: 'center' });
  doc.moveDown();

  qResponses.forEach((qa, i) => {
    doc.font('Helvetica-Bold').fontSize(12).text(`Q${i + 1}. ${qa.question}`);
    if (qa.marks) doc.font('Helvetica').fontSize(10).text(`[${qa.marks} marks]`);
    doc.moveDown(0.3);
    doc.font('Helvetica').fontSize(11).text(qa.answer || '[Answer not provided]');
    doc.moveDown();
  });

  doc.end();
  return Buffer.concat(buffers);
}

function generateSubmissionChecklist(tender, bid, cvPaths) {
  const lines = [
    'TENDERLY — SUBMISSION CHECKLIST',
    '================================',
    `Tender: ${tender.title}`,
    `Reference: ${tender.reference_number || 'N/A'}`,
    `Deadline: ${tender.deadline ? new Date(tender.deadline).toLocaleDateString('en-IE') : 'Check tender'}`,
    '',
    'Documents Included in this ZIP:',
    '-------------------------------',
    '[ ] 01_Cover_Letter.pdf',
    '[ ] 02_Technical_Proposal.pdf',
    '[ ] 03_Company_Profile.pdf',
    '[ ] 04_Financial_Proposal.pdf',
  ];

  if ((bid.questions_responses || []).length > 0) {
    lines.push('[ ] 05_Scored_Questions_Responses.pdf');
  }

  if (cvPaths.length > 0) {
    lines.push(`[ ] CVs/ (${cvPaths.length} file(s))`);
  }

  lines.push('');
  lines.push('Before Submission:');
  lines.push('------------------');
  lines.push('[ ] Review all documents for accuracy and completeness');
  lines.push('[ ] Obtain authorised signature on Cover Letter');
  lines.push('[ ] Verify submission portal requirements on eTenders.ie');
  lines.push('[ ] Submit before deadline');
  lines.push('');
  lines.push(`Generated by Tenderly on ${new Date().toISOString()}`);

  return lines.join('\n');
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function addSection(doc, title, text) {
  doc.font('Helvetica-Bold').fontSize(12).text(title, { underline: true });
  doc.moveDown(0.3);
  doc.font('Helvetica').fontSize(11).text(text || '');
  doc.moveDown();
}

function slugify(str) {
  return (str || 'tender')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .substring(0, 30);
}
