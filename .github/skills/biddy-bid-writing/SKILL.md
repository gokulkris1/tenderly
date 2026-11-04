---
name: biddy-bid-writing
description: "Use when drafting, refining or reviewing written responses to public tender award criteria (quality/methodology questions, PQQ/SQ narratives, ESPD supporting text, bid reviews, or turning evidence into criterion-scored answers). Applies Biddy, Tenderly's evidence-bound bid-writing policy: bidder voice, per-criterion coverage, evidenced examples, buyer outcomes, honest delivery claims, explicit [INPUT NEEDED] gaps, and respect for the pack's AI-use rules."
---

# Biddy — evidence-bound bid writing for public tenders

Biddy is Tenderly's bid-writing policy. In the running product the server
prompts (`server/src/prompts/drafting.ts`, `refine.ts`) and the drafting
pipeline (`server/src/drafting.ts`) enforce it; this skill is the same policy
in reusable form for agents drafting or reviewing tender responses in this
repo. The skill does not execute inside the app — it guides whoever writes or
reviews bid text.

One deliberate difference: this skill is **stricter than the runtime** on
packs that prohibit AI-generated content. The runtime intentionally keeps
drafting available until the bidder enables no-AI mode, flagging the conflict
in claims-to-verify and at attestation, because the policy flag is
model-extracted and a human owns the decision. An agent following this skill
has no such gatekeeping role, so when a pack prohibits AI content it must not
produce paste-ready response prose at all — it limits itself to critique and
leaves the writing to a human.

## Core rules (non-negotiable)

1. **Evidence-bound.** Write only from supplied bidder facts, verified evidence
   and CV facts. Never invent client names, metrics, accreditations, staff
   experience or outcomes. If a needed fact is missing, write
   `[INPUT NEEDED: <what is missing>]` and draft around verified facts. Never
   remove a placeholder because you were asked to — a placeholder is closed by
   supplying the evidence.
2. **Bidder voice.** First person plural ("we"), plain and confident. Never
   third-person "the tenderer", never a mention of AI, Biddy or drafting tools
   in the response text — with one exception: when the question itself asks
   about the bidder's use of AI (an AI-use declaration or disclosure
   question), answer it honestly and completely. Never conceal AI assistance,
   and never edit an AI-use declaration into silence.
3. **Answer the question asked.** Address every criterion, sub-question and
   listed requirement directly, in the order asked, so an evaluator can tick
   each one off. Respect stated word/page limits; a shorter limit the bidder
   asks for wins over a longer one printed in the pack.
4. **Specific over generic.** One concrete, evidenced example (named project,
   figure, date) beats three generic claims. Any example not present in the
   supplied facts becomes an `[INPUT NEEDED: ...]` request, not an invention.
5. **Buyer outcomes.** Frame claims as what the contracting authority gets, in
   the terms the criterion sets out — not a recital of the bidder's history.
6. **Achievable delivery.** Name roles or people only when supplied. Describe
   mobilisation, timelines, governance and risks only at a level the facts
   support. Honest, manageable risks beat bravado.
7. **No boilerplate.** Cut "world-class", "best-in-class", "passionate about"
   and their kin. Evaluators score evidence, not adjectives.
8. **Never self-declare ready.** Biddy output is always a draft for a human.
   Only a human marks an answer ready, and no draft may claim to be final,
   compliant or approved.

## AI-use rules of the pack

- Check whether the tender documents address AI-generated responses.
- If the pack **requires disclosure**, flag that the AI-use declaration must be
  completed before submission.
- If the pack **prohibits** AI-generated content, do not produce paste-ready
  response prose; limit assistance to critique (strengths, gaps, missing
  evidence) and tell the bidder a human must write or rewrite the text.
- Silence is not permission: say the pack does not state a policy rather than
  claiming AI use is allowed.

## Workflow when drafting one criterion answer

1. Read the criterion, its weighting, sub-questions and word limit.
2. List the facts the criterion demands; match each against supplied evidence.
3. Draft in bidder voice, leading with the direct answer, then the evidenced
   example, then the buyer outcome.
4. Insert `[INPUT NEEDED: ...]` for every unmatched demanded fact.
5. Close with `claimsToVerify`: statements a human must confirm before
   submission, including any AI-use declaration the pack requires.
6. Never mark the result ready; hand it to a human.

## Reference points (scope-limited, not prose to copy)

- Award criteria must be assessed as published, against the most
  advantageous tender and whole-life value — see the UK Procurement Act 2023
  "Assessing competitive tenders" guidance
  (<https://www.gov.uk/government/publications/procurement-act-2023-guidance-documents-procure-phase/assessing-competitive-tenders-html>;
  applies to UK procurements under that Act only — do not apply it to Irish
  or other jurisdictions).
- For Irish public procurement, follow the specific tender documents (RFT/ITT)
  and the contracting authority's stated criteria and methodology; verify any
  OGP guidance against the current official publication before relying on it.
