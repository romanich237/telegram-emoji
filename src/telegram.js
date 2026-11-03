const API = 'https://api.telegram.org';

class TelegramClient {
  constructor(token) {
    this.token = token;
  }

  async call(method, payload = {}) {
    const response = await fetch(`${API}/bot${this.token}/${method}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload)
    });
    const data = await response.json();
    if (!response.ok || !data.ok) {
      throw new Error(data.description || `Telegram API error: ${response.status}`);
    }
    return data.result;
  }

  async getStickerSet(shortName) {
    return this.call('getStickerSet', { name: shortName });
  }

  async getFileUrl(fileId) {
    const file = await this.call('getFile', { file_id: fileId });
    return `${API}/file/bot${this.token}/${file.file_path}`;
  }

  async downloadFile(fileId) {
    const url = await this.getFileUrl(fileId);
    const response = await fetch(url);
    if (!response.ok) throw new Error('Не удалось загрузить превью эмодзи');
    return response;
  }
}

module.exports = { TelegramClient };