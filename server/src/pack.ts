import JSZip from "jszip";
import PptxGenJS from "pptxgenjs";
import { AlignmentType, Document, HeadingLevel, Packer, Paragraph, TextRun } from "docx";
import { certificateStatus, inScope, selectedLots } from "./serializers.js";
import { rollUpEligibility } from "./eligibility.js";
import { attestationValid, provenanceSummaryFile, type Attestation } from "./attestation.js";
import { buildRunbook, runbookText } from "./runbook.js";
import type { BidAnswer, CompanyProfile, EvidenceRecord, PersonRecord, ProvenanceEntry, StoredDocument, TenderAnalysis, TenderRecord } from "./types.js";

const INK = "17332B";
const GREEN = "167A5A";
const MUTED = "667B74";
const PALE = "E8F5EF";
const PAPER = "F5F7F5";

function safeFilename(value: string) {
  // eslint-disable-next-line no-control-regex -- control characters are exactly what must be stripped from a generated filename
  return value.replace(/[\\/:*?"<>|\x00-\x1f]/g, "_").replace(/\s+/g, " ").trim().slice(0, 100) || "Tender";
}

function paragraph(text: string, options: { bold?: boolean; heading?: typeof HeadingLevel[keyof typeof HeadingLevel] } = {}) {
  return new Paragraph({
    heading: options.heading,
    spacing: { after: options.heading ? 160 : 110, line: 280 },
    children: [new TextRun({ text, bold: options.bold, color: options.heading ? INK : undefined, font: "Aptos", size: options.heading ? 26 : 20 })],
  });
}

function titleBlock(title: string, subtitle: string) {
  return [
    new Paragraph({ alignment: AlignmentType.LEFT, spacing: { after: 120 }, children: [new TextRun({ text: "TENDERLY", bold: true, color: GREEN, font: "Aptos", size: 18, characterSpacing: 80 })] }),
    new Paragraph({ heading: HeadingLevel.TITLE, spacing: { after: 120 }, children: [new TextRun({ text: title, bold: true, color: INK, font: "Aptos", size: 38 })] }),
    new Paragraph({ spacing: { after: 340 }, children: [new TextRun({ text: subtitle, color: MUTED, font: "Aptos", size: 19 })] }),
  ];
}

async function makeResponseDoc(tender: TenderRecord, analysis: TenderAnalysis, answers: BidAnswer[], company: CompanyProfile) {
  const answerMap = new Map(answers.map((answer) => [answer.questionId, answer]));
  const children = [
    ...titleBlock("Tender Response", `${tender.title} · ${tender.authority}`),
    paragraph("Tenderer", { heading: HeadingLevel.HEADING_1 }),
    paragraph(company.name),
    paragraph("Executive summary", { heading: HeadingLevel.HEADING_1 }),
    paragraph(analysis.executiveSummary),
  ];
  for (const [index, question] of analysis.questions.entries()) {
    children.push(paragraph(`${index + 1}. ${question.title}`, { heading: HeadingLevel.HEADING_1 }));
    if (question.prompt) children.push(new Paragraph({ spacing: { after: 120 }, children: [new TextRun({ text: question.prompt, italics: true, color: MUTED, font: "Aptos", size: 18 })] }));
    const answer = answerMap.get(question.id);
    children.push(paragraph(answer?.response?.trim() || "[RESPONSE REQUIRED]"));
  }
  const doc = new Document({ sections: [{ properties: {}, children }] });
  return Packer.toBuffer(doc);
}

async function makeEvidenceRegister(tender: TenderRecord, evidence: EvidenceRecord[], answers: BidAnswer[] = []) {
  const children = [...titleBlock("Evidence Register", tender.title)];
  if (!evidence.length) children.push(paragraph("No reusable evidence items were attached."));

  // Which answers cite each item, so a reviewer can see what rests on what.
  const citedBy = new Map<string, string[]>();
  for (const answer of answers) {
    for (const id of answer.evidence) {
      citedBy.set(id, [...(citedBy.get(id) ?? []), answer.questionId]);
    }
  }

  evidence.forEach((item, index) => {
    children.push(paragraph(`${index + 1}. ${item.name}`, { heading: HeadingLevel.HEADING_2 }));
    const state = item.verified ? "Verified" : "Review required";
    const expiry = item.expiresOn ? ` · expires ${item.expiresOn}` : "";
    const file = item.filename ? ` · file: ${item.filename}` : "";
    children.push(paragraph(`${item.kind} · ${state}${expiry}${file}`));
    const cites = citedBy.get(item.id) ?? [];
    if (cites.length) children.push(paragraph(`Cited by ${cites.length} answer${cites.length > 1 ? "s" : ""}.`));
    if (item.content) children.push(paragraph(item.content));
  });
  return Packer.toBuffer(new Document({ sections: [{ properties: {}, children }] }));
}

async function makeCv(person: PersonRecord) {
  const children = [
    ...titleBlock(person.name, person.title || "Proposed personnel"),
    paragraph("Skills", { heading: HeadingLevel.HEADING_1 }),
    paragraph(person.skills.join(" · ") || "See CV profile"),
    paragraph("Experience", { heading: HeadingLevel.HEADING_1 }),
    paragraph(person.cvText || "[CV CONTENT REQUIRED]"),
  ];
  return Packer.toBuffer(new Document({ sections: [{ properties: {}, children }] }));
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- TODO(TLY-26): pptxgenjs does not export a usable Slide type here; typed with the strict-TypeScript story.
function addSlideHeader(slide: any, label: string, number: number) {
  slide.background = { color: "FFFFFF" };
  slide.addText("tenderly", { x: .55, y: .35, w: 1.3, h: .3, fontFace: "Aptos", fontSize: 15, bold: true, color: INK, margin: 0 });
  slide.addShape("rect", { x: .55, y: .76, w: .33, h: .035, line: { color: GREEN, transparency: 100 }, fill: { color: GREEN } });
  slide.addText(label.toUpperCase(), { x: .55, y: 1.0, w: 4.2, h: .25, fontFace: "Aptos", fontSize: 8, bold: true, color: GREEN, charSpacing: 1.6, margin: 0 });
  slide.addText(String(number).padStart(2, "0"), { x: 12.0, y: .4, w: .65, h: .2, fontFace: "Aptos", fontSize: 8, color: "9AA8A3", align: "right", margin: 0 });
}

export async function createSynopsisDeck(tender: TenderRecord, analysis: TenderAnalysis, company: CompanyProfile) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- TODO(TLY-26): pptxgenjs ships an awkward constructor type; typed with the strict-TypeScript story.
  const PptxConstructor = PptxGenJS as unknown as new () => any;
  const pptx = new PptxConstructor();
  pptx.layout = "LAYOUT_WIDE";
  pptx.author = "Tenderly";
  pptx.subject = `Bid synopsis for ${tender.title}`;
  pptx.title = `${tender.title} — Bid synopsis`;
  pptx.company = company.name;
  pptx.lang = "en-IE";
  pptx.theme = { headFontFace: "Aptos Display", bodyFontFace: "Aptos", lang: "en-IE" };

  const slides = analysis.synopsisSlides.slice(0, 3);
  for (let index = 0; index < slides.length; index += 1) {
    const info = slides[index];
    const slide = pptx.addSlide();
    addSlideHeader(slide, index === 0 ? "The opportunity" : index === 1 ? "Can / should we bid?" : "How to win", index + 1);
    slide.addText(info.title || (index === 0 ? tender.title : analysis.headline), { x: .55, y: 1.4, w: 8.4, h: 1.0, fontFace: "Aptos Display", fontSize: 27, bold: false, color: INK, breakLine: false, margin: 0, valign: "mid", fit: "shrink" });
    if (index === 0) {
      slide.addText(analysis.executiveSummary, { x: .55, y: 2.55, w: 7.3, h: 1.35, fontFace: "Aptos", fontSize: 12, color: MUTED, margin: 0, breakLine: false, valign: "top", fit: "shrink" });
      const metrics = [["Buyer", tender.authority], ["Value", analysis.contractValue || tender.estimatedValue || "Not stated"], ["Deadline", analysis.deadline || tender.deadline || "Verify"]];
      metrics.forEach(([label, value], metricIndex) => {
        const x = .55 + metricIndex * 2.55;
        slide.addShape("rect", { x, y: 4.55, w: 2.25, h: 1.15, rectRadius: .06, line: { color: "DEE7E3", width: 1 }, fill: { color: PAPER } });
        slide.addText(label.toUpperCase(), { x: x + .18, y: 4.77, w: 1.8, h: .18, fontSize: 7, bold: true, color: "8A9994", charSpacing: 1.1, margin: 0 });
        slide.addText(value, { x: x + .18, y: 5.08, w: 1.82, h: .38, fontSize: 12, bold: true, color: INK, margin: 0, fit: "shrink" });
      });
      slide.addShape("rect", { x: 9.35, y: 1.55, w: 3.25, h: 4.55, rectRadius: .08, line: { color: "D7E6E0", width: 1 }, fill: { color: "F5FAF8" } });
      slide.addText("BID DECISION", { x: 9.72, y: 1.95, w: 2.4, h: .2, fontSize: 7, bold: true, color: GREEN, charSpacing: 1.2, margin: 0 });
      slide.addText(`${analysis.fitScore}`, { x: 9.7, y: 2.35, w: 1.2, h: .65, fontSize: 31, bold: true, color: GREEN, margin: 0 });
      slide.addText("/ 100 fit", { x: 10.82, y: 2.72, w: .9, h: .2, fontSize: 8, color: MUTED, margin: 0 });
      slide.addText(analysis.decision.replace("_", " "), { x: 9.72, y: 3.28, w: 2.2, h: .4, fontSize: 17, bold: true, color: INK, margin: 0 });
      slide.addText(analysis.access.replaceAll("_", " ").toLowerCase(), { x: 9.72, y: 3.85, w: 2.35, h: .55, fontSize: 10, color: MUTED, margin: 0, fit: "shrink" });
    } else {
      const bullets = info.bullets.slice(0, 7).map((text) => ({ text, options: { bullet: { indent: 13 }, hanging: 4, breakLine: true } }));
      slide.addText(bullets, { x: .72, y: 2.55, w: 8.1, h: 3.8, fontFace: "Aptos", fontSize: 15, color: INK, breakLine: false, margin: 0.05, paraSpaceAfterPt: 12, valign: "top", fit: "shrink" });
      slide.addShape("rect", { x: 9.45, y: 1.55, w: 3.0, h: 4.7, rectRadius: .08, line: { color: "DFE8E4", width: 1 }, fill: { color: PAPER } });
      const side = index === 1 ? analysis.fatalGates.slice(0, 5).map((gate) => `${gate.status === "PASS" ? "✓" : gate.status === "FAIL" ? "×" : "!"} ${gate.requirement}`) : analysis.risks.slice(0, 5);
      slide.addText(index === 1 ? "ELIGIBILITY GATES" : "WATCH-OUTS", { x: 9.76, y: 1.93, w: 2.2, h: .2, fontSize: 7, bold: true, color: GREEN, charSpacing: 1.1, margin: 0 });
      slide.addText(side.length ? side.join("\n\n") : "No additional items extracted", { x: 9.76, y: 2.35, w: 2.22, h: 3.2, fontSize: 10, color: MUTED, margin: 0, breakLine: false, fit: "shrink" });
    }
    slide.addText("Generated from source-linked Tenderly analysis · verify portal deadlines immediately before submission", { x: .55, y: 7.05, w: 8.7, h: .16, fontSize: 6.5, color: "98A5A0", margin: 0 });
  }
  const output = await pptx.write({ outputType: "nodebuffer" });
  return Buffer.isBuffer(output) ? output : Buffer.from(output as ArrayBuffer);
}

export function submissionBlockers(
  tender: TenderRecord,
  analysis: TenderAnalysis,
  answers: BidAnswer[],
  documents: StoredDocument[],
  evidence: EvidenceRecord[] = [],
  // Roles nobody on the team can fill. Passed in rather than recomputed here so
  // the pack does not need the people tables to decide whether it is blocked.
  unfillableRoles: string[] = [],
) {
  const blockers: string[] = [];
  // A named person must state they have reviewed this exact content before the
  // final pack leaves the system. Editing any answer invalidates that statement.
  if (!attestationValid(tender.metadata.attestation as Attestation | undefined, answers)) {
    blockers.push("Attestation not recorded");
  }
  // A certificate the tender makes a condition of participation, with nothing
  // verified to show for it, is a hard blocker (TLY-43).
  for (const certificate of certificateStatus(analysis.requiredCertificates ?? [], evidence)) {
    if (certificate.mandatory && !certificate.satisfied) blockers.push(`${certificate.name} — missing`);
  }
  // A gate on a lot the user is not bidding is not a reason to block their pack.
  const selection = selectedLots(tender);
  const gatesInScope = analysis.fatalGates.filter((gate) => inScope(gate.lotId, selection));
  const eligibility = rollUpEligibility(gatesInScope);
  if (gatesInScope.length > 0 ? eligibility !== "PASS" : analysis.eligibility !== "PASS") {
    blockers.push(`Eligibility is ${gatesInScope.length > 0 ? eligibility : analysis.eligibility}; resolve all mandatory gates before final pack`);
  }
  gatesInScope.filter((gate) => gate.status === "FAIL" || gate.status === "REVIEW").forEach((gate) => blockers.push(`${gate.requirement}: ${gate.status.toLowerCase()}`));
  const answerMap = new Map(answers.map((answer) => [answer.questionId, answer]));
  analysis.questions.filter((question) => question.required && inScope(question.lotId, selection)).forEach((question) => {
    const answer = answerMap.get(question.id);
    if (!answer?.response.trim() || answer.status !== "ready") blockers.push(`Required response not ready: ${question.title}`);
  });
  const overrides = (tender.metadata.checklistOverrides ?? {}) as Record<string, string>;
  analysis.submissionChecklist.filter((item) => item.required && item.status !== "READY" && overrides[item.id] !== "READY").forEach((item) => blockers.push(`Submission item needs action: ${item.label}`));
  // A bid naming nobody for a role the buyer requires will be rejected on the
  // formality, whatever the responses say.
  for (const role of unfillableRoles) blockers.push(role);

  const requiresCompletedBuyerFile = analysis.submissionChecklist.some((item) => item.required && ["BUYER_TEMPLATE", "PRICING", "SIGNATURE"].includes(item.kind));
  if (requiresCompletedBuyerFile && !documents.some((document) => document.role === "submission")) blockers.push("Upload completed buyer templates / pricing / signed declarations as submission files");
  return [...new Set(blockers)];
}

export async function createSubmissionPack(args: { tender: TenderRecord; analysis: TenderAnalysis; answers: BidAnswer[]; documents: StoredDocument[]; company: CompanyProfile; people: PersonRecord[]; evidence: EvidenceRecord[]; provenance?: ProvenanceEntry[]; unfillableRoles?: string[]; draft: boolean }) {
  const blockers = submissionBlockers(args.tender, args.analysis, args.answers, args.documents, args.evidence, args.unfillableRoles ?? []);
  if (!args.draft && blockers.length) return { blockers, buffer: null as Buffer | null };
  const zip = new JSZip();
  const prefix = args.draft ? "DRAFT_" : "";
  zip.file(`${prefix}01_Tender_Response.docx`, await makeResponseDoc(args.tender, args.analysis, args.answers, args.company));
  for (const [index, person] of args.people.entries()) zip.file(`${prefix}${String(index + 2).padStart(2, "0")}_CV_${safeFilename(person.name)}.docx`, await makeCv(person));
  for (const document of args.documents.filter((item) => item.role === "submission" && item.bytes)) zip.file(safeFilename(document.filename), document.bytes!);

  // The last mile travels with every pack, draft or final: whoever opens the
  // ZIP is the person who has to do the uploading, and the draft is what a team
  // rehearses with before the final one exists.
  zip.file(`${prefix}Submission_Runbook.txt`, runbookText(args.tender, buildRunbook(args.tender, args.analysis)));
  if (args.draft) {
    zip.file("_Tenderly_Internal/Evidence_Register.docx", await makeEvidenceRegister(args.tender, args.evidence, args.answers));
    zip.file("_Tenderly_Internal/Bid_Synopsis.pptx", await createSynopsisDeck(args.tender, args.analysis, args.company));
    zip.file("_Tenderly_Internal/READINESS.txt", `TENDERLY DRAFT PACK — NOT READY FOR SUBMISSION\n\n${blockers.length ? blockers.map((blocker) => `- ${blocker}`).join("\n") : "No automated blockers detected. Human final review is still required."}\n`);
  } else {
    // The record of how the response was produced leaves with the response.
    zip.file("Provenance_Summary.txt", provenanceSummaryFile({
      analysis: args.analysis, answers: args.answers, provenance: args.provenance ?? [],
      attestation: args.tender.metadata.attestation as Attestation | undefined,
    }));
    zip.file("Submission_Manifest.txt", `Tender: ${args.tender.title}\nTenderer: ${args.company.name}\nGenerated: ${new Date().toISOString()}\n\nThis manifest records pack assembly only. Final submission remains a human-controlled action on the buyer portal.\n`);
  }
  return { blockers, buffer: await zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE", compressionOptions: { level: 6 } }) };
}

export function packFilename(tender: TenderRecord, draft: boolean) {
  return `${draft ? "DRAFT_" : ""}Tenderly_${safeFilename(tender.title).replace(/\s+/g, "_")}.zip`;
}
