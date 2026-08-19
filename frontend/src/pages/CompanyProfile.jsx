import { useState, useEffect } from 'react';
import { createCompany, updateCompany } from '../utils/api';
import { useApp } from '../context/AppContext';

const EXPERTISE_OPTIONS = [
  'IT Consulting', 'Software Development', 'Cloud Services', 'Cybersecurity',
  'Data Analytics', 'Project Management', 'Management Consulting', 'Engineering',
  'Construction', 'Healthcare', 'Education', 'Legal Services', 'Finance',
  'HR & Recruitment', 'Marketing & Communications', 'Environmental Services',
];

export default function CompanyProfile() {
  const { company, setCompany } = useApp();
  const [form, setForm] = useState({
    name: '', registration_number: '', address: '',
    contact_email: '', contact_phone: '', expertise: [],
    annual_turnover: '',
  });
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    if (company) {
      setForm({
        name: company.name || '',
        registration_number: company.registration_number || '',
        address: company.address || '',
        contact_email: company.contact_email || '',
        contact_phone: company.contact_phone || '',
        expertise: company.expertise || [],
        annual_turnover: company.annual_turnover || '',
      });
    }
  }, [company]);

  function toggleExpertise(item) {
    setForm((p) => ({
      ...p,
      expertise: p.expertise.includes(item)
        ? p.expertise.filter((e) => e !== item)
        : [...p.expertise, item],
    }));
  }

  async function handleSave(e) {
    e.preventDefault();
    setSaving(true);
    setError('');
    try {
      let result;
      if (company?.id) {
        result = await updateCompany(company.id, form);
      } else {
        result = await createCompany(form);
      }
      setCompany(result.data.company);
      setSaved(true);
      setTimeout(() => setSaved(false), 3000);
    } catch (err) {
      setError(err.response?.data?.error || err.message);
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="profile-page">
      <h1>🏢 Company Profile</h1>
      <p className="profile-hint">
        Set up your company profile to pre-fill bid documents and check eligibility automatically.
      </p>

      <form onSubmit={handleSave} className="profile-form">
        <div className="form-row">
          <div className="form-field">
            <label>Company Name *</label>
            <input
              type="text"
              value={form.name}
              onChange={(e) => setForm((p) => ({ ...p, name: e.target.value }))}
              required
              placeholder="Your company name"
            />
          </div>
          <div className="form-field">
            <label>CRO Registration Number</label>
            <input
              type="text"
              value={form.registration_number}
              onChange={(e) => setForm((p) => ({ ...p, registration_number: e.target.value }))}
              placeholder="e.g. 123456"
            />
          </div>
        </div>

        <div className="form-field">
          <label>Address</label>
          <input
            type="text"
            value={form.address}
            onChange={(e) => setForm((p) => ({ ...p, address: e.target.value }))}
            placeholder="Company registered address"
          />
        </div>

        <div className="form-row">
          <div className="form-field">
            <label>Contact Email *</label>
            <input
              type="email"
              value={form.contact_email}
              onChange={(e) => setForm((p) => ({ ...p, contact_email: e.target.value }))}
              required
              placeholder="contact@yourcompany.ie"
            />
          </div>
          <div className="form-field">
            <label>Contact Phone</label>
            <input
              type="tel"
              value={form.contact_phone}
              onChange={(e) => setForm((p) => ({ ...p, contact_phone: e.target.value }))}
              placeholder="+353 1 234 5678"
            />
          </div>
        </div>

        <div className="form-field">
          <label>Annual Turnover (€)</label>
          <input
            type="number"
            value={form.annual_turnover}
            onChange={(e) => setForm((p) => ({ ...p, annual_turnover: e.target.value }))}
            placeholder="e.g. 500000"
          />
        </div>

        <div className="form-field">
          <label>Areas of Expertise</label>
          <div className="expertise-grid">
            {EXPERTISE_OPTIONS.map((opt) => (
              <button
                key={opt}
                type="button"
                className={`expertise-chip ${form.expertise.includes(opt) ? 'selected' : ''}`}
                onClick={() => toggleExpertise(opt)}
              >
                {form.expertise.includes(opt) ? '✓ ' : ''}{opt}
              </button>
            ))}
          </div>
        </div>

        {error && <p className="error-msg">❌ {error}</p>}
        {saved && <p className="success-msg">✅ Profile saved successfully!</p>}

        <button type="submit" className="btn btn-primary btn-large" disabled={saving}>
          {saving ? '💾 Saving...' : '💾 Save Profile'}
        </button>
      </form>
    </div>
  );
}
