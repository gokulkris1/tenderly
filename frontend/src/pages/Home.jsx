import { useNavigate } from 'react-router-dom';

export default function Home() {
  const navigate = useNavigate();

  return (
    <div className="home-page">
      <div className="hero">
        <div className="hero-content">
          <h1>🎯 Tenderly</h1>
          <p className="hero-subtitle">
            Your intelligent Irish public procurement assistant
          </p>
          <p className="hero-desc">
            Discover tenders on eTenders.ie, get an instant synopsis deck, verify your eligibility,
            and generate a complete bid document set — all in one place.
          </p>
          <div className="hero-actions">
            <button className="btn btn-primary btn-large" onClick={() => navigate('/discover')}>
              🔍 Discover Tenders
            </button>
            <button className="btn btn-ghost btn-large" onClick={() => navigate('/profile')}>
              🏢 Set Up Company Profile
            </button>
          </div>
        </div>
      </div>

      <div className="features-grid">
        <div className="feature-card">
          <div className="feature-icon">🔍</div>
          <h3>Discover</h3>
          <p>Search live tenders from eTenders.ie or paste any procurement URL to import instantly.</p>
        </div>
        <div className="feature-card">
          <div className="feature-icon">📊</div>
          <h3>Synopsis Deck</h3>
          <p>Get a 1–3 slide overview of any tender: key details, value, deadline, and critical info at a glance.</p>
        </div>
        <div className="feature-card">
          <div className="feature-icon">✅</div>
          <h3>Eligibility Check</h3>
          <p>Instantly know if it&apos;s a framework bid, who can apply, and whether you need a consortium partner.</p>
        </div>
        <div className="feature-card">
          <div className="feature-icon">📝</div>
          <h3>Bid Builder</h3>
          <p>Auto-fill bid documents, answer scored questions, upload CVs — then download a ZIP ready to submit.</p>
        </div>
      </div>

      <div className="cta-section">
        <h2>Ready to win your next tender?</h2>
        <button className="btn btn-success btn-large" onClick={() => navigate('/discover')}>
          Get Started →
        </button>
      </div>
    </div>
  );
}
