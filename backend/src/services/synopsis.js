import OpenAI from 'openai';

let openai = null;
function getAI() {
  if (!openai && process.env.OPENAI_API_KEY) {
    openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  }
  return openai;
}

/**
 * Generate a synopsis deck (1-3 slides) for a tender.
 * Returns an array of slide objects: { title, bullets, type }
 */
export async function generateSynopsis(tender, bidderProfile = null) {
  const ai = getAI();

  const prompt = buildPrompt(tender, bidderProfile);

  if (ai) {
    try {
      const completion = await ai.chat.completions.create({
        model: 'gpt-4o-mini',
        messages: [{ role: 'user', content: prompt }],
        temperature: 0.3,
        response_format: { type: 'json_object' },
      });
      const result = JSON.parse(completion.choices[0].message.content);
      return result.slides || buildFallbackSlides(tender, bidderProfile);
    } catch (err) {
      console.error('OpenAI error, using fallback synopsis:', err.message);
    }
  }

  return buildFallbackSlides(tender, bidderProfile);
}

function buildPrompt(tender, bidderProfile) {
  const bp = bidderProfile
    ? `Bidder company: ${bidderProfile.name}, expertise: ${(bidderProfile.expertise || []).join(', ')}`
    : 'No bidder profile provided.';

  return `You are a procurement expert. Analyze the tender below and return a JSON object with a "slides" array of 1-3 slide objects.
Each slide must have: { "title": string, "type": "overview"|"eligibility"|"action", "bullets": string[], "highlight": string }

Tender details:
- Title: ${tender.title}
- Authority: ${tender.contracting_authority || 'Unknown'}
- Deadline: ${tender.deadline || 'TBD'}
- Estimated Value: ${tender.estimated_value ? '€' + tender.estimated_value.toLocaleString() : 'TBD'}
- Category: ${tender.category || 'General'}
- Framework: ${tender.framework_agreement ? 'Yes - ' + JSON.stringify(tender.framework_details) : 'No'}
- Description: ${(tender.description || '').substring(0, 800)}
- Eligibility: ${JSON.stringify(tender.eligibility_criteria || {})}
${bp}

Generate slides covering:
1. Overview (critical details: what, who, value, deadline)
2. Eligibility & bid structure (can we apply alone, framework restrictions, requirements)
3. Action items / next steps (optional slide)

Return JSON only, no markdown.`;
}

function buildFallbackSlides(tender, bidderProfile) {
  const daysToDeadline = tender.deadline
    ? Math.ceil((new Date(tender.deadline) - Date.now()) / 86400000)
    : null;

  const slides = [
    {
      type: 'overview',
      title: '📋 Tender Overview',
      highlight: tender.title,
      bullets: [
        `Authority: ${tender.contracting_authority || 'Not specified'}`,
        `Reference: ${tender.reference_number || 'N/A'}`,
        `Category: ${tender.category || 'General Procurement'}`,
        `Estimated Value: ${tender.estimated_value ? '€' + Number(tender.estimated_value).toLocaleString() : 'Not disclosed'}`,
        `Deadline: ${tender.deadline ? new Date(tender.deadline).toLocaleDateString('en-IE') : 'Check tender documents'}`,
        daysToDeadline !== null
          ? `⏰ ${daysToDeadline > 0 ? daysToDeadline + ' days remaining' : 'DEADLINE PASSED'}`
          : '',
      ].filter(Boolean),
    },
    {
      type: 'eligibility',
      title: '✅ Eligibility & Bid Structure',
      highlight: tender.framework_agreement
        ? '⚠️ Framework Agreement — check participation rules'
        : '🟢 Open tender — any eligible company may apply',
      bullets: buildEligibilityBullets(tender, bidderProfile),
    },
  ];

  const actionBullets = buildActionBullets(tender, bidderProfile, daysToDeadline);
  if (actionBullets.length) {
    slides.push({
      type: 'action',
      title: '🚀 Action Plan',
      highlight: 'Steps to submit a winning bid',
      bullets: actionBullets,
    });
  }

  return slides;
}

function buildEligibilityBullets(tender, bidderProfile) {
  const bullets = [];
  const ec = tender.eligibility_criteria || {};
  const fd = tender.framework_details || {};

  if (tender.framework_agreement) {
    bullets.push('📌 This is a Framework Agreement');
    if (fd.multiParty) bullets.push('👥 Multi-party framework — consortium may be required');
    if (fd.openToAll) bullets.push('🟢 Open to all interested parties');
    else bullets.push('⚠️ Restricted — check if your company is on the approved list');
  } else {
    bullets.push('🟢 Open procedure — any qualifying company may submit');
  }

  if (ec.turnover)
    bullets.push(`💰 Minimum turnover requirement: €${Number(ec.turnover).toLocaleString()}`);
  if (ec.experience_years)
    bullets.push(`📅 Minimum experience required: ${ec.experience_years} years`);
  if (ec.insurance)
    bullets.push(`🛡️ Insurance requirement: €${Number(ec.insurance).toLocaleString()}`);
  if (ec.raw && !ec.turnover && !ec.experience_years)
    bullets.push(`📝 Criteria: ${ec.raw.substring(0, 120)}...`);

  if (bidderProfile) {
    const expertise = (bidderProfile.expertise || []).join(', ');
    bullets.push(`🏢 Your expertise (${expertise}) — verify alignment with requirements`);
  }

  if (bullets.length === 0) bullets.push('Review tender documents for specific eligibility criteria');
  return bullets;
}

function buildActionBullets(tender, bidderProfile, daysToDeadline) {
  const bullets = [];
  if (daysToDeadline !== null && daysToDeadline <= 0) {
    bullets.push('❌ Deadline has passed — submission no longer possible');
    return bullets;
  }
  if (daysToDeadline !== null && daysToDeadline < 7)
    bullets.push(`🔴 URGENT: Only ${daysToDeadline} days to deadline`);

  bullets.push('1. Download and review all tender documents');
  bullets.push('2. Confirm eligibility criteria are met');
  if (tender.framework_agreement)
    bullets.push('3. Confirm framework participation status or apply to join');
  bullets.push('4. Prepare company profile, financials, and relevant experience');
  bullets.push('5. Identify required CVs and team roles');
  bullets.push('6. Use Tenderly Bid Builder to complete and export documents');
  return bullets;
}
