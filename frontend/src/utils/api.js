import axios from 'axios';

const API_BASE = import.meta.env.VITE_API_URL || 'http://localhost:4000';

const api = axios.create({ baseURL: API_BASE });

// Tenders
export const getTenders = (params) => api.get('/api/tenders', { params });
export const fetchTenderFromUrl = (url) => api.post('/api/tenders/fetch', { url });
export const getTender = (id) => api.get(`/api/tenders/${id}`);
export const generateSynopsis = (tenderId, bidderProfile) =>
  api.post(`/api/tenders/${tenderId}/synopsis`, { bidderProfile });

// Bids
export const createBid = (data) => api.post('/api/bids', data);
export const getBid = (id) => api.get(`/api/bids/${id}`);
export const updateBid = (id, data) => api.patch(`/api/bids/${id}`, data);
export const uploadCVs = (bidId, files) => {
  const fd = new FormData();
  files.forEach((f) => fd.append('cvs', f));
  return api.post(`/api/bids/${bidId}/upload-cv`, fd);
};
export const generateZip = (bidId) =>
  api.post(`/api/bids/${bidId}/generate-zip`, {}, { responseType: 'blob' });

// Companies
export const createCompany = (data) => api.post('/api/companies', data);
export const getCompany = (id) => api.get(`/api/companies/${id}`);
export const updateCompany = (id, data) => api.patch(`/api/companies/${id}`, data);
