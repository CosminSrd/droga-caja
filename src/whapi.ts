import { config } from './config.js';

const API = 'https://gate.whapi.cloud';
const REQUEST_TIMEOUT_MS = 20_000;

type Button = { type: 'quick_reply'; title: string; id: string };
type ListRow = { title: string; id: string; description?: string };

async function request(path: string, body: unknown) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  let response: Response;
  try {
    response = await fetch(`${API}${path}`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${config.WHAPI_TOKEN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') {
      throw new Error(`Whapi request timed out after ${REQUEST_TIMEOUT_MS}ms`);
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
  if (!response.ok) throw new Error(`Whapi request failed: ${response.status} ${await response.text()}`);
  return response.json();
}

export function sendMenu(to: string, text: string, buttons: Button[]) {
  return request('/messages/interactive', {
    to, type: 'button', body: { text },
    action: { buttons: buttons.slice(0, 3) },
  });
}

export function sendText(to: string, body: string) {
  return request('/messages/text', { to, body });
}

export function sendList(to: string, text: string, rows: ListRow[]) {
  return request('/messages/interactive', {
    to,
    type: 'list',
    body: { text },
    action: { button: 'Ver opciones', sections: [{ title: 'Ofertas activas', rows: rows.slice(0, 10) }] },
  });
}
