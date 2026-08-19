import express from 'express';
import { fetchTenderList, fetchTenderDetail } from '../services/etenders.js';
import { generateSynopsis } from '../services/synopsis.js';
import { query } from '../db/index.js';

const router = express.Router();

// GET /api/tenders — list tenders (from etenders.ie or DB cache)
router.get('/', async (req, res, next) => {
  const { keyword = '', page = 1, source = 'etenders' } = req.query;

  try {
    if (source === 'db') {
      const result = await query(
        `SELECT id, title, reference_number, contracting_authority, deadline,
                estimated_value, framework_agreement, status, source_url
         FROM tenders ORDER BY created_at DESC LIMIT 50`
      );
      return res.json({ tenders: result.rows });
    }

    const data = await fetchTenderList({ keyword, page: Number(page) });
    res.json(data);
  } catch (err) {
    next(err);
  }
});

// POST /api/tenders/fetch — fetch & parse a tender from URL or etenders ref
router.post('/fetch', async (req, res) => {
  const { url } = req.body;
  if (!url) return res.status(400).json({ error: 'URL is required' });

  try {
    const detail = await fetchTenderDetail(url);

    // Upsert to DB
    const existing = await query(
      'SELECT id FROM tenders WHERE source_url = $1',
      [url]
    );

    let tender;
    if (existing.rows.length > 0) {
      const upd = await query(
        `UPDATE tenders SET title=$1, contracting_authority=$2, description=$3,
         category=$4, deadline=$5, estimated_value=$6, framework_agreement=$7,
         framework_details=$8, eligibility_criteria=$9, raw_html=$10, reference_number=$11
         WHERE source_url=$12 RETURNING *`,
        [
          detail.title, detail.contracting_authority, detail.description,
          detail.category, detail.deadline, detail.estimated_value,
          detail.framework_agreement, JSON.stringify(detail.framework_details),
          JSON.stringify(detail.eligibility_criteria), detail.raw_html,
          detail.reference_number, url,
        ]
      );
      tender = upd.rows[0];
    } else {
      const ins = await query(
        `INSERT INTO tenders (title, reference_number, contracting_authority, description,
         category, deadline, estimated_value, framework_agreement, framework_details,
         eligibility_criteria, source_url, raw_html)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING *`,
        [
          detail.title, detail.reference_number, detail.contracting_authority,
          detail.description, detail.category, detail.deadline, detail.estimated_value,
          detail.framework_agreement, JSON.stringify(detail.framework_details),
          JSON.stringify(detail.eligibility_criteria), url, detail.raw_html,
        ]
      );
      tender = ins.rows[0];
    }

    res.json({ tender });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/tenders/:id
router.get('/:id', async (req, res) => {
  const result = await query('SELECT * FROM tenders WHERE id = $1', [req.params.id]);
  if (!result.rows.length) return res.status(404).json({ error: 'Not found' });
  res.json({ tender: result.rows[0] });
});

// POST /api/tenders/:id/synopsis
router.post('/:id/synopsis', async (req, res) => {
  const tenderResult = await query('SELECT * FROM tenders WHERE id = $1', [req.params.id]);
  if (!tenderResult.rows.length) return res.status(404).json({ error: 'Tender not found' });

  const tender = tenderResult.rows[0];
  const { bidderProfile } = req.body;

  const slides = await generateSynopsis(tender, bidderProfile);

  const eligibility_result = assessEligibility(tender, bidderProfile);

  const ins = await query(
    `INSERT INTO synopsis (tender_id, slides, eligibility_result, recommendation)
     VALUES ($1, $2, $3, $4) RETURNING *`,
    [tender.id, JSON.stringify(slides), JSON.stringify(eligibility_result), eligibility_result.recommendation]
  );

  res.json({ synopsis: ins.rows[0], slides, eligibility_result });
});

function assessEligibility(tender, bidderProfile) {
  const issues = [];
  const passed = [];

  if (tender.framework_agreement) {
    const fd = tender.framework_details || {};
    if (!fd.openToAll) {
      issues.push('Framework agreement — may be restricted to pre-selected suppliers');
    } else {
      passed.push('Framework is open to all interested parties');
    }
    if (fd.multiParty) {
      issues.push('Multi-party framework — consider consortium or tie-up with partners');
    }
  } else {
    passed.push('Open procedure — you may apply independently');
  }

  if (bidderProfile) {
    const ec = tender.eligibility_criteria || {};
    if (ec.turnover && bidderProfile.annual_turnover) {
      if (bidderProfile.annual_turnover >= ec.turnover) {
        passed.push(`Turnover requirement met (€${Number(ec.turnover).toLocaleString()})`);
      } else {
        issues.push(`Turnover shortfall: need €${Number(ec.turnover).toLocaleString()}, have €${Number(bidderProfile.annual_turnover).toLocaleString()}`);
      }
    }
  }

  const canApplyAlone = !tender.framework_agreement || (tender.framework_details?.openToAll && !tender.framework_details?.multiParty);
  const recommendation = issues.length === 0
    ? 'You appear eligible to submit a bid independently.'
    : issues.length <= 2
      ? 'Eligible with caveats — review the flagged items before submitting.'
      : 'Multiple eligibility concerns — consider a consortium or seek clarification from the authority.';

  return { passed, issues, canApplyAlone, recommendation };
}

export default router;
