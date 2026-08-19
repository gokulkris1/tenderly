import axios from 'axios';
import * as cheerio from 'cheerio';

const ALLOWED_TENDER_HOSTS = [
  'www.etenders.gov.ie',
  'etenders.gov.ie',
  'www.procurement.ie',
  'ted.europa.eu',
  'esenders.gov.ie',
];

/**
 * Validate that a user-supplied URL points to a trusted procurement portal.
 */
function validateTenderUrl(urlStr) {
  let parsed;
  try {
    parsed = new URL(urlStr);
  } catch {
    throw new Error('Invalid URL format');
  }
  if (!['http:', 'https:'].includes(parsed.protocol)) {
    throw new Error('Only http/https URLs are allowed');
  }
  const host = parsed.hostname.toLowerCase();
  if (!ALLOWED_TENDER_HOSTS.some((h) => host === h || host.endsWith('.' + h))) {
    throw new Error(
      `URL host "${host}" is not in the list of allowed procurement portals. ` +
        `Allowed hosts: ${ALLOWED_TENDER_HOSTS.join(', ')}`
    );
  }
  return parsed.toString();
}

const ETENDERS_BASE = 'https://www.etenders.gov.ie';
const SEARCH_URL = `${ETENDERS_BASE}/epps/cft/listContractNoticesAction.do`;

export async function fetchTenderList({ keyword = '', page = 1 } = {}) {
  try {
    const response = await axios.get(SEARCH_URL, {
      params: {
        searchType: 'keyword',
        keyword,
        page,
        d_contractType: '',
        d_contractingAuthority: '',
      },
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; Tenderly/1.0)',
        Accept: 'text/html',
      },
      timeout: 15000,
    });

    const $ = cheerio.load(response.data);
    const tenders = [];

    // Parse tender rows from etenders.ie listing table
    $('table.listTable tbody tr, .result-item, .notice-row').each((i, el) => {
      const cells = $(el).find('td');
      if (cells.length < 2) return;

      const titleEl = $(cells[0]).find('a').first();
      const title = titleEl.text().trim();
      const href = titleEl.attr('href');
      const ref = $(cells[1]).text().trim();
      const authority = $(cells[2])?.text()?.trim() || '';
      const deadline = $(cells[3])?.text()?.trim() || '';

      if (title) {
        tenders.push({
          title,
          reference_number: ref,
          contracting_authority: authority,
          deadline_text: deadline,
          source_url: href ? (href.startsWith('http') ? href : `${ETENDERS_BASE}${href}`) : null,
        });
      }
    });

    // Fallback: try JSON-like embedded data
    if (tenders.length === 0) {
      $('script').each((i, el) => {
        const content = $(el).html() || '';
        const match = content.match(/var notices\s*=\s*(\[.*?\]);/s);
        if (match) {
          try {
            const data = JSON.parse(match[1]);
            data.forEach((item) => {
              tenders.push({
                title: item.title || item.noticeTitle,
                reference_number: item.referenceNumber || item.ref,
                contracting_authority: item.authority || item.ca,
                deadline_text: item.deadline,
                source_url: item.url
                  ? `${ETENDERS_BASE}${item.url}`
                  : null,
              });
            });
          } catch (_) {}
        }
      });
    }

    return { tenders, total: tenders.length };
  } catch (err) {
    console.error('etenders fetch error:', err.message);
    // Return empty gracefully — user can provide URL manually
    return { tenders: [], total: 0, error: err.message };
  }
}

/**
 * Fetch full details for a single tender by URL
 */
export async function fetchTenderDetail(url) {
  const safeUrl = validateTenderUrl(url);
  const response = await axios.get(safeUrl, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (compatible; Tenderly/1.0)',
      Accept: 'text/html',
    },
    timeout: 20000,
  });

  const $ = cheerio.load(response.data);
  const raw_html = response.data;

  // Generic extraction helpers
  const getField = (label) => {
    let val = '';
    $('th, td.label, .field-label').each((_, el) => {
      if ($(el).text().trim().toLowerCase().includes(label.toLowerCase())) {
        val = $(el).next().text().trim() || $(el).parent().next().text().trim();
      }
    });
    return val;
  };

  const title =
    $('h1').first().text().trim() ||
    $('title').text().replace('eTenders', '').trim() ||
    getField('title');

  const description =
    $('[id*="description"], [class*="description"], .notice-description')
      .first()
      .text()
      .trim() || getField('description');

  const deadlineText =
    getField('deadline') ||
    getField('closing date') ||
    getField('receipt of tenders') ||
    getField('submission');

  const authority =
    getField('contracting authority') ||
    getField('awarding authority') ||
    $('[class*="authority"]').first().text().trim();

  const refNumber =
    getField('reference') ||
    getField('notice reference') ||
    $('[class*="reference"]').first().text().trim();

  const category =
    getField('cpv') ||
    getField('category') ||
    getField('type of contract');

  const valueText = getField('estimated value') || getField('contract value');

  // Framework detection
  const pageText = $('body').text().toLowerCase();
  const isFramework =
    pageText.includes('framework agreement') ||
    pageText.includes('framework contract') ||
    pageText.includes('dynamic purchasing');

  const frameworkDetails = isFramework
    ? {
        multiParty: pageText.includes('multi-party') || pageText.includes('multiparty'),
        lotsBased: pageText.includes('lot'),
        openToAll:
          pageText.includes('any economic operator') ||
          pageText.includes('open procedure') ||
          pageText.includes('all interested'),
      }
    : null;

  // Eligibility criteria extraction
  const eligibilityText =
    $('[id*="eligib"], [class*="eligib"]').text().trim() ||
    getField('eligibility') ||
    getField('selection criteria') ||
    getField('participation conditions');

  return {
    title: title || 'Untitled Tender',
    reference_number: refNumber,
    contracting_authority: authority,
    description: description || pageText.substring(0, 1000),
    category,
    deadline: parseDeadline(deadlineText),
    estimated_value: parseValue(valueText),
    currency: 'EUR',
    framework_agreement: isFramework,
    framework_details: frameworkDetails,
    eligibility_criteria: {
      raw: eligibilityText,
      turnover: extractNumeric(eligibilityText, /turnover[^\d]*([€$]?[\d,]+)/i),
      experience_years: extractNumeric(eligibilityText, /(\d+)\s*year/i),
      insurance: extractNumeric(eligibilityText, /insurance[^\d]*([€$]?[\d,]+)/i),
    },
    source_url: url,
    raw_html,
  };
}

function parseDeadline(text) {
  if (!text) return null;
  const d = new Date(text.replace(/\//g, '-'));
  return isNaN(d.getTime()) ? null : d;
}

function parseValue(text) {
  if (!text) return null;
  const num = parseFloat(text.replace(/[^0-9.]/g, ''));
  return isNaN(num) ? null : num;
}

function extractNumeric(text, regex) {
  const match = (text || '').match(regex);
  if (!match) return null;
  return parseFloat(match[1].replace(/[^0-9.]/g, '')) || null;
}
