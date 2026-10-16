import { config } from './config.js';

const API = 'https://gate.whapi.cloud';

type Button = { type: 'quick_reply'; title: string; id: string };

async function request(path: string, body: unknown) {
  const response = await fetch(`${API}${path}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${config.WHAPI_TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
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
