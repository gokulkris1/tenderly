import { useState } from 'react';
import SynopsisSlide from './SynopsisSlide';

export default function SynopsisDeck({ slides, eligibility, onProceed, onBack }) {
  const [current, setCurrent] = useState(0);

  if (!slides || slides.length === 0) {
    return <p className="empty">No synopsis available.</p>;
  }

  return (
    <div className="synopsis-deck">
      <div className="slide-wrapper">
        <SynopsisSlide
          slide={slides[current]}
          index={current}
          total={slides.length}
        />
      </div>

      <div className="slide-nav">
        <button
          className="btn btn-ghost"
          disabled={current === 0}
          onClick={() => setCurrent((c) => c - 1)}
        >
          ← Previous
        </button>
        <div className="slide-dots">
          {slides.map((_, i) => (
            <span
              key={i}
              className={`dot ${i === current ? 'active' : ''}`}
              onClick={() => setCurrent(i)}
            />
          ))}
        </div>
        <button
          className="btn btn-ghost"
          disabled={current === slides.length - 1}
          onClick={() => setCurrent((c) => c + 1)}
        >
          Next →
        </button>
      </div>

      {eligibility && (
        <div className="eligibility-panel">
          <h3>🎯 Eligibility Assessment</h3>
          <p className="recommendation">{eligibility.recommendation}</p>
          {eligibility.passed?.length > 0 && (
            <ul className="check-list passed">
              {eligibility.passed.map((p, i) => <li key={i}>✅ {p}</li>)}
            </ul>
          )}
          {eligibility.issues?.length > 0 && (
            <ul className="check-list issues">
              {eligibility.issues.map((p, i) => <li key={i}>⚠️ {p}</li>)}
            </ul>
          )}
          <p className="apply-solo">
            {eligibility.canApplyAlone
              ? '🟢 You can submit this bid independently.'
              : '🔶 Consider a consortium or tie-up with another company.'}
          </p>
        </div>
      )}

      <div className="deck-actions">
        {onBack && (
          <button className="btn btn-ghost" onClick={onBack}>
            ← Back
          </button>
        )}
        <button className="btn btn-success btn-large" onClick={onProceed}>
          🚀 Let&apos;s Go — Build the Bid!
        </button>
      </div>
    </div>
  );
}
