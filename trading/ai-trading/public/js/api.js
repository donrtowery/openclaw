// ── API Wrapper ────────────────────────────────────────────

const API_URL = '/api/dashboard';

function getApiKey() {
  return localStorage.getItem('openclaw_api_key') || '';
}

function setApiKey(key) {
  localStorage.setItem('openclaw_api_key', key);
}

async function apiCall(action, params = {}) {
  const res = await fetch(API_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': getApiKey(),
    },
    body: JSON.stringify({ action, ...params }),
  });

  if (res.status === 401) {
    showKeyModal();
    throw new Error('Unauthorized');
  }

  const json = await res.json();
  if (json.error) throw new Error(json.error);
  return json;
}

function showKeyModal() {
  document.getElementById('key-modal').style.display = 'flex';
  document.getElementById('key-error').style.display = 'none';
  document.getElementById('key-input').value = '';
  document.getElementById('key-input').focus();
}

function hideKeyModal() {
  document.getElementById('key-modal').style.display = 'none';
}

function checkApiKey() {
  if (!getApiKey()) {
    showKeyModal();
    return false;
  }
  return true;
}

// Key modal event listeners
document.getElementById('key-submit').addEventListener('click', async () => {
  const key = document.getElementById('key-input').value.trim();
  if (!key) return;
  setApiKey(key);
  try {
    await apiCall('get_engine_status');
    hideKeyModal();
    loadTabData(activeTab);
  } catch {
    document.getElementById('key-error').style.display = 'block';
    setApiKey('');
  }
});

document.getElementById('key-input').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') document.getElementById('key-submit').click();
});
