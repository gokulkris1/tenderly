import { useState } from 'react';
import { updateBid, uploadCVs } from '../../utils/api';

const SECTIONS = [
  { key: 'understanding_of_requirements', label: 'Understanding of Requirements', type: 'textarea', required: true },
  { key: 'methodology', label: 'Proposed Methodology', type: 'textarea', required: true },
  { key: 'team_expertise', label: 'Team & Expertise', type: 'textarea', required: true },
  { key: 'project_plan', label: 'Project Plan & Timeline', type: 'textarea', required: false },
  { key: 'quality_assurance', label: 'Quality Assurance Approach', type: 'textarea', required: false },
  { key: 'risk_management', label: 'Risk Management', type: 'textarea', required: false },
  { key: 'total_price', label: 'Total Proposed Price (€)', type: 'number', required: true },
  { key: 'payment_terms', label: 'Payment Terms', type: 'text', required: false },
  { key: 'company_name', label: 'Company Name', type: 'text', required: true },
  { key: 'registration_number', label: 'Company Registration Number', type: 'text', required: false },
  { key: 'address', label: 'Company Address', type: 'text', required: false },
  { key: 'contact_email', label: 'Contact Email', type: 'email', required: true },
  { key: 'contact_phone', label: 'Contact Phone', type: 'tel', required: false },
  { key: 'competencies', label: 'Core Competencies', type: 'textarea', required: false },
  { key: 'relevant_experience', label: 'Relevant Experience', type: 'textarea', required: false },
  { key: 'financial_standing', label: 'Financial Standing Statement', type: 'textarea', required: false },
  { key: 'insurance', label: 'Insurance & Certifications', type: 'text', required: false },
];

export default function BidForm({ bid, tender, company, onComplete }) {
  const prefill = {
    company_name: company?.name || '',
    registration_number: company?.registration_number || '',
    address: company?.address || '',
    contact_email: company?.contact_email || '',
    contact_phone: company?.contact_phone || '',
    competencies: (company?.expertise || []).join(', '),
  };

  const [formData, setFormData] = useState({ ...prefill, ...(bid?.form_data || {}) });
  const [questions, setQuestions] = useState(bid?.questions_responses || []);
  const [newQuestion, setNewQuestion] = useState('');
  const [newMarks, setNewMarks] = useState('');
  const [cvFiles, setCvFiles] = useState([]);
  const [saving, setSaving] = useState(false);
  const [activeTab, setActiveTab] = useState('details');

  function handleChange(key, value) {
    setFormData((p) => ({ ...p, [key]: value }));
  }

  function addQuestion() {
    if (!newQuestion.trim()) return;
    setQuestions((p) => [...p, { question: newQuestion, marks: newMarks, answer: '' }]);
    setNewQuestion('');
    setNewMarks('');
  }

  function updateAnswer(idx, answer) {
    setQuestions((p) => p.map((q, i) => (i === idx ? { ...q, answer } : q)));
  }

  function removeQuestion(idx) {
    setQuestions((p) => p.filter((_, i) => i !== idx));
  }

  async function handleSave() {
    setSaving(true);
    try {
      await updateBid(bid.id, { form_data: formData, questions_responses: questions });
      if (cvFiles.length > 0) await uploadCVs(bid.id, cvFiles);
      onComplete && onComplete();
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="bid-form">
      <div className="tab-bar">
        {['details', 'questions', 'cvs'].map((t) => (
          <button
            key={t}
            className={`tab ${activeTab === t ? 'active' : ''}`}
            onClick={() => setActiveTab(t)}
          >
            {t === 'details' ? '📝 Bid Details' : t === 'questions' ? '❓ Scored Questions' : '👤 Upload CVs'}
          </button>
        ))}
      </div>

      {activeTab === 'details' && (
        <div className="form-section">
          <p className="section-hint">Fill in your bid details below. All fields marked * are required.</p>
          {SECTIONS.map((s) => (
            <div key={s.key} className="form-field">
              <label>
                {s.label} {s.required && <span className="req">*</span>}
              </label>
              {s.type === 'textarea' ? (
                <textarea
                  rows={4}
                  value={formData[s.key] || ''}
                  onChange={(e) => handleChange(s.key, e.target.value)}
                  placeholder={`Enter ${s.label.toLowerCase()}...`}
                />
              ) : (
                <input
                  type={s.type}
                  value={formData[s.key] || ''}
                  onChange={(e) => handleChange(s.key, e.target.value)}
                  placeholder={s.label}
                />
              )}
            </div>
          ))}
        </div>
      )}

      {activeTab === 'questions' && (
        <div className="form-section">
          <p className="section-hint">
            Add scored/marked questions from the tender and write your responses.
          </p>
          <div className="add-question-row">
            <input
              type="text"
              placeholder="Question text..."
              value={newQuestion}
              onChange={(e) => setNewQuestion(e.target.value)}
              className="q-input"
            />
            <input
              type="text"
              placeholder="Marks (e.g. 20)"
              value={newMarks}
              onChange={(e) => setNewMarks(e.target.value)}
              className="marks-input"
            />
            <button className="btn btn-secondary" onClick={addQuestion}>
              + Add Question
            </button>
          </div>

          {questions.length === 0 && (
            <p className="empty">No questions added yet. Add questions from the tender above.</p>
          )}

          {questions.map((q, i) => (
            <div key={i} className="question-block">
              <div className="question-header">
                <strong>Q{i + 1}. {q.question}</strong>
                {q.marks && <span className="marks-badge">{q.marks} marks</span>}
                <button className="btn-icon" onClick={() => removeQuestion(i)}>🗑️</button>
              </div>
              <textarea
                rows={5}
                placeholder="Write your detailed response here..."
                value={q.answer || ''}
                onChange={(e) => updateAnswer(i, e.target.value)}
              />
            </div>
          ))}
        </div>
      )}

      {activeTab === 'cvs' && (
        <div className="form-section">
          <p className="section-hint">
            Upload CVs for team members / key personnel required by the tender (PDF, DOC, DOCX).
          </p>
          <input
            type="file"
            multiple
            accept=".pdf,.doc,.docx"
            onChange={(e) => setCvFiles(Array.from(e.target.files))}
            className="file-input"
          />
          {cvFiles.length > 0 && (
            <ul className="file-list">
              {cvFiles.map((f, i) => <li key={i}>📄 {f.name}</li>)}
            </ul>
          )}
          {bid?.uploaded_cvs?.length > 0 && (
            <div>
              <p className="uploaded-label">Previously uploaded:</p>
              <ul className="file-list">
                {bid.uploaded_cvs.map((f, i) => (
                  <li key={i}>✅ {f.name || f}</li>
                ))}
              </ul>
            </div>
          )}
        </div>
      )}

      <div className="bid-form-actions">
        <button className="btn btn-primary btn-large" onClick={handleSave} disabled={saving}>
          {saving ? '💾 Saving...' : '💾 Save & Continue'}
        </button>
      </div>
    </div>
  );
}
